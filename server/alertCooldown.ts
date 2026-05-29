// 銘柄ごとの最終発火時刻を一元管理。alertLoop (1m z-score) と tickDetector (10s 超短期) が共有し、
// 同銘柄で 5 分以内に二重発火しないようにする。

export const COOLDOWN_MS = 5 * 60 * 1000;

const lastFiredAt = new Map<string, number>();

export function isOnCooldown(symbol: string, now: number = Date.now()): boolean {
  const t = lastFiredAt.get(symbol) ?? -Infinity;
  return now - t < COOLDOWN_MS;
}

export function markFired(symbol: string, now: number = Date.now()): void {
  lastFiredAt.set(symbol, now);
}

// テスト用
export function _reset(): void {
  lastFiredAt.clear();
}
