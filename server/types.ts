export type Symbol =
  | 'NIY=F' | 'NQ=F' | 'YM=F' | 'ES=F'
  | 'JPY=X' | 'CL=F' | '^VIX' | '^TNX'
  | '9983.T' | '8035.T' | '6857.T' | '9984.T' | '6367.T';   // 値がさ株上位5

export interface Price {
  symbol: Symbol;
  price: number;             // Yahoo が返す値そのまま (Nikkei は index 値、ドル円は rate、米株指数も index 値)
  changePercent: number;     // Yahoo が返す前日比 %
  timestamp: number;
  stale: boolean;
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

export type SSEEvent =
  | { type: 'prices'; payload: Price[] }
  | { type: 'news'; payload: NewsItem[] };
