import { fetchMinuteBars, type Bar } from '../correlation.js';
import {
  detectBurst, detectTrend, computeContext, returns, returns5m, stdDev,
  DEFAULT_PARAMS, type DetectorParams, type AlertEvent, type CrossSnapshot,
} from '../alertDetector.js';
import { broadcast } from '../sse/broker.js';
import { INSTRUMENTS } from '../config.js';
import { isOnCooldown, markFired } from '../alertCooldown.js';
import { getRealtimeBars, isRealtimeBarsReady, getRollingReturn } from '../feedBars.js';

// v0.3.17: 1min ごとに全銘柄の 1m bars を取得 → adaptive z-score 検知 → SSE で alert ブロードキャスト。
// 旧 changeDetector (client side, fixed-% threshold) を全置換。

const POLL_MS = 60 * 1000;
// v0.3.32: 横断確認に香港ハンセン(^HSI)を追加し、ES=F を外す。東京寄りで米株先物が
// 夜間閑散でも、アジア時間にリアルタイムで動くハンセンで日経急騰の裏取りができる。
const CROSS_REQUIRED = new Set(['NIY=F', 'NQ=F', 'YM=F', '^HSI', 'JPY=X']);  // 指数・FX のみ横断確認必須

// instrument label のルックアップ
const META_BY_SYM = new Map(INSTRUMENTS.map(i => [i.symbol as string, i]));
const SYMBOLS = INSTRUMENTS.map(i => i.symbol as string);

const barsCache = new Map<string, Bar[]>();

let timer: NodeJS.Timeout | null = null;
let running = false;

export function getCachedBars(symbol: string): Bar[] {
  return barsCache.get(symbol) ?? [];
}

// v0.3.31: 評価に使う 1m bars。リアルタイム feed バーが溜まっていればそれを、
// ウォームアップ中は Yahoo 分足を返す。系列は混ぜず全リアルタイム or 全 Yahoo。
// これで日経(NIY=F)の z-score も横断確認(NQ/YM/HSI/JPY)も同じ実時間軸で評価できる。
// v0.3.32: 相関ループ・AIチャット文脈でも同じ実時間優先ロジックを使えるよう export。
export function barsFor(symbol: string): Bar[] {
  return isRealtimeBarsReady(symbol) ? getRealtimeBars(symbol) : (barsCache.get(symbol) ?? []);
}

async function refreshAllBars(): Promise<void> {
  await Promise.all(SYMBOLS.map(async (sym) => {
    try {
      const bars = await fetchMinuteBars(sym);
      if (bars.length > 0) barsCache.set(sym, bars);
    } catch (err) {
      console.warn(`[alertLoop] ${sym} fetch failed:`, err instanceof Error ? err.message : err);
    }
  }));
}

function buildCrossSnapshot(): CrossSnapshot {
  const latestReturn = new Map<string, number>();
  const baselineSigma = new Map<string, number>();
  for (const sym of SYMBOLS) {
    const bars = barsFor(sym);   // リアルタイム足優先 (横断確認の時間軸を日経に揃える)
    if (bars.length < 62) continue;
    const baseline = bars.slice(-61, -1);
    const r = returns(baseline);
    if (r.length < 10) continue;
    baselineSigma.set(sym, stdDev(r));
    const prev = bars[bars.length - 2]!.close;
    const cur = bars[bars.length - 1]!.close;
    if (prev > 0) latestReturn.set(sym, (cur - prev) / prev);
  }
  return { latestReturn, baselineSigma };
}

function evaluateAndFire(): void {
  const cross = buildCrossSnapshot();
  const now = Date.now();

  for (const sym of SYMBOLS) {
    // v0.3.19: アラートは日経225先物のみ。他銘柄は分足取得のみ続け、AI 説明の元ネタ専用。
    if (sym !== 'NIY=F') continue;
    // v0.3.30/31: NIY=F はリアルタイム OSE バーが溜まればそれで z-score 評価。
    // ウォームアップ中(起動〜約65分)は Yahoo(CME, 約10分遅延) 分足にフォールバック。
    const bars = barsFor(sym);
    if (!bars || bars.length < 65) continue;

    if (isOnCooldown(sym, now)) continue;

    const meta = META_BY_SYM.get(sym);
    if (!meta) continue;
    const crossRequired = CROSS_REQUIRED.has(sym);

    // burst (1m) 優先
    const burst = detectBurst(sym, bars, crossRequired, cross);
    let result: { z: number; latestRet: number; kind: 'slope' | 'magnitude'; windowSec: number } | null = null;
    if (burst) result = { ...burst, kind: 'slope', windowSec: 60 };
    else {
      const trend = detectTrend(sym, bars, crossRequired, cross);
      if (trend) result = { ...trend, kind: 'magnitude', windowSec: 300 };
    }
    if (!result) continue;

    const { pa15min, change15min, range1h } = computeContext(bars);
    const lastBarT = bars[bars.length - 1]!.t;
    const alert: AlertEvent = {
      symbol: sym,
      symbolLabel: meta.labelJa,
      changePercent: result.latestRet * 100,
      windowSeconds: result.windowSec,
      detectionKind: result.kind,
      direction: result.latestRet >= 0 ? 'up' : 'down',
      triggeredAt: lastBarT,
      change15min,
      pa15min,
      range1h,
      zscore: result.z,
    };

    markFired(sym, now);
    console.log(`[alertLoop] ${sym} ${alert.detectionKind} ${alert.direction} ${alert.changePercent.toFixed(3)}% (|z|=${result.z.toFixed(2)})`);
    broadcast({ type: 'alert', payload: alert });
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

// NIY=F の横断確認: cross の中で |z|>=crossZMin かつ同方向の他資産が1つでもあれば true。
function crossConfirms(latestRet: number, cross: CrossSnapshot, P: DetectorParams): boolean {
  const dir = latestRet >= 0 ? 'up' : 'down';
  for (const cs of CROSS_REQUIRED) {
    if (cs === 'NIY=F') continue;
    const csRet = cross.latestReturn.get(cs);
    const csSig = cross.baselineSigma.get(cs);
    if (csRet === undefined || csSig === undefined || csSig <= 0) continue;
    if (Math.abs(csRet) / csSig < P.crossZMin) continue;
    if ((csRet >= 0 ? 'up' : 'down') === dir) return true;
  }
  return false;
}

// v0.3.33: 短期検知のリアルタイム化。分足の確定を待たず、priceLoop の毎 tick(~2秒) に
// 呼ばれ、リアルタイム buffer の 60秒(burst)/5分(trend) ローリング窓で z 評価して即発火する。
// baseline σ は分足から(緩変なので毎分更新で十分)、最新リターンだけ実時間ローリング窓を使う。
// 横断確認は buildCrossSnapshot(実時間1分足ベース、方向確認用)。クールダウン共有で 60秒経路の
// バー版と二重発火しない(先に鳴った方が他をロックする)。feed 断などローリング不可時は何もしない
// (従来の 60秒バー版がフォールバックとして残る)。
export function evaluateRealtime(): void {
  const sym = 'NIY=F';
  const now = Date.now();
  if (isOnCooldown(sym, now)) return;
  const meta = META_BY_SYM.get(sym);
  if (!meta) return;
  const bars = barsFor(sym);
  const P = DEFAULT_PARAMS;
  if (bars.length < P.baselineLookback + 1) return;
  const baselineReturns = returns(bars.slice(-(P.baselineLookback + 1), -1));
  if (baselineReturns.length < 10) return;
  const sigma1 = stdDev(baselineReturns);
  if (sigma1 <= 0) return;

  const cross = buildCrossSnapshot();
  let result: { z: number; latestRet: number; kind: 'slope' | 'magnitude'; windowSec: number } | null = null;

  // burst (リアルタイム 60秒ローリング) 優先。静寂前提 + 横断確認は bar 版 detectBurst と同条件。
  const ret60 = getRollingReturn(60_000, sym);
  if (ret60 !== null) {
    const z = Math.abs(ret60) / sigma1;
    const recent = baselineReturns.slice(-P.quietLookback);
    const quietOk = recent.length >= P.quietLookback && median(recent.map(Math.abs)) < sigma1 * P.quietMedianRatio;
    if (z >= P.zThreshold && quietOk && crossConfirms(ret60, cross, P)) {
      result = { z, latestRet: ret60, kind: 'slope', windowSec: 60 };
    }
  }
  // trend (リアルタイム 5分ローリング)。静寂前提は省略 (bar 版 detectTrend と同様)。
  if (!result) {
    const r5 = returns5m(bars);
    const ret300 = getRollingReturn(300_000, sym);
    if (r5.length >= 11 && ret300 !== null) {
      const sigma5 = stdDev(r5.slice(0, -1));
      const z = sigma5 > 0 ? Math.abs(ret300) / sigma5 : 0;
      if (sigma5 > 0 && z >= P.zThreshold && crossConfirms(ret300, cross, P)) {
        result = { z, latestRet: ret300, kind: 'magnitude', windowSec: 300 };
      }
    }
  }
  if (!result) return;

  const { pa15min, change15min, range1h } = computeContext(bars);
  const alert: AlertEvent = {
    symbol: sym,
    symbolLabel: meta.labelJa,
    changePercent: result.latestRet * 100,
    windowSeconds: result.windowSec,
    detectionKind: result.kind,
    direction: result.latestRet >= 0 ? 'up' : 'down',
    triggeredAt: now,
    change15min, pa15min, range1h,
    zscore: result.z,
  };
  markFired(sym, now);
  console.log(`[alertLoop:rt] ${sym} ${result.kind} ${alert.direction} ${alert.changePercent.toFixed(3)}% (|z|=${result.z.toFixed(2)})`);
  broadcast({ type: 'alert', payload: alert });
}

async function tick(): Promise<void> {
  try {
    await refreshAllBars();
    evaluateAndFire();
  } catch (err) {
    console.error('[alertLoop] tick error:', err instanceof Error ? err.message : err);
  }
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(async () => { await tick(); schedule(); }, POLL_MS);
}

export function startAlertLoop(): void {
  if (running) return;
  running = true;
  void tick();
  schedule();
}

export function stopAlertLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}
