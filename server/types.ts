export type Symbol =
  | 'NK=F' | 'NQ=F' | 'YM=F' | 'ES=F'
  | 'JPY=X' | 'CL=F' | '^VIX' | '^TNX'
  | '9983.T' | '8035.T' | '6857.T' | '9984.T' | '6367.T';   // 値がさ株上位5

export interface Price {
  symbol: Symbol;
  price: number;             // 元の通貨での価格 (USD 建て銘柄は USD、JPY 建ては JPY)
  changePercent: number;     // 元の通貨での前日比 (Yahoo 提供)
  timestamp: number;
  stale: boolean;
  // ─── JPY 換算 (USD 建て銘柄のみ、JPY=X レートで変換) ───
  // 値があるかどうかで「USD 銘柄かつ JPY=X 利用可能」を判定可能。
  // アラート検知・相関計算は jpyPrice を優先して使い、円ベースで一貫させる。
  jpyPrice?: number;
  jpyChangePercent?: number;
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
