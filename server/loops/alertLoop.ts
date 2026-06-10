import { fetchMinuteBars, type Bar } from '../correlation.js';
import { inPollWindow } from '../../collector/session.js';
import { DEFAULT_PARAMS } from '../alertDetector.js';
import { emitAlert } from '../alertHistory.js';
import { INSTRUMENTS } from '../config.js';
import { getRealtimeBars, isRealtimeBarsReady } from '../feedBars.js';
import { evaluateBarsNiy } from '../alertEngine.js';

// v0.3.17: 1min ごとに全銘柄の 1m bars を取得 → adaptive z-score 検知 → SSE で alert ブロードキャスト。
// v0.3.35: 横断確認(他資産の同方向確認)を全面廃止。日経自身の z-score(+静寂前提) のみで発火。

const POLL_MS = 60 * 1000;
// 鮮度ゲート: リアルタイム足の最新バーが現在から MAX_BAR_LAG_MS 以上遅れている(フィード停止→復帰中で
// 古い足が最新に見える状態)なら発火しない。これが無いと数分遅れの stale な急変/グランビルを出す。
const MAX_BAR_LAG_MS = 150_000;   // 2.5分(通常の足遅れ<60s + 余裕)

/** リアルタイム足が新鮮か(最新バー時刻が now から maxLagMs 以内)。純粋関数(テスト用)。 */
export function barsAreFresh(bars: Bar[], now: number, maxLagMs: number): boolean {
  if (bars.length === 0) return false;
  return now - bars[bars.length - 1]!.t <= maxLagMs;
}

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
    // フィード停止/復帰中の古い足では発火しない(数分遅れの stale なアラートを防ぐ)。
    if (!barsAreFresh(bars, now, MAX_BAR_LAG_MS)) {
      console.warn(`[alertLoop] ${sym} 足が遅延 (lag ${Math.round((now - bars[bars.length - 1]!.t) / 1000)}s) — フィード停止/復帰中とみなし発火しない`);
      continue;
    }

    const meta = META_BY_SYM.get(sym);
    if (!meta) continue;

    // 検知ロジックは sink ベースの alertEngine に委譲。sink = emitAlert (SSE + DB)。
    evaluateBarsNiy(bars, meta, DEFAULT_PARAMS, now, emitAlert);
  }
}

async function tick(): Promise<void> {
  if (!inPollWindow(Date.now())) return;   // 取引時間外は何もしない(軽量化)
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
