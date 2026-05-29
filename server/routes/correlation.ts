import type { Request, Response } from 'express';
import { getCorrelationSnapshot } from '../loops/correlationLoop.js';

export function correlationHandler(_req: Request, res: Response): void {
  res.json(getCorrelationSnapshot());
}
