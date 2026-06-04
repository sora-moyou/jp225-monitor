import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getSessionOHLC, getLatestTick, getRecentBars } from '../db/store.js';
import { computeLevels, type LevelsResult } from '../levels.js';
import { broadcast } from '../sse/broker.js';
import { classifySession } from '../../collector/session.js';
import { getForecastSnapshot } from './forecastLoop.js';
import { emitAlert } from '../alertHistory.js';
import { detectDoubleTopBottom, DEFAULT_DOUBLE_PARAMS } from '../doublePattern.js';
import { detectLevelBreak } from '../levelBreak.js';
import { extractSwingPivots } from '../swingPivots.js';
import { resolveLevelsConfig } from '../configStore.js';

const SYMBOL = 'NIY=F';
const POLL_MS = 8_000;   // 当日H/Lをほぼリアルタイム化(従来60s)。NIY=Fのみで軽い。
// 取得セッション数: 直近高安2(可変) / 20Sフィボ / 長期高安 を賄える数 + 余裕。
const fetchSessionsFor = (lookback: number, lookback2: number): number => Math.max(lookback, lookback2, 20) + 4;

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let last: LevelsResult = { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
let lastSig = '';
let tickCount = 0;
let warnedNoTick = false;
// ダブルトップ/ボトムの per-level クールダウン。同一レベル(種別+価格)を15分は再発火しない。
// 8秒ループでゾーン内に留まる間の連発を防ぐ。共有クールダウン(alertCooldown)とは独立。
const DTB_COOLDOWN_MS = 15 * 60_000;
const lastDtbFire = new Map<string, number>();
// 水準抜けの per-level クールダウン(DTB と同様 15分・別マップ)。
const BREAK_COOLDOWN_MS = 15 * 60_000;
const lastBreakFire = new Map<string, number>();
// 最新tickがこれ以上古い(収集停止/復帰中)なら、stale な価格でダブル/水準抜けを誤発火しないよう検知しない。
const DETECT_FRESH_MS = 90_000;
// 確定スイングピボットの戻り閾値(円)。これ以上戻った極値だけを固定水準として採用(1分足ノイズを除外)。
const PIVOT_RECLAIM_YEN = 25;
// 診断用: 各ステージの所要時間を記録。「価格水準の計算が終わらない」の原因切り分け用。
// DB取得(getSessionOHLC)が支配的なら索引/データ量が原因、computeLevels が支配的ならロジックが原因。

export function sessionKey(cs: { sessionDate: string; session: string } | null): string {
  return cs ? `${cs.sessionDate}/${cs.session}` : 'none';
}

/** レベル集合(価格+tier+丸めスコア+swing)の署名。current は UI が price SSE でライブ追従するため除外。
 *  価格が同じでも tier/score(強さ)が変わったら再配信されるよう、各 level の tier と
 *  0.5刻みに丸めた score も署名に含める。price 昇順ソートで決定性を保つ。
 *  これが変わった時だけ SSE 配信し、8秒間隔でも無駄な配信をしない。 */
export function levelSignature(r: LevelsResult): string {
  const prices = [...r.up, ...r.down]
    .sort((a, b) => a.price - b.price)
    .map(l => `${l.price}:${l.tier}:${Math.round(l.score * 2) / 2}`)
    .join(',');
  return `${prices}#${r.swing ? `${r.swing.high}-${r.swing.low}-${r.swing.leg}` : ''}`;
}

function tick(): void {
  if (!db) return;
  tickCount++;
  const tStart = Date.now();
  try {
    const now = Date.now();
    const latest = getLatestTick(db, SYMBOL);
    if (!latest) {
      // ticks テーブルに NIY=F が無い → 水準は出ない(「蓄積中…」のまま)。一度だけ警告。
      if (!warnedNoTick) { console.warn('[levelsLoop] NIY=F の tick がDBに無いため水準を計算できません(収集デーモン未稼働 or データ未蓄積)'); warnedNoTick = true; }
      return;
    }
    warnedNoTick = false;
    const tDb = Date.now();
    const lc = resolveLevelsConfig();
    const sessions = getSessionOHLC(db, SYMBOL, fetchSessionsFor(lc.lookbackSessions, lc.lookbackSessions2));
    const dbMs = Date.now() - tDb;
    const cs = classifySession(now);
    const fc = getForecastSnapshot();
    const extra = fc.targets
      ? [{ price: fc.targets.projHigh, label: 'ADR上限予測' }, { price: fc.targets.projLow, label: 'ADR下限予測' }]
      : [];
    const tCompute = Date.now();
    const result = computeLevels(sessions, latest.price, now, cs, extra);
    const computeMs = Date.now() - tCompute;
    last = result;
    const sig = levelSignature(result);
    let sent = false;
    if (sig !== lastSig) {
      lastSig = sig;
      broadcast({ type: 'levels', payload: result });
      sent = true;
    }
    // 最新tickが古い(収集停止/復帰中)なら、stale な価格でダブル/水準抜けを誤発火させない(水準配信は上で継続)。
    if (now - latest.t > DETECT_FRESH_MS) return;
    // ── ダブルトップ/ボトム検知(全レベル対象・手前10円・髭タッチ・ネック不要)──
    // 直近 lookbackBars 分の1分足(髭=h/l)を取り、全レベルに対し検知。per-level クールダウンで間引く。
    try {
      const sinceT = now - DEFAULT_DOUBLE_PARAMS.lookbackBars * 60_000;
      const recent = getRecentBars(db, SYMBOL, sinceT).map(b => ({ t: b.t, h: b.h, l: b.l }));
      // dtb/水準抜けの対象は「固定水準」のみ: 当日ぶんは確定スイングピボット(swingPivots)、
      // それ以外は computeLevels の固定 hl(前セッション/直近/長期)。現値追従の当日高安は使わない
      // (動く端を基準にすると下落中にダブルボトムが乱発する)。同価格は丸めて重複排除(ピボット優先)。
      const pivots = extractSwingPivots(recent, PIVOT_RECLAIM_YEN)
        .map(p => ({ price: p.price, label: p.kind === 'low' ? '押し安値' : '戻り高値' }));
      const seen = new Set<number>();
      const hlLevels = [...pivots, ...(result.hlLevels ?? [])]
        .filter(l => { const k = Math.round(l.price / 5) * 5; if (seen.has(k)) return false; seen.add(k); return true; });
      for (const dsig of detectDoubleTopBottom(hlLevels, recent, latest.price)) {
        const key = `${dsig.kind}@${dsig.level.toFixed(1)}`;
        if (now - (lastDtbFire.get(key) ?? -Infinity) <= DTB_COOLDOWN_MS) continue;
        lastDtbFire.set(key, now);
        const name = dsig.kind === 'top' ? 'Wトップ' : 'Wボトム';
        console.log(`[levelsLoop] ${name} @${Math.round(dsig.level)} (${dsig.label})`);
        emitAlert({
          symbol: SYMBOL, symbolLabel: `日経225先物 (${name})`,
          changePercent: 0, windowSeconds: 60, detectionKind: 'dtb',
          direction: dsig.kind === 'top' ? 'down' : 'up',
          triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
          level: Math.round(dsig.level),
          note: `${name} ${Math.round(dsig.level)}円(${dsig.label})に接近`,
        });
      }
      // ── 水準抜け検知(DTBの補集合: 反転せず抜けた/ネック未達で再度抜けた)──
      // 同じ hlLevels・同じ直近1分足を対象。per-level クールダウンで連発抑制。
      for (const bsig of detectLevelBreak(hlLevels, recent, latest.price)) {
        const key = `${bsig.kind}@${bsig.level.toFixed(1)}`;
        if (now - (lastBreakFire.get(key) ?? -Infinity) <= BREAK_COOLDOWN_MS) continue;
        lastBreakFire.set(key, now);
        const lvl = Math.round(bsig.level);
        console.log(`[levelsLoop] 水準抜け ${bsig.kind} @${lvl} (${bsig.label})`);
        emitAlert({
          symbol: SYMBOL, symbolLabel: '日経225先物',
          changePercent: 0, windowSeconds: 60, detectionKind: 'break',
          direction: bsig.kind === 'up' ? 'up' : 'down',
          triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
          level: lvl,
          note: `${lvl.toLocaleString('ja-JP')}水準抜けの可能性あり`,
        });
      }
    } catch (err) {
      console.warn('[levelsLoop] dtb/break detect failed:', err instanceof Error ? err.message : err);
    }
    // 診断ログ: 最初の3tick / 遅い時(DB>500ms or compute>150ms) / 水準が空の時 に出す。
    // 通常は無音。これを見れば「どのステージで詰まるか」「水準が空になっていないか」が分かる。
    const empty = result.up.length === 0 && result.down.length === 0;
    if (tickCount <= 3 || dbMs > 500 || computeMs > 150 || empty) {
      console.log(`[levelsLoop] db=${dbMs}ms compute=${computeMs}ms total=${Date.now() - tStart}ms `
        + `sessions=${sessions.length} up=${result.up.length} down=${result.down.length} `
        + `${sent ? 'broadcast' : 'unchanged'}${empty ? ' ⚠空(蓄積中表示)' : ''}`
        + `${dbMs > 500 ? ' ⚠DB遅延' : ''}`);
    }
  } catch (err) {
    // 原因解明のためスタックトレースまで出す(従来は message のみ)。
    console.warn(`[levelsLoop] tick FAILED (total=${Date.now() - tStart}ms): `
      + (err instanceof Error ? (err.stack ?? err.message) : String(err)));
  }
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(() => {
    tick();
    schedule();
  }, POLL_MS);
}

export function startLevelsLoop(): void {
  if (running) return;
  try { db = openDb(resolveDbPath()); }
  catch (err) { console.warn('[levelsLoop] open db failed:', err instanceof Error ? err.message : err); return; }
  running = true;
  tick();
  schedule();
}

export function stopLevelsLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (db) { db.close(); db = null; }
}

export function getLevelsSnapshot(): LevelsResult { return last; }
