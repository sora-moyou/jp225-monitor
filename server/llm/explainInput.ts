// /api/explain と チャットの explain_move ツールで共有する ExplainInput 組立。
// news/crossAsset/newsSince/newsWindowMs/l2Recent を同一規約で組むための単一ソース。
// 規約: 暴落(crash)はニュース窓を広く(24h)・絞り込みなし(newsSince=0)で原因分析(ユーザー指定)。
// それ以外は「前回アラート以降」(newsSinceForAlert)に限定し、同じ古いニュースを毎回引用しない。
import type { ExplainInput } from './openai.js';
import { getNews } from '../cache.js';
import { getSignificantMovers } from '../marketSnapshot.js';
import { newsSinceForAlert } from '../shockWindow.js';
import { getRecentL2Summary } from '../alertHistory.js';

export interface BuildExplainArgs {
  symbol: string;
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: ExplainInput['detectionKind'];
  direction?: 'up' | 'down';
  change15min?: number | null;
  pa15min?: ExplainInput['pa15min'];
  range1h?: ExplainInput['range1h'];
}

const CRASH_NEWS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** route と tool が同一規約で ExplainInput を組む。news/crossAsset/l2Recent も内部で取得する。 */
export function buildExplainInput(a: BuildExplainArgs): ExplainInput {
  const isCrash = a.detectionKind === 'crash';
  return {
    symbol: a.symbol,
    symbolLabel: a.symbolLabel,
    changePercent: a.changePercent,
    windowSeconds: a.windowSeconds,
    detectionKind: a.detectionKind,
    direction: a.direction,
    change15min: typeof a.change15min === 'number' ? a.change15min : null,
    pa15min: a.pa15min ?? null,
    range1h: a.range1h ?? null,
    news: getNews(),
    crossAsset: getSignificantMovers(a.symbol),
    // 暴落はニュース窓を広く・絞り込みなし。それ以外は前回アラート以降に限定。
    newsSince: isCrash ? 0 : newsSinceForAlert(),
    newsWindowMs: isCrash ? CRASH_NEWS_WINDOW_MS : undefined,
    l2Recent: getRecentL2Summary(Date.now()) ?? undefined, // テクニカル判定時に直近L2状態を併記
  };
}
