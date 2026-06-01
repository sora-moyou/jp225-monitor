import type { Price } from '../types.js';

// v0.3.30: 日経225先物のリアルタイム価格を nikkei225jp.com の内部 feed から取得する。
//
// 背景: 従来の主経路 Yahoo `NIY=F` は CME(シカゴ)のヤン建て契約で、無料データは
// 約10分ディレイ。ユーザーが実際に建てる大阪取引所(OSE)の日経225先物とは別物で、
// 場中の急騰がアプリ側に10分届かず、超短期(5/10秒)フラッシュ検知が空振りしていた。
//
// この feed は nikkei225jp.com が 2.5 秒間隔でポーリングしている JS ペイロードで、
// `A[code]="値_前日比_騰落率_時刻_フラグ_高値_安値";` 形式。code 136 = 日経225先物mini
// 大阪取引所(OSE)で、日中立会の値がリアルタイム反映される(同 feed の CME code 717 が
// 約10分遅れているのと対照的)。認証不要・Cloudflare なし。
//
// 時刻フィールドは HH:MM (分粒度) しか無いため tick 検知の 5/10秒窓には使えない。
// feed 自体がリアルタイムなので、timestamp には取得時の wall-clock を入れる。

const FEED_URL = 'https://jss.nikkei225jp.com/ajaxindex/ajax_TOP.js';
const REFERER = 'https://nikkei225jp.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FinanceMonitor/0.3';
const OSE_MINI_CODE = '136';   // 日経225先物mini 大阪取引所(OSE)

/** `A[code]="..."` 行を code → fields(配列) に分解する純粋関数。 */
export function parseAjaxTop(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const re = /A\[(\w+)\]="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    map.set(m[1]!, m[2]!.split('_'));
  }
  return map;
}

/**
 * feed テキストから OSE mini (code 136) の価格を Price(NIY=F) に変換する。
 * timestamp は呼び出し側が注入 (テスト容易化 + wall-clock を使うため)。
 */
export function extractOseMini(text: string, now: number): Price | null {
  const fields = parseAjaxTop(text).get(OSE_MINI_CODE);
  if (!fields) return null;
  const price = Number(fields[0]);
  if (!Number.isFinite(price) || price <= 0) return null;
  const changePercent = Number(fields[2]);
  return {
    symbol: 'NIY=F',
    price,
    changePercent: Number.isFinite(changePercent) ? changePercent : 0,
    timestamp: now,
    stale: false,
  };
}

/** OSE mini のリアルタイム価格を取得。失敗時は null (呼び出し側で Yahoo にフォールバック)。 */
export async function fetchOseMiniPrice(): Promise<Price | null> {
  const res = await fetch(FEED_URL, { headers: { 'User-Agent': UA, 'Referer': REFERER } });
  if (!res.ok) return null;
  const text = await res.text();
  return extractOseMini(text, Date.now());
}
