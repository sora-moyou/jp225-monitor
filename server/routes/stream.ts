import type { Request, Response } from 'express';
import { register, unregister } from '../sse/broker.js';
import { getPrices, getNews } from '../cache.js';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';
import { getIndicatorsSnapshot } from '../loops/indicatorsLoop.js';
import { getSignalTradeState, getSignalTradeStateB } from '../signalTrade/engine.js';
import { isMarketOpen } from '../../core/session.js';

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
  // テクニカル指標(RSI/SMA/BB)の最新スナップショットを接続直後に一回送る(levels と同様に broadcast 取りこぼしを補う)。
  const indicators = getIndicatorsSnapshot();
  if (indicators) {
    res.write(`event: indicators\ndata: ${JSON.stringify(indicators)}\n\n`);
  }
  // v0.7.24: 接続直後に市場開場フラグを一回送る(price ループの state 変化 broadcast を取りこぼす新規接続を補う)。
  res.write(`event: market\ndata: ${JSON.stringify({ open: isMarketOpen(Date.now()) })}\n\n`);

  // トレードシグナルの現在状態を接続直後に一回送る(engine の tick broadcast を取りこぼす新規接続を補う)。
  res.write(`event: signalTrade\ndata: ${JSON.stringify(getSignalTradeState())}\n\n`);
  // ★v0.8.2: System B(紙専用)の現在状態も接続直後に一回送る(A とは別イベント。currentSignal は含まない)。
  res.write(`event: signalTradeB\ndata: ${JSON.stringify(getSignalTradeStateB())}\n\n`);

  register(res);
  req.on('close', () => unregister(res));
}
