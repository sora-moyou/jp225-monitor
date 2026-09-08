// 価格フィード(ajax_cme2.js)の**健全性ハートビート**(RECORD-ONLY・取引挙動には一切関与しない)。
//
// ■ 何のためか(★これは実際に起きた事故の再発検知)
//   2026-09-06 08:19 JST に提供元の ajax_cme.js が凍結した。にもかかわらず
//   ・136(NIY=F)は liveFlag=0 になって静かに消え(監視も紙も実取引も 2 営業日 全停止)、
//   ・731/737 は **liveFlag=1 のまま凍り**、同じ値が毎秒「新しいティック」として記録され続けた。
//   どちらも **誰も気づかなかった**。ログには出ていたが、その文言は「HTTP フィード失敗」で
//   事実(取得は成功していた)と違っていた = 読んだ人を誤った原因に誘導した。
//   → 「取れているか」ではなく **「提供元の時計が進んでいるか」** を、常時見える場所に出す。
//
// ■ ★どこに載せるか = 共有DB(jp225.db)の meta テーブル
//   既存の `tick_archive_status`(server/db/tickArchiveHeartbeat.ts)/ `ledger_export_status`
//   (server/db/ledgerExport.ts)と **同じ置き場・同じ流儀**。新しい配管を1つも増やさない。
//   meta は trade2 の 30分ごとの `VACUUM INTO`(prices_<host>.db)にそのまま乗るので、
//   **既存の書き出しに自動的に乗り**、別PCからでも「フィードが生きていたか」が後から読める。
//
// ■ 書き手は誰か
//   monitor プロセスの priceLoop(server/loops/priceLoop.ts)。ポールのたびに測り、
//   PRICE_FEED_HEARTBEAT_MS ごとに meta へ書く(毎ポール書くと 2 秒ごとに meta を叩くことになる)。
//   collector は同じ取得関数を使うが**書かない**: 2 プロセスが同じキーを取り合うと、
//   どちらの状態を見ているのか読めなくなる(片方が止まっても値が更新され続ける = 無音に戻る)。
//
// ■ ★「止まっている」が一目で分かること
//   ①`state` … ok / settled(全銘柄が清算・週末等=正常に止まっている) / frozen(★事故) / down(取得失敗)。
//     **清算中の停止は正常**なので必ず場合分けする。分けないと週末は毎回赤くなり指標が死ぬ。
//   ②`price_feed_status` … 同じ内容の**人が読む1行**。JSON を開かなくても状態が読める。
//   ③ ハートビート自体が止まったら(= monitor 停止)、読み手が `at` の古さから検出する
//     (describePriceFeed)。**「値が更新されない」を「正常」と誤読させない**。

import type { DatabaseSync } from 'node:sqlite';
import type { Price } from '../types.js';
import type { FeedFreezeState } from '../sources/ajaxCmePrice.js';
import { classifySession, inPollWindow } from '../../core/session.js';
import { getMeta, setMeta } from './store.js';
import { jstStamp, fmtDur } from './tickArchiveHeartbeat.js';

/** 共有DB(jp225.db)meta のキー。JSON 本体と、人が読む1行の2本(ティック保管と同じ作法)。 */
export const PRICE_FEED_HEARTBEAT_KEY = 'price_feed_heartbeat';
export const PRICE_FEED_STATUS_KEY = 'price_feed_status';

/** meta へ書く間隔(測るのは毎ポール・書くのはこの間隔)。 */
export const PRICE_FEED_HEARTBEAT_MS = 60_000;
/** 読み手が「ハートビート自体が止まった(monitor 停止)」と判定する猶予(= 3周期)。 */
export const PRICE_FEED_HEARTBEAT_FRESH_MS = 3 * PRICE_FEED_HEARTBEAT_MS;

/** ok=新鮮 / offhours=取引時間外(取りに行っていない) / settled=取得成功だが全銘柄が清算(liveFlag=0) /
 *  stalled=★立会中なのに NIY=F が stale / frozen=★提供元の時計が凍結 / down=取得失敗。 */
export type PriceFeedState = 'ok' | 'offhours' | 'settled' | 'stalled' | 'frozen' | 'down';

// ─── ★「立会中なのに NIY=F が来ない」の番人(2026-09-06 の損害の本体) ─────────────
//
// 提供元の時計(frozen)が見ているのは 731/737 で、**136 だけが liveFlag=0 で固まる**形は捕まらない。
// ところが 2026-09-06 の損害の本体はまさにそれで、NIY=F が 09-05 05:59 を最後に消え、
// 09-07/09-08 は alerts 0 / signal_plans 0 / 実取引 0 = **監視も紙も実取引も全停止**した。
// price_feed_status に `NIY=F=...(stale)` とは出るが、**引け後や夜間の正常な stale と字面が同じ**で
// 区別できない。そこで「立会中か」を掛けて判定する。
//
// ★セッション判定は core/session.ts の **classifySession** を使う(新しい判定を書かない)。
//   isMarketOpen(= inPollWindow)は前後マージン(前 5分 / 後 10分)を持つので、
//   引け 15:45〜15:55 の 10 分は「窓内だが立会は終わっている」= NIY=F が liveFlag=0 になるのが正常。
//   ここで isMarketOpen を使うと **毎日2回、確実に誤報が出る**。マージンの無い classifySession が正しい。
//
// ★この番人は **表示と判定だけ**。mergeSources に渡す Price も stale フラグも一切変えない
//   (取引を止める副作用を持ち込まない)。

/** 立会中に NIY=F が来ない状態がこれだけ続いたら異常とみなす。
 *  ポールは約2秒・フィードは約4秒周期なので、3分は取りこぼし数十回ぶんの余裕がある。 */
export const NIY_STALE_ALARM_MS = 180_000;

/** NIY=F 欠測の観測結果。staleMs=null は「立会外なので判定していない」。 */
export interface NiyStaleState {
  staleMs: number | null;
  alarm: boolean;
}

/** 立会中の NIY=F 欠測を数える観測子。**注入・リセットできる**(隠れたモジュール状態にしない)。 */
export class NiyStaleWatch {
  private since = 0;
  private last: NiyStaleState = { staleMs: null, alarm: false };

  constructor(private readonly alarmAfterMs: number = NIY_STALE_ALARM_MS) {}

  /** prices は **その回の ajax_cme 取得結果**。NIY=F が無い/stale なら「来ていない」。 */
  observe(prices: readonly Price[], now: number): NiyStaleState {
    if (classifySession(now) === null) {          // 立会外 = 来ないのが正常。数えない。
      this.since = 0;
      this.last = { staleMs: null, alarm: false };
      return this.last;
    }
    const niy = prices.find(p => p.symbol === 'NIY=F');
    if (niy && !niy.stale) {
      this.since = 0;
      this.last = { staleMs: 0, alarm: false };
      return this.last;
    }
    if (this.since === 0) this.since = now;
    const staleMs = Math.max(0, now - this.since);
    this.last = { staleMs, alarm: staleMs > this.alarmAfterMs };
    return this.last;
  }

  get state(): NiyStaleState { return this.last; }
  reset(): void { this.since = 0; this.last = { staleMs: null, alarm: false }; }
}

/** 既定の観測子(実プロセスで priceLoop が使う1個)。 */
export const niyStaleWatch = new NiyStaleWatch();

export interface PriceFeedSymbolHealth {
  symbol: string;
  price: number;
  /** その回の Price.stale(凍結中は全銘柄 true になる)。 */
  stale: boolean;
}

export interface PriceFeedHeartbeat {
  v: 1;
  /** このハートビートを書いた時刻。**読み手はこれの古さで monitor 停止を検出する**。 */
  at: number;
  atJst: string;
  state: PriceFeedState;
  reason: string;
  /** 提供元自身の時計(liveFlag=1 の行の HH:MM の最大値)。判定不能なら null。 */
  clock: string | null;
  frozen: boolean;
  /** 時計が最後に変わってからの経過。 */
  frozenMs: number;
  /** 立会中か(classifySession が非 null)。判定の場合分けの根拠を残す。 */
  inSession: boolean;
  /** 立会中に NIY=F が来ていない継続時間。立会外は null。 */
  niyStaleMs: number | null;
  symbols: PriceFeedSymbolHealth[];
}

/** ハートビートを組み立てる純関数(DB に触らない=テストしやすい)。
 *  prices は **その回の ajax_cme 取得結果**(mergeSources に入る前)。 */
export function buildPriceFeedHeartbeat(input: {
  now: number;
  prices: readonly Price[];
  feed: FeedFreezeState;
  /** 立会中の NIY=F 欠測の観測結果。渡さなければ「判定しない」。 */
  niy?: NiyStaleState;
}): PriceFeedHeartbeat {
  const { now, prices, feed } = input;
  const niy = input.niy ?? { staleMs: null, alarm: false };
  const symbols = prices.map(p => ({ symbol: String(p.symbol), price: p.price, stale: !!p.stale }));
  const inSession = classifySession(now) !== null;

  let state: PriceFeedState;
  let reason: string;
  if (!inPollWindow(now)) {
    // ★取引時間外は priceLoop が **取りに行かない**。ここで書かないと毎晩2.5時間・週末50時間ぶん
    //   ハートビートが古くなり、読み手が「monitor が死んだ」と誤読する(tick_archive の idle と同じ扱い)。
    state = 'offhours';
    reason = '取引時間外(取得していないのが正常)';
  } else if (prices.length === 0) {
    state = 'down';
    reason = '取得失敗(jss2 / 225225.jp の両ホストが応答しない or 中身が読めない)';
  } else if (feed.frozen) {
    // ★事故そのもの。値は取れているのに提供元が更新を止めている = liveFlag は当てにならない。
    state = 'frozen';
    reason = `★提供元の時計が凍結(clock=${feed.clock ?? '?'} のまま${fmtDur(feed.frozenMs)})`
      + ' — 全銘柄を stale 扱いにして偽ティックを止めた';
  } else if (niy.alarm) {
    // ★2026-09-06 の損害の本体。731/737 は生きているのに 136 だけ来ない形はここでしか捕まらない。
    state = 'stalled';
    reason = `★立会中なのに NIY=F が${fmtDur(niy.staleMs ?? 0)}来ていない`
      + '(提供元の 136 が liveFlag=0 のまま = 監視/紙/実取引が止まる)';
  } else if (feed.clock === null) {
    // 週末・清算中。**止めてある**のであって止まっているのではない。
    state = 'settled';
    reason = '取得成功だが全銘柄が清算/停止(liveFlag=0)= この時間帯は正常';
  } else {
    state = 'ok';
    reason = `新鮮(提供元の時計=${feed.clock}・${fmtDur(feed.frozenMs)}前に更新)`;
  }

  return {
    v: 1, at: now, atJst: jstStamp(now), state, reason,
    clock: feed.clock, frozen: feed.frozen, frozenMs: feed.frozenMs,
    inSession, niyStaleMs: niy.staleMs,
    symbols,
  };
}

/** 1行の先頭に出す表示ラベル。
 *  ★state の値をそのまま大文字にしない。`stalled`(立会中に NIY=F が来ない)と、読み手側の
 *    `describePriceFeed` が出す「ハートビート自体が止まった」は **別物** で、どちらも "STALLED" と
 *    書くと確実に取り違える。今回の事故の入口が `HTTP フィード失敗(jss2/225225 両方)` という
 *    **読んで原因を取り違える文言** だったので、同じ形を残さない。 */
const STATE_LABEL: Record<PriceFeedState, string> = {
  ok: 'OK',
  offhours: 'OFFHOURS',
  settled: 'SETTLED',
  stalled: 'NIY-MISSING',     // 立会中に NIY=F が来ていない(フィードは生きている)
  frozen: 'FEED-FROZEN',      // 提供元の時計が止まっている
  down: 'FETCH-FAILED',       // 両ホストから取れない
};

/** 人が読む1行(meta の price_feed_status に入る値)。
 *  JSON と同じ構造体から**この関数だけ**で作るので、2つの表現が食い違うことはない。 */
export function formatPriceFeedStatus(hb: PriceFeedHeartbeat): string {
  const parts: string[] = [`${STATE_LABEL[hb.state]} ${hb.atJst} JST`, hb.reason];
  parts.push(hb.symbols.length === 0
    ? '銘柄=無し'
    : hb.symbols.map(s => `${s.symbol}=${s.price}${s.stale ? '(stale)' : ''}`).join(' '));
  return parts.join(' | ');
}

// ─── ★判定はここにしか無い(画面はサーバの結論を表示するだけ) ─────────────────
//
// 差し戻し(2026-09-08)で見つかった欠陥: 画面(renderPriceDot)が `frozen` を独自に最優先で見ていたため、
// 両ホスト取得失敗のときサーバは 'down'、画面は「提供元の更新が停止」と **別の結論** を出していた。
// 2箇所で判定する形そのものが欠陥なので、判定は buildPriceFeedHeartbeat だけに置き、
// 画面には **状態と理由の文字列** を渡す。画面がやるのは色の割り当てだけ。

/** /api/status が返す形。**画面はこれを表示するだけ**(独自判定をしない)。 */
export interface PriceFeedApiState {
  state: PriceFeedState;
  reason: string;
  /** この判定を出した時刻(画面が古さを出したくなった時のため)。 */
  at: number;
}

/** priceLoop が測った最新のハートビート。**判定結果の置き場**であって判定はしない。 */
let published: PriceFeedHeartbeat | null = null;

/** priceLoop が毎ポール呼ぶ(meta への書き込みは60秒に1回だが、画面は常に最新を見せる)。 */
export function publishPriceFeedHeartbeat(hb: PriceFeedHeartbeat): void { published = hb; }

/** /api/status 用。まだ一度も測っていなければ null(= 旧 monitor と同じ扱いで画面は従来表示)。 */
export function priceFeedApiState(): PriceFeedApiState | null {
  return published ? { state: published.state, reason: published.reason, at: published.at } : null;
}

/** テスト用(プロセスをまたがない状態を消す)。 */
export function resetPublishedPriceFeedHeartbeat(): void { published = null; }

export function readPriceFeedHeartbeat(db: DatabaseSync): PriceFeedHeartbeat | null {
  const raw = getMeta(db, PRICE_FEED_HEARTBEAT_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as PriceFeedHeartbeat;
    return (v && typeof v.at === 'number' && Array.isArray(v.symbols)) ? v : null;
  } catch {
    return null;   // 壊れた値は「無い」扱い(次のハートビートで上書きされる)
  }
}

/** 測った状態を共有DBの meta に書く。書いたハートビートを返す。 */
export function writePriceFeedHeartbeat(
  db: DatabaseSync,
  opts: { now?: number; prices: readonly Price[]; feed: FeedFreezeState; niy?: NiyStaleState },
): PriceFeedHeartbeat {
  const now = opts.now ?? Date.now();
  const hb = buildPriceFeedHeartbeat({ now, prices: opts.prices, feed: opts.feed, niy: opts.niy });
  setMeta(db, PRICE_FEED_HEARTBEAT_KEY, JSON.stringify(hb));
  setMeta(db, PRICE_FEED_STATUS_KEY, formatPriceFeedStatus(hb));
  return hb;
}

// ─── 読み手側(スナップショットを開いた人 / 将来の UI) ──────

export interface PriceFeedVerdict {
  state: PriceFeedState | 'missing';
  ageMs: number | null;
  text: string;
}

/** ハートビートを **読む時刻から見て** 評価する。
 *  ★要点: monitor が止まると最後の値が 'ok' のまま凍る。`at` の古さを見ないと
 *    「OK のまま止まっている」を見逃す(tickArchiveHeartbeat の describeTickArchive と同じ)。 */
export function describePriceFeed(
  hb: PriceFeedHeartbeat | null, now: number,
  freshMs: number = PRICE_FEED_HEARTBEAT_FRESH_MS,
): PriceFeedVerdict {
  if (!hb) {
    return { state: 'missing', ageMs: null, text: 'MISSING 価格フィードのハートビートが無い(記録が始まっていない/古い版で動いている)' };
  }
  const ageMs = now - hb.at;
  const line = formatPriceFeedStatus(hb);
  if (ageMs > freshMs) {
    return {
      state: 'down', ageMs,
      // ★"STALLED" とは書かない(上の STATE_LABEL 参照)。ここで言っているのは **測る側が止まった** こと。
      text: `HEARTBEAT-LOST 価格フィードのハートビートが${fmtDur(ageMs)}前で止まっている`
        + `(monitor が動いていない疑い — 下の1行は止まる直前の状態) | ${line}`,
    };
  }
  return { state: hb.state, ageMs, text: line };
}
