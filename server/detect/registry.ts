// 検知ワイヤリングの一元化(STEP 6)。
//
// 目的: 検知器(detector)の呼び出し・cooldown/dedup 状態・emit ルーティングを 1 箇所に集約する。
// 検知器そのもののアルゴリズムは変更しない(levelBreak/levelHold/swingDouble/granville/shock/dailyBand は
// 従来どおり純関数)。ここが変えるのは「配線」だけ:
//   ・emit を inline の emitAlert ではなく **注入された AlertSink(コールバック)** に流す。
//   ・cooldown/dedup 状態を module singleton ではなく **consumer ごとの state bundle** に持たせる
//     (server=levelsLoop と collector が同一プロセスで走っても相互に発火を抑制し合わない=設計レビュー必須修正)。
//
// consumer は 2 つ:
//   ・server(levelsLoop): runLevelDetectors(sink=emitAlert)。levels の SSE broadcast は levelsLoop 側に残す。
//   ・collector(alertCollector): runBarDetectors + runLevelDetectors(sink=DB 記録)。
//
// ★DB への記録(alerts)は「両方の consumer が検知するが、書くのは1つだけ」。collector 稼働中は
//   collector が authoritative writer で、monitor 側は SSE(バナー)だけ出して記録しない
//   (判定は server/alertHistory.ts の monitorPersistMode / MONITOR_ONLY_KINDS が唯一の権威)。
//   ここに検知種別を足すときは、それが monitor 専用でない限り MONITOR_ONLY_KINDS には足さないこと。
//
// crash は本モジュールに含めない: server(levelsLoop 内 inline)・collector(checkCrash)ともに独自の
// セッション高値シード経路を持ち、既に別実装。二重 emit を避けるため crash は各 consumer 側に残す。

import type { DatabaseSync } from 'node:sqlite';
import {
  getSessionOHLC, getLatestTick, getRecentBars, getVolumeBars, getDailyCloses, upsertDailyClose,
  type SessionOHLC, type Tick,
} from '../db/store.js';
import { collectRecentBars } from '../barsSource.js';
import { computeVolumeProfile } from '../volumeProfile.js';
import { computeCongestionProfile } from '../congestionProfile.js';
import { computeTrendLines } from '../trendLines.js';
import { computeLevels, type LevelsResult } from '../levels.js';
import { classifySession, type SessionInfo } from '../../core/session.js';
import { getForecastSnapshot } from '../loops/forecastLoop.js';
import { detectLevelBreak, type BreakSignal } from '../levelBreak.js';
import { detectLevelHold } from '../levelHold.js';
import { extractSwingPivots } from '../swingPivots.js';
import { detectSwingDouble, DEFAULT_SWING_DOUBLE } from '../swingDouble.js';
import { detectNWave, nwaveLevelCandidates, type NWave } from '../nwave.js';
import { aggregateSignals, DEFAULT_AGGREGATE, recentMomentumDir } from '../signals/aggregate.js';
import { computeDailyBands, computeDailyMAs, dailyCloseSeries, DAILY_CLOSES_KEEP, DAILYBAND_FETCH_SESSIONS, type DailyBand, type DailyMA } from '../dailyBand.js';
import type { AlertSignal } from '../signals/types.js';
import {
  resolveLevelsConfig, resolveBreakScore, resolveDoubleFormingEnabled, resolveSlopeConfluenceBonus,
  resolveNwaveEnabled, resolveNwaveMinSwingYen, resolveBandwalkEnabled, resolveEffectiveScalpBias,
  resolveShockParams,
} from '../configStore.js';
import {
  buildBandwalkSamples, evaluateBandwalk, describeBandwalk, shouldFireBandwalk,
  createBandwalkFireState, DEFAULT_BANDWALK, type BandwalkFireState,
} from '../bandwalk.js';
import {
  aggregate5m, aggregateBars, buildBarBandLookup, buildSqueezeSnapshot,
  type SqueezeSnapshot, type SqueezeState,
} from '../indicators.js';
import { SQUEEZE_BW_LOOKBACK } from '../../core/indicatorSpec.js';
import { evaluateBarsNiy, createBarDetectState, type BarDetectState, type AlertSink } from '../alertEngine.js';
import { DEFAULT_PARAMS, type DetectorParams } from '../alertDetector.js';
import type { InstrumentMeta } from '../types.js';
import type { Bar } from '../correlation.js';

export type { AlertSink, BarDetectState };
export { createBarDetectState };

const SYMBOL = 'NIY=F';
const SYMBOL_LABEL = '日経225先物';
// 取得セッション数: 直近高安2(可変) / 20Sフィボ / 長期高安 を賄える数 + 余裕。
const fetchSessionsFor = (lookback: number, lookback2: number): number => Math.max(lookback, lookback2, 20) + 4;

// ── L2(価格系)検知のチューニング定数(旧 levelsLoop から集約・値は不変)──
const RECENT_BARS_MIN = 90;
// ★スイング形成(pivot)の鮮度上限: 極値が今から この時間より前 のピボットは「今 形成」ではないので出さない
//   (90分窓の古い端に残る確定ピボットが再起動等で誤発火するのを防ぐ・seed と二重の保険)。
const PIVOT_FRESH_MS = 40 * 60_000;
const BREAK_DIR_COOLDOWN_MS = 20 * 60_000;
const ZONE_COOLDOWN_MS = 20 * 60_000;
const DOUBLE_COOLDOWN_MS = 30 * 60_000;
// 最新tickがこれ以上古い(収集停止/復帰中)なら stale な価格で誤発火させない。
export const DETECT_FRESH_MS = 90_000;
const PIVOT_RECLAIM_PCT = 0.003;
const LEVEL_MERGE_YEN = 40;
const PIVOT_FORMED_MIN_PCT = 0.005;
const SWING_DOUBLE_CHECK_MS = 60_000;
// ★N波動(値幅観測論): 節目/アラートとも主要スイング(swingDouble と同じ抽出)から算出。約60秒間引き +
//   方向×round(B) の 30 分クールダウン(別の B は即再発火・同一 B は30分ごとに再アラート)。
// ★バンドウォーク用の1分足の取得窓。indicatorsLoop / scalpContext / scalpPlanRunner と **同じ6時間**に
//   合わせる(同じ足・同じ算出経路にしないと「アラートは成立・AI文脈は非成立」の食い違いが起きる)。
const BANDWALK_BARS_WINDOW_MS = 6 * 60 * 60_000;
// ★スクイーズ/バルジ用の足の窓は **7日**(indicatorsLoop の SQUEEZE_BARS_WINDOW_MS と同じ理由・同じ値)。
//   判定には確定5分足が SQUEEZE_BW_LOOKBACK + (SQUEEZE_BB_PERIOD−1) 本(BW の先頭欠測ぶん)必要で、
//   バンドウォークと同じ6時間窓では5分足が最大72本しか作れず ready は永久に false(=判定が死ぬ)。
//   ★参照本数を下げても窓は7日のまま(6時間窓で作れる最大72本では必要本数に届かない)。
const SQUEEZE_BARS_WINDOW_MS = 7 * 24 * 60 * 60_000;
const SQUEEZE_TF_MS = 5 * 60_000;
// ★7日ぶんの1分足の読み直しは重い。5分足が1本閉じるまで入力は1本も増えない=結果も必ず同じなので、
//   「5分の枠が変わったとき」だけ読む(実質5分に1回)。SETTLE は直前の1分足が DB/ライブ足に載る猶予。
const SQUEEZE_SETTLE_MS = 20_000;
// ★同種別の再発火クールダウン(30分)。実測(NIY=F 5分足 38,624本・193日・参照本数72のとき)では
//   状態に入る足が 5.9回/日、状態は最長19本(=95分)張り付く。入った足で1回だけ(squeezeEdge)に加えて
//   これを置かないと、同じ収縮局面で出たり入ったりする度に鳴る(実データの否定対照: 状態の足を
//   全部鳴らすと 32.0回/日 → エッジ+この30分で 7.3回/日)。★参照本数を動かすと発火数も動く。
const SQUEEZE_COOLDOWN_MS = 30 * 60_000;
// ── スクイーズ/バルジ **後の抜け**(squeeze_break / bulge_break)──────────────────────────
// ★緩衝5円: 呼値が5円。節目ちょうど(高値そのもの)に置くと、同じ値を1ティック触っただけで鳴る
//   (既存の検知が「節目ちょうどには置かない」流儀なのと同じ理由)。呼値1つぶん外へずらす。
const SQUEEZE_BREAK_BUFFER_YEN = 5;
// ★有効期限60分(ユーザー確定)。根拠: この検知が言いたいのは「収縮/拡大の **直後** に、その足の
//   レンジをどちらへ外したか」であって、何時間も経ってからの通過ではない。判定足は5分足なので
//   60分 = その足12本ぶん。これを外すと、水準が一日中生き続けて「ずっと前のスクイーズの高値を
//   たまたま今超えた」だけの通過が鳴る(否定対照: 期限を外すと発火数が増える)。
const SQUEEZE_BREAK_EXPIRE_MS = 60 * 60_000;
const NWAVE_CHECK_MS = 60_000;
const NWAVE_COOLDOWN_MS = 30 * 60_000;
const SWING_LOOKBACK_DAYS = 4;
const SWING_PIVOT_RECLAIM_PCT = 0.008;
const SWING_DOUBLE_TF_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const REACTION_CHECK_MS = 60_000;
const REACTION_LOOKBACK_DAYS = 5;
const REACTION_RECLAIM_1H_PCT = 0.003;
const REACTION_RECLAIM_3H_PCT = 0.005;
const REACTION_CLUSTER_YEN = 30;
const REACTION_MIN = 2;
const VOLUME_CHECK_MS = 30 * 60_000;
const VOLUME_LOOKBACK_DAYS = 40;
const VOLUME_BIN_YEN = 50;
const CONGESTION_CHECK_MS = 30 * 60_000;
const CONGESTION_LOOKBACK_MS = 24 * 60 * 60_000;
const CONGESTION_BIN_YEN = 50;
const TREND_CHECK_MS = 60_000;
const TREND_LOOKBACK_DAYS = 15;
const TREND_CONFLUENCE_YEN = 40;
const DAILYBAND_CHECK_MS = 60_000;
const DAILYBAND_COOLDOWN_MS = 20 * 60_000;
// ★v0.9.98: この2つは server/dailyBand.ts へ移した(AI 文脈と共有する SSOT・値は不変)。

/** 価格比(%)→円。スイング/節目の閾値を現値に追従させる。 */
export function yenPct(price: number, pct: number): number {
  return Math.max(1, Math.round(price * pct));
}

// L2(価格系)検知のチューニング定数を一括 export。発火頻度の事前監査ツール(scripts/alert-audit.mts)が
// 同じ値で実データ・リプレイできるようにする(定数のドリフト=乱発バグの再発を防ぐ)。
export const LEVELS_TUNING = {
  recentBarsMin: RECENT_BARS_MIN, levelMergeYen: LEVEL_MERGE_YEN,
  pivotReclaimPct: PIVOT_RECLAIM_PCT, pivotFormedMinPct: PIVOT_FORMED_MIN_PCT, swingPivotReclaimPct: SWING_PIVOT_RECLAIM_PCT,
  reactionReclaim1hPct: REACTION_RECLAIM_1H_PCT, reactionReclaim3hPct: REACTION_RECLAIM_3H_PCT,
  swingLookbackDays: SWING_LOOKBACK_DAYS, swingDoubleTfMs: SWING_DOUBLE_TF_MS, zoneCooldownMs: ZONE_COOLDOWN_MS, doubleCooldownMs: DOUBLE_COOLDOWN_MS,
  breakDirCooldownMs: BREAK_DIR_COOLDOWN_MS,
} as const;

/** 1分足を上位足(tfMs)のH/Lにリサンプル。スイング抽出用に {t,h,l} のみ返す。 */
export function resampleHL(bars: { t: number; h: number; l: number }[], tfMs: number): { t: number; h: number; l: number }[] {
  const m = new Map<number, { t: number; h: number; l: number }>();
  for (const b of bars) {
    const k = Math.floor(b.t / tfMs) * tfMs;
    const e = m.get(k);
    if (e) { if (b.h > e.h) e.h = b.h; if (b.l < e.l) e.l = b.l; }
    else m.set(k, { t: k, h: b.h, l: b.l });
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/**
 * 確定 Day 終値(進行中の日は含めない)を daily_closes へ永続化し、日足MA/バンド用の終値系列(古い→新しい)を返す。
 * export はテスト(空DBでもバンドが空にならない回帰)用。副作用(upsert)あり。
 */
export function persistAndResolveDailyCloses(
  database: DatabaseSync, symbol: string,
  confirmed: { sessionDate: string; close: number; openT: number }[], keep: number,
): number[] {
  for (const d of confirmed.slice(-keep)) upsertDailyClose(database, symbol, d.sessionDate, d.close, d.openT);
  const durableCloses = getDailyCloses(database, symbol, keep).map(r => r.close);
  const fallbackCloses = confirmed.map(s => s.close);
  return (durableCloses.length >= fallbackCloses.length ? durableCloses : fallbackCloses).slice(-keep);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  per-consumer 状態(factory)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** レベル検知の consumer ごとの状態。**解析キャッシュ**(reaction/volume/congestion/trend/dailyband・重い再計算を
 *  間引くタイマ付き)と **検知器の cooldown/dedup**(break 方向別/ゾーン共有/pivot/swing/dailyband/dailyMa)を保持。
 *  server(levelsLoop)と collector が別インスタンスを持ち、互いの発火を抑制し合わない。 */
export interface LevelDetectState {
  // 解析キャッシュ(computeLevelAnalytics)
  lastReactionCheck: number;
  reactionLevels: { price: number; reactions: number }[];
  lastVolumeCheck: number;
  volumeLevels: { price: number; rel: number; isPoc: boolean }[];
  lastCongestionCheck: number;
  congestionLevels: { price: number; rel: number; visits: number }[];
  lastTrendCheck: number;
  trendlineLevels: { price: number; kind: 'support' | 'resistance'; touches: number }[];
  // ★N波動: 直近の確認済み N 波(節目投影 + アラート発火に共用)と、その未到達目標の節目候補をキャッシュ。
  lastNwaveCheck: number;
  nwave: NWave | null;
  nwaveLevels: { price: number; label: string }[];
  lastDailyBandCheck: number;
  confirmedDailyCloses: number[];
  // 検知器 cooldown/dedup(runLevelDetectors)
  lastBreakDir: Map<'up' | 'down', number>;
  lastEmit: Map<string, number>;
  lastPivotT: number;
  pivotSeeded: boolean;   // ★起動時に既存の確定ピボットを「既知」化したか(再起動で古いピボットが『形成』と誤発火するのを防ぐ)。
  lastSwingCheck: number;
  lastNwaveFire: Map<string, number>;   // ★N波動アラートの方向×round(B) の30分クールダウン(別Bは即再発火・同一Bは30分毎)。
  // ★バンドウォーク: 直近に判定した確定5分足・成立中の向き・方向別クールダウン(server/bandwalk.ts)。
  bandwalk: BandwalkFireState;
  // ★スクイーズ/バルジ: 直近に読んだ5分枠・判定済みの確定足・直前の状態(下の squeezeFire)。
  squeeze: SqueezeFireState;
  lastDailyBandEmit: Map<string, number>;
  lastDailyMaEmit: Map<string, number>;
}

/** consumer ごとの新しいレベル検知状態を生成。 */
export function createLevelDetectState(): LevelDetectState {
  return {
    lastReactionCheck: 0, reactionLevels: [],
    lastVolumeCheck: 0, volumeLevels: [],
    lastCongestionCheck: 0, congestionLevels: [],
    lastTrendCheck: 0, trendlineLevels: [],
    lastNwaveCheck: 0, nwave: null, nwaveLevels: [],
    lastDailyBandCheck: 0, confirmedDailyCloses: [],
    lastBreakDir: new Map(), lastEmit: new Map(), lastPivotT: 0, pivotSeeded: false, lastSwingCheck: 0,
    lastNwaveFire: new Map(),
    bandwalk: createBandwalkFireState(),
    squeeze: createSqueezeFireState(),
    lastDailyBandEmit: new Map(), lastDailyMaEmit: new Map(),
  };
}

/** consumer ごとの全検知状態(bar + level)。 */
export interface DetectorState { bar: BarDetectState; level: LevelDetectState; }
export function createDetectorState(): DetectorState {
  return { bar: createBarDetectState(), level: createLevelDetectState() };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  bar 検知(shock/trend/ma_sr)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** 確定1分足からの bar 検知(shock/trend/ma_sr)を state を使って実行し sink に流す。
 *  検知ロジックは alertEngine.evaluateBarsNiy そのまま(WIRING のみ集約)。 */
export function runBarDetectors(
  bars: Bar[], meta: InstrumentMeta, now: number, sink: AlertSink,
  state: BarDetectState, params: DetectorParams = DEFAULT_PARAMS,
): void {
  evaluateBarsNiy(bars, meta, params, now, sink, state);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  level 解析(SSE/検知の共通入力)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** level 検知の入力一式(SSE broadcast 用の result も含む)。 */
export interface LevelAnalytics {
  result: LevelsResult;
  latest: Tick;
  sessions: SessionOHLC[];
  cs: SessionInfo | null;
  dailyBandLevels: DailyBand[];
  dailyMaLevels: DailyMA[];
  nwave?: NWave | null;   // ★直近の確認済み N 波(nwave アラート発火用・未確認/OFF は null）
  dbMs: number;
  computeMs: number;
}

/** 反応水準・出来高・もみ合い・トレンドライン・日足バンド/MA を(state のキャッシュを使い間引きつつ)算出し、
 *  computeLevels の result まで返す。levelsLoop / collector が共通で使う重い解析。最新 tick が無ければ null。 */
export function computeLevelAnalytics(db: DatabaseSync, now: number, state: LevelDetectState): LevelAnalytics | null {
  const latest = getLatestTick(db, SYMBOL);
  if (!latest) return null;
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
  if (now - state.lastReactionCheck >= REACTION_CHECK_MS) {
    state.lastReactionCheck = now;
    try {
      const rb = getRecentBars(db, SYMBOL, now - REACTION_LOOKBACK_DAYS * DAY_MS).map(b => ({ t: b.t, h: b.h, l: b.l }));
      const piv = [
        ...extractSwingPivots(resampleHL(rb, 60 * 60_000), yenPct(latest.price, REACTION_RECLAIM_1H_PCT)),
        ...extractSwingPivots(resampleHL(rb, 180 * 60_000), yenPct(latest.price, REACTION_RECLAIM_3H_PCT)),
      ].map(p => p.price).sort((a, b) => a - b);
      const cl: { price: number; reactions: number }[] = [];
      for (const p of piv) {
        const c = cl.find(x => Math.abs(x.price - p) <= REACTION_CLUSTER_YEN);
        if (c) { c.price = (c.price * c.reactions + p) / (c.reactions + 1); c.reactions++; }
        else cl.push({ price: p, reactions: 1 });
      }
      state.reactionLevels = cl.filter(c => c.reactions >= REACTION_MIN).map(c => ({ price: Math.round(c.price), reactions: c.reactions }));
    } catch (err) { console.warn('[detect] reaction levels failed:', err instanceof Error ? err.message : err); }
  }
  // 価格帯別出来高(HVN/POC)を約30分ごとに再計算してキャッシュ(出来高は基礎データ由来=週次更新)。
  if (now - state.lastVolumeCheck >= VOLUME_CHECK_MS) {
    state.lastVolumeCheck = now;
    try {
      const vb = getVolumeBars(db, SYMBOL, now - VOLUME_LOOKBACK_DAYS * DAY_MS);
      state.volumeLevels = computeVolumeProfile(vb, VOLUME_BIN_YEN).map(n => ({ price: n.price, rel: n.rel, isPoc: n.isPoc }));
    } catch (err) { console.warn('[detect] volume profile failed:', err instanceof Error ? err.message : err); }
  }
  // もみ合い帯(直近1日の時間滞在=出来高の次善)を約30分ごとに再計算してキャッシュ。
  if (now - state.lastCongestionCheck >= CONGESTION_CHECK_MS) {
    state.lastCongestionCheck = now;
    try {
      const cb = getRecentBars(db, SYMBOL, now - CONGESTION_LOOKBACK_MS).map(b => ({ t: b.t, h: b.h, l: b.l }));
      state.congestionLevels = computeCongestionProfile(cb, CONGESTION_BIN_YEN).map(n => ({ price: n.price, rel: n.rel, visits: n.visits }));
    } catch (err) { console.warn('[detect] congestion profile failed:', err instanceof Error ? err.message : err); }
  }
  // 有効トレンドライン(3点接触の斜め支持/抵抗線)を約60秒ごとに再計算。1H/3H のスイング点から探索。
  if (now - state.lastTrendCheck >= TREND_CHECK_MS) {
    state.lastTrendCheck = now;
    try {
      const tb = getRecentBars(db, SYMBOL, now - TREND_LOOKBACK_DAYS * DAY_MS).map(b => ({ t: b.t, h: b.h, l: b.l }));
      const tpiv = [
        ...extractSwingPivots(resampleHL(tb, 60 * 60_000), yenPct(latest.price, REACTION_RECLAIM_1H_PCT)),
        ...extractSwingPivots(resampleHL(tb, 180 * 60_000), yenPct(latest.price, REACTION_RECLAIM_3H_PCT)),
      ];
      state.trendlineLevels = computeTrendLines(tpiv, latest.price, now)
        .filter(t => state.reactionLevels.some(r => Math.abs(r.price - t.priceNow) <= TREND_CONFLUENCE_YEN))
        .map(t => ({ price: t.priceNow, kind: t.kind, touches: t.touches }));
    } catch (err) { console.warn('[detect] trend lines failed:', err instanceof Error ? err.message : err); }
  }
  // N波動(値幅観測論)を約60秒ごとに再計算してキャッシュ。swingDouble と同じ主要スイング抽出
  // (4日窓・5分足・reclaim 0.8%)から末尾3ピボットで A→B→C を判定し、確認済み(B 抜け)なら未到達の
  // N値/V値/E値を節目候補にする。OFF(resolveNwaveEnabled=false)なら空にする。
  if (now - state.lastNwaveCheck >= NWAVE_CHECK_MS) {
    state.lastNwaveCheck = now;
    try {
      if (resolveNwaveEnabled()) {
        const nb = getRecentBars(db, SYMBOL, now - SWING_LOOKBACK_DAYS * DAY_MS).map(b => ({ t: b.t, h: b.h, l: b.l }));
        const npiv = extractSwingPivots(resampleHL(nb, SWING_DOUBLE_TF_MS), yenPct(latest.price, SWING_PIVOT_RECLAIM_PCT));
        const nw = detectNWave(npiv, latest.price, resolveNwaveMinSwingYen());
        state.nwave = nw;
        state.nwaveLevels = nw ? nwaveLevelCandidates(nw, latest.price) : [];
      } else {
        state.nwave = null; state.nwaveLevels = [];
      }
    } catch (err) { console.warn('[detect] nwave failed:', err instanceof Error ? err.message : err); }
  }
  // 日足バンド用の確定終値(進行中の取引日を除外)を約60秒キャッシュ。
  if (now - state.lastDailyBandCheck >= DAILYBAND_CHECK_MS || state.confirmedDailyCloses.length === 0) {
    state.lastDailyBandCheck = now;
    try {
      const days = getSessionOHLC(db, SYMBOL, DAILYBAND_FETCH_SESSIONS)
        .filter(s => s.session === 'Day')
        .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
      const inDay = cs?.session === 'Day';
      const confirmed = inDay ? days.slice(0, -1) : days;
      state.confirmedDailyCloses = persistAndResolveDailyCloses(db, SYMBOL, confirmed, DAILY_CLOSES_KEEP);
    } catch (err) { console.warn('[detect] daily bands (confirmed closes) failed:', err instanceof Error ? err.message : err); }
  }
  // バンド算出は毎ティック(現在値を進行中取引日の終値として append し MA25/σ を再計算)。
  const dailyBandLevels = state.confirmedDailyCloses.length >= 24
    ? computeDailyBands(dailyCloseSeries(state.confirmedDailyCloses, latest.price))
    : [];
  const dailyMaLevels = computeDailyMAs(dailyCloseSeries(state.confirmedDailyCloses, latest.price, 75));
  const tCompute = Date.now();
  const result = computeLevels(sessions, latest.price, now, cs, extra, state.reactionLevels, state.volumeLevels, state.congestionLevels, state.trendlineLevels, state.nwaveLevels);
  const computeMs = Date.now() - tCompute;
  return { result, latest, sessions, cs, dailyBandLevels, dailyMaLevels, nwave: state.nwave, dbMs, computeMs };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  スクイーズ/バルジ(squeeze/bulge)の発火判定 — 純関数(SSOT)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// 状態そのもの(BW <= BWlow / BW >= BWhigh)の定義は server/indicators.ts が SSOT。ここが決めるのは
// 「その状態を **いつ アラートとして出すか**」だけ:
//   ①状態に入った足で1回だけ(squeezeEdge)。②同種別は 30分 再発火しない(SQUEEZE_COOLDOWN_MS)。
//   ③ready が false(参照本数 SQUEEZE_BW_LOOKBACK 本が未充足)の間は絶対に出さない。

/** スクイーズ/バルジが鳴った確定5分足の「その後の抜け」を見張る対象。
 *  ★1つの事象につき **上抜け1回・下抜け1回まで**(往復したら両方鳴る = それが情報)。
 *  ★新しいスクイーズ/バルジが鳴ったら、この watch ごと差し替える(前の事象は終了)。 */
export interface SqueezeBreakWatch {
  /** どちらの事象の後か(アラート文と種別 squeeze_break / bulge_break を決める)。 */
  kind: 'squeeze' | 'bulge';
  /** 発火した確定5分足の高値/安値(緩衝を足す前の素の水準。アラート文にはこの値を出す)。 */
  high: number;
  low: number;
  /** 有効期限の起点(= 親アラートを鳴らした時刻)。 */
  firedAt: number;
  /** 既に鳴らしたか(方向ごとに1回まで)。 */
  upDone: boolean;
  downDone: boolean;
}

/** スクイーズ/バルジの発火状態。slot=直近に7日窓を読んだ5分枠 / lastBarT=判定済みの確定足 / prev=直前の状態 /
 *  watch=直近の事象の「その後の抜け」見張り(null=見張り無し)。 */
export interface SqueezeFireState { slot: number; lastBarT: number; prev: SqueezeState; watch: SqueezeBreakWatch | null }
export function createSqueezeFireState(): SqueezeFireState { return { slot: 0, lastBarT: 0, prev: null, watch: null }; }

/** ★状態に **入った足** だけを返す(非 null かつ 直前と違うとき)。それ以外は null。
 *  ・null → squeeze … 発火(入った)
 *  ・squeeze → squeeze … 発火しない(同じ状態が続く間は板を埋めない)
 *  ・squeeze → bulge … 発火する(別の状態に入った)
 *  ・squeeze → null … 発火しない(状態から **抜けた** ことは通知しない) */
export function squeezeEdge(prev: SqueezeState, next: SqueezeState): SqueezeState {
  return next !== null && prev !== next ? next : null;
}

/** 確定足のスナップショットから「今 鳴らすべきか」を決め、state を更新する(副作用は state のみ)。
 *  戻り値 = 鳴らす種別('squeeze'|'bulge') / null = 鳴らさない。
 *
 *  ★同じ確定足では二度評価しない(snap.t が進んだときだけ)。7日窓の読み直しを間引いても、
 *    間引きの位相ずれで同じ足を二度評価して二度鳴らすことが無いようにするため。
 *  ★ready:false の間は状態を **null 扱い** にする(本数不足の窓は最大/最小が数本で決まるので、
 *    毎朝かならず squeeze か bulge になる=無意味な発火)。snap.state は buildSqueezeSnapshot が
 *    既に null にしているが、ここでも落とす(発火の入口で ready を見る責任を持たせる)。
 *  ★クールダウンは既存の state.lastEmit に相乗り(キー 'squeeze:<種別>'。既存キーは
 *    'up@69120' / 'double@...' 形式なので衝突しない)。 */
export function squeezeFire(
  state: LevelDetectState, snap: SqueezeSnapshot, now: number, cooldownMs: number = SQUEEZE_COOLDOWN_MS,
): SqueezeState {
  const t = snap.t;
  if (t == null || !(t > state.squeeze.lastBarT)) return null;   // 新しい確定足が無い
  state.squeeze.lastBarT = t;
  const next: SqueezeState = snap.ready ? snap.state : null;
  const fired = squeezeEdge(state.squeeze.prev, next);
  // ★prev は発火の可否に関わらず更新する(クールダウンで抑えた回も「状態は移った」)。
  state.squeeze.prev = next;
  if (fired === null) return null;
  const key = `squeeze:${fired}`;
  if (now - (state.lastEmit.get(key) ?? -Infinity) <= cooldownMs) return null;
  state.lastEmit.set(key, now);
  return fired;
}

/** アラート文(監査ツールと本番で同じ文言を出すための SSOT)。
 *  ★本数は SQUEEZE_BW_LOOKBACK から組み立てる(定数は動く。文言に数字を焼き付けない)。
 *  例(参照72本のとき): `スクイーズ — BB幅が72本の最小(BW 0.14 / 高安 0.82/0.14) 69,120円` */
export function describeSqueeze(kind: 'squeeze' | 'bulge', snap: SqueezeSnapshot, price: number): string {
  const n = (v: number | null): string => (v == null ? '—' : v.toFixed(2));
  const name = kind === 'squeeze' ? 'スクイーズ' : 'バルジ';
  const word = kind === 'squeeze' ? '最小' : '最大';
  return `${name} — BB幅が${SQUEEZE_BW_LOOKBACK}本の${word}(BW ${n(snap.bw)} / 高安 ${n(snap.bwHigh)}/${n(snap.bwLow)})`
    + ` ${Math.round(price).toLocaleString('ja-JP')}円`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  スクイーズ/バルジ **後の抜け**(squeeze_break / bulge_break)— 純関数(SSOT)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// 親(squeeze/bulge)が鳴った確定5分足の高安を水準として覚え、以降のティックで現値と照合するだけ。
//   ①上抜け = 現値 >  その足の高値 + SQUEEZE_BREAK_BUFFER_YEN
//   ②下抜け = 現値 <  その足の安値 − SQUEEZE_BREAK_BUFFER_YEN
//   ③1事象につき 上1回・下1回まで(往復は両方鳴る)。④SQUEEZE_BREAK_EXPIRE_MS を過ぎたら見張りを捨てる。
//   ⑤新しい親が鳴ったら見張りごと差し替え(前の事象は終了)。
// ★売買はしない(表示・記録のみ)。エンジン(server/signalTrade/**)はこの種別を一切見ない。

/** 検知種別。親の kind から導出する(対応表の手書きコピーを2箇所に置かない)。 */
export function squeezeBreakKind(kind: 'squeeze' | 'bulge'): 'squeeze_break' | 'bulge_break' {
  return kind === 'squeeze' ? 'squeeze_break' : 'bulge_break';
}

/** 親が鳴った確定足から見張りを作る(新しい事象は常に前の事象を置き換える)。 */
export function makeSqueezeBreakWatch(
  kind: 'squeeze' | 'bulge', bar: { h: number; l: number }, firedAt: number,
): SqueezeBreakWatch {
  return { kind, high: bar.h, low: bar.l, firedAt, upDone: false, downDone: false };
}

/** 現値を見張りと照合し、鳴らすべきなら発火情報を返す(state.squeeze.watch を更新する)。
 *  戻り値 null = 鳴らさない。★上下は同時に成立しない(high >= low かつ緩衝は正)ので1ティック1件。 */
export function squeezeBreakFire(
  state: LevelDetectState, price: number, now: number,
  bufferYen: number = SQUEEZE_BREAK_BUFFER_YEN, expireMs: number = SQUEEZE_BREAK_EXPIRE_MS,
): { kind: 'squeeze' | 'bulge'; direction: 'up' | 'down'; level: number } | null {
  const w = state.squeeze.watch;
  if (!w) return null;
  // ★期限切れは見張りごと捨てる(以後この事象では二度と鳴らない)。
  if (now - w.firedAt > expireMs) { state.squeeze.watch = null; return null; }
  if (!w.upDone && price > w.high + bufferYen) { w.upDone = true; return { kind: w.kind, direction: 'up', level: w.high }; }
  if (!w.downDone && price < w.low - bufferYen) { w.downDone = true; return { kind: w.kind, direction: 'down', level: w.low }; }
  return null;
}

/** アラート文(監査ツールと本番で同じ文言を出すための SSOT)。水準と現値の **両方** を出す。
 *  例: `スクイーズ後の上抜け — 62,495円(スクイーズ足の高値 62,490 を突破)` */
export function describeSqueezeBreak(
  kind: 'squeeze' | 'bulge', direction: 'up' | 'down', level: number, price: number,
): string {
  const yen = (v: number): string => Math.round(v).toLocaleString('ja-JP');
  const name = kind === 'squeeze' ? 'スクイーズ' : 'バルジ';
  const dirWord = direction === 'up' ? '上抜け' : '下抜け';
  const hl = direction === 'up' ? '高値' : '安値';
  const verb = direction === 'up' ? '突破' : '割り込み';
  return `${name}後の${dirWord} — ${yen(price)}円(${name}足の${hl} ${yen(level)} を${verb})`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  level 検知(break/level_sr/pivot/double + dailyband + dailyMa)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** computeLevelAnalytics の出力から level 系検知器を実行し sink に流す。crash はここに含めない(各 consumer 側)。
 *  cooldown/dedup は state に閉じ込め、consumer 間で相互抑制しない。 */
export function runLevelDetectors(
  db: DatabaseSync, a: LevelAnalytics, now: number, state: LevelDetectState, sink: AlertSink,
): void {
  const { result, latest } = a;
  // ── L2 価格系シグナル(double / level_sr / break / pivot)を生成 → 集約 → emit ──
  try {
    const sinceT = now - RECENT_BARS_MIN * 60_000;
    const recentBars = getRecentBars(db, SYMBOL, sinceT);
    const recent = recentBars.map(b => ({ t: b.t, h: b.h, l: b.l }));
    const rawPivots = extractSwingPivots(recent, yenPct(latest.price, PIVOT_RECLAIM_PCT));
    const pivots = rawPivots.map(p => ({ price: p.price, label: p.kind === 'low' ? 'スイング安値' : 'スイング高値' }));
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

    // 水準抜け(break): 同方向は最外1本+方向別クールダウンで前置フィルタ。
    const breaks = detectLevelBreak(hlLevels, recent, latest.price);
    const outer = new Map<'up' | 'down', BreakSignal>();
    for (const b of breaks) {
      const cur = outer.get(b.kind);
      if (!cur || (b.kind === 'up' ? b.level > cur.level : b.level < cur.level)) outer.set(b.kind, b);
    }
    for (const bsig of outer.values()) {
      if (now - (state.lastBreakDir.get(bsig.kind) ?? -Infinity) <= BREAK_DIR_COOLDOWN_MS) continue;
      const lvl = Math.round(bsig.level);
      const dirWord = bsig.kind === 'up' ? '上抜け' : '下抜け';
      signals.push({
        // ★40日ライブ: break 継続方向のアルファ≈0pt。単独スコアを 1.2→0.9(既定・config化)に下げ、
        //   minScore=1 未満=単独では出さず、コンフルエンス(別種+0.5 で1.4)時のみ生かす。
        type: 'break', direction: bsig.kind, reference: { kind: 'level', price: lvl }, stage: 'confirmed',
        score: resolveBreakScore(), triggeredAt: now,
        text: `${lvl.toLocaleString('ja-JP')} ${bsig.label}を${dirWord}(水準抜けの可能性あり)`,
      });
    }

    // 水準サポート/レジスタンス(level_sr): 反発確認後。
    for (const h of detectLevelHold(hlLevels, recent, latest.price)) {
      const lvl = Math.round(h.level);
      const word = h.kind === 'support' ? 'サポート' : 'レジスタンス';
      signals.push({
        type: 'level_sr', direction: h.kind === 'support' ? 'up' : 'down',
        reference: { kind: 'level', price: lvl }, stage: 'confirmed', score: 1.1, triggeredAt: now,
        text: `${lvl.toLocaleString('ja-JP')} ${h.label}が${word}の可能性`,
      });
    }

    // スイング転換点の形成(pivot): 起動後に新しく確定したピボットが現れたら1回。
    const newest = rawPivots[rawPivots.length - 1];
    const prevPivot = rawPivots[rawPivots.length - 2];
    // ★起動直後(未seed)は、その時点で既に存在する確定ピボットを『既知』として基準化し発火しない。
    //   これが無いと再起動で lastPivotT=0 にリセットされ、90分窓に残る古い確定ピボット(生きた押し安値でない
    //   かなり前の極値)が『形成』として誤発火する(実バグ: 現値64,060付近なのに文中に 63,575 等の古い価格)。
    if (!state.pivotSeeded) {
      state.pivotSeeded = true;
      state.lastPivotT = newest ? newest.t : 0;
    } else if (newest && newest.t > state.lastPivotT
        && now - newest.t < PIVOT_FRESH_MS   // ★鮮度: 極値が古いピボットは「今 形成」ではないので出さない(保険)。
        && (!prevPivot || Math.abs(newest.price - prevPivot.price) >= yenPct(latest.price, PIVOT_FORMED_MIN_PCT))) {
      state.lastPivotT = newest.t;
      const lvl = Math.round(newest.price);
      const word = newest.kind === 'low' ? 'スイング安値' : 'スイング高値';
      const note = newest.kind === 'low' ? '押し安値の可能性' : '戻り高値の可能性';
      signals.push({
        type: 'pivot', direction: newest.kind === 'low' ? 'up' : 'down',
        reference: { kind: 'swing', price: lvl }, stage: 'confirmed', score: 1.0, triggeredAt: now,
        text: `${lvl.toLocaleString('ja-JP')} ${word}を形成(${note})`,
      });
    }

    // ダブル天井/大底(double, 長周期): 約60秒に1回。
    if (now - state.lastSwingCheck >= SWING_DOUBLE_CHECK_MS) {
      state.lastSwingCheck = now;
      // ★終値も持つ(第6章の帯条件に BB が要る)。resampleHL は h/l しか返さず終値を捨てるので
      //   aggregateBars(=indicators の SSOT)で 5分足へ集約する。h/l の作り方は resampleHL と同一
      //   なので、スイングピボット(=幾何)は従来と1円も変わらない。
      const longBars = getRecentBars(db, SYMBOL, now - SWING_LOOKBACK_DAYS * DAY_MS)
        .map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));
      const longBars5 = aggregateBars(longBars, SWING_DOUBLE_TF_MS);
      // ★帯の値は「その足の時点まで」で引く(未来を見ない)。列に無い足は null=判定できない→出さない。
      const bandAt = buildBarBandLookup(longBars5);
      const sd = detectSwingDouble(
        extractSwingPivots(longBars5, yenPct(latest.price, SWING_PIVOT_RECLAIM_PCT)), latest.price,
        piv => bandAt(piv.t, piv.price), DEFAULT_SWING_DOUBLE,
      );
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
        // ★40日ライブ: double は反転が効かない(形成通知の方向的中が低い)。
        //   既定は breakout(成立)のみ出す(forming は doubleFormingEnabled=true のときだけ)。
        //   breakout のスコアも 1.5→1.0 に減点(単独では他の 1.0 系と同格に扱う)。
        if (sd.stage === 'breakout' || resolveDoubleFormingEnabled()) {
          signals.push({
            type: 'double', direction: sd.kind === 'bottom' ? 'up' : 'down', reference: { kind: 'neck', price: neck },
            stage: sd.stage === 'breakout' ? 'confirmed' : 'forming',
            score: 1.0, triggeredAt: now, text,
          });
        }
      }
    }

    // 集約 → クールダウン → emit。
    // ★slope 方向一致ボーナス: 直近1分足のモメンタム向きを求め、同方向のクラスタへ加点(40日ライブ: slope +52pt)。
    const momentumDir = recentMomentumDir(recentBars.map(b => ({ t: b.t, c: b.c })));
    const aggParams = { ...DEFAULT_AGGREGATE, slopeConfluenceBonus: resolveSlopeConfluenceBonus() };
    for (const item of aggregateSignals(signals, aggParams, momentumDir)) {
      const ck = item.type === 'double'
        ? `double@${Math.round(item.reference.price / 5) * 5}#${item.stage ?? ''}`
        : `${item.direction}@${Math.round(item.reference.price / LEVEL_MERGE_YEN) * LEVEL_MERGE_YEN}`;
      const cd = item.type === 'double' ? DOUBLE_COOLDOWN_MS : ZONE_COOLDOWN_MS;
      if (now - (state.lastEmit.get(ck) ?? -Infinity) <= cd) continue;
      state.lastEmit.set(ck, now);
      if (item.types.includes('break')) state.lastBreakDir.set(item.direction, now);
      console.log(`[detect] signal ${item.type} ${item.direction} @${Math.round(item.reference.price)} score=${item.score.toFixed(2)}`
        + `${item.types.length > 1 ? ` conf[${item.types.join(',')}]` : ''}`);
      sink({
        symbol: SYMBOL, symbolLabel: SYMBOL_LABEL,
        changePercent: 0, windowSeconds: 60, detectionKind: item.type,
        direction: item.direction, triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
        level: Math.round(item.reference.price), note: item.text,
        referenceKind: item.reference.kind, referencePrice: Math.round(item.reference.price),
      });
    }
  } catch (err) {
    console.warn('[detect] signal detect failed:', err instanceof Error ? err.message : err);
  }
  // ── N波動確認(nwave): 値幅観測論。B 抜けで確認された N 波を「目標=V値(倍返し)」で通知。
  //    analytics で算出済みの N 波(a.nwave)をそのまま使う(節目と同一の波=乖離しない)。方向×round(B) の
  //    30 分クールダウン(double/dailyband と同機構): 別の B(=新しい波)は即再発火し、同一 B が続く間は
  //    30 分ごとに再アラートする(同一波の毎ティック連発だけを抑える)。
  try {
    const nw = a.nwave;
    if (nw) {
      const key = `${nw.direction}@${Math.round(nw.b)}`;
      if (now - (state.lastNwaveFire.get(key) ?? -Infinity) > NWAVE_COOLDOWN_MS) {
        state.lastNwaveFire.set(key, now);
        const yen = (v: number): string => Math.round(v).toLocaleString('ja-JP');
        const dirWord = nw.direction === 'up' ? '上昇' : '下降';
        const note = `${dirWord}N波を確認 目標V値 ${yen(nw.targets.V)}（A ${yen(nw.a)} / B ${yen(nw.b)} / C ${yen(nw.c)}）`;
        console.log(`[detect] nwave ${nw.direction} V=${Math.round(nw.targets.V)} (B=${Math.round(nw.b)})`);
        sink({
          symbol: SYMBOL, symbolLabel: SYMBOL_LABEL,
          changePercent: 0, windowSeconds: 60, detectionKind: 'nwave', direction: nw.direction,
          triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
          level: Math.round(nw.targets.V), note,
          referenceKind: 'nwave', referencePrice: Math.round(nw.targets.V),
        });
      }
    }
  } catch (err) {
    console.warn('[detect] nwave emit failed:', err instanceof Error ? err.message : err);
  }
  // ── バンドウォーク(bandwalk): BB±σ に沿った一方向の推移。判定は server/bandwalk.ts(純関数)が SSOT。
  //    ・確定した5分足が新しくなった時だけ評価する(同じ足で二度鳴らさない=間引きも兼ねる)。
  //    ・足は collectRecentBars(DB ∪ メモリ内ライブ足)。★ここだけ兄弟検知器(getRecentBars=DB のみ)と
  //      違うのは、この判定が **AI 文脈にも同じ内容で出る** ため。DB だけに繋いで collector 停止時に
  //      無音で死ぬ事故(v0.9.37)を繰り返さない。
  //    ・目線(scalpBias): 'long'=上のみ / 'short'=下のみ / 'none'(未設定/AI委任)=上下とも(ユーザー確定仕様)。
  try {
    if (resolveBandwalkEnabled()) {
      const bias = resolveEffectiveScalpBias();
      const bars1m = collectRecentBars(db, SYMBOL, now - BANDWALK_BARS_WINDOW_MS);
      const samples = buildBandwalkSamples(bars1m, DEFAULT_BANDWALK.windowBars, resolveShockParams());
      const lastT = samples.length > 0 ? samples[samples.length - 1]!.t : 0;
      if (lastT > state.bandwalk.lastBarT) {
        state.bandwalk.lastBarT = lastT;
        const bw = evaluateBandwalk(samples, bias, DEFAULT_BANDWALK);
        if (shouldFireBandwalk(state.bandwalk, bw, DEFAULT_BANDWALK) && bw) {
          const note = describeBandwalk(bw);
          console.log(`[detect] bandwalk ${bw.direction} ratio=${bw.ratio.toFixed(2)} bars=${bw.bars} band=${Math.round(bw.band)} bias=${bias}`);
          sink({
            symbol: SYMBOL, symbolLabel: SYMBOL_LABEL,
            changePercent: 0, windowSeconds: 60, detectionKind: 'bandwalk', direction: bw.direction,
            triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
            level: Math.round(bw.band), note,
            referenceKind: 'bb', referencePrice: Math.round(bw.band),
          });
        }
      }
    }
  } catch (err) {
    console.warn('[detect] bandwalk detect failed:', err instanceof Error ? err.message : err);
  }
  // ── スクイーズ/バルジ(squeeze/bulge): 5分足20本±2σ の BB幅が SQUEEZE_BW_LOOKBACK 本の最小/最大に達した足で1回だけ。
  //    ・状態の定義は server/indicators.ts(buildSqueezeSnapshot)、発火の可否は上の squeezeFire が SSOT。
  //    ・足は collectRecentBars(DB ∪ メモリ内ライブ足)= bandwalk と同じ流儀(collector 停止時に無音で死なない)。
  //    ・**方向を持たない検知**。payload の direction は必須項目なので 'up' を入れるが意味は無い
  //      (「収縮した/拡大した」は上下どちらへ動くかを語らない)。reference には確定足の終値を入れる。
  //    ・窓は7日(SQUEEZE_BARS_WINDOW_MS)と重いので、5分の枠が変わったときだけ読む。
  try {
    const slot = Math.floor((now - SQUEEZE_SETTLE_MS) / SQUEEZE_TF_MS);
    if (slot !== state.squeeze.slot) {
      state.squeeze.slot = slot;
      const bars5 = aggregate5m(collectRecentBars(db, SYMBOL, now - SQUEEZE_BARS_WINDOW_MS));
      const closed = bars5.slice(0, -1);   // 最後の1本は形成中なので使わない(確定足のみ)
      const snap = buildSqueezeSnapshot(closed.map(b => b.c), closed.map(b => b.t));
      const fired = squeezeFire(state, snap, now);
      const lastClosed = closed.length > 0 ? closed[closed.length - 1]! : null;
      const price = lastClosed ? lastClosed.c : null;
      if (fired !== null && lastClosed != null && price != null) {
        // ★「その後の抜け」の見張りを、この確定足の高安で張り直す(前の事象はここで終了)。
        state.squeeze.watch = makeSqueezeBreakWatch(fired, lastClosed, now);
        const note = describeSqueeze(fired, snap, price);
        console.log(`[detect] ${fired} bw=${snap.bw?.toFixed(2)} high/low=${snap.bwHigh?.toFixed(2)}/${snap.bwLow?.toFixed(2)} @${Math.round(price)}`);
        sink({
          symbol: SYMBOL, symbolLabel: SYMBOL_LABEL,
          changePercent: 0, windowSeconds: 60, detectionKind: fired, direction: 'up',
          triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
          level: Math.round(price), note,
          referenceKind: 'bb', referencePrice: Math.round(price),
        });
      }
    }
  } catch (err) {
    console.warn('[detect] squeeze detect failed:', err instanceof Error ? err.message : err);
  }
  // ── スクイーズ/バルジ後の抜け(squeeze_break / bulge_break)──────────────────────────────
  //    ★上の squeeze ブロックと違って **毎ティック** 評価する(5分の枠を待たない)。抜けは足の確定を
  //      待つ性質のものではなく、現値がその足の高安 ± 緩衝 を外した瞬間が中身だから。
  //    ・水準/期限/重複の規則は上の squeezeBreakFire が SSOT。売買はしない(表示・記録のみ)。
  try {
    const brk = squeezeBreakFire(state, latest.price, now);
    if (brk) {
      const note = describeSqueezeBreak(brk.kind, brk.direction, brk.level, latest.price);
      console.log(`[detect] ${squeezeBreakKind(brk.kind)} ${brk.direction} level=${Math.round(brk.level)} @${Math.round(latest.price)}`);
      sink({
        symbol: SYMBOL, symbolLabel: SYMBOL_LABEL,
        changePercent: 0, windowSeconds: 60, detectionKind: squeezeBreakKind(brk.kind), direction: brk.direction,
        triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
        level: Math.round(brk.level), note,
        referenceKind: 'level', referencePrice: Math.round(brk.level),
      });
    }
  } catch (err) {
    console.warn('[detect] squeeze break detect failed:', err instanceof Error ? err.message : err);
  }
  // ── 日足バンド検知(dailyband): MA25 ±1σ/±2σ の5水準で水準抜け/反発を評価し直接 emit(集約は通さない)──
  try {
    if (a.dailyBandLevels.length > 0) {
      const sinceT = now - RECENT_BARS_MIN * 60_000;
      const recent = getRecentBars(db, SYMBOL, sinceT).map(b => ({ t: b.t, h: b.h, l: b.l }));
      const bandLevelList = a.dailyBandLevels.map(b => ({ price: b.price, label: 'daily ' + b.label }));
      const refKindOf = (price: number): DailyBand['refKind'] =>
        a.dailyBandLevels.find(b => b.price === price)?.refKind ?? 'ma25';
      const emitBand = (price: number, direction: 'up' | 'down', refKind: DailyBand['refKind'], note: string): void => {
        const key = `${direction}@${Math.round(price / 40) * 40}`;
        if (now - (state.lastDailyBandEmit.get(key) ?? -Infinity) <= DAILYBAND_COOLDOWN_MS) return;
        state.lastDailyBandEmit.set(key, now);
        console.log(`[detect] dailyband ${direction} @${Math.round(price)} (${refKind})`);
        sink({
          symbol: SYMBOL, symbolLabel: SYMBOL_LABEL,
          changePercent: 0, windowSeconds: 60, detectionKind: 'dailyband', direction,
          triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
          level: Math.round(price), note,
          referenceKind: refKind, referencePrice: Math.round(price),
        });
      };
      for (const bsig of detectLevelBreak(bandLevelList, recent, latest.price)) {
        const price = Math.round(bsig.level);
        const refKind = refKindOf(bsig.level);
        const label = bsig.label.replace(/^daily /, '');
        const dirWord = bsig.kind === 'up' ? '上抜け' : '下抜け';
        emitBand(price, bsig.kind, refKind, `日足${label} ${price.toLocaleString('ja-JP')}を${dirWord}`);
      }
      for (const h of detectLevelHold(bandLevelList, recent, latest.price)) {
        const price = Math.round(h.level);
        const refKind = refKindOf(h.level);
        const label = h.label.replace(/^daily /, '');
        const direction = h.kind === 'support' ? 'up' : 'down';
        const word = h.kind === 'support' ? 'サポート' : 'レジスタンス';
        emitBand(price, direction, refKind, `日足${label} ${price.toLocaleString('ja-JP')}が${word}の可能性`);
      }
    }
  } catch (err) {
    console.warn('[detect] dailyband detect failed:', err instanceof Error ? err.message : err);
  }
  // ── 日足MA線検知(dailyMa): MA5/20/50/75 の各線で水準抜け/反発を評価し直接 emit(バンドと同機構・集約なし)──
  try {
    if (a.dailyMaLevels.length > 0) {
      const sinceT = now - RECENT_BARS_MIN * 60_000;
      const recent = getRecentBars(db, SYMBOL, sinceT).map(b => ({ t: b.t, h: b.h, l: b.l }));
      const maLevelList = a.dailyMaLevels.map(m => ({ price: m.price, label: m.label }));
      const emitMa = (price: number, direction: 'up' | 'down', label: string, note: string): void => {
        const key = `${direction}@${Math.round(price / 40) * 40}`;
        if (now - (state.lastDailyMaEmit.get(key) ?? -Infinity) <= DAILYBAND_COOLDOWN_MS) return;
        state.lastDailyMaEmit.set(key, now);
        console.log(`[detect] dailyma ${direction} @${Math.round(price)} (${label})`);
        sink({
          symbol: SYMBOL, symbolLabel: SYMBOL_LABEL,
          changePercent: 0, windowSeconds: 60, detectionKind: 'dailyband', direction,
          triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
          level: Math.round(price), note,
          referenceKind: label.toLowerCase(), referencePrice: Math.round(price),
        });
      };
      for (const bsig of detectLevelBreak(maLevelList, recent, latest.price)) {
        const price = Math.round(bsig.level);
        const dirWord = bsig.kind === 'up' ? '上抜け' : '下抜け';
        emitMa(price, bsig.kind, bsig.label, `日足${bsig.label} ${price.toLocaleString('ja-JP')}を${dirWord}`);
      }
      for (const h of detectLevelHold(maLevelList, recent, latest.price)) {
        const price = Math.round(h.level);
        const direction = h.kind === 'support' ? 'up' : 'down';
        const word = h.kind === 'support' ? 'サポート' : 'レジスタンス';
        emitMa(price, direction, h.label, `日足${h.label} ${price.toLocaleString('ja-JP')}が${word}の可能性`);
      }
    }
  } catch (err) {
    console.warn('[detect] dailyma detect failed:', err instanceof Error ? err.message : err);
  }
}
