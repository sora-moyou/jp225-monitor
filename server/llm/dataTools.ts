import type { NewsItem, Price } from '../types.js';
import { INSTRUMENTS } from '../config.js';
import { tokyoCashOpen } from '../../core/session.js';
import { bigrams } from '../../core/textBigrams.js';
import { openDb, resolveDbPath, getRecentAlerts, getSessionOHLC, getRecentBars, type AlertRow } from '../db/store.js';
import { rowKind, summarize } from '../alertHistory.js';
import { crashDrawdown } from '../crash.js';
import { getPrices } from '../cache.js';
import { buildExplainInput } from './explainInput.js';
import { noteReferencedNews } from '../shockWindow.js';
import { explain, fmt, type ExplainInput } from './explain.js';

const LABEL_MAP = new Map(INSTRUMENTS.map(i => [i.symbol as string, i]));

export function formatPricesForChat(prices: Price[], now: number): string {
  if (prices.length === 0) return '(価格未取得)';
  const cashOpen = tokyoCashOpen(now);
  return prices.map(p => {
    const meta = LABEL_MAP.get(p.symbol);
    const label = meta?.labelJa ?? p.symbol;
    const sign = p.changePercent >= 0 ? '+' : '';
    // 東証個別株(.T)は 9:00-15:30 のみ取引。場外は前回終値で動かないので「今動いた」材料に誤用させない。
    const tokyoClosed = meta?.category === 'heavyweight' && !cashOpen;
    const staleMark = tokyoClosed ? ' ※東証クローズ中・前回終値(値動きなし)' : (p.stale ? ' (stale)' : '');
    const chgLabel = tokyoClosed ? '前場引け比' : '';
    return `- ${label} ${p.symbol}: ${fmt(p.price)} (${sign}${p.changePercent.toFixed(2)}%${chgLabel ? ' ' + chgLabel : ''})${staleMark}`;
  }).join('\n');
}

// 文字バイグラムは core/textBigrams.ts が唯一の実装(ニュースの裏取り判定と共用)。
// ここに関数のコピーを戻さないこと(2 箇所に置くと片方だけ直して黙ってズレる)。挙動は移設前と同一。

export function formatNewsForChat(news: NewsItem[], now: number, queryText = ''): string {
  if (news.length === 0) return '(ニュースなし)';
  // ③: 最新発話と文字バイグラムが重なるニュースを優先。重なりゼロなら直近にフォールバック。
  const qGrams = new Set(bigrams(queryText));
  const scored = news.map(n => {
    const title = n.title.toLowerCase();
    let hits = 0;
    for (const g of qGrams) if (title.includes(g)) hits++;
    return { n, hits };
  });
  const relevant = scored.filter(s => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.n.publishedAt - a.n.publishedAt)
    .slice(0, 12)
    .map(s => s.n);
  const list = relevant.length > 0 ? relevant : news.slice(0, 15);
  return list.map(n => {
    const ageMin = Math.max(0, Math.round((now - n.publishedAt) / 60000));
    return `- [${ageMin}分前] [${n.source}] ${n.title}`;
  }).join('\n');
}

export const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: '最新の市況・ニュース・出来事を調べる。価格や材料を聞かれて手元のコンテキストに無い/古い時に使う。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '検索クエリ(日本語可)' } }, required: ['query'] },
  },
};
// ─── monitor 自身のデータ参照ツール(外部キー不要・常時有効) ───
export const NIKKEI_SYMBOL = 'NIY=F';   // チャット/テクニカルと同じ日経シンボル(config INSTRUMENTS の main)

export const EXPLAIN_MOVE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'explain_move',
    description: '直近の急変(急落/急騰)の原因を分析する。「なぜ急落した?」等、値動きの理由を問われたら使う。ニュース近接・他資産連動・極性から原因文を返す。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '銘柄シンボル(省略時は日経 NIY=F)' },
        sinceMinutes: { type: 'number', description: '何分前までの急変を対象にするか(省略時60)' },
      },
    },
  },
};

export const QUERY_ALERTS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'query_alerts',
    description: '直近のアラート履歴(暴落/急変/節目抜け/トレンド転換等)と種別別の継続率・戻り率・平均リターンを要約する。「最近どんなアラートが出た?」等に使う。',
    parameters: {
      type: 'object',
      properties: {
        withinMinutes: { type: 'number', description: '何分前までを対象にするか(省略時120)' },
        limit: { type: 'number', description: '最大件数(省略時10)' },
      },
    },
  },
};

export const PRICE_HISTORY_TOOL = {
  type: 'function' as const,
  function: {
    name: 'price_history',
    description: '価格履歴を要約する。本日のセッションOHLC(today)か直近N分の値動き(recent)を返す。「本日の高安は?」「直近の値動きは?」等に使う。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '銘柄シンボル(例 NIY=F)' },
        window: { type: 'string', enum: ['today', 'recent'], description: 'today=本日OHLC / recent=直近N分(省略時 today)' },
        minutes: { type: 'number', description: 'recent の対象分数(省略時60)' },
      },
      required: ['symbol'],
    },
  },
};

const MAX_TOOL_ROUNDS = 3;

export type CreateFn = (params: Record<string, unknown>) => Promise<any>;
/** ツール名→ハンドラ。引数は JSON.parse 済みオブジェクト。短い説明文字列を返す(例外を投げない)。 */
export type ToolHandlers = Record<string, (args: any) => Promise<string>>;

/** ツール実行ループ。tool_calls が出る限りハンドラへディスパッチ→再投入。上限到達時は tools 無しで最終回答。
 *  テスト可能な純ループ。handlers は tool_call の function.name で引く(未知名は「unknown tool」を返しループ継続)。 */
export async function runChatWithTools(
  create: CreateFn, messages: any[], tools: unknown[], handlers: ToolHandlers, maxRounds = MAX_TOOL_ROUNDS,
): Promise<string> {
  const msgs = [...messages];
  for (let round = 0; round < maxRounds; round++) {
    const completion = await create({ messages: msgs, tools, tool_choice: 'auto' });
    const choice = completion.choices?.[0];
    const msg = choice?.message;
    const calls = msg?.tool_calls;
    if (!calls || calls.length === 0) {
      const text = msg?.content?.trim() ?? '(no response)';
      return choice?.finish_reason === 'length' ? text + ' …(token切れ)' : text;
    }
    msgs.push(msg);
    for (const tc of calls) {
      const name = tc.function?.name ?? '';
      const handler = handlers[name];
      let result: string;
      if (!handler) {
        result = `(unknown tool: ${name || 'unnamed'})`;
      } else {
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch { args = {}; }
        // ハンドラ自身が try/catch する規約だが、二重の安全網としてここでも握る。
        try { result = await handler(args); } catch (e) { result = `(ツール失敗: ${e instanceof Error ? e.message : String(e)})`; }
      }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  // 上限到達: tools 無しで必ず1回答
  const final = await create({ messages: msgs });
  return final.choices?.[0]?.message?.content?.trim() ?? '(no response)';
}

// ─── monitor データ参照: 常時注入ブロック & ツールハンドラ ───

function hhmm(t: number): string {
  return new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
}

/** チャット system prompt に常時注入する monitor データ要約(直近アラート + 本日OHLC)。
 *  DB 不在/データ無しでも例外を投げず、出せるブロックだけ返す(空なら '')。 */
export function buildMonitorContext(now = Date.now()): string {
  const blocks: string[] = [];
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    // 直近アラート(60分以内・最大8件)
    try {
      const recent = getRecentAlerts(db, 8).filter(a => now - a.triggered_at <= 60 * 60_000);
      if (recent.length > 0) {
        const lines = recent.map(a => {
          const arrow = a.direction === 'up' ? '▲' : a.direction === 'down' ? '▼' : '';
          const price = a.price != null ? Math.round(a.price).toLocaleString('ja-JP') : '-';
          return `- ${hhmm(a.triggered_at)} ${rowKind(a.detection_kind, a.window_seconds)} ${arrow} ${price}`;
        });
        blocks.push(`■ 直近アラート(60分以内):\n${lines.join('\n')}`);
      }
    } catch { /* アラート要約は欠落許容 */ }
    // 本日のセッションOHLC(日経 NIY)
    try {
      const s = getSessionOHLC(db, NIKKEI_SYMBOL, 1)[0];
      if (s) {
        blocks.push(`■ 本日の日経(${s.session}): 高値 ${Math.round(s.high).toLocaleString('ja-JP')}(${hhmm(s.highT)}) / `
          + `安値 ${Math.round(s.low).toLocaleString('ja-JP')}(${hhmm(s.lowT)}) / 現値 ${Math.round(s.close).toLocaleString('ja-JP')}`);
      }
    } catch { /* OHLC は欠落許容 */ }
  } catch { /* DB 不在は無視(注入なし) */ }
  finally { try { db?.close(); } catch { /* ignore */ } }
  return blocks.join('\n\n');
}

/** explain_move の入力組立(DB 読みのみ・LLM 非依存=テスト可能)。直近の crash/shock 行、
 *  無ければセッション高値 vs 現在値を crashDrawdown で算出して BuildExplainArgs を返す。該当無しは null。 */
export function resolveExplainMoveArgs(
  db: ReturnType<typeof openDb>, symbol: string, sinceMs: number, now: number,
): import('./explainInput.js').BuildExplainArgs | null {
  const meta = LABEL_MAP.get(symbol);
  const symbolLabel = meta?.labelJa ?? symbol;
  // 1) 直近の crash/shock アラート行を探す(対象シンボル・期間内)
  const row = getRecentAlerts(db, 30).find(a =>
    a.symbol === symbol && (a.detection_kind === 'crash' || a.detection_kind === 'shock')
    && now - a.triggered_at <= sinceMs);
  if (row) {
    return {
      symbol, symbolLabel,
      changePercent: row.change_percent ?? 0,
      windowSeconds: row.window_seconds ?? 60,
      detectionKind: row.detection_kind as ExplainInput['detectionKind'],
      direction: row.direction === 'up' || row.direction === 'down' ? row.direction : undefined,
      change15min: null, pa15min: null, range1h: null,
    };
  }
  // 2) アラート行が無ければセッション高値 vs 現在値を crashDrawdown で算出
  const s = getSessionOHLC(db, symbol, 1)[0];
  const current = getPrices().find(pp => pp.symbol === symbol)?.price ?? s?.close ?? 0;
  if (!s || current <= 0) return null;
  const dd = crashDrawdown(s.high, current);   // 高値からの下落率(0〜1)
  const changePercent = -dd * 100;             // 下落=負
  return {
    symbol, symbolLabel, changePercent, windowSeconds: 300,
    detectionKind: dd >= 0.03 ? 'crash' : 'shock',
    direction: changePercent >= 0 ? 'up' : 'down',
    change15min: null, pa15min: null, range1h: null,
  };
}

/** explain_move: 直近の crash/shock 行(無ければセッション高値 vs 現在値)を特定し explain() で原因文を返す。 */
async function handleExplainMove(args: { symbol?: string; sinceMinutes?: number }): Promise<string> {
  const now = Date.now();
  const symbol = typeof args.symbol === 'string' && args.symbol ? args.symbol : NIKKEI_SYMBOL;
  const sinceMs = (typeof args.sinceMinutes === 'number' && args.sinceMinutes > 0 ? args.sinceMinutes : 60) * 60_000;
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    const moveArgs = resolveExplainMoveArgs(db, symbol, sinceMs, now);
    if (!moveArgs) return '該当する急変データなし。';
    const result = await explain(buildExplainInput(moveArgs));
    if (result.newsMaxPublishedAt > 0) noteReferencedNews(result.newsMaxPublishedAt);
    return result.text;
  } catch (e) {
    return `(原因分析に失敗: ${e instanceof Error ? e.message : String(e)})`;
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** query_alerts: 直近アラート一覧 + 種別別 継続率/戻り率/平均リターンの要約。 */
async function handleQueryAlerts(args: { withinMinutes?: number; limit?: number }): Promise<string> {
  const now = Date.now();
  const withinMs = (typeof args.withinMinutes === 'number' && args.withinMinutes > 0 ? args.withinMinutes : 120) * 60_000;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : 10;
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    const rows: AlertRow[] = getRecentAlerts(db, Math.max(limit, 50)).filter(a => now - a.triggered_at <= withinMs);
    if (rows.length === 0) return `直近${Math.round(withinMs / 60_000)}分のアラートなし。`;
    const list = rows.slice(0, limit).map(a => {
      const arrow = a.direction === 'up' ? '▲' : a.direction === 'down' ? '▼' : '';
      const price = a.price != null ? Math.round(a.price).toLocaleString('ja-JP') : '-';
      return `- ${hhmm(a.triggered_at)} ${rowKind(a.detection_kind, a.window_seconds)} ${arrow} ${price}`;
    });
    const stats = summarize(rows).map(s =>
      `- ${s.label}(${s.count}件): 継続${(s.hitRate * 100).toFixed(0)}% 戻り${(s.revertRate * 100).toFixed(0)}% 15分平均${s.avgRet15 >= 0 ? '+' : ''}${s.avgRet15.toFixed(2)}%`);
    return `直近アラート:\n${list.join('\n')}\n\n種別別統計(15分基準):\n${stats.join('\n')}`;
  } catch (e) {
    return `(アラート照会に失敗: ${e instanceof Error ? e.message : String(e)})`;
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** price_history: 本日OHLC(today)か直近N分(recent)の値動きを要約。 */
async function handlePriceHistory(args: { symbol?: string; window?: 'today' | 'recent'; minutes?: number }): Promise<string> {
  const symbol = typeof args.symbol === 'string' && args.symbol ? args.symbol : NIKKEI_SYMBOL;
  const meta = LABEL_MAP.get(symbol);
  const label = meta?.labelJa ?? symbol;
  const window = args.window === 'recent' ? 'recent' : 'today';
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    if (window === 'today') {
      const s = getSessionOHLC(db, symbol, 1)[0];
      if (!s) return `${label}: 本日のデータなし。`;
      const move = s.open > 0 ? ((s.close - s.open) / s.open) * 100 : 0;
      return `${label} 本日(${s.session}): 始値 ${fmt(s.open)} / 高値 ${fmt(s.high)}(${hhmm(s.highT)}) / `
        + `安値 ${fmt(s.low)}(${hhmm(s.lowT)}) / 現値 ${fmt(s.close)}(始値比 ${move >= 0 ? '+' : ''}${move.toFixed(2)}%)`;
    }
    const minutes = typeof args.minutes === 'number' && args.minutes > 0 ? Math.min(Math.floor(args.minutes), 1440) : 60;
    const bars = getRecentBars(db, symbol, Date.now() - minutes * 60_000);
    if (bars.length === 0) return `${label}: 直近${minutes}分のデータなし。`;
    const open = bars[0]!.o;
    const last = bars[bars.length - 1]!.c;
    let high = -Infinity, low = Infinity;
    for (const b of bars) { if (b.h > high) high = b.h; if (b.l < low) low = b.l; }
    const move = open > 0 ? ((last - open) / open) * 100 : 0;
    return `${label} 直近${minutes}分: 始値 ${fmt(open)} / 高値 ${fmt(high)} / 安値 ${fmt(low)} / `
      + `現値 ${fmt(last)}(${move >= 0 ? '+' : ''}${move.toFixed(2)}%)`;
  } catch (e) {
    return `(価格履歴に失敗: ${e instanceof Error ? e.message : String(e)})`;
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** データツールのハンドラマップ(外部キー不要・常時有効)。 */
export function buildDataToolHandlers(): ToolHandlers {
  return {
    explain_move: handleExplainMove,
    query_alerts: handleQueryAlerts,
    price_history: handlePriceHistory,
  };
}
