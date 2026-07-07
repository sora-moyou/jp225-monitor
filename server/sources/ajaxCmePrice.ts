import type { Price } from '../types.js';

// v0.7.16(実弾ルート修正 / 長寿命ドリフト対策): NIY=F(大阪取引所 OSE 日経225先物mini)の
// リアルタイム価格を、socket ではなく **公開 HTTP エンドポイント** ajax_cme.js から取得する。
//
// 背景: socket.io ストリーム(nikkei225jpSocket.ts)は起動直後は real-time だが、長時間つなぎ続けた
// そのマシンの長寿命セッションだけが約10分遅延へ劣化する事故があった(2026-07-07)。socket 側では
// proactive make-before-break 等で対処してきたが、根本的には「長寿命セッションがドリフトする」性質は残る。
// この ajax_cme.js は毎 GET が **新しいスナップショット** を返すため、長寿命セッション自体が存在せず、
// ドリフトが原理的に起きない。実測(polling 約8s)で A[136] の価格が毎回更新され、時刻(HH:MM)が
// 現在の JST に一致 = near-real-time を確認済み。
//
// 形式: JSONP 風の行 `A[code]="price_change_changePct_time_liveFlag_high_low";`。
//   [0]=price / [1]=change / [2]=changePct / [3]=time(場中は HH:MM・停止中は MM/DD)/
//   [4]=liveFlag(1=ライブ・0=停止/清算)/ [5]=high / [6]=low
// NIY=F は code 136(日経先物mini)。
//
// 設計: パースは純関数 parseAjaxCme(ネットワーク無しで単体テスト可)。fetch は失敗時に throw せず null。
// timestamp は「取得した値が現在値そのもの」なので取得時刻(Date.now)を入れてよい(=真のリアルタイム)。
// socket は他銘柄(NQ=F/YM=F/^HSI/CL=F/^TNX/JPY=X)のために残す。

const PRIMARY_URL = 'https://jss2.nikkei225jp.com/ajaxindex/ajax_cme.js';
/** jss2 が落ちた時のフォールバック(同形式)。まず PRIMARY を試し、失敗したらこちら。 */
const FALLBACK_URL = 'https://225225.jp/_data/_nfsDATA/ajaxindex/ajax_cme.js';
const REFERER = 'https://225225.jp/2nk/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FinanceMonitor/0.7';
/** ハングした接続で priceLoop が止まらないよう 6 秒でタイムアウト。 */
const TIMEOUT_MS = 6000;

/** parseAjaxCme の戻り(price 以外は取れなければ null)。 */
export interface AjaxCmeQuote {
  price: number;
  changePct: number | null;
  high: number | null;
  low: number | null;
  live: boolean;
}

/**
 * ajax_cme.js テキストから指定 code の値を取り出す純粋関数。
 * `A[<code>]="([^"]+)"` を正規表現で抽出し、`_` で分割する。
 *   price      = parseFloat(fields[0]) — 有限かつ正でなければ null(=採用しない)
 *   changePct  = parseFloat(fields[2]) — 数値でなければ null
 *   live       = fields[4] === '1'
 *   high/low   = fields[5]/[6] — 数値でなければ null
 * code が存在しない/price が不正なら null。
 */
export function parseAjaxCme(text: string, code: string): AjaxCmeQuote | null {
  // code は数値コードだが念のため正規表現メタ文字をエスケープしてから埋め込む。
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`A\\[${escaped}\\]="([^"]+)"`);
  const m = re.exec(text);
  if (!m) return null;
  const fields = m[1]!.split('_');
  const price = parseFloat(fields[0] ?? '');
  if (!Number.isFinite(price) || price <= 0) return null;
  const changePctRaw = parseFloat(fields[2] ?? '');
  const highRaw = parseFloat(fields[5] ?? '');
  const lowRaw = parseFloat(fields[6] ?? '');
  return {
    price,
    changePct: Number.isFinite(changePctRaw) ? changePctRaw : null,
    high: Number.isFinite(highRaw) ? highRaw : null,
    low: Number.isFinite(lowRaw) ? lowRaw : null,
    live: fields[4] === '1',
  };
}

/** 1 URL を GET してパースする内部ヘルパ。失敗/非200/パース不能は null(throw しない)。 */
async function fetchOne(url: string, code: string): Promise<Price | null> {
  try {
    // キャッシュバスタ(_=now)で CDN/ブラウザキャッシュを避け、毎回新しいスナップショットを得る。
    const res = await fetch(`${url}?_=${Date.now()}`, {
      headers: { 'User-Agent': UA, 'Referer': REFERER },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const q = parseAjaxCme(text, code);
    if (!q) return null;
    return {
      symbol: 'NIY=F',
      price: q.price,
      // 取得した値が現在値そのもの → 取得時刻を timestamp にしてよい(真のリアルタイム)。
      timestamp: Date.now(),
      stale: false,
      changePercent: q.changePct ?? 0,
    };
  } catch {
    return null;   // タイムアウト/ネットワークエラー等は throw せず null。
  }
}

/**
 * NIY=F(code 既定 '136')の現在値を ajax_cme.js から取得する。
 * まず jss2(PRIMARY)、失敗したら 225225.jp(FALLBACK)を試す。両方失敗で null。
 * 決して throw しない(priceLoop はこの null を「取得不能」として扱い、Yahoo で埋めない)。
 */
export async function fetchAjaxCmePrice(code = '136'): Promise<Price | null> {
  const primary = await fetchOne(PRIMARY_URL, code);
  if (primary) return primary;
  return fetchOne(FALLBACK_URL, code);
}
