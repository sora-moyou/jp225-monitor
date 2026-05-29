export type { Symbol, Price, NewsItem, InstrumentMeta, SSEEvent, AlertEventPayload } from '../server/types.js';
import type { AlertEventPayload } from '../server/types.js';

// v0.3.17: AlertEvent はサーバ側 alertDetector が emit する shape を再 export するだけ。
// 旧 client-side ChangeDetector は廃止。
export type DetectionKind = 'magnitude' | 'slope';
export type AlertEvent = AlertEventPayload;

export interface PriceAction {
  open: number;
  high: number;
  low: number;
  current: number;
}
