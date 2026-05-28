import type { Request, Response } from 'express';
import { getLogs } from '../logBuffer.js';

export function logsHandler(req: Request, res: Response): void {
  const sinceRaw = req.query['since'];
  const since = typeof sinceRaw === 'string' ? Number(sinceRaw) : NaN;
  const logs = Number.isFinite(since) ? getLogs(since) : getLogs();
  res.json({ logs });
}
