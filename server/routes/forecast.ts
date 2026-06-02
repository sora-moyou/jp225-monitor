import type { Request, Response } from 'express';
import { getForecastSnapshot } from '../loops/forecastLoop.js';

export function forecastHandler(_req: Request, res: Response): void {
  res.json(getForecastSnapshot());
}
