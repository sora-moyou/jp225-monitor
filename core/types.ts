// core/types.ts — 共有 DTO 型のリーフ層。
// ここは core 境界の最下層: server/ や collector/ から何も import してはならない(非循環)。
// これらの型は backend/frontend(web)双方が参照する「送受信スキーマ」なので core に置く。

import type { DetectionKind } from './detectionKinds.js';
// NewsItem に載せるインパクト推定の型。実体(重み・純関数)は core/newsImpact.ts。
// 型のみの import なのでコンパイル後に消え、実行時の循環は生じない。
import type { NewsImpact } from './newsImpact.js';
import type { NewsConfidence } from './newsConfidence.js';

export type { DetectionKind };

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
  // ★ドテン(反転)許可の委任状態(ADD-ONLY): 許可 ON の時だけ true を載せる。OFF(既定)では欠落=既存 meta JSON 不変。
  dotenEnabled?: true;
  // ★レンジ再評価(未約定→ブレイク)の許可状態(ADD-ONLY): レンジ使用時のみ載せる(レンジOFF=既定では欠落=既存 meta JSON 不変)。
  rangeReevalEnabled?: boolean;
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
  // ★インパクト推定(ADD-ONLY・任意)。算出は core/newsImpact.ts の純関数、付与は取得ループ。
  //   欠落=旧世代のペイロード(表示側は時刻順にフォールバックする)。AI 文脈の組み立ては
  //   この欄を読まない(server/llm/explain.ts の scoreNews は従来どおり)=表示だけの追加。
  impact?: NewsImpact;
  // ★確度(ADD-ONLY・任意)。インパクトとは **独立した軸**。算出は core/newsConfidence.ts。
  //   スコアには混ぜない(混ぜると未確認=減点になり、相場が最も動く第一報が沈む)。
  //   表示のバッジと、後からの検証(DB の confidence 列)にだけ使う。
  confidence?: NewsConfidence;
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
  // ★種別の定義は core/detectionKinds.ts が唯一の真実(union の手書きコピーはもう無い)。
  //   v0.6.0 再設計: double/ma_sr/level_sr/break/pivot/trend が現行。dtb/swingdtb/granville/ma は履歴後方互換で残す。
  detectionKind: DetectionKind;
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

// ── 反応水準(Level)。宣言は core に置き、算出モジュール server/levels.ts が再export する
//    (core → server/levels の循環を避けるため。levels.ts は算出コードのみを持つ)。
export interface Level {
  price: number;
  dist: number;             // price - current (5円丸め)
  labels: string[];
  strong: boolean;          // 後方互換: tier>=1
  score: number;            // 意識度スコア
  tier: 0 | 1 | 2;          // 相対ランク(0=通常 / 1=★ / 2=★★合流帯)
  confluence: boolean;      // 合流倍率が掛かったか(tier2 判定に使用)
  fib?: number;             // 0.382 | 0.5 | 0.618 など
  reversalLine?: boolean;   // fib 50% の方向転換ライン
}
export interface LevelsResult {
  current: number;
  up: Level[];
  down: Level[];
  swing: { high: number; low: number; leg: 'up' | 'down' } | null;
  reversalSatisfied: boolean;
  asOf: number;
  // 高安関係の全水準(クラスタ/上位N選抜・スコア合計によらず全件)。ダブルトップ/ボトム検知用に露出。
  hlLevels?: { price: number; label: string }[];
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
    rationale?: string;   // ★保有中もシグナル枠に理由を表示するため(現在シグナルの根拠)。
    at: number;
    // レンジ両面ストラドル(trade2 追従用)。mode==='range' の時は range に上下2レッグ(片レッグ落ちも可)。
    mode?: 'range';
    range?: { upper?: SignalRangeLeg; lower?: SignalRangeLeg };
    // ★v0.7.56: このシグナルの実効設定スナップショット(委任モード+値)。trade2 が entry_meta に記録する。
    //   既存フィールドは不変=在るときだけ付与(パネル表示互換)。
    settings?: SignalSettingsSnapshot;
    // ★ドテン(反転)シグナル(ADD-ONLY): 実 doten の時だけ true。反転指示=保有と反対方向・limit/stop/SL は新規反対建玉・
    //   signalId は新規採番。trade2 は「doten:true + 新 signalId + FILLED」を専用トリガーにする。非 doten では欠落=既存 JSON 不変。
    doten?: true;
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
    // ★レンジ建玉のTP(反対側レンジ節目・利益側のみ)。設定時は損側=固定initialStop(ラチェットせず)、
    //   利側=tpTrigger(節目の5円内側)到達で成行決済。directional / rangeTp 無しでは付与しない。
    rangeTp?: number;      // 反対側レンジ節目(TP目標の生値)。
    tpTrigger?: number;    // 成行TPの発火価格(buy=rangeTp−5 / sell=rangeTp+5)。
  };
  // ★直近に「決済(filled→flat)した」シグナルの signalId(trade2 の即時再同期用・A のみ)。
  //   紙エンジンが約定中の建玉を決済した瞬間に、そのエントリーの ARM 采番(currentSignal.signalId)を載せ、
  //   次の決済まで保持する(late-join の追従側も読める)。ADD-ONLY: 一度も決済していない state では欠落=
  //   既存 SSE JSON は不変(lastBroadcastJson の dedupe と既定挙動を保つ)。決済ロジック/紙損益には無影響。
  lastExitedSignalId?: number;
  // ★未約定失効(armed-timeout)の累計(ADD-ONLY)。「武装したのに一度も約定せず15分で失効した」回数。
  //   monitor が正規シグナルを出したのに trade2 が受信後ずっと拒否する乖離は、必ずここに終着する。
  //   実測 sid=361(2026-07-30)は trade2 が147回拒否したが monitor 側には件数がどこにも残らず完全に無音だった。
  //   count===0 のときは付与しない=既存 SSE JSON 不変(broadcast dedupe と旧クライアント互換を壊さない)。
  //   ★v0.9.59: 表示は「累計」ではなく streak(連続失効=約定のたびに 0 へ戻る)を使う。count(累計)は
  //     「無音の失敗を数える」ための別指標として残す(消さない)。waitMin/bias は待機表示の材料:
  //     waitMin=直前に失効したブラケットで **実際に使われた** 待ち時間[分](可変なので固定文字列にしない)、
  //     bias=直前に失効したブラケットの向き(パネルの「買い目線/売り目線/レンジ」と同じ語彙)。
  //     不明なら欠落させる(空括弧や「不明」を出さない)。
  armedTimeout?: { count: number; streak: number; lastAt: number; waitMin?: number; bias?: 'buy' | 'sell' | 'range' };
  updatedAt: number;
}

// ── テクニカル指標(RSI/SMA/BB)の SSE ペイロード。算出は server/indicators.ts(core→server 非依存のため
//    ここで送受信スキーマだけを宣言し、server 側の IndicatorSnapshot が構造的に一致する)。
export interface IndicatorValuesPayload {
  rsi: number | null;
  sma: number | null;
  bbUpper: number | null;
  bbMid: number | null;
  bbLower: number | null;
  price: number;
  pctB: number | null;
}
export interface IndicatorPointPayload {
  t?: number;
  close: number;
  rsi: number | null;
  sma: number | null;
  bbU: number | null;
  bbL: number | null;
}
// ★蓄積状況(ADD-ONLY・任意)。パネルが「蓄積中…」の理由を画面だけで自己診断するための状態マーカー。
//   'no-bars'=窓内の1分足が0本(データ供給そのものが無い)/ 'warming'=足はあるが本数不足(remaining=残り本数)/
//   'ready'=主指標を算出済み / 'closed'=取引時間外(ドーマント)/ 'disabled'=機能OFF(設定)。
//   既存フィールドの意味は一切変えない(欠落=旧世代=従来表示)。
export interface IndicatorProgressPayload {
  state: 'no-bars' | 'warming' | 'ready' | 'closed' | 'disabled';
  remaining: number;
}
export interface IndicatorSnapshotPayload extends IndicatorValuesPayload {
  series: IndicatorPointPayload[];
  t?: number;
  live?: IndicatorValuesPayload;
  progress?: IndicatorProgressPayload;
}

export type SSEEvent =
  | { type: 'prices'; payload: Price[] }
  | { type: 'news'; payload: NewsItem[] }
  | { type: 'alert'; payload: AlertEventPayload }
  | { type: 'levels'; payload: LevelsResult }
  // ★テクニカル指標(RSI/SMA/BB)の現在値+直近系列。表示/AI文脈専用(検知アラートではない)。indicatorsLoop が配信。
  | { type: 'indicators'; payload: IndicatorSnapshotPayload }
  // v0.7.24: 市場開場フラグ。価格ボードが「取引時間外(閉場・正常)」と「取得不能(フィード障害)」を区別する。
  | { type: 'market'; payload: { open: boolean } }
  // トレードシグナルの現在状態(flat/armed/filled)。既存イベントは不変・これは A(実売買)系統。
  | { type: 'signalTrade'; payload: SignalTradeState }
  // ★v0.8.2: System B(紙専用の並走系統)の現在状態。A とは別イベントで露出する。
  //   B は currentSignal/hold を持たない(trade2 は B を絶対に追わない)=payload の signal/hold は常に欠落。
  | { type: 'signalTradeB'; payload: SignalTradeState };
