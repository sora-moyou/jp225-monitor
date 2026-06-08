import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getSessionOHLC, getLatestTick, getRecentBars, getVolumeBars } from '../db/store.js';
import { computeVolumeProfile } from '../volumeProfile.js';
import { computeCongestionProfile } from '../congestionProfile.js';
import { computeTrendLines } from '../trendLines.js';
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
import { computeDailyBands, dailyCloseSeries, type DailyBand } from '../dailyBand.js';
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
// ── 反応水準(v0.6.12): 実トレード同様「1時間足/3時間足のスイング」から求める。1分足クラスタは
// ノイズが多い(微細な反応が並ぶ)ため、上位足にリサンプルしてスイング高安を抽出→クラスタ化して
// 反応回数を数える。高位足のスイングは session高安/Fib に一致し、意味ある S/R になる。約60秒ごと再計算。
const REACTION_CHECK_MS = 60_000;
const REACTION_LOOKBACK_DAYS = 5;
const REACTION_RECLAIM_1H = 120;    // 1時間足スイングの戻り幅(主要な1Hスイングのみ)
const REACTION_RECLAIM_3H = 200;    // 3時間足スイングの戻り幅
const REACTION_CLUSTER_YEN = 30;    // 同一水準帯に束ねる許容
const REACTION_MIN = 2;             // 1H/3H 合わせて2回以上スイング点になった帯のみ採用
let lastReactionCheck = 0;
let reactionLevels: { price: number; reactions: number }[] = [];
// ── 価格帯別出来高(v0.6.13): 厚い出来高帯(HVN)/POC を durable な S/R 候補に。出来高は基礎データ(週次)
// 由来のため過去ぶんのみ。週次更新で十分(HVNは数週間で大きく動かない)。重い集計は30分ごとに1回。
const VOLUME_CHECK_MS = 30 * 60_000;
const VOLUME_LOOKBACK_DAYS = 40;   // 基礎データの出来高期間に届く長さ
const VOLUME_BIN_YEN = 50;
let lastVolumeCheck = 0;
let volumeLevels: { price: number; rel: number; isPoc: boolean }[] = [];
// ── もみ合い帯(v0.6.14): 出来高フィードが無い直近の需給を「時間滞在(在足数)」で近似する次善指標。
// 直近1営業日のライブ足から往復しつつ停滞した帯を抽出。出来高ループと同じく30分ごとに再計算。
const CONGESTION_CHECK_MS = 30 * 60_000;
const CONGESTION_LOOKBACK_MS = 24 * 60 * 60_000;   // 直近1日(ユーザー指定)
const CONGESTION_BIN_YEN = 50;
let lastCongestionCheck = 0;
let congestionLevels: { price: number; rel: number; visits: number }[] = [];
// ── 有効トレンドライン(v0.6.15): 1H/3H のスイング点から3点以上接触する斜め線を引き、now へ延長した
// 「今のライン価格」を節目化。ブレイクまで有効(ステートレス再計算)。重い探索は60秒ごとに1回。
const TREND_CHECK_MS = 60_000;
const TREND_LOOKBACK_DAYS = 15;   // 反応水準と同程度の期間からスイング点を取る
const TREND_CONFLUENCE_YEN = 40;  // 合流ゲート: ライン価格が水平の反応水準(2回以上)とこの距離内の線だけ採用
let lastTrendCheck = 0;
let trendlineLevels: { price: number; kind: 'support' | 'resistance'; touches: number }[] = [];
// ── 日足バンド(v0.6.17 → v0.6.22 リアルタイム化): 夜間セッション終値25本の MA25 ±1σ/±2σ の5水準。
// 現値がこの帯を抜け/反発したら dailyband アラートを直接 emit(crash 同様・集約は通さない)。
// v0.6.22: 最後の日足(進行中の夜間足)は確定を待たず現在値を終値とする。確定済み夜間終値の取得/フィルタは
// セッション境界でしか変わらないため約60秒キャッシュのままだが、現在値の追加とバンド算出は毎ティック実行する
// (= MA25/σ が現在値に合わせて毎ティック動く)。
const DAILYBAND_CHECK_MS = 60_000;
const DAILYBAND_COOLDOWN_MS = 20 * 60_000;   // ゾーン(40円刻み)×方向の発火クールダウン
let lastDailyBandCheck = 0;
let confirmedNightCloses: number[] = [];     // 確定済み夜間終値(古い→新しい、直近~30本)。60sキャッシュ。
let dailyBandLevels: DailyBand[] = [];        // 毎ティック再計算(confirmed24 + 現在値)。
const lastDailyBandEmit = new Map<string, number>();

/** 1分足を上位足(tfMs)のH/Lにリサンプル。スイング抽出用に {t,h,l} のみ返す。 */
function resampleHL(bars: { t: number; h: number; l: number }[], tfMs: number): { t: number; h: number; l: number }[] {
  const m = new Map<number, { t: number; h: number; l: number }>();
  for (const b of bars) {
    const k = Math.floor(b.t / tfMs) * tfMs;
    const e = m.get(k);
    if (e) { if (b.h > e.h) e.h = b.h; if (b.l < e.l) e.l = b.l; }
    else m.set(k, { t: k, h: b.h, l: b.l });
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

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
        // 1時間足・3時間足にリサンプルしてスイング高安を抽出(実トレードで1H/3Hにラインを引くのと同じ)。
        const piv = [
          ...extractSwingPivots(resampleHL(rb, 60 * 60_000), REACTION_RECLAIM_1H),
          ...extractSwingPivots(resampleHL(rb, 180 * 60_000), REACTION_RECLAIM_3H),
        ].map(p => p.price).sort((a, b) => a - b);
        const cl: { price: number; reactions: number }[] = [];
        for (const p of piv) {
          const c = cl.find(x => Math.abs(x.price - p) <= REACTION_CLUSTER_YEN);
          if (c) { c.price = (c.price * c.reactions + p) / (c.reactions + 1); c.reactions++; }
          else cl.push({ price: p, reactions: 1 });
        }
        reactionLevels = cl.filter(c => c.reactions >= REACTION_MIN).map(c => ({ price: Math.round(c.price), reactions: c.reactions }));
      } catch (err) { console.warn('[levelsLoop] reaction levels failed:', err instanceof Error ? err.message : err); }
    }
    // 価格帯別出来高(HVN/POC)を約30分ごとに再計算してキャッシュ(出来高は基礎データ由来=週次更新)。
    if (now - lastVolumeCheck >= VOLUME_CHECK_MS) {
      lastVolumeCheck = now;
      try {
        const vb = getVolumeBars(db, SYMBOL, now - VOLUME_LOOKBACK_DAYS * DAY_MS);
        volumeLevels = computeVolumeProfile(vb, VOLUME_BIN_YEN).map(n => ({ price: n.price, rel: n.rel, isPoc: n.isPoc }));
      } catch (err) { console.warn('[levelsLoop] volume profile failed:', err instanceof Error ? err.message : err); }
    }
    // もみ合い帯(直近1日の時間滞在=出来高の次善)を約30分ごとに再計算してキャッシュ。
    if (now - lastCongestionCheck >= CONGESTION_CHECK_MS) {
      lastCongestionCheck = now;
      try {
        const cb = getRecentBars(db, SYMBOL, now - CONGESTION_LOOKBACK_MS).map(b => ({ t: b.t, h: b.h, l: b.l }));
        congestionLevels = computeCongestionProfile(cb, CONGESTION_BIN_YEN).map(n => ({ price: n.price, rel: n.rel, visits: n.visits }));
      } catch (err) { console.warn('[levelsLoop] congestion profile failed:', err instanceof Error ? err.message : err); }
    }
    // 有効トレンドライン(3点接触の斜め支持/抵抗線)を約60秒ごとに再計算。1H/3H のスイング点から探索。
    if (now - lastTrendCheck >= TREND_CHECK_MS) {
      lastTrendCheck = now;
      try {
        const tb = getRecentBars(db, SYMBOL, now - TREND_LOOKBACK_DAYS * DAY_MS).map(b => ({ t: b.t, h: b.h, l: b.l }));
        const tpiv = [
          ...extractSwingPivots(resampleHL(tb, 60 * 60_000), REACTION_RECLAIM_1H),
          ...extractSwingPivots(resampleHL(tb, 180 * 60_000), REACTION_RECLAIM_3H),
        ];
        // 合流ゲート(v0.6.16・バックテスト検証): 単独の3点ラインは乱択並み(+2〜3pt)だが、確定価格が
        // 水平の反応水準(2回以上反転した実S/R)と重なる線だけは反発率が明確に高い(非合流比 +9〜12pt)。
        // よって reactionLevels(=スイング点2回以上の集積)と ±TREND_CONFLUENCE_YEN で重なる線のみ採用。
        trendlineLevels = computeTrendLines(tpiv, latest.price, now)
          .filter(t => reactionLevels.some(r => Math.abs(r.price - t.priceNow) <= TREND_CONFLUENCE_YEN))
          .map(t => ({ price: t.priceNow, kind: t.kind, touches: t.touches }));
      } catch (err) { console.warn('[levelsLoop] trend lines failed:', err instanceof Error ? err.message : err); }
    }
    // 日足バンド(MA25 ±1σ/±2σ)。日足=夜間セッション、終値=各夜間クローズ。
    // 確定済み夜間終値の取得/フィルタは約60秒キャッシュ(セッション境界でしか変わらない)。
    // v0.6.22: 進行中の夜間足は EXCLUDE し、代わりに現在値を「進行中日足の終値」として扱う。
    if (now - lastDailyBandCheck >= DAILYBAND_CHECK_MS || confirmedNightCloses.length === 0) {
      lastDailyBandCheck = now;
      try {
        const nights = getSessionOHLC(db, SYMBOL, 60)
          .filter(s => s.session === 'Night')
          .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));   // 古い→新しい
        // 今が夜間セッション中なら、getSessionOHLC が返す最新の夜間足は「進行中(未確定)」なので除外する
        // (これは現在値で代表される)。それ以外は全て確定済み。
        const inNight = cs?.session === 'Night';
        const confirmed = inNight ? nights.slice(0, -1) : nights;
        confirmedNightCloses = confirmed.slice(-30).map(s => s.close);
      } catch (err) { console.warn('[levelsLoop] daily bands (confirmed closes) failed:', err instanceof Error ? err.message : err); }
    }
    // バンド算出は毎ティック(現在値を進行中日足の終値として append し MA25/σ を再計算)。
    dailyBandLevels = confirmedNightCloses.length >= 24
      ? computeDailyBands(dailyCloseSeries(confirmedNightCloses, latest.price))
      : [];
    const tCompute = Date.now();
    const result = computeLevels(sessions, latest.price, now, cs, extra, reactionLevels, volumeLevels, congestionLevels, trendlineLevels);
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
    // ── 日足バンド検知(dailyband): MA25 ±1σ/±2σ の5水準で水準抜け/反発を評価し直接 emit(集約は通さない)──
    try {
      if (dailyBandLevels.length > 0) {
        const sinceT = now - RECENT_BARS_MIN * 60_000;
        const recent = getRecentBars(db, SYMBOL, sinceT).map(b => ({ t: b.t, h: b.h, l: b.l }));
        const bandLevelList = dailyBandLevels.map(b => ({ price: b.price, label: 'daily ' + b.label }));
        const refKindOf = (price: number): DailyBand['refKind'] =>
          dailyBandLevels.find(b => b.price === price)?.refKind ?? 'ma25';
        const emitBand = (price: number, direction: 'up' | 'down', refKind: DailyBand['refKind'], note: string): void => {
          const key = `${direction}@${Math.round(price / 40) * 40}`;
          if (now - (lastDailyBandEmit.get(key) ?? -Infinity) <= DAILYBAND_COOLDOWN_MS) return;
          lastDailyBandEmit.set(key, now);
          console.log(`[levelsLoop] dailyband ${direction} @${Math.round(price)} (${refKind})`);
          emitAlert({
            symbol: SYMBOL, symbolLabel: '日経225先物',
            changePercent: 0, windowSeconds: 60, detectionKind: 'dailyband', direction,
            triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
            level: Math.round(price), note,
            referenceKind: refKind, referencePrice: Math.round(price),
          });
        };
        // 水準抜け(break)
        for (const bsig of detectLevelBreak(bandLevelList, recent, latest.price)) {
          const price = Math.round(bsig.level);
          const refKind = refKindOf(bsig.level);
          const label = bsig.label.replace(/^daily /, '');
          const dirWord = bsig.kind === 'up' ? '上抜け' : '下抜け';
          emitBand(price, bsig.kind, refKind, `日足${label} ${price.toLocaleString('ja-JP')}を${dirWord}`);
        }
        // 反発(support/resistance)
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
      console.warn('[levelsLoop] dailyband detect failed:', err instanceof Error ? err.message : err);
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
