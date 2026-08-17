// ★層1(執行): エントリー価格を N225 の刻みに丸める純関数。
//
// ■ なぜ要るか(実測 2026-08-17)
//   monitor も trade2 も、刻み丸めを **決済・保護ストップにしか** 掛けていなかった。
//   エントリー価格は AI が出した生値のまま送られ、刻み外の価格は **業者に拒否されるまで検出されない**。
// ■ 丸める向き
//   必ず「約定しにくい側」へ寄せる。有利側へ寄せると AI が意図していない価格で約定しうる。
//     買い指値 → 切り下げ / 売り指値 → 切り上げ / 買い逆指値 → 切り上げ / 売り逆指値 → 切り下げ

/** N225(ミニ/マイクロ)の呼値。 */
export const ENTRY_TICK_YEN = 5;

/** エントリー価格を刻みに丸める。非有限はそのまま返す(欠損処理は呼び出し側の既存契約に任せる)。 */
export function roundEntryToTick(price: number, side: 'buy' | 'sell', kind: 'limit' | 'stop'): number {
  if (!Number.isFinite(price)) return price;
  // 買い指値・売り逆指値は下へ / 売り指値・買い逆指値は上へ。
  const down = (side === 'buy') === (kind === 'limit');
  const t = ENTRY_TICK_YEN;
  return down ? Math.floor(price / t) * t : Math.ceil(price / t) * t;
}
