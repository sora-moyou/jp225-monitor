import { fetchMinuteBars, type Bar } from '../correlation.js';
import {
  detectBurst, detectTrend, computeContext, returns, stdDev,
  type AlertEvent, type CrossSnapshot,
} from '../alertDetector.js';
import { broadcast } from '../sse/broker.js';
import { INSTRUMENTS } from '../config.js';
import { isOnCooldown, markFired } from '../alertCooldown.js';
import { getRealtimeBars, isRealtimeBarsReady } from '../feedBars.js';

// v0.3.17: 1min ごとに全銘柄の 1m bars を取得 → adaptive z-score 検知 → SSE で alert ブロードキャスト。
// 旧 changeDetector (client side, fixed-% threshold) を全置換。

const POLL_MS = 60 * 1000;
const CROSS_REQUIRED = new Set(['NIY=F', 'NQ=F', 'YM=F', 'ES=F', 'JPY=X']);  // 指数・FX のみ横断確認必須

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
// これで日経(NIY=F)の z-score も横断確認(NQ/YM/JPY)も同じ実時間軸で評価できる。
function barsFor(symbol: string): Bar[] {
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
