// 暴落(crash)判定の純粋ロジック。セッション高値からの下落率で定義(ユーザー指定: 3%以上)。
// 発火のエッジ/ヒステリシス(状態)は呼び出し側 levelsLoop が持つ。ここは閾値と計算のみ。

export const CRASH_DRAWDOWN_PCT = 0.03;      // セッション高値から 3% 下落で暴落
export const CRASH_HYSTERESIS_PCT = 0.005;   // 2.5% まで戻したら状態リセット(再暴落で再発火可)

/** セッション高値からの下落率(0〜1)。high<=0 は 0。 */
export function crashDrawdown(sessionHigh: number, current: number): number {
  return sessionHigh > 0 ? (sessionHigh - current) / sessionHigh : 0;
}

/** 暴落(下落率 ≥ pct)か。 */
export function isCrash(sessionHigh: number, current: number, pct: number = CRASH_DRAWDOWN_PCT): boolean {
  return crashDrawdown(sessionHigh, current) >= pct;
}
