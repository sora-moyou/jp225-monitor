// アラート再設計(v0.6.0)の共通シグナル型。
// L2 テクニカル検知器は本型の配列を産出し、aggregate.ts が重複排除/コンフルエンス統合/しきい値で
// 1本化してから emitAlert に写像する。各検知器が個別 emit していた従来構成を置き換える基盤。

import type { DetectionKind } from '../../core/detectionKinds.js';

// ★集約パイプラインを通る検知種別だけの **部分集合**(nwave/dailyband/crash はここを通さず直接 emit する)。
//   名前は core/detectionKinds.ts に束ねてあるので、SSOT 側で改名/削除すればここが never になり tsc が落ちる。
//     double   … ダブル天井/大底(swingベース)
//     ma_sr    … MA サポート/レジスタンス(価格がMAで支持/抵抗)
//     level_sr … 意識水準のサポート/レジスタンス(反発確認後)
//     break    … 水準抜け
//     pivot    … スイング転換点の形成
//     trend    … トレンド転換
export type SignalType =
  Extract<DetectionKind, 'double' | 'ma_sr' | 'level_sr' | 'break' | 'pivot' | 'trend'>;

export interface SignalReference {
  kind: string;   // 'sessionLow' | 'prevClose' | 'ma25' | 'swingHigh' | 'neck' | ...(履歴の reference_kind に保存)
  price: number;  // 基準価格(MA値含む)
}

export interface AlertSignal {
  type: SignalType;
  direction: 'up' | 'down';
  reference: SignalReference;
  stage?: 'forming' | 'confirmed';
  score: number;          // 強度(意識度×確認強度×鮮度 等。aggregate でコンフルエンス加点)
  scoreParts?: string[];  // スコア内訳(表示/デバッグ用、任意)
  text: string;           // 明確な日本語(「{基準名}{動作}の可能性」+値)
  triggeredAt: number;
}

// シグナル種別の表示名(コンフルエンス併記やログ用)。
export const SIGNAL_LABEL: Record<SignalType, string> = {
  double: 'ダブル天底',
  ma_sr: 'MAサポレジ',
  level_sr: '水準サポレジ',
  break: '水準抜け',
  pivot: 'スイング形成',
  trend: 'トレンド転換',
};
