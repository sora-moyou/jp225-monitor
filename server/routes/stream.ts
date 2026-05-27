import type { Request, Response } from 'express';
import { register, unregister } from '../sse/broker.js';
import { getPrices, getNews } from '../cache.js';

export function streamHandler(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 接続直後に最新値を一回送る
  const prices = getPrices();
  if (prices.length > 0) {
    res.write(`event: prices\ndata: ${JSON.stringify(prices)}\n\n`);
  }
  const news = getNews();
  if (news.length > 0) {
    res.write(`event: news\ndata: ${JSON.stringify(news)}\n\n`);
  }

  register(res);
  req.on('close', () => unregister(res));
}
