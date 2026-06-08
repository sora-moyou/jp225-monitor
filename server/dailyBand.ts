// 日足バンド検知(v0.6.17): 日足(夜間セッション=17:00〜翌6:00)の終値25本から MA25 と ±1σ/±2σ の
// 5水準を算出する純粋関数。levelsLoop が現値とこの5水準で水準抜け/反発(detectLevelBreak/detectLevelHold)を
// 評価し、dailyband アラートを直接 emit する(集約パイプラインは通さない。crash と同様)。
//
// σ は母標準偏差(N=25で割る)。標本(N-1)ではない — ユーザー確認済みの仕様。

export interface DailyBand {
  price: number;
  label: string;
  refKind: 'ma25' | 'sigma1' | 'sigma2';
}

/**
 * 直近25本の夜間セッション終値から日足バンド5水準を算出。
 * nightCloses は時系列順(古い→新しい)で渡す想定だが、平均/分散は順序に依らない。
 * 25本未満なら [] を返す。価格は整数に丸める。
 */
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
