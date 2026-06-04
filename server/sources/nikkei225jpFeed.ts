import type { Price, Symbol } from '../types.js';

// v0.3.30: 日経225先物のリアルタイム価格を nikkei225jp.com の内部 feed から取得する。
// v0.3.31: 米国系(ダウ/ナスダック/原油/10年債)もこの feed の CFD/リアルタイムコードで
//          一括取得するよう一般化。
//
// 背景: 従来の主経路 Yahoo は CME/NYMEX 系を約10分ディレイで返す(NIY=F は CME のヤン建てで
// ユーザーが建てる大阪取引所(OSE)とも別物)。場中の急騰がアプリに10分届かず急変検知が空振り
// していた。この feed は nikkei225jp.com が 2.5 秒間隔でポーリングする JS ペイロードで、
// `A[code]="値_前日比_騰落率_時刻_フラグ_高値_安値";` 形式。CFD コード(OTC, CME の10分
// 再配信制限を受けない)はリアルタイム更新される。認証不要・Cloudflare なし。
//
// 時刻フィールドは HH:MM (分粒度) しか無いため tick 検知の 5/10秒窓には使えない。
// feed 自体がリアルタイムなので、timestamp には取得時の wall-clock を入れる。

const FEED_URL = 'https://jss.nikkei225jp.com/ajaxindex/ajax_TOP.js';
const REFERER = 'https://nikkei225jp.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FinanceMonitor/0.3';

// アプリの Symbol → feed コード対応。実測でリアルタイム(数分以内)を確認したもののみ採用。
//   136 日経225先物mini OSE / 737 CFD NAS100 / 731 ダウCFD / 733 香港ハンセンCFD /
//   921 WTI原油先物 / 811 米国10年債利回り / 511 ドル円
// S&P500(ES=F)はこの feed に現物stale しか無く、VIX はスポットのリアルタイム源が無いため
// 監視銘柄から外した(v0.3.32)。
const SYMBOL_CODES: ReadonlyArray<readonly [Symbol, string]> = [
  ['NIY=F', '136'],
  ['NQ=F',  '737'],
  ['YM=F',  '731'],
  ['^HSI',  '733'],
  ['CL=F',  '921'],
  ['^TNX',  '811'],
  ['JPY=X', '511'],
];

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
 * feed テキストから SYMBOL_CODES にある全銘柄の Price を抽出する。
 * timestamp は呼び出し側が注入 (テスト容易化 + wall-clock を使うため)。
 * 値が壊れている/コードが無い銘柄はスキップ (取れた分だけ返す)。
 */
export function extractFeedPrices(text: string, now: number): Price[] {
  const map = parseAjaxTop(text);
  const out: Price[] = [];
  for (const [symbol, code] of SYMBOL_CODES) {
    const fields = map.get(code);
    if (!fields) continue;
    const price = Number(fields[0]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const changePercent = Number(fields[2]);
    // 鮮度: 取引中の銘柄は時刻[3]が HH:MM。停止中(立会外/場中フリーズ/休日)は日付("06/04"等)に
    // なりフラグ[4]も "1"→"0"・高安が空になる。約定していない銘柄の凍結値・参照値を「ライブ tick」と
    // 誤認すると、動いていないのに分足が動いたように見え急変等が誤発火するため stale を復元する。
    // (timestamp は短期窓の解像度確保のため従来どおり wall-clock を注入。)
    const timeField = (fields[3] ?? '').trim();
    const live = /^\d{1,2}:\d{2}$/.test(timeField);
    out.push({
      symbol,
      price,
      changePercent: Number.isFinite(changePercent) ? changePercent : 0,
      timestamp: now,
      stale: !live,
    });
  }
  return out;
}

/** OSE mini (NIY=F) 単体を返す薄いヘルパ (互換用)。 */
export function extractOseMini(text: string, now: number): Price | null {
  return extractFeedPrices(text, now).find(p => p.symbol === 'NIY=F') ?? null;
}

/** feed の全リアルタイム銘柄を取得。失敗時は空配列 (呼び出し側で Yahoo にフォールバック)。 */
export async function fetchFeedPrices(): Promise<Price[]> {
  // v0.4: ハングした接続でポーリングループ/起動が止まらないよう 5秒でタイムアウト。
  const res = await fetch(FEED_URL, { headers: { 'User-Agent': UA, 'Referer': REFERER }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) return [];
  const text = await res.text();
  return extractFeedPrices(text, Date.now());
}
