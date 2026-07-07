import { type Bar } from '../correlation.js';
import { inPollWindow } from '../../collector/session.js';
import { DEFAULT_PARAMS } from '../alertDetector.js';
import { emitAlert } from '../alertHistory.js';
import { INSTRUMENTS } from '../config.js';
import { getRealtimeBars } from '../feedBars.js';
import { evaluateBarsNiy } from '../alertEngine.js';

// v0.3.17: 1min ごとに全銘柄の 1m bars を取得 → adaptive z-score 検知 → SSE で alert ブロードキャスト。
// v0.3.35: 横断確認(他資産の同方向確認)を全面廃止。日経自身の z-score(+静寂前提) のみで発火。
// v0.7.20(no-Yahoo): 全 4 銘柄が 225225.jp の HTTP フィード → feedBars にリアルタイム蓄積されるため、
// Yahoo 分足(fetchMinuteBars)フォールバックを全廃。評価・AI 元ネタとも getRealtimeBars のみを使う。

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

let timer: NodeJS.Timeout | null = null;
let running = false;

export function getCachedBars(symbol: string): Bar[] {
  return getRealtimeBars(symbol);
}

// v0.7.20(no-Yahoo): 評価に使う 1m bars は **リアルタイム足のみ**(全 4 銘柄が HTTP フィード→feedBars に
// 蓄積される)。日経(NIY=F)の z-score も横断確認(NQ/YM/JPY)も同じ実時間軸で評価できる。ウォームアップ中
// (リアルタイム足<65)は空/浅い配列を返し、呼び出し側の `bars.length < 65` で単にスキップされる(遅延した
// Yahoo 足で評価/「足が遅延」ログを出さない=実弾安全 v0.7.9)。リアルタイム足は warmFromDb(DB 種付け)/
// ajax_cme・ajax_fx 蓄積で満たされ次第、新鮮に評価する。
// v0.3.32: 相関ループ・AIチャット文脈でも同じロジックを使えるよう export。
export function barsFor(symbol: string): Bar[] {
  return getRealtimeBars(symbol);
}

function evaluateAndFire(): void {
  const now = Date.now();

  for (const sym of SYMBOLS) {
    // v0.3.19: アラートは日経225先物のみ。他銘柄のリアルタイム足は AI 説明/相関の元ネタ専用(feedBars が蓄積)。
    if (sym !== 'NIY=F') continue;
    // v0.7.20(no-Yahoo): NIY=F はリアルタイム OSE バー(ajax_cme / DB 種付け)**のみ**で z-score 評価。
    // ウォームアップ中(リアルタイム足<65)は barsFor が空を返し、下の length<65 で単にスキップ
    // (遅延源を混ぜない=実弾安全 v0.7.9)。
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

function tick(): void {
  if (!inPollWindow(Date.now())) return;   // 取引時間外は何もしない(軽量化)
  try {
    // v0.7.20(no-Yahoo): Yahoo 分足の事前取得は撤去。評価は feedBars のリアルタイム足を直接読む。
    evaluateAndFire();
  } catch (err) {
    console.error('[alertLoop] tick error:', err instanceof Error ? err.message : err);
  }
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(() => { tick(); schedule(); }, POLL_MS);
}

export function startAlertLoop(): void {
  if (running) return;
  running = true;
  tick();
  schedule();
}

export function stopAlertLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}
