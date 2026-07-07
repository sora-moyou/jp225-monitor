import type { Price, Symbol } from '../types.js';
import { parseAjaxCme, quoteToPrice } from './ajaxCmePrice.js';

// v0.7.20(全銘柄 HTTP 化): ドル円(JPY=X)を公開 HTTP エンドポイント ajax_fx.js の code 511 から取得する。
// 行の形式は ajax_cme.js と同一(`A[code]="price_change_changePct_time_liveFlag_high_low";`)なので、
// パースは ajaxCmePrice の純関数 parseAjaxCme / quoteToPrice をそのまま再利用する。
//   511 → JPY=X(ドル円) — 実測で ~24h ライブ(liveFlag='1')。
// 設計は ajaxCmePrice と同じ: fetch は throw せず [] / null、毎 GET 新スナップショット、
// live=false(清算/停止)は stale:true(持ち越し扱い)。

const PRIMARY_URL = 'https://jss2.nikkei225jp.com/ajaxindex/ajax_fx.js';
/** jss2 が落ちた時のフォールバック(同形式)。 */
const FALLBACK_URL = 'https://225225.jp/_data/_nfsDATA/ajaxindex/ajax_fx.js';
const REFERER = 'https://225225.jp/4fx/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FinanceMonitor/0.7';
const TIMEOUT_MS = 6000;

/** ajax_fx.js のコード → アプリ Symbol。 */
export const AJAX_FX_CODE_SYMBOL: ReadonlyArray<readonly [string, Symbol]> = [
  ['511', 'JPY=X'],   // ドル円
];

/** ajax_fx.js テキストから指定コード群を Price[] に展開する純関数(ネットワーク無しでテスト可)。 */
export function pricesFromAjaxFxText(
  text: string,
  codeSymbols: ReadonlyArray<readonly [string, Symbol]> = AJAX_FX_CODE_SYMBOL,
): Price[] {
  const out: Price[] = [];
  for (const [code, symbol] of codeSymbols) {
    const q = parseAjaxCme(text, code);   // 同形式 → parseAjaxCme を再利用
    if (q) out.push(quoteToPrice(symbol, q));
  }
  return out;
}

/** 1 URL を GET して生テキストを返す。失敗/非200 は null(throw しない)。 */
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}?_=${Date.now()}`, {
      headers: { 'User-Agent': UA, 'Referer': REFERER },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * ajax_fx.js を **1 GET** して JPY=X(code 511)を Price[] に展開する。
 * まず jss2(PRIMARY)、失敗したら 225225.jp(FALLBACK)。両方失敗で []。決して throw しない。
 */
export async function fetchAjaxFxPrices(
  codeSymbols: ReadonlyArray<readonly [string, Symbol]> = AJAX_FX_CODE_SYMBOL,
): Promise<Price[]> {
  const text = (await fetchText(PRIMARY_URL)) ?? (await fetchText(FALLBACK_URL));
  if (text === null) return [];
  return pricesFromAjaxFxText(text, codeSymbols);
}
