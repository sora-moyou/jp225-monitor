import type { Price, Symbol } from '../types.js';

// v0.7.16(実弾ルート修正 / 長寿命ドリフト対策): NIY=F(大阪取引所 OSE 日経225先物mini)の
// リアルタイム価格を、socket ではなく **公開 HTTP エンドポイント** ajax_cme.js から取得する。
//
// v0.7.20(全銘柄 HTTP 化): socket / Yahoo を全廃し、監視 4 銘柄すべてを公開 HTTP から取る。
//   ajax_cme.js: 136 → NIY=F(日経225mini) / 731 → YM=F(NYダウ CFD) / 737 → NQ=F(NASDAQ100 CFD)
//   ajax_fx.js : 511 → JPY=X(ドル円)  ← ajaxFxPrice.ts(本ファイルの純関数 parseAjaxCme を再利用)
// これで「長寿命 socket セッションが約10分ドリフトする」事故(2026-07-07)を全銘柄で原理的に排除する。
//
// 背景: socket.io ストリーム(旧 nikkei225jpSocket.ts)は起動直後は real-time だが、長時間つなぎ続けた
// そのマシンの長寿命セッションだけが約10分遅延へ劣化する事故があった。socket 側では proactive
// make-before-break 等で対処してきたが、根本的には「長寿命セッションがドリフトする」性質は残る。
// この ajax_cme.js は毎 GET が **新しいスナップショット** を返すため、長寿命セッション自体が存在せず、
// ドリフトが原理的に起きない。実測(polling 約8s)で価格が毎回更新され、時刻(HH:MM)が現在の JST に
// 一致 = near-real-time を確認済み(136/731/737 とも ~24h ライブ)。
//
// 形式: JSONP 風の行 `A[code]="price_change_changePct_time_liveFlag_high_low";`。
//   [0]=price / [1]=change / [2]=changePct / [3]=time(場中は HH:MM・停止中は MM/DD)/
//   [4]=liveFlag(1=ライブ・0=停止/清算)/ [5]=high / [6]=low
//
// 設計: パースは純関数 parseAjaxCme(ネットワーク無しで単体テスト可)。fetch は失敗時に throw せず
// [] / null。timestamp は「取得した値が現在値そのもの」なので取得時刻(Date.now)を入れてよい(=真の
// リアルタイム)。liveFlag が '1' でない(清算/停止)銘柄は stale:true にして「持ち越し」に回す。

const PRIMARY_URL = 'https://jss2.nikkei225jp.com/ajaxindex/ajax_cme.js';
/** jss2 が落ちた時のフォールバック(同形式)。まず PRIMARY を試し、失敗したらこちら。 */
const FALLBACK_URL = 'https://225225.jp/_data/_nfsDATA/ajaxindex/ajax_cme.js';
const REFERER = 'https://225225.jp/2nk/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FinanceMonitor/0.7';
/** ハングした接続で priceLoop が止まらないよう 6 秒でタイムアウト。 */
const TIMEOUT_MS = 6000;

/** ajax_cme.js のコード → アプリ Symbol。実測で ~24h ライブを確認済み。 */
export const AJAX_CME_CODE_SYMBOL: ReadonlyArray<readonly [string, Symbol]> = [
  ['136', 'NIY=F'],   // 日経225mini(OSE) — 実際に建てる銘柄
  ['731', 'YM=F'],    // NYダウ CFD
  ['737', 'NQ=F'],    // NASDAQ100 CFD
];

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

/**
 * パース済み quote を Price に変換する純関数。
 * live=false(清算/停止)なら stale:true を立て、「持ち越し」に回す(fresh には載せない)。
 * timestamp は取得時刻(現在値そのものなので真のリアルタイム)。
 */
export function quoteToPrice(symbol: Symbol, q: AjaxCmeQuote): Price {
  return {
    symbol,
    price: q.price,
    timestamp: Date.now(),
    stale: !q.live,
    changePercent: q.changePct ?? 0,
  };
}

/** ajax_cme.js テキストから指定コード群を Price[] に展開する純関数(ネットワーク無しでテスト可)。
 *  パース不能な code は落とす(存在しない/価格不正)。live=false は stale:true。 */
export function pricesFromAjaxText(
  text: string,
  codeSymbols: ReadonlyArray<readonly [string, Symbol]> = AJAX_CME_CODE_SYMBOL,
): Price[] {
  const out: Price[] = [];
  for (const [code, symbol] of codeSymbols) {
    const q = parseAjaxCme(text, code);
    if (q) out.push(quoteToPrice(symbol, q));
  }
  return out;
}

/** 1 URL を GET して生テキストを返す内部ヘルパ。失敗/非200 は null(throw しない)。 */
async function fetchText(url: string): Promise<string | null> {
  try {
    // キャッシュバスタ(_=now)で CDN/ブラウザキャッシュを避け、毎回新しいスナップショットを得る。
    const res = await fetch(`${url}?_=${Date.now()}`, {
      headers: { 'User-Agent': UA, 'Referer': REFERER },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;   // タイムアウト/ネットワークエラー等は throw せず null。
  }
}

/**
 * ajax_cme.js を **1 GET** して複数コード(既定 136/731/737)を Price[] に展開する。
 * まず jss2(PRIMARY)、失敗したら 225225.jp(FALLBACK)を試す。両方失敗で []。
 * 決して throw しない。live=false の銘柄は stale:true(持ち越し扱い)。
 */
export async function fetchAjaxCmePrices(
  codeSymbols: ReadonlyArray<readonly [string, Symbol]> = AJAX_CME_CODE_SYMBOL,
): Promise<Price[]> {
  const text = (await fetchText(PRIMARY_URL)) ?? (await fetchText(FALLBACK_URL));
  if (text === null) return [];
  return pricesFromAjaxText(text, codeSymbols);
}

/**
 * 後方互換: 単一 code(既定 NIY=F '136')の現在値を返す。fresh(live)のみ返し、stale/取得不能は null。
 * 既存の collector 経路(NIY=F throttle)で使用。
 */
export async function fetchAjaxCmePrice(code = '136'): Promise<Price | null> {
  const symbol = (AJAX_CME_CODE_SYMBOL.find(([c]) => c === code)?.[1]) ?? 'NIY=F';
  const prices = await fetchAjaxCmePrices([[code, symbol]]);
  const p = prices.find(x => x.symbol === symbol);
  return p && !p.stale ? p : null;
}
