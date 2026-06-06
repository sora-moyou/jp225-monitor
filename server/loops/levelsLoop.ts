import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getSessionOHLC, getLatestTick, getRecentBars } from '../db/store.js';
import { computeLevels, type LevelsResult } from '../levels.js';
import { broadcast } from '../sse/broker.js';
import { classifySession } from '../../collector/session.js';
import { getForecastSnapshot } from './forecastLoop.js';
import { emitAlert } from '../alertHistory.js';
import { detectLevelBreak, type BreakSignal } from '../levelBreak.js';
import { detectLevelHold } from '../levelHold.js';
import { extractSwingPivots } from '../swingPivots.js';
import { detectSwingDouble, DEFAULT_SWING_DOUBLE } from '../swingDouble.js';
import { aggregateSignals, DEFAULT_AGGREGATE } from '../signals/aggregate.js';
import { crashDrawdown, CRASH_DRAWDOWN_PCT, CRASH_HYSTERESIS_PCT } from '../crash.js';
import type { AlertSignal, SignalType } from '../signals/types.js';
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
// ── アラート再設計(v0.6.0): L2 価格系シグナルを signals→aggregate→emit に一本化 ──
// 直近1分足の取得本数(break/level_sr/pivot 用の窓)。
const RECENT_BARS_MIN = 90;
// 水準抜けの方向別クールダウン(階段状連発の抑制)。トレンド中は通り道の固定水準を次々抜けるため、
// 同方向は最外1本+方向別クールダウンで前置フィルタする(集約前)。逆方向(反転)は許可。
const BREAK_DIR_COOLDOWN_MS = 20 * 60_000;   // v0.6.2: 10→20。トレンドで主要水準を次々抜ける連発を更に抑制。
const lastBreakDir = new Map<'up' | 'down', number>();
// v0.6.2: クールダウンは「価格ゾーン×方向」で共有(種別問わず)。同じ水準帯で support→resistance→break が
// 立て続けに出る乱発を1本化する。double のみ neck×stage で別管理(別物・低頻度)。
const ZONE_COOLDOWN_MS = 20 * 60_000;       // ゾーン×方向の共有クールダウン
const DOUBLE_COOLDOWN_MS = 30 * 60_000;
const lastEmit = new Map<string, number>();
// 最新tickがこれ以上古い(収集停止/復帰中)なら、stale な価格で誤発火しないよう検知しない。
const DETECT_FRESH_MS = 90_000;
// ── 暴落(crash): セッション高値からの下落率がこれ以上(ユーザー定義)。閾値/計算は crash.ts に集約。
let crashSessionKey = '';
let crashSessionHigh = 0;
let crashFired = false;
// 確定スイングピボットの戻り閾値(円)。break/level_sr/pivot の基準・形成判定に使う。
// v0.6.1: 25→60。v0.6.2: 実データ監査で全体が過剰発火(level_sr 6.5/h 等)→ 主要スイングのみに絞るため 120。
// 「意識される水準」= computeLevels tier≥1(当日/前日/長期高安・節目・合流)+ この主要スイング、に限定する。
const PIVOT_RECLAIM_YEN = 120;
// 近接水準の統合許容(円)。これ以内の水準は1本にまとめる(クラスタの擦り抜け=乱発を防ぐ)。
const LEVEL_MERGE_YEN = 40;
// スイング形成(pivot)通知の最小スイング幅(円)。これ未満の小さな転換は通知しない(2.9/h→主要のみ)。
const PIVOT_FORMED_MIN_YEN = 200;
let lastPivotT = 0;   // 最後に「形成」を通知したピボットの時刻(新規確定のみ通知)
// ── ダブル天井/大底(double, 長周期スイング)──
// 複数セッションをまたぐ大きな W/M 反転。重いDB読取を避け約60秒に1回だけ再計算する。
const SWING_DOUBLE_CHECK_MS = 60_000;           // 再計算間隔(8秒tick毎ではない)
const SWING_LOOKBACK_DAYS = 4;                  // ピボット抽出に使う直近の暦日数(セッションまたぎ)
// 主要スイングのみ確定(micro はピボットにしない)。実データ較正: 150では細かいWを拾い、500で
// 狙いの大ダブル(例: 谷66,950→ネック67,765→谷66,930)を捉える。場中チューニングで調整可。
const SWING_PIVOT_RECLAIM_YEN = 500;
const DAY_MS = 86_400_000;
let lastSwingCheck = 0;
// ── 反応水準(v0.6.10): パネルに「複数回反転した実反応の帯」を出すため、直近数日のスイングピボットを
// クラスタ化して反転回数を数える。重いので約60秒ごとに再計算してキャッシュ。
const REACTION_CHECK_MS = 60_000;
const REACTION_LOOKBACK_DAYS = 3;
const REACTION_RECLAIM_YEN = 50;    // 反応とみなすスイングの戻り幅(意味ある反転のみ)
const REACTION_CLUSTER_YEN = 25;    // 同一水準帯に束ねる許容
const REACTION_MIN = 2;             // 2回以上反転した帯のみ採用
let lastReactionCheck = 0;
let reactionLevels: { price: number; reactions: number }[] = [];

// L2(価格系)検知のチューニング定数を一括 export。発火頻度の事前監査ツール(scripts/alert-audit.mjs)が
// 同じ値で実データ・リプレイできるようにする(定数のドリフト=乱発バグの再発を防ぐ)。
export const LEVELS_TUNING = {
  recentBarsMin: RECENT_BARS_MIN, pivotReclaimYen: PIVOT_RECLAIM_YEN, levelMergeYen: LEVEL_MERGE_YEN,
  pivotFormedMinYen: PIVOT_FORMED_MIN_YEN, swingPivotReclaimYen: SWING_PIVOT_RECLAIM_YEN,
  swingLookbackDays: SWING_LOOKBACK_DAYS, zoneCooldownMs: ZONE_COOLDOWN_MS, doubleCooldownMs: DOUBLE_COOLDOWN_MS,
  breakDirCooldownMs: BREAK_DIR_COOLDOWN_MS,
} as const;
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
    // 反応水準を約60秒ごとに再計算してキャッシュ(直近数日のスイングピボットをクラスタ化し反転回数を数える)。
    if (now - lastReactionCheck >= REACTION_CHECK_MS) {
      lastReactionCheck = now;
      try {
        const rb = getRecentBars(db, SYMBOL, now - REACTION_LOOKBACK_DAYS * DAY_MS).map(b => ({ t: b.t, h: b.h, l: b.l }));
        const piv = extractSwingPivots(rb, REACTION_RECLAIM_YEN).map(p => p.price).sort((a, b) => a - b);
        const cl: { price: number; reactions: number }[] = [];
        for (const p of piv) {
          const c = cl.find(x => Math.abs(x.price - p) <= REACTION_CLUSTER_YEN);
          if (c) { c.price = (c.price * c.reactions + p) / (c.reactions + 1); c.reactions++; }
          else cl.push({ price: p, reactions: 1 });
        }
        reactionLevels = cl.filter(c => c.reactions >= REACTION_MIN).map(c => ({ price: Math.round(c.price), reactions: c.reactions }));
      } catch (err) { console.warn('[levelsLoop] reaction levels failed:', err instanceof Error ? err.message : err); }
    }
    const tCompute = Date.now();
    const result = computeLevels(sessions, latest.price, now, cs, extra, reactionLevels);
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
    // ── 暴落検知: セッション高値から CRASH_DRAWDOWN_PCT 以上の下落でアラート(AIが広いニュース窓で原因分析)──
    // セッションが変わったらリセット。高値=DB上のセッション高値・ランニング・現値の最大(再起動でも欠けない)。
    // エッジ発火(暴落入りで1回)+ ヒステリシスで戻したらリセット → 同セッションの再暴落でも再発火。
    try {
      const csk = sessionKey(cs);
      if (csk !== crashSessionKey) { crashSessionKey = csk; crashSessionHigh = 0; crashFired = false; }
      if (csk !== 'none') {
        const inProg = cs ? sessions.find(s => s.sessionDate === cs.sessionDate && s.session === cs.session) : undefined;
        crashSessionHigh = Math.max(crashSessionHigh, inProg?.high ?? 0, latest.price);
        const dd = crashDrawdown(crashSessionHigh, latest.price);
        if (dd >= CRASH_DRAWDOWN_PCT && !crashFired) {
          crashFired = true;
          const high = Math.round(crashSessionHigh), drop = Math.round(crashSessionHigh - latest.price);
          const pct = (dd * 100).toFixed(1);
          console.log(`[levelsLoop] 暴落 high=${high} now=${Math.round(latest.price)} -${pct}% (-${drop})`);
          emitAlert({
            symbol: SYMBOL, symbolLabel: '日経225先物',
            changePercent: -dd * 100, windowSeconds: 6 * 3600, detectionKind: 'crash', direction: 'down',
            triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0, level: high,
            note: `暴落: セッション高値${high.toLocaleString('ja-JP')}から -${pct}%(-${drop.toLocaleString('ja-JP')}円)`,
            referenceKind: 'sessionHigh', referencePrice: high,
          });
        } else if (dd < CRASH_DRAWDOWN_PCT - CRASH_HYSTERESIS_PCT) {
          crashFired = false;   // 戻したら次の暴落に備えてリセット
        }
      }
    } catch (err) {
      console.warn('[levelsLoop] crash detect failed:', err instanceof Error ? err.message : err);
    }
    // ── L2 価格系シグナル(double / level_sr / break / pivot)を生成 → 集約 → emit(v0.6.0)──
    // 対象水準は「固定水準」のみ: 当日ぶんは確定スイングピボット、それ以外は computeLevels の固定 hl
    // (前セッション/直近/長期)。現値追従の当日高安は使わない(動く端を基準にすると乱発する)。
    try {
      const sinceT = now - RECENT_BARS_MIN * 60_000;
      const recent = getRecentBars(db, SYMBOL, sinceT).map(b => ({ t: b.t, h: b.h, l: b.l }));
      const rawPivots = extractSwingPivots(recent, PIVOT_RECLAIM_YEN);
      // ラベルはトレンド中立(「押し安値/戻り高値」は方向を含み水準抜け文で矛盾するため)。形成イベントは別途方向語を使う。
      const pivots = rawPivots.map(p => ({ price: p.price, label: p.kind === 'low' ? 'スイング安値' : 'スイング高値' }));
      // ③有意性ゲート(v0.6.2): break/level_sr の対象は「意識される水準」のみ。
      // = computeLevels の tier≥1(当日/前日/長期高安・節目・合流=スコア上位)+ 主要スイング(reclaim120)。
      // 全マイナー水準に反応すると ~6/h で乱発する(実データ監査)。名前付き水準を優先(明確な文言ⒶⒺ)。
      const sigNamed = [...result.up, ...result.down]
        .filter(l => l.tier >= 1)
        .map(l => ({ price: l.price, label: l.labels[0] ?? '水準' }));
      const kept: number[] = [];
      const hlLevels = [...sigNamed, ...pivots]
        .filter(l => {
          if (!(l.price > 0) || kept.some(k => Math.abs(k - l.price) <= LEVEL_MERGE_YEN)) return false;
          kept.push(l.price); return true;
        });

      const signals: AlertSignal[] = [];

      // 水準抜け(break): 同方向は最外1本+方向別クールダウンで前置フィルタ(トレンドの階段状連発を抑制)。
      const breaks = detectLevelBreak(hlLevels, recent, latest.price);
      const outer = new Map<'up' | 'down', BreakSignal>();
      for (const b of breaks) {
        const cur = outer.get(b.kind);
        if (!cur || (b.kind === 'up' ? b.level > cur.level : b.level < cur.level)) outer.set(b.kind, b);
      }
      for (const bsig of outer.values()) {
        if (now - (lastBreakDir.get(bsig.kind) ?? -Infinity) <= BREAK_DIR_COOLDOWN_MS) continue;
        const lvl = Math.round(bsig.level);
        const dirWord = bsig.kind === 'up' ? '上抜け' : '下抜け';
        signals.push({
          type: 'break', direction: bsig.kind, reference: { kind: 'level', price: lvl }, stage: 'confirmed',
          score: 1.2, triggeredAt: now,
          text: `${lvl.toLocaleString('ja-JP')} ${bsig.label}を${dirWord}(水準抜けの可能性あり)`,
        });
      }

      // 水準サポート/レジスタンス(level_sr): 反発確認後(③)。
      for (const h of detectLevelHold(hlLevels, recent, latest.price)) {
        const lvl = Math.round(h.level);
        const word = h.kind === 'support' ? 'サポート' : 'レジスタンス';
        signals.push({
          type: 'level_sr', direction: h.kind === 'support' ? 'up' : 'down',
          reference: { kind: 'level', price: lvl }, stage: 'confirmed', score: 1.1, triggeredAt: now,
          text: `${lvl.toLocaleString('ja-JP')} ${h.label}が${word}の可能性`,
        });
      }

      // スイング転換点の形成(pivot): 新しい確定ピボットが現れたら1回。直前ピボットからの値幅が
      // PIVOT_FORMED_MIN_YEN 以上の「主要な転換」だけ通知(小さな形成は出さない)。方向語(押し安値/戻り高値)許可。
      const newest = rawPivots[rawPivots.length - 1];
      const prevPivot = rawPivots[rawPivots.length - 2];
      if (newest && newest.t > lastPivotT
          && (!prevPivot || Math.abs(newest.price - prevPivot.price) >= PIVOT_FORMED_MIN_YEN)) {
        lastPivotT = newest.t;
        const lvl = Math.round(newest.price);
        const word = newest.kind === 'low' ? 'スイング安値' : 'スイング高値';
        const note = newest.kind === 'low' ? '押し安値の可能性' : '戻り高値の可能性';
        signals.push({
          type: 'pivot', direction: newest.kind === 'low' ? 'up' : 'down',
          reference: { kind: 'swing', price: lvl }, stage: 'confirmed', score: 1.0, triggeredAt: now,
          text: `${lvl.toLocaleString('ja-JP')} ${word}を形成(${note})`,
        });
      }

      // ダブル天井/大底(double, 長周期): 約60秒に1回。谷差は不問、本物のWはネック突出度で判定。forming/confirmed。
      if (now - lastSwingCheck >= SWING_DOUBLE_CHECK_MS) {
        lastSwingCheck = now;
        const longBars = getRecentBars(db, SYMBOL, now - SWING_LOOKBACK_DAYS * DAY_MS).map(b => ({ t: b.t, h: b.h, l: b.l }));
        const sd = detectSwingDouble(extractSwingPivots(longBars, SWING_PIVOT_RECLAIM_YEN), latest.price, DEFAULT_SWING_DOUBLE);
        if (sd) {
          const neck = Math.round(sd.neck);
          const yen = (v: number): string => Math.round(v).toLocaleString('ja-JP');
          const [g1, g2] = sd.legs;
          const name = sd.kind === 'bottom' ? 'ダブルボトム' : 'ダブルトップ';
          const word = sd.kind === 'bottom' ? '上抜け' : '下抜け';
          const watch = sd.kind === 'bottom' ? '上抜けで上昇期待' : '下抜けで下落警戒';
          const legLabel = sd.kind === 'bottom' ? '谷' : '山';
          const text = sd.stage === 'breakout'
            ? `${name}成立 — ネック${yen(neck)}円を${word}(${legLabel}${yen(g1)}/${yen(g2)})目標≈${yen(sd.target)}`
            : `${name}形成 — ネック${yen(neck)}円(${legLabel}${yen(g1)}→${yen(g2)})。${watch}`;
          signals.push({
            type: 'double', direction: sd.kind === 'bottom' ? 'up' : 'down', reference: { kind: 'neck', price: neck },
            stage: sd.stage === 'breakout' ? 'confirmed' : 'forming',
            score: sd.stage === 'breakout' ? 1.5 : 1.0, triggeredAt: now, text,
          });
        }
      }

      // 集約(同方向・近接基準を1本化しコンフルエンス加点)→ クールダウン → emit。
      // break/level_sr/pivot は「価格ゾーン×方向」共有クールダウン(同水準帯の S/R/抜け 連発を1本化)。double は別管理。
      for (const a of aggregateSignals(signals, DEFAULT_AGGREGATE)) {
        const ck = a.type === 'double'
          ? `double@${Math.round(a.reference.price / 5) * 5}#${a.stage ?? ''}`
          : `${a.direction}@${Math.round(a.reference.price / LEVEL_MERGE_YEN) * LEVEL_MERGE_YEN}`;
        const cd = a.type === 'double' ? DOUBLE_COOLDOWN_MS : ZONE_COOLDOWN_MS;
        if (now - (lastEmit.get(ck) ?? -Infinity) <= cd) continue;
        lastEmit.set(ck, now);
        if (a.types.includes('break')) lastBreakDir.set(a.direction, now);   // 階段状連発の方向別抑制を更新
        console.log(`[levelsLoop] signal ${a.type} ${a.direction} @${Math.round(a.reference.price)} score=${a.score.toFixed(2)}`
          + `${a.types.length > 1 ? ` conf[${a.types.join(',')}]` : ''}`);
        emitAlert({
          symbol: SYMBOL, symbolLabel: '日経225先物',
          changePercent: 0, windowSeconds: 60, detectionKind: a.type,
          direction: a.direction, triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
          level: Math.round(a.reference.price), note: a.text,
          referenceKind: a.reference.kind, referencePrice: Math.round(a.reference.price),
        });
      }
    } catch (err) {
      console.warn('[levelsLoop] signal detect failed:', err instanceof Error ? err.message : err);
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
