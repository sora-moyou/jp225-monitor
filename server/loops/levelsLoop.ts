import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getSessionOHLC, getLatestTick, getRecentBars } from '../db/store.js';
import { computeLevels, type LevelsResult } from '../levels.js';
import { broadcast } from '../sse/broker.js';
import { classifySession } from '../../collector/session.js';
import { getForecastSnapshot } from './forecastLoop.js';
import { emitAlert } from '../alertHistory.js';
import { detectDoubleTopBottom, DEFAULT_DOUBLE_PARAMS } from '../doublePattern.js';
import { detectLevelBreak, type BreakSignal } from '../levelBreak.js';
import { extractSwingPivots } from '../swingPivots.js';
import { detectSwingDouble, DEFAULT_SWING_DOUBLE } from '../swingDouble.js';
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
// 水準抜けの per-level クールダウン(DTB と同様 15分・別マップ)。同一水準の再タッチ連発を抑制。
const BREAK_COOLDOWN_MS = 15 * 60_000;
const lastBreakFire = new Map<string, number>();
// 水準抜けの方向別クールダウン。トレンド中は価格の通り道に固定水準が複数あり、各水準を抜けるたびに
// 1本ずつ発火して「水準が動いて見える」階段状の連発になる。方向別に一定時間まとめ、逆方向(反転)は許可。
const BREAK_DIR_COOLDOWN_MS = 10 * 60_000;
const lastBreakDir = new Map<'up' | 'down', number>();
// 最新tickがこれ以上古い(収集停止/復帰中)なら、stale な価格でダブル/水準抜けを誤発火しないよう検知しない。
const DETECT_FRESH_MS = 90_000;
// 確定スイングピボットの戻り閾値(円)。これ以上戻った極値だけを固定水準として採用(1分足ノイズを除外)。
const PIVOT_RECLAIM_YEN = 25;
// ── 長周期スイング・ダブルボトム/トップ(swingDouble)──
// 複数セッションをまたぐ大きな W/M 反転を捉える。重いDB読取を避け約60秒に1回だけ再計算する。
const SWING_DOUBLE_CHECK_MS = 60_000;           // 再計算間隔(8秒tick毎ではない)
const SWING_LOOKBACK_DAYS = 4;                  // ピボット抽出に使う直近の暦日数(セッションまたぎ)
// 主要スイングのみ確定(micro はピボットにしない)。実データ較正: 150では細かいWを拾い、500で
// 狙いの大ダブル(例: 谷66,950→ネック67,765→谷66,930)を捉える。場中チューニングで調整可。
const SWING_PIVOT_RECLAIM_YEN = 500;
const SWING_DTB_COOLDOWN_MS = 30 * 60_000;      // per-neck × stage クールダウン
const DAY_MS = 86_400_000;
let lastSwingCheck = 0;
const lastSwingFire = new Map<string, number>();
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
        // ラベルはトレンド中立の語を使う。「押し安値/戻り高値」は方向(上昇の押し/下降の戻り)を含むため、
        // 上昇相場で高値を上抜けした時に「戻り高値を上抜け」と矛盾する。スイング高値/安値なら両局面で成立。
        .map(p => ({ price: p.price, label: p.kind === 'low' ? 'スイング安値' : 'スイング高値' }));
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
      // 同じ hlLevels・同じ直近1分足を対象。連発を2段で整理する:
      //  (1) 同一tick内の同方向ブレイクは「最も外側の1本」に集約(上抜け=最高水準/下抜け=最安水準=
      //      価格が最も遠くまで抜けた=最も意味がある)。近接水準を同時に複数出さない。
      //  (2) 方向別クールダウンで、トレンド中に水準を次々抜ける階段状の連発を1本化(逆方向=反転は許可)。
      const breaks = detectLevelBreak(hlLevels, recent, latest.price);
      const outer = new Map<'up' | 'down', BreakSignal>();
      for (const b of breaks) {
        const cur = outer.get(b.kind);
        if (!cur || (b.kind === 'up' ? b.level > cur.level : b.level < cur.level)) outer.set(b.kind, b);
      }
      for (const bsig of outer.values()) {
        if (now - (lastBreakDir.get(bsig.kind) ?? -Infinity) <= BREAK_DIR_COOLDOWN_MS) continue;   // 方向別(階段状連発の抑制)
        const key = `${bsig.kind}@${bsig.level.toFixed(1)}`;
        if (now - (lastBreakFire.get(key) ?? -Infinity) <= BREAK_COOLDOWN_MS) continue;            // per-level(再タッチの抑制)
        lastBreakFire.set(key, now);
        lastBreakDir.set(bsig.kind, now);
        const lvl = Math.round(bsig.level);
        const dirWord = bsig.kind === 'up' ? '上抜け' : '下抜け';
        console.log(`[levelsLoop] 水準抜け ${bsig.kind} @${lvl} (${bsig.label})`);
        emitAlert({
          symbol: SYMBOL, symbolLabel: '日経225先物',
          changePercent: 0, windowSeconds: 60, detectionKind: 'break',
          direction: bsig.kind === 'up' ? 'up' : 'down',
          triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
          level: lvl,
          // 「何の水準か」を付記(ユーザー指定): 価格 + 由来ラベル(スイング高安/前日Day終値/長期高 等) + 方向。
          note: `${lvl.toLocaleString('ja-JP')} ${bsig.label}を${dirWord}(水準抜けの可能性あり)`,
        });
      }
      // ── 長周期スイング・ダブルボトム/トップ(複数セッションをまたぐ大反転)──
      // 約60秒に1回だけ、直近 SWING_LOOKBACK_DAYS 日のピボット(大 reclaim=主要スイングのみ)で検知。
      // 谷の価格差は不問(ユーザー指定)、本物のWかはネック突出度で判定。forming/breakout の2段。
      if (now - lastSwingCheck >= SWING_DOUBLE_CHECK_MS) {
        lastSwingCheck = now;
        const longBars = getRecentBars(db, SYMBOL, now - SWING_LOOKBACK_DAYS * DAY_MS).map(b => ({ t: b.t, h: b.h, l: b.l }));
        const swingPivots = extractSwingPivots(longBars, SWING_PIVOT_RECLAIM_YEN);
        const sd = detectSwingDouble(swingPivots, latest.price, DEFAULT_SWING_DOUBLE);
        if (sd) {
          const neck = Math.round(sd.neck);
          const key = `${sd.kind}@${neck}#${sd.stage}`;
          if (now - (lastSwingFire.get(key) ?? -Infinity) > SWING_DTB_COOLDOWN_MS) {
            lastSwingFire.set(key, now);
            const yen = (v: number): string => Math.round(v).toLocaleString('ja-JP');
            const [g1, g2] = sd.legs;
            const name = sd.kind === 'bottom' ? 'ダブルボトム' : 'ダブルトップ';
            const word = sd.kind === 'bottom' ? '上抜け' : '下抜け';
            const watch = sd.kind === 'bottom' ? '上抜けで上昇期待' : '下抜けで下落警戒';
            const legLabel = sd.kind === 'bottom' ? '谷' : '山';
            const note = sd.stage === 'breakout'
              ? `${name}成立 — ネック${yen(neck)}円を${word}(${legLabel}${yen(g1)}/${yen(g2)})目標≈${yen(sd.target)}`
              : `${name}形成 — ネック${yen(neck)}円(${legLabel}${yen(g1)}→${yen(g2)})。${watch}`;
            console.log(`[levelsLoop] swingDouble ${sd.kind} ${sd.stage} neck=${neck} legs=${Math.round(g1)}/${Math.round(g2)}`);
            emitAlert({
              symbol: SYMBOL, symbolLabel: `日経225先物 (${name})`,
              changePercent: 0, windowSeconds: 60, detectionKind: 'swingdtb',
              direction: sd.kind === 'bottom' ? 'up' : 'down',
              triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
              level: neck, note,
            });
          }
        }
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
