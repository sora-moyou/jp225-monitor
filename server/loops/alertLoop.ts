import { fetchMinuteBars, type Bar } from '../correlation.js';
import {
  detectBurst, detectTrend, computeContext, returns, returns5m, stdDev,
  DEFAULT_PARAMS, type AlertEvent,
} from '../alertDetector.js';
import { emitAlert } from '../alertHistory.js';
import { detectGranvilleReversal, detectGranvilleContinuation } from '../granville.js';
import { INSTRUMENTS } from '../config.js';
import { canFire, markFired } from '../alertCooldown.js';
import { getRealtimeBars, isRealtimeBarsReady, getRollingReturn } from '../feedBars.js';

// v0.3.17: 1min ごとに全銘柄の 1m bars を取得 → adaptive z-score 検知 → SSE で alert ブロードキャスト。
// v0.3.35: 横断確認(他資産の同方向確認)を全面廃止。日経自身の z-score(+静寂前提) のみで発火。

const POLL_MS = 60 * 1000;

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

function evaluateAndFire(): void {
  const now = Date.now();

  for (const sym of SYMBOLS) {
    // v0.3.19: アラートは日経225先物のみ。他銘柄は分足取得のみ続け、AI 説明の元ネタ専用。
    if (sym !== 'NIY=F') continue;
    // v0.3.30/31: NIY=F はリアルタイム OSE バーが溜まればそれで z-score 評価。
    // ウォームアップ中(起動〜約65分)は Yahoo(CME, 約10分遅延) 分足にフォールバック。
    const bars = barsFor(sym);
    if (!bars || bars.length < 65) continue;

    const meta = META_BY_SYM.get(sym);
    if (!meta) continue;

    // グランビル(MA(75本)ベース)。①転換、②③継続(戻り売り/押し目買い)。日経のみ・共有クールダウン使用。
    // 先に評価し、発火したらこのtickの burst/trend は同方向で抑制される。
    if (sym === 'NIY=F') {
      const closes = bars.map(b => b.close);
      const rev = detectGranvilleReversal(closes);
      const cont = detectGranvilleContinuation(closes);
      const g = rev
        ? { sig: rev, note: `グランビル${rev.dir === 'up' ? '買い' : '売り'}転換` }
        : cont
          ? { sig: cont, note: cont.dir === 'up' ? 'グランビル押し目買い' : 'グランビル戻り売り' }
          : null;
      const gPrice = bars[bars.length - 1]!.close;
      if (g && canFire(sym, g.sig.dir, gPrice, now)) {
        const ctx = computeContext(bars);
        markFired(sym, g.sig.dir, gPrice, now);
        console.log(`[alertLoop] ${sym} ${g.note} dev=${g.sig.deviation.toFixed(2)}% (MA=${Math.round(g.sig.ma)})`);
        emitAlert({
          symbol: sym,
          symbolLabel: meta.labelJa,
          changePercent: g.sig.deviation,
          windowSeconds: 75 * 60,
          detectionKind: 'granville',
          direction: g.sig.dir,
          triggeredAt: bars[bars.length - 1]!.t,
          change15min: ctx.change15min,
          pa15min: ctx.pa15min,
          range1h: ctx.range1h,
          zscore: 0,
          note: g.note,
        });
      }
    }

    // burst (1m) 優先、無ければ trend (5m, 長期)。両方とも考慮する。(v0.3.35: 横断確認なし)
    const burst = detectBurst(bars);
    let result: { z: number; latestRet: number; kind: 'slope' | 'magnitude'; windowSec: number } | null = null;
    if (burst) result = { ...burst, kind: 'slope', windowSec: 60 };
    else {
      const trend = detectTrend(bars);
      if (trend) result = { ...trend, kind: 'magnitude', windowSec: 300 };
    }
    if (!result) continue;

    const dir = result.latestRet >= 0 ? 'up' : 'down';
    const curPrice = bars[bars.length - 1]!.close;
    if (!canFire(sym, dir, curPrice, now)) continue;   // 共有クールダウン (逆方向は起点越えで解禁)

    const { pa15min, change15min, range1h } = computeContext(bars);
    const alert: AlertEvent = {
      symbol: sym,
      symbolLabel: meta.labelJa + (result.windowSec === 60 ? ' (短期1分)' : ' (長期5分)'),
      changePercent: result.latestRet * 100,
      windowSeconds: result.windowSec,
      detectionKind: result.kind,
      direction: dir,
      triggeredAt: bars[bars.length - 1]!.t,
      change15min,
      pa15min,
      range1h,
      zscore: result.z,
    };

    markFired(sym, dir, curPrice, now);
    console.log(`[alertLoop] ${sym} ${alert.detectionKind} ${dir} ${alert.changePercent.toFixed(3)}% (|z|=${result.z.toFixed(2)})`);
    emitAlert(alert);
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

// v0.3.33: 短期検知のリアルタイム化。分足の確定を待たず、priceLoop の毎 tick(~2秒) に
// 呼ばれ、リアルタイム buffer の 60秒(burst)/5分(trend) ローリング窓で z 評価して即発火する。
// baseline σ は分足から(緩変なので毎分更新で十分)、最新リターンだけ実時間ローリング窓を使う。
// v0.3.35: 横断確認は廃止。日経自身の z(+静寂前提) のみ。クールダウン共有で 60秒バー版と
// 二重発火しない(先に鳴った方が他をロックする)。feed 断などローリング不可時は何もしない。
export function evaluateRealtime(): void {
  const sym = 'NIY=F';
  const now = Date.now();
  const meta = META_BY_SYM.get(sym);
  if (!meta) return;
  const bars = barsFor(sym);
  const P = DEFAULT_PARAMS;
  if (bars.length < P.baselineLookback + 1) return;
  const baselineReturns = returns(bars.slice(-(P.baselineLookback + 1), -1));
  if (baselineReturns.length < 10) return;
  const sigma1 = stdDev(baselineReturns);
  if (sigma1 <= 0) return;

  let result: { z: number; latestRet: number; kind: 'slope' | 'magnitude'; windowSec: number } | null = null;

  // burst (リアルタイム 60秒ローリング) 優先。静寂前提は bar 版 detectBurst と同条件。
  const ret60 = getRollingReturn(60_000, sym);
  if (ret60 !== null) {
    const z = Math.abs(ret60) / sigma1;
    const recent = baselineReturns.slice(-P.quietLookback);
    const quietOk = recent.length >= P.quietLookback && median(recent.map(Math.abs)) < sigma1 * P.quietMedianRatio;
    if (z >= P.zThreshold && quietOk) {
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
      if (sigma5 > 0 && z >= P.zThreshold) {
        result = { z, latestRet: ret300, kind: 'magnitude', windowSec: 300 };
      }
    }
  }
  if (!result) return;

  const dir = result.latestRet >= 0 ? 'up' : 'down';
  const curPrice = bars[bars.length - 1]!.close;
  if (!canFire(sym, dir, curPrice, now)) return;   // 共有クールダウン (逆方向は起点越えで解禁)

  const { pa15min, change15min, range1h } = computeContext(bars);
  const alert: AlertEvent = {
    symbol: sym,
    symbolLabel: meta.labelJa + (result.windowSec === 60 ? ' (短期1分)' : ' (長期5分)'),
    changePercent: result.latestRet * 100,
    windowSeconds: result.windowSec,
    detectionKind: result.kind,
    direction: dir,
    triggeredAt: now,
    change15min, pa15min, range1h,
    zscore: result.z,
  };
  markFired(sym, dir, curPrice, now);
  console.log(`[alertLoop:rt] ${sym} ${result.kind} ${dir} ${alert.changePercent.toFixed(3)}% (|z|=${result.z.toFixed(2)})`);
  emitAlert(alert);
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
