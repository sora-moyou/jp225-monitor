import type { Request, Response } from 'express';
import { explain } from '../llm/openai.js';
import { getNews } from '../cache.js';

interface ExplainBody {
  symbolLabel?: string;
  changePercent?: number;
  windowSeconds?: number;
  detectionKind?: 'magnitude' | 'slope';
}

export async function explainHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as ExplainBody;
  if (typeof body.symbolLabel !== 'string'
      || typeof body.changePercent !== 'number'
      || typeof body.windowSeconds !== 'number'
      || (body.detectionKind !== 'magnitude' && body.detectionKind !== 'slope')) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  try {
    const text = await explain({
      symbolLabel: body.symbolLabel,
      changePercent: body.changePercent,
      windowSeconds: body.windowSeconds,
      detectionKind: body.detectionKind,
      news: getNews(),
    });
    res.json({ explanation: text });
  } catch (err) {
    console.error('[explain] error:', err);
    res.status(500).json({ explanation: '(説明取得失敗)' });
  }
}
