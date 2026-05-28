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
  /** 直近15分の参考変化率 (発火窓と分離したコンテキスト) */
  change15min: number | null;
}
