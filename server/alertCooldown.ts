// 銘柄ごとの最終発火を一元管理。全アラート種別(超短期/短期1分/長期5分)で共有する。
// 同方向はクールダウン(既定15分・設定で変更可)。ただしクールダウン中でも「逆方向」は、発火時の
// 起点価格を越えて価格が戻った場合(上発火→起点割れ / 下発火→起点超え)だけ許可する。どれか1つでも
// 発火したら即この共有クールダウンに入る(種別ごとに独立はしない)。

export const COOLDOWN_MS = 15 * 60 * 1000;   // 既定。実際の値は setCooldownMs で上書き可。
let cooldownMs = COOLDOWN_MS;

/** 設定からクールダウン(ms)を反映。起動時・設定保存時に呼ぶ。 */
export function setCooldownMs(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) cooldownMs = ms;
}
export function getCooldownMs(): number { return cooldownMs; }

export type Dir = 'up' | 'down';
interface FireRec { at: number; dir: Dir; price: number; }

const lastFire = new Map<string, FireRec>();

/**
 * 発火可否。
 * - 記録なし / クールダウン明け(既定15分経過) → 無条件で可。
 * - クールダウン中・同方向 → 不可。
 * - クールダウン中・逆方向 → 価格が起点を越えて戻った場合のみ可
 *   (起点が up 発火なら price < 起点、down 発火なら price > 起点)。
 */
export function canFire(symbol: string, dir: Dir, price: number, now: number = Date.now()): boolean {
  const rec = lastFire.get(symbol);
  if (!rec) return true;
  if (now - rec.at >= cooldownMs) return true;
  if (dir === rec.dir) return false;
  return rec.dir === 'up' ? price < rec.price : price > rec.price;
}

export function markFired(symbol: string, dir: Dir, price: number, now: number = Date.now()): void {
  lastFire.set(symbol, { at: now, dir, price });
}

// テスト用
export function _reset(): void { lastFire.clear(); }
