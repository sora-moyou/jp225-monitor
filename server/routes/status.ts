import type { Request, Response } from 'express';
import { getYahooStatus } from '../loops/priceLoop.js';
import { getProviderStatus } from '../llm/openai.js';

export function statusHandler(_req: Request, res: Response): void {
  res.json({
    yahoo: getYahooStatus(),
    llm: getProviderStatus(),
  });
}
