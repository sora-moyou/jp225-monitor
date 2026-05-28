import type { Request, Response } from 'express';
import { translate } from '../llm/openai.js';

interface TranslateBody { text?: string; }

export async function translateHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as TranslateBody;
  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (body.text.length > 2000) {
    res.status(400).json({ error: 'text too long (max 2000 chars)' });
    return;
  }
  try {
    const translated = await translate(body.text);
    res.json({ translated });
  } catch (err) {
    console.error('[translate] error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'translation failed' });
  }
}
