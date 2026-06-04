import type { LevelsResult } from './levels.js';

export type Symbol =
  | 'NIY=F' | 'NQ=F' | 'YM=F' | '^HSI'
  | 'JPY=X' | 'CL=F' | '^TNX'
  | '6861.T' | '9983.T' | '6146.T' | '6273.T'
  | '8035.T' | '9984.T' | '285A.T';   // 値がさ株7(高株価・日経寄与上位)

export interface Price {
  symbol: Symbol;
  price: number;             // Yahoo が返す値そのまま (Nikkei は index 値、ドル円は rate、米株指数も index 値)
  changePercent: number;     // 前日終値比 %
  timestamp: number;
  stale: boolean;
  // v0.3.33: NIY=F のみ。アラート2階層に対応した直近の動きを価格ボードに表示する。
  //   ultraShortYen = 超短期(5〜10秒窓の値幅・円。tickDetector は値幅ベース) 例 +50
  //   shortPct      = 短期(直近60秒の変化率 %。alertLoop 1分burst 相当)
  // 算出に十分なサンプルが無い窓は null。
  momentum?: { ultraShortYen: number | null; shortPct: number | null };
}

export interface NewsItem {
  id: string;
  title: string;
  source: string;
  lang: 'ja' | 'en';
  url: string;
  publishedAt: number;
}

export interface InstrumentMeta {
  symbol: Symbol;
  labelJa: string;
  labelEn: string;
  magnitudeThreshold: number;
  slopeThreshold: number;
  unit: 'percent' | 'bp';
  category?: 'main' | 'heavyweight';   // 値がさ株は 'heavyweight'
}

// AlertEvent shape kept in sync with server/alertDetector.ts (re-declared here to avoid client→alertDetector import)
export interface AlertEventPayload {
  symbol: string;
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: 'slope' | 'magnitude' | 'granville' | 'shock' | 'dtb' | 'break' | 'ma' | 'swingdtb';
  direction: 'up' | 'down';
  triggeredAt: number;
  change15min: number | null;
  pa15min: { open: number; high: number; low: number; current: number } | null;
  range1h: { high: number; low: number } | null;
  zscore: number;
  note?: string;   // 任意: バナーで「%/秒」の代わりに表示する説明(グランビル等)
  level?: number;  // 任意: 対象の価格水準(ダブルトップ/ボトムの水準価格など)
}

export type SSEEvent =
  | { type: 'prices'; payload: Price[] }
  | { type: 'news'; payload: NewsItem[] }
  | { type: 'alert'; payload: AlertEventPayload }
  | { type: 'levels'; payload: LevelsResult };
