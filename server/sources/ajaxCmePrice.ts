import type { Price, Symbol } from '../types.js';

// v0.7.16(実取引ルート修正 / 長寿命ドリフト対策): NIY=F(大阪取引所 OSE 日経225先物mini)の
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

// ★v0.9.110(2026-09-08): 取得先を ajax_cme.js → **ajax_cme2.js** に差し替えた。
//   理由: 提供元がファイルを作り替え、旧 ajax_cme.js が **2026-09-06 08:19 JST で凍結** した
//   (実HTTPで確認: Last-Modified が `Sat, 05 Sep 2026 23:19:43 GMT` 以後まったく動かない)。
//   提供元の本番ページ(225225.jp/2nk/)は既に ajax_cme2.js を読んでおり、136/731/737 の3コードとも
//   同じ形式で入っている(jss2 / 225225.jp のどちらのホストでも生きていることを実HTTPで確認済み)。
//   ★実害: 旧ファイルは 136 が liveFlag=0 で止まった一方、731/737 は **liveFlag=1 のまま凍結** した。
//     liveFlag だけを見る quoteToPrice は stale を立てられず、timestamp=Date.now() を毎秒振り直して
//     **同じ値を新しいティックとして記録し続けた**(実測: 2026-09-07 の YM=F 24,833件・相異なる価格1種)。
//     この「liveFlag が嘘をつく」失敗形を二度と無音で通さないため、下の凍結検知(feedClock)を入れる。
//   注: ajax_fx.js(ajaxFxPrice.ts / JPY=X)は生きているので触っていない。
const PRIMARY_URL = 'https://jss2.nikkei225jp.com/ajaxindex/ajax_cme2.js';
/** jss2 が落ちた時のフォールバック(同形式)。まず PRIMARY を試し、失敗したらこちら。 */
const FALLBACK_URL = 'https://225225.jp/_data/_nfsDATA/ajaxindex/ajax_cme2.js';
const REFERER = 'https://225225.jp/2nk/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FinanceMonitor/0.7';
/** ハングした接続で priceLoop が止まらないよう 6 秒でタイムアウト。 */
const TIMEOUT_MS = 6000;

/** ajax_cme2.js のコード → アプリ Symbol。実測で ~24h ライブを確認済み。 */
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
 * ajax_cme2.js テキストから指定 code の値を取り出す純粋関数(行の形式は旧 ajax_cme.js と同一)。
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

/** ajax_cme2.js テキストから指定コード群を Price[] に展開する純関数(ネットワーク無しでテスト可)。
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

// ─── 提供元の凍結検知(★2026-09-06 の事故を二度と無音で通さない) ──────────────
//
// ■ 何を見るか = **提供元自身の時計**
//   各行の [3] は場中なら `HH:MM`(= 提供元が「いま何時のスナップショットか」と言っている時刻)、
//   停止/清算中は `MM/DD`。つまり **liveFlag=1 かつ [3] が HH:MM の行の時刻** が提供元の時計。
//   価格そのものは動かない時間帯が普通にあるので「価格が変わらない」では判定できない。
//   liveFlag も、今回の事故のとおり **1 のまま凍る** ので単独では信用できない。
//   → 「提供元の時計が進んでいるか」だけが、ファイルが生きている証拠になる。
//
// ■ ★見る行を **自分がゲートしている銘柄だけ** に絞る(2026-09-08 の差し戻しで判明した欠陥)
//   このファイルには 67 行・47 銘柄が入っており、その中には **liveFlag=1 のまま常時10〜16分遅れる行**
//   が実在する(実測 2026-09-08 17:10 の断面: A[621]=16:55 = 15分遅れ / A[713][715][716][717][721] も
//   1〜12分遅れ。60サンプル中 60 で「5分超遅れかつ liveFlag=1」の行が存在した)。
//   ファイル全体の最大値を採ると、00:00 JST を回った瞬間に文字列比較で "23:58" > "00:07" となり、
//   **遅れている 23時台の行に最大値がピン留めされて frozen が誤って立つ**(実再現: 00:06 で frozen=true)。
//   → 見るのは **codeSymbols のコード(既定 136/731/737)だけ**。実測130サンプルでこの3本は常に
//     ファイル最大値と ±1分以内で、2026-09-06 の事故では 731/737 が **揃って** 08:19 で凍っていた
//     (実HTTPで確認済み)= 検知力は落ちない。
//   ★136 は引け後 `MM/DD` 形式になり HH:MM の正規表現から外れる。日中は 731/737 が時計を供給する。
//
// ■ 比較は **等値のみ**(大小比較をしない)
//   23:59 → 00:00 の日跨ぎで「時計が戻った」と誤判定しないため。変わったかどうかしか見ない。
//   ★ただし等値比較だけでは上の「ピン留め」は防げなかった(値は毎回同じなので変化が起きない)。
//     日跨ぎの安全は **等値比較 + 見る行の絞り込み** の2つで初めて成立する。
//
// ■ 判定できない時は判定しない
//   liveFlag=1 の行が1つも無い(週末・全銘柄が清算中)なら clock=null → frozen=false。
//   ここを異常にすると週末は毎回赤くなり、誰も見なくなる = 指標が死ぬ(tickArchiveHeartbeat と同じ思想)。
//   その間も **基準時刻は据え置く**(リセットしない): 凍結中に全銘柄が清算に入っただけで
//   凍結の記憶が消えるのは、まさに無音に戻る道。

/** 提供元の時計がこれだけ進まなければ「凍結」とみなす。
 *  実測(2026-09-08 の ajax_cme2.js)では時計は分単位で進む。5分は数分の取りこぼしを許す余裕。 */
export const FROZEN_AFTER_MS = 300_000;

/** 既定で時計を見るコード(= 本番でゲートしている 136/731/737)。 */
export const AJAX_CME_CLOCK_CODES: readonly string[] = AJAX_CME_CODE_SYMBOL.map(([code]) => code);

/** ajax_cme テキストから **提供元の時計** を取り出す純関数。
 *  ★`codes`(既定 136/731/737)の行だけを見る。ファイル全体を見ると、常時10分以上遅れる別銘柄の行に
 *    引きずられて日跨ぎで誤検知する(上のコメント参照)。
 *  liveFlag=1 かつ [3] が `HH:MM` の行だけを見て、その最大値を返す。1つも無ければ null。 */
export function feedClock(text: string, codes: readonly string[] = AJAX_CME_CLOCK_CODES): string | null {
  let best: string | null = null;
  for (const code of codes) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`A\\[${escaped}\\]="([^"]+)"`).exec(text);
    if (!m) continue;
    const f = m[1]!.split('_');
    if (f[4] !== '1') continue;                  // 清算/停止の行は提供元の時計ではない
    const t = f[3] ?? '';
    if (!/^\d{2}:\d{2}$/.test(t)) continue;      // MM/DD 等は時計ではない
    if (best === null || t > best) best = t;     // 最大値(文字列比較で足りる)
  }
  return best;
}

/** 凍結観測の結果。frozenMs = 時計が最後に変わってからの経過(clock=null のときは 0)。 */
export interface FeedFreezeState {
  clock: string | null;
  frozen: boolean;
  frozenMs: number;
}

/** 時計の観測子。**モジュールグローバルの隠れ状態にしない**(テストから注入・リセットできる)。 */
export class FeedFreezeWatch {
  private clock: string | null = null;
  private since = 0;
  private last: FeedFreezeState = { clock: null, frozen: false, frozenMs: 0 };

  constructor(private readonly frozenAfterMs: number = FROZEN_AFTER_MS) {}

  observe(text: string, now: number, codes: readonly string[] = AJAX_CME_CLOCK_CODES): FeedFreezeState {
    const clock = feedClock(text, codes);
    if (clock === null) {
      // 判定できない(全銘柄が清算中)。★基準時刻は据え置く = 凍結の記憶を消さない。
      this.last = { clock: null, frozen: false, frozenMs: 0 };
      return this.last;
    }
    if (clock !== this.clock) {   // ★等値比較のみ(日跨ぎで戻っても「変わった」= 生きている)
      this.clock = clock;
      this.since = now;
    }
    const frozenMs = Math.max(0, now - this.since);
    this.last = { clock, frozen: frozenMs > this.frozenAfterMs, frozenMs };
    return this.last;
  }

  /** 直近の観測結果(まだ一度も観測していなければ clock=null / frozen=false)。 */
  get state(): FeedFreezeState { return this.last; }

  reset(): void {
    this.clock = null; this.since = 0;
    this.last = { clock: null, frozen: false, frozenMs: 0 };
  }
}

/** 既定の観測子(実プロセスで fetchAjaxCmePrices が使う1個)。テストは自前の watch を渡せる。 */
export const ajaxCmeFreezeWatch = new FeedFreezeWatch();

/** 画面/ログ用に直近の観測結果を読む(/api/status・priceLoop が使う。ネットワークに触らない)。 */
export function ajaxCmeFeedState(): FeedFreezeState { return ajaxCmeFreezeWatch.state; }

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
 * ajax_cme2.js を **1 GET** して複数コード(既定 136/731/737)を Price[] に展開する。
 * まず jss2(PRIMARY)、失敗したら 225225.jp(FALLBACK)を試す。両方失敗で []。
 * 決して throw しない。live=false の銘柄は stale:true(持ち越し扱い)。
 *
 * ★提供元の時計が凍結している間は **返す Price を全て stale:true** にする。
 *   理由: 凍結値が mergeSources に fresh として採用されると、priceLoop が毎ポール
 *   timestamp=Date.now() の偽ティックを記録し続ける(2026-09-07 に実際に起きた)。
 *   凍結していない時の戻り値は従来と完全に同一(凍結検知は観測のみで何も変えない)。
 */
export async function fetchAjaxCmePrices(
  codeSymbols: ReadonlyArray<readonly [string, Symbol]> = AJAX_CME_CODE_SYMBOL,
  watch: FeedFreezeWatch = ajaxCmeFreezeWatch,
  now: number = Date.now(),
): Promise<Price[]> {
  const text = (await fetchText(PRIMARY_URL)) ?? (await fetchText(FALLBACK_URL));
  if (text === null) return [];   // 取得失敗は「時計が進まない」ではない → 凍結判定に混ぜない
  // ★時計を見るのは **いま自分がゲートしているコードだけ**(呼び出し側が絞ったらそれに追随する)。
  const freeze = watch.observe(text, now, codeSymbols.map(([code]) => code));
  const prices = pricesFromAjaxText(text, codeSymbols);
  return freeze.frozen ? prices.map(p => ({ ...p, stale: true })) : prices;
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
