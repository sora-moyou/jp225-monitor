import type { Request, Response } from 'express';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';

export function levelsHandler(_req: Request, res: Response): void {
  res.json(getLevelsSnapshot());
}
