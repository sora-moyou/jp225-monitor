// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  ① AI に渡すデータ — 本番と同じ組み立てを **import して呼ぶ**(コピーしない)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// 本番(server/llm/scalpPlanRunner.ts の runScalpPlanWithChartInner → server/llm/scalpPlan.ts の
// buildScalpPlan)は、AI へ渡すデータをこの順で組み立てている:
//
//   【市場の現状 <日時>】
//   ■ 現在価格:            … formatPricesForChat(prices, now)
//   <technical>            … buildNikkeiTechnical() + formatMomentumLine(computeRegime(...))
//                             + buildRichScalpContextResult()(構造化データ A〜G + 仮想取引の成績)
//   <monitorCtx>           … buildMonitorContext(now)(直近アラート60分 + 本日のセッションOHLC)
//   ■ 関連ニュース:        … formatNewsForChat(news, now, 質問文)
//
// ここでは **その全てを同じ関数で** 組み立てる。ラボ側で書いた整形処理は1つも無い。
//
// ★本番との差(隠さず記録して画面にも出す):
//   (1) 価格 … 本番は priceLoop が回した getPrices() のキャッシュ。ラボは別プロセスでループが無いので
//       同じ取得源(fetchAjaxCmePrices / fetchAjaxFxPrices + mergeSources)を **1回だけ** 叩いて
//       setPrices() に入れる。使う関数は本番と同じ。
//   (2) 節目(levels) … 本番は levelsLoop が 8 秒ごとに更新するモジュール内スナップショット。
//       ラボは startLevelsLoop() → 即 stopLevelsLoop() で **1 tick だけ** 回して同じ値を得る。
//       (このループの書き込み先は砂箱 DB。実 DB は開かれない)
//   (3) 勢い(regime) … 本番は getRealtimeOHLCBars()(フィードのメモリ内足)。ラボはフィードが無いので
//       collectRecentBars() の DB 足を同じ computeRegime() に渡す。
//   (4) ニュース … 本番は newsLoop のキャッシュ。ラボは DB の news 表から直近ぶんを読んで setNews()。
//   いずれも「取れないブロックは欠落のまま」= 埋めない。

import { setPrices, getPrices, setNews, getNews } from '../cache.js';
import { fetchAjaxCmePrices } from '../sources/ajaxCmePrice.js';
import { fetchAjaxFxPrices } from '../sources/ajaxFxPrice.js';
import { mergeSources } from '../loops/priceLoop.js';
import { startLevelsLoop, stopLevelsLoop, getLevelsSnapshot } from '../loops/levelsLoop.js';
import { buildNikkeiTechnical } from '../chatContext.js';
import { computeRegime, formatMomentumLine } from '../signalTrade/regime.js';
import { buildRichScalpContextResult } from '../llm/scalpPlanRunner.js';
import { resolveScalpTrendVetoYen } from '../configStore.js';
import { resolveEffectiveRangeEnabled } from '../llm/scalpPlan.js';
import { formatPricesForChat, formatNewsForChat, buildMonitorContext } from '../llm/dataTools.js';
import { collectRecentBars } from '../barsSource.js';
import { openDb, resolveDbPath, getRecentNews } from '../db/store.js';
import { keepOnlyStarLevels, stripLevelBlocks, type StarFilterStats, type NoLevelStats } from './starLevels.js';
import type { NewsItem } from '../types.js';

const NIKKEI_SYMBOL = 'NIY=F';

/** ★大台(キリ番)ブロック。**現在値から機械生成した参考値**であって実測の節目ではない。
 *  見出しにその旨を書く(データの出所を偽らない)。現在値 ±500円の 100円刻み / 50円刻み。 */
export function buildKiribanBlock(price: number): string {
  if (!(typeof price === 'number' && price > 0)) return '';
  const fmt = (v: number): string => v.toLocaleString('en-US');
  const h: number[] = [], f: number[] = [];
  for (let v = Math.ceil((price - 500) / 50) * 50; v <= price + 500; v += 50) {
    (v % 100 === 0 ? h : f).push(v);
  }
  if (h.length === 0 && f.length === 0) return '';
  return '■ 大台(キリ番) ★現在値から機械生成した参考値(実測の節目ではない):' + '\n'
    + '100円刻み: ' + h.map(fmt).join(' / ') + '\n'
    + '50円刻み: ' + f.map(fmt).join(' / ');
}
/** 構造化データに使う実 OHLC の取得窓。★本番(scalpPlanRunner の RICH_BARS_WINDOW_MS)と同じ 6 時間。 */
const RICH_BARS_WINDOW_MS = 6 * 60 * 60_000;
/** ニュースを DB から拾う窓。本番の newsLoop が保持している量におおよそ揃える。 */
const NEWS_WINDOW_MS = 24 * 60 * 60_000;

/** 「その回に何が取れて何が取れなかったか」。★埋めないかわりに **欠落を明示** する。 */
export interface ContextDiagnostics {
  now: number;
  /** 現在値(NIY=F)。取れなければ null。 */
  price: number | null;
  priceCount: number;
  /** DB 足の本数と、最も新しい足の時刻。 */
  barCount: number;
  lastBarT: number | null;
  /** 節目(上/下)の本数。0 なら levels ブロックは出ていない。 */
  levelsUp: number;
  levelsDown: number;
  newsCount: number;
  /** 各ブロックが本文に出たか(見出しの有無で判定)。 */
  blocks: Record<string, boolean>;
  /** 取得中に起きた問題(空なら問題なし)。 */
  problems: string[];
  /** ★のみに絞ったときの除外前後の本数(絞っていなければ null)。 */
  starFilter?: StarFilterStats | null;
  /** ★節目を丸ごと外したときの内訳(外していなければ null)。 */
  noLevels?: NoLevelStats | null;
}

export interface BuiltContext {
  /** ★AI に渡すデータの全文(そのまま表示・そのまま送る)。 */
  text: string;
  diag: ContextDiagnostics;
}

/** DB 行 → NewsItem(formatNewsForChat が読むのは title / source / publishedAt だけ)。 */
function toNewsItems(rows: ReturnType<typeof getRecentNews>): NewsItem[] {
  return rows.map(r => ({
    id: r.id, title: r.title, source: r.source,
    lang: (r.lang === 'en' ? 'en' : 'ja') as 'ja' | 'en',
    url: r.url, publishedAt: r.published_at,
  }));
}

/** 価格を1回だけ取得してキャッシュへ入れる(本番 priceLoop と同じ取得源・同じ合成)。 */
async function primePrices(problems: string[]): Promise<void> {
  try {
    const [cme, fx] = await Promise.all([fetchAjaxCmePrices(), fetchAjaxFxPrices()]);
    const fresh = mergeSources([cme, fx]);
    if (fresh.length === 0) { problems.push('価格の取得が0件(取引時間外 or 取得先の障害)'); return; }
    setPrices(fresh);
  } catch (e) {
    problems.push(`価格取得に失敗: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 節目スナップショットを1 tick だけ回して埋める(書き込み先は砂箱 DB)。 */
function primeLevels(problems: string[]): void {
  try {
    startLevelsLoop();   // start の中で tick() が同期実行される
  } catch (e) {
    problems.push(`levels の算出に失敗: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try { stopLevelsLoop(); } catch { /* 停止失敗は無視 */ }
  }
}

/** ニュースを砂箱 DB から読んでキャッシュへ入れる。 */
function primeNews(now: number, problems: string[]): void {
  let db = null as ReturnType<typeof openDb> | null;
  try {
    db = openDb(resolveDbPath());
    const rows = getRecentNews(db, now - NEWS_WINDOW_MS, 200);
    setNews(toNewsItems(rows));
    if (rows.length === 0) problems.push('ニュースが DB に無い(直近24時間)');
  } catch (e) {
    problems.push(`ニュース読み出しに失敗: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export interface BuildOpts {
  /** ライブ価格を1回取りに行くか。★凍結断面の再生では false(過去の断面に今日の価格を混ぜない)。 */
  livePrices?: boolean;
  /** 断面の時刻。未指定は Date.now()(= 偽時計を入れている場合はその時刻)。 */
  now?: number;
  /** ★節目を「★(=tier≥1)」のものだけに絞るか。既定 false(本番と同じ全量)。 */
  starLevelsOnly?: boolean;
  /** ★節目由来のブロックを **丸ごと渡さない** か。starLevelsOnly より優先。 */
  noLevels?: boolean;
  /** ★大台(キリ番)の一覧をデータに足すか(現在値から機械生成・実測の節目ではない)。 */
  kiriban?: boolean;
}

/**
 * ★①のデータ全文を組み立てる。使う関数はすべて本番のもの(この下に新しい整形処理は無い)。
 * newsQuery … 本番は「その回の質問文」を渡して関連ニュースを選ばせている。ラボも同じ引数に
 *             その回の質問文を渡す(何を渡したかは記録に残す)。
 */
export async function buildLabContext(newsQuery: string, opts: BuildOpts = {}): Promise<BuiltContext> {
  const problems: string[] = [];
  const now = opts.now ?? Date.now();

  if (opts.livePrices !== false) await primePrices(problems);
  primeLevels(problems);
  primeNews(now, problems);

  const prices = getPrices();
  const news = getNews();
  const price = prices.find(p => p.symbol === NIKKEI_SYMBOL)?.price ?? null;
  if (price === null) problems.push(`${NIKKEI_SYMBOL} の現在値が取れない(以降のブロックは大半が欠落する)`);

  // ── 勢い(regime): 本番と同じ computeRegime。足だけ DB 由来(理由は冒頭の注記(3))。
  let bars: ReturnType<typeof collectRecentBars> = [];
  let db = null as ReturnType<typeof openDb> | null;
  try {
    db = openDb(resolveDbPath());
    bars = collectRecentBars(db, NIKKEI_SYMBOL, now - RICH_BARS_WINDOW_MS);
  } catch (e) {
    problems.push(`足の読み出しに失敗: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  const vetoYen = resolveScalpTrendVetoYen();
  const regime = computeRegime(bars, now, vetoYen > 0 ? vetoYen : 100);
  const rangeEnabled = resolveEffectiveRangeEnabled();

  // ── technical(本番 runScalpPlanWithChartInner と同じ連結)
  const baseTech = buildNikkeiTechnical(undefined, price ?? undefined);
  const rich = buildRichScalpContextResult(NIKKEI_SYMBOL, price ?? 0, now).text;
  // ★キリ番ブロックは、節目を外した跡地(テクニカル節の直後)に置く。位置を節目と揃えることで
  //   「節目の代わりに何を渡したか」の比較が意味を持つ。
  const kiri = opts.kiriban ? buildKiribanBlock(price ?? 0) : '';
  const technical = `${baseTech ? `${baseTech}\n` : ''}${formatMomentumLine(regime, rangeEnabled)}`
    + `${kiri ? `\n\n${kiri}` : ''}${rich ? `\n\n${rich}` : ''}`;

  // ── 全文(本番 buildScalpPlan の systemPrompt の **データ部分** と同じ組み立て)
  const monitorCtx = buildMonitorContext(now);
  const fullText =
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(prices, now)}\n\n` +
    (technical ? `${technical}\n\n` : '') +
    (monitorCtx ? `${monitorCtx}\n\n` : '') +
    `■ 関連ニュース:\n${formatNewsForChat(news, now, newsQuery)}`;

  // ★節目の扱い(本番の整形には触れず、出来上がった本文から抜く)。
  //   noLevels … 節目由来のブロックを丸ごと外す(最優先)
  //   starLevelsOnly … ★(tier≥1)の行/項目だけ残す
  const stripped = opts.noLevels ? stripLevelBlocks(fullText) : null;
  const filtered = !stripped && opts.starLevelsOnly ? keepOnlyStarLevels(fullText) : null;
  const text = stripped ? stripped.text : (filtered ? filtered.text : fullText);

  const levels = getLevelsSnapshot();
  const diag: ContextDiagnostics = {
    now, price, priceCount: prices.length,
    barCount: bars.length,
    lastBarT: bars.length > 0 ? bars[bars.length - 1]!.t : null,
    levelsUp: levels.up.length, levelsDown: levels.down.length,
    newsCount: news.length,
    blocks: {
      '現在価格': text.includes('■ 現在価格:'),
      '節目(上値/下値メド)': /上値|下値/.test(baseTech ?? ''),
      '勢い': text.includes('勢い'),
      '直近の足': text.includes('直近の足'),
      'テクニカル指標': text.includes('RSI'),
      '直近アラート': text.includes('■ 直近アラート'),
      '本日の日経': text.includes('■ 本日の日経'),
      // ★本番の見出しは「紙トレード成績」(語彙は本番のまま。ユーザー語では仮想取引の成績)。
      '仮想取引の成績': text.includes('トレード成績'),
      '関連ニュース': !text.includes('(ニュースなし)'),
    },
    problems,
    starFilter: filtered ? filtered.stats : null,
    noLevels: stripped ? stripped.stats : null,
  };
  return { text, diag };
}
