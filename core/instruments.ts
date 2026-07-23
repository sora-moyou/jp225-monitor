import type { InstrumentMeta } from './types.js';

// v0.3.32: 監視銘柄を「リアルタイム取得可能なもの + 値がさ株5」に再設計。
// v0.7.20(全銘柄 HTTP 化): 価格源を公開 HTTP(ajax_cme.js / ajax_fx.js)のみに統一。この 2 エンドポイントで
// ~24h ライブに取れる 4 銘柄に絞る: NIY=F(136)/YM=F(731)/NQ=F(737)/JPY=X(511)。
// ^HSI(香港ハンセン)/CL=F(WTI原油)/^TNX(米10年債)は socket 廃止に伴いドロップ(HTTP 源が無い/cash コードは
// 立会外で stale)。順序・ラベルは残る 4 銘柄で維持。
// STEP 2 リファクタ: 実行時定数 INSTRUMENTS を core へ移設(依存は core/types.ts のみ=非循環)。
// server/config.ts は本モジュールから再export し、web は本モジュールを直接 import する(web→server 実行時依存の解消)。
export const INSTRUMENTS: InstrumentMeta[] = [
  { symbol: 'NIY=F',  labelJa: '日経225先物',    labelEn: 'Nikkei 225 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.15, unit: 'percent', category: 'main' },
  { symbol: 'NQ=F',  labelJa: 'ナスダック100先物', labelEn: 'Nasdaq 100 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.15, unit: 'percent', category: 'main' },
  { symbol: 'YM=F',  labelJa: 'ダウ先物',        labelEn: 'Dow Fut',        magnitudeThreshold: 0.30, slopeThreshold: 0.15, unit: 'percent', category: 'main' },
  { symbol: 'JPY=X', labelJa: 'ドル円',          labelEn: 'USD/JPY',        magnitudeThreshold: 0.20, slopeThreshold: 0.10, unit: 'percent', category: 'main' },
  // 値がさ株（東証、高株価・日経寄与上位7）— AI説明の連動材料用、カード非表示
  { symbol: '6861.T', labelJa: 'キーエンス',           labelEn: 'Keyence',         magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
  { symbol: '9983.T', labelJa: 'ファーストリテイリング', labelEn: 'Fast Retailing',  magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
  { symbol: '6146.T', labelJa: 'ディスコ',             labelEn: 'Disco',           magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
  { symbol: '6273.T', labelJa: 'SMC',                 labelEn: 'SMC',             magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
  { symbol: '8035.T', labelJa: '東京エレクトロン',     labelEn: 'Tokyo Electron',   magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
  { symbol: '9984.T', labelJa: 'ソフトバンクグループ', labelEn: 'SoftBank Group',   magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
  { symbol: '285A.T', labelJa: 'キオクシアHD',         labelEn: 'Kioxia Holdings',  magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
];
