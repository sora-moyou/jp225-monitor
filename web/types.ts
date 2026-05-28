export type { Symbol, Price, NewsItem, InstrumentMeta, SSEEvent } from '../server/types.js';

export type DetectionKind = 'magnitude' | 'slope';

export interface PriceAction {
  open: number;
  high: number;
  low: number;
  current: number;
}

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
  /** 直近15分のOHLC (テクニカル分析用) */
  pa15min: PriceAction | null;
  /** 直近1時間の最高値/最安値 (短期サポレジ参考) */
  range1h: { high: number; low: number } | null;
}
