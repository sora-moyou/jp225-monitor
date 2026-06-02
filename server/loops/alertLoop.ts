import { fetchMinuteBars, type Bar } from '../correlation.js';
import { DEFAULT_PARAMS } from '../alertDetector.js';
import { emitAlert } from '../alertHistory.js';
import { INSTRUMENTS } from '../config.js';
import { getRealtimeBars, isRealtimeBarsReady } from '../feedBars.js';
import { evaluateBarsNiy, evaluateRealtimeNiy } from '../alertEngine.js';

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

    // 検知ロジックは sink ベースの alertEngine に委譲。sink = emitAlert (SSE + DB)。
    evaluateBarsNiy(bars, meta, DEFAULT_PARAMS, now, emitAlert);
  }
}

// v0.3.33: 短期検知のリアルタイム化。分足の確定を待たず、priceLoop の毎 tick(~2秒) に
// 呼ばれ、リアルタイム buffer の 60秒(burst)/5分(trend) ローリング窓で z 評価して即発火する。
// baseline σ は分足から(緩変なので毎分更新で十分)、最新リターンだけ実時間ローリング窓を使う。
// v0.3.35: 横断確認は廃止。日経自身の z(+静寂前提) のみ。クールダウン共有で 60秒バー版と
// 二重発火しない(先に鳴った方が他をロックする)。feed 断などローリング不可時は何もしない。
export function evaluateRealtime(): void {
  const sym = 'NIY=F';
  const meta = META_BY_SYM.get(sym);
  if (!meta) return;
  const bars = barsFor(sym);
  evaluateRealtimeNiy(bars, meta, DEFAULT_PARAMS, Date.now(), emitAlert);
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
