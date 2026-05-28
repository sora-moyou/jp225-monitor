import type { Request, Response } from 'express';
import { chat } from '../llm/openai.js';
import { getPrices, getNews } from '../cache.js';

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
    const reply = await chat({
      messages,
      prices: getPrices(),
      news: getNews(),
    });
    res.json({ reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[chat] error:', msg);
    res.status(500).json({ reply: `(チャット失敗: ${msg.slice(0, 120)})` });
  }
}
