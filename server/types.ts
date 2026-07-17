import type { LevelsResult } from './levels.js';

// レンジ両面ストラドルの1レッグ(表示/連携用・engine/openai と同形)。
export interface SignalRangeLeg {
  side: 'buy' | 'sell';
  type: 'limit' | 'stop';
  entry: number;
  stopLoss: number;
}

// ★v0.7.56: 設定スナップショット。各シグナル発生時の実効設定(委任モード+値)を1オブジェクトにまとめ、
// 紙 meta / 実弾 entry_meta に記録し、trade2 が「どの設定でエントリーしたか」を残せるようにする。
// value は AI委任項目で実測可能なもの(LC幅=|entry−SL|)のみ数値、それ以外の ai は省略(mode のみ)。
export interface KnobSettingSnapshot {
  mode: 'manual' | 'ai';
  value?: number | string | boolean;   // manual は設定値 / ai は実測 LC 幅のみ(なければ省略)。
}
export interface SignalSettingsSnapshot {
  lcFloor: KnobSettingSnapshot;
  lcCeiling: KnobSettingSnapshot;
  lcHardMax: { enabled: boolean; value: number };   // 安全上限(policy とは独立)。
  trendVeto: KnobSettingSnapshot;
  cooldown: KnobSettingSnapshot;
  bias: KnobSettingSnapshot;
  range: KnobSettingSnapshot;
}

export type Symbol =
  | 'NIY=F' | 'NQ=F' | 'YM=F' | 'JPY=X'
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
  // v0.6.0 再設計: double/ma_sr/level_sr/break/pivot/trend が現行。dtb/swingdtb/granville/ma は履歴後方互換で残す。
  detectionKind: 'slope' | 'magnitude' | 'granville' | 'shock' | 'dtb' | 'break' | 'ma' | 'swingdtb'
    | 'double' | 'ma_sr' | 'level_sr' | 'pivot' | 'trend' | 'crash' | 'dailyband';
  direction: 'up' | 'down';
  triggeredAt: number;
  change15min: number | null;
  pa15min: { open: number; high: number; low: number; current: number } | null;
  range1h: { high: number; low: number } | null;
  zscore: number;
  note?: string;   // 任意: バナーで「%/秒」の代わりに表示する説明(グランビル等)
  level?: number;  // 任意: 対象の価格水準(ダブルトップ/ボトムの水準価格など)
  referenceKind?: string;   // v0.6.0: 基準の種別(sessionLow/ma/neck/swing/level 等)。履歴の的中率内訳用。
  referencePrice?: number;  // v0.6.0: 基準価格(MA値含む)。
}

// トレードシグナル(表示専用・紙トラッキング)の SSE state。エントリーは AI(scalp-plan)、
// 決済は非公開 phase-exit。売買命令は送らず、現在シグナルの表示のみ(backend→frontend の唯一の IF)。
export interface SignalTradeState {
  phase: 'flat' | 'armed' | 'filled';
  // armed(エントリー注文中)。指値/逆指値の新規と初期LC(1つに正規化・途中のLC移動は出さない)。
  // mode==='range' の時は range(上下2レッグ・片レッグ落ちも可)を持ち、パネルは両面を描く。
  entry?: {
    direction: 'buy' | 'sell';
    limitEntry?: number; stopEntry?: number;
    initialStop?: number;                              // 後方互換: 単一正規化値(指値優先)
    stopLossForLimit?: number; stopLossForStop?: number; // レッグ別 初期LC(指値/逆指値それぞれ)
    rationale?: string; at: number;
    mode?: 'range';
    range?: { upper?: SignalRangeLeg; lower?: SignalRangeLeg };
  };
  // filled(保有中)。決済逆指値は非表示。建値と含み(pt)のみ。
  position?: { direction: 'buy' | 'sell'; entryPrice: number; qty: number; unrealized: number; at: number };
  // 直近決済(決済時に一時表示するため)。
  lastExit?: { exitPrice: number; pnl: number; at: number };
  // 現在シグナル(trade2 追従用)。ARM ごとに signalId を単調増加で採番し、擬似約定(filled)後も保持する
  // (見送り none では更新しない)。既存の表示用フィールドとは独立=パネル表示は不変。
  signal?: {
    signalId: number;
    direction: 'buy' | 'sell';
    limitEntry?: number; stopEntry?: number;
    stopLossForLimit?: number; stopLossForStop?: number;
    at: number;
    // レンジ両面ストラドル(trade2 追従用)。mode==='range' の時は range に上下2レッグ(片レッグ落ちも可)。
    mode?: 'range';
    range?: { upper?: SignalRangeLeg; lower?: SignalRangeLeg };
    // ★v0.7.56: このシグナルの実効設定スナップショット(委任モード+値)。trade2 が entry_meta に記録する。
    //   既存フィールドは不変=在るときだけ付与(パネル表示互換)。
    settings?: SignalSettingsSnapshot;
  };
  // 保有中の意図(trade2 追従用)。filled の間だけ付与し、決済逆指値(computeExitStop の絶対価格)を
  // 毎tick公開する。signalId=そのエントリーの ARM 采番=trade2 が「どの建玉のストップか」を対応づける。
  // exitStop=null は有効な逆指値なし(異常時)。flat/armed では付与しない。既存フィールドは不変=パネル表示互換。
  hold?: {
    signalId: number;
    direction: 'buy' | 'sell';
    entryPrice: number;
    exitStop: number | null;
    at: number;   // エントリー約定時刻(= position.at)。建玉の対応キー(exitStop 自体は毎tick動く)。
  };
  updatedAt: number;
}

export type SSEEvent =
  | { type: 'prices'; payload: Price[] }
  | { type: 'news'; payload: NewsItem[] }
  | { type: 'alert'; payload: AlertEventPayload }
  | { type: 'levels'; payload: LevelsResult }
  // v0.7.24: 市場開場フラグ。価格ボードが「取引時間外(閉場・正常)」と「取得不能(フィード障害)」を区別する。
  | { type: 'market'; payload: { open: boolean } }
  // トレードシグナルの現在状態(flat/armed/filled)。既存イベントは不変・これは新規追加。
  | { type: 'signalTrade'; payload: SignalTradeState };
