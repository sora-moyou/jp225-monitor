import type { Request, Response } from 'express';
import { register, unregister } from '../sse/broker.js';
import { getPrices, getNews } from '../cache.js';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';

export function streamHandler(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 接続直後に最新値を一回送る(levels は signature 変化時のみ broadcast されるため、
  // スコアリングで代表価格が安定すると新規接続クライアントは broadcast を取りこぼし
  // 「水準ボードが空」になる。prices/news と同様に接続時スナップショットで補う)。
  const prices = getPrices();
  if (prices.length > 0) {
    res.write(`event: prices\ndata: ${JSON.stringify(prices)}\n\n`);
  }
  const news = getNews();
  if (news.length > 0) {
    res.write(`event: news\ndata: ${JSON.stringify(news)}\n\n`);
  }
  const levels = getLevelsSnapshot();
  if (levels.up.length > 0 || levels.down.length > 0) {
    res.write(`event: levels\ndata: ${JSON.stringify(levels)}\n\n`);
  }

  register(res);
  req.on('close', () => unregister(res));
}
