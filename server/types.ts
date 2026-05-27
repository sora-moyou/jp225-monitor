export type Symbol =
  | 'NK=F' | 'NQ=F' | 'YM=F' | 'ES=F'
  | 'JPY=X' | 'CL=F' | '^VIX' | '^TNX';

export interface Price {
  symbol: Symbol;
  price: number;
  changePercent: number;
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
}

export type SSEEvent =
  | { type: 'prices'; payload: Price[] }
  | { type: 'news'; payload: NewsItem[] };
