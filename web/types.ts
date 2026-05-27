export type { Symbol, Price, NewsItem, InstrumentMeta, SSEEvent } from '../server/types.js';

export type DetectionKind = 'magnitude' | 'slope';

export interface AlertEvent {
  symbol: string;
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: DetectionKind;
  direction: 'up' | 'down';
  triggeredAt: number;
}
