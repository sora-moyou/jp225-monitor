import type { Request, Response } from 'express';
import { chat, type Correlate } from '../llm/openai.js';
import { getPrices, getNews } from '../cache.js';
import { buildNikkeiTechnical } from '../chatContext.js';
import { getCorrelationSnapshot } from '../loops/correlationLoop.js';
import { INSTRUMENTS } from '../config.js';

// v0.3.34: AI には「相関の高い1銘柄」だけ渡す。日経の急変が外部(ファンダ)要因か
// 日経固有(テクニカル)要因かを切り分ける材料になればよい(全 movers は渡さない)。
function topCorrelate(): Correlate | undefined {
  const top = getCorrelationSnapshot().ranked[0];
  if (!top) return undefined;
  const tp = getPrices().find(p => p.symbol === top.symbol);
  if (!tp) return undefined;
  const meta = INSTRUMENTS.find(i => i.symbol === top.symbol);
  return {
    label: meta?.labelJa ?? top.symbol,
    corr: top.corr,
    samples: top.samples,
    changePercent: tp.changePercent,
  };
}

interface ChatMsg { role: 'user' | 'assistant'; content: string; }

interface Body {
  messages?: ChatMsg[];
}

function isValidMsg(m: unknown): m is ChatMsg {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  return (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string';
}

export async function chatHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as Body;
  if (!Array.isArray(body.messages) || body.messages.length === 0 || !body.messages.every(isValidMsg)) {
    res.status(400).json({ error: 'invalid messages' });
    return;
  }
  // 安全のため履歴を最新20件にキャップ
  const messages = body.messages.slice(-20);
  try {
    const prices = getPrices();
    const niyPrice = prices.find(p => p.symbol === 'NIY=F')?.price;
    const reply = await chat({
      messages,
      prices,
      news: getNews(),
      // v0.3.36: バー蓄積中でも現在価格から節目メドを出せるよう fallbackPrice を渡す。
      technical: buildNikkeiTechnical(undefined, niyPrice),
      correlate: topCorrelate(),
    });
    res.json({ reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[chat] error:', msg);
    res.status(500).json({ reply: `(チャット失敗: ${msg.slice(0, 120)})` });
  }
}
