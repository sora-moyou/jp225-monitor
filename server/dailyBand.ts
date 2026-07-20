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

/**
 * 直近25本の取引日足終値(=各取引日の15:45クローズ)から日足バンド5水準を算出。
 * dailyCloses は時系列順(古い→新しい)で渡す想定だが、平均/分散は順序に依らない。
 * 25本未満なら [] を返す。価格は整数に丸める。
 */
/**
 * 取引日足終値系列を組み立てる(v0.6.22 リアルタイム MA25 → v0.8.6 取引日足)。
 * 最後の日足(進行中の取引日)は確定を待たず、現在値を終値として採用する。
 * 確定済み取引日終値(=各日の15:45)の直近24本 + 現在値 = 25値 を返す。これを computeDailyBands に渡すと、
 * MA25/σ が現在値の変化に合わせて毎ティック動く。
 */
export function dailyCloseSeries(confirmedDailyCloses: number[], currentPrice: number): number[] {
  return [...confirmedDailyCloses.slice(-24), currentPrice];
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
