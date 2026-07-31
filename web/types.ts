// STEP 2 リファクタ: 共有 DTO 型は core/types.ts に集約。web→server の型依存を断つため core から取る。
export type { Symbol, Price, NewsItem, InstrumentMeta, SSEEvent, AlertEventPayload, LevelsResult, Level } from '../core/types.js';
export type { IndicatorSnapshotPayload as IndicatorSnapshot, IndicatorValuesPayload, IndicatorPointPayload, IndicatorProgressPayload } from '../core/types.js';
import type { AlertEventPayload } from '../core/types.js';

// v0.3.17: AlertEvent はサーバ側 alertDetector が emit する shape を再 export するだけ。
// 旧 client-side ChangeDetector は廃止。
// ★検知種別は core/detectionKinds.ts が唯一の定義。ここで手書きコピーを持たない
//   (かつてここのコピーだけ 'dailyband' / 'nwave' を欠いたまま放置されていた)。
export type { DetectionKind } from '../core/detectionKinds.js';
export type AlertEvent = AlertEventPayload;

export interface PriceAction {
  open: number;
  high: number;
  low: number;
  current: number;
}
