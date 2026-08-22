// 日足バンド検知(v0.6.17 → v0.8.6 取引日足化): 取引日足の終値25本から MA25 と ±1σ/±2σ の
// 5水準を算出する純粋関数。★取引日足=夜間(17:00)〜翌日中(15:45)を1日とし、終値は日中セッションの15:45クローズ
// (基礎データの取引日日足シートと同じ定義)。levelsLoop が現値とこの5水準で水準抜け/反発(detectLevelBreak/detectLevelHold)を
// 評価し、dailyband アラートを直接 emit する(集約パイプラインは通さない。crash と同様)。
//
// σ は母標準偏差(N=25で割る)。標本(N-1)ではない — ユーザー確認済みの仕様。

export interface DailyBand {
  price: number;
  label: string;
  refKind: 'ma25' | 'sigma1' | 'sigma2';
}

// 日足MA線(v0.8.6追加): MA5/20/50/75 を「線のみ」(±σバンドは付けない)でアラート化する水準。
export interface DailyMA {
  price: number;
  label: string;   // 'MA5' | 'MA20' | 'MA50' | 'MA75'
  period: number;
}

// 日足MA線の期間(バンドの MA25 とは別・線のみ)。ユーザー指定。
export const DAILY_MA_PERIODS = [5, 20, 50, 75] as const;

// ─── ★取引日足シリーズの取り方(SSOT・v0.9.98) ────────────────────────────────
// ここに置く理由: この2つは **日足シリーズの仕様** なので、日足を作る本モジュールが持つ。
//   もともと server/detect/registry.ts のファイル内 const だった(=アラート経路しか読めなかった)。
//   ★AI 文脈にも同じ日足を渡すことになったので、**2箇所に同じ数字を手書きしない** ためここへ移した。
//   ★値は移動前と1つも変えていない(アラートの発火条件は不変)。

/** 取引日終値(daily_closes)を何営業日ぶん保持/参照するか。MA75 に足りるだけの余裕。 */
export const DAILY_CLOSES_KEEP = 80;

/** 取引日終値を組み直すときに bars_1m から読むセッション数(≒カレンダー200日ぶん)。 */
export const DAILYBAND_FETCH_SESSIONS = 200;

/** 日足バンド(MA25±σ)の算出に必要な終値の本数。これ未満は [] が返る。 */
export const DAILY_BAND_MIN_CLOSES = 25;

/**
 * 取引日足終値系列から日足MA線(MA5/20/50/75)の各水準を算出する純粋関数。
 * 各期間につき、その期間以上の終値がある時だけ直近period本の単純平均を1水準として返す(不足期間はスキップ)。
 * 価格は整数に丸める。バンド(computeDailyBands)とは独立で ±σ は付けない=線のみ。
 * ★MA75 には75本の取引日終値が必要なため、呼び出し側は十分な本数の系列を渡すこと(dailyCloseSeries の keep を拡げる)。
 */
export function computeDailyMAs(dailyCloses: number[]): DailyMA[] {
  const out: DailyMA[] = [];
  for (const period of DAILY_MA_PERIODS) {
    if (dailyCloses.length < period) continue;   // 期間に満たない終値はスキップ
    const last = dailyCloses.slice(-period);
    const mean = last.reduce((a, b) => a + b, 0) / period;
    out.push({ price: Math.round(mean), label: 'MA' + period, period });
  }
  return out;
}

/**
 * 直近25本の取引日足終値(=各取引日の15:45クローズ)から日足バンド5水準を算出。
 * dailyCloses は時系列順(古い→新しい)で渡す想定だが、平均/分散は順序に依らない。
 * 25本未満なら [] を返す。価格は整数に丸める。
 */
/**
 * 取引日足終値系列を組み立てる(v0.6.22 リアルタイム MA25 → v0.8.6 取引日足)。
 * 最後の日足(進行中の取引日)は確定を待たず、現在値を終値として採用する。
 * 確定済み取引日終値(=各日の15:45)の直近 keep 本 + 現在値 を返す。これを computeDailyBands に渡すと、
 * MA25/σ が現在値の変化に合わせて毎ティック動く。
 * keep の既定は24(=バンド用: 24本+現在値=25値。従来挙動と同一・不変)。
 * ★日足MA線(MA50/75)用にはより長い系列が要るため keep=75 など大きい値で呼ぶ(バンドは keep=24 のまま=不変)。
 */
export function dailyCloseSeries(confirmedDailyCloses: number[], currentPrice: number, keep = 24): number[] {
  return [...confirmedDailyCloses.slice(-keep), currentPrice];
}

export function computeDailyBands(nightCloses: number[]): DailyBand[] {
  if (nightCloses.length < 25) return [];
  const last25 = nightCloses.slice(-25);
  const ma = last25.reduce((a, b) => a + b, 0) / 25;
  const variance = last25.reduce((a, b) => a + (b - ma) ** 2, 0) / 25;   // 母分散(N=25)
  const sd = Math.sqrt(variance);
  return [
    { price: Math.round(ma), label: 'MA25', refKind: 'ma25' },
    { price: Math.round(ma + sd), label: '+1sigma', refKind: 'sigma1' },
    { price: Math.round(ma - sd), label: '-1sigma', refKind: 'sigma1' },
    { price: Math.round(ma + 2 * sd), label: '+2sigma', refKind: 'sigma2' },
    { price: Math.round(ma - 2 * sd), label: '-2sigma', refKind: 'sigma2' },
  ];
}
