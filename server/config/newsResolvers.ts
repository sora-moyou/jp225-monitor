// ニュース取得(newsLoop)の tunable リゾルバ。
// configStore.ts が re-export する(既存の alertResolvers/levelsResolvers/scalpResolvers と同じ作法)。

import { loadConfig } from '../configStore.js';

/** ★取引時間外もニュースを取得するか。
 *  未設定 / 非 boolean は **false = 現行どおり**(v0.7.5 のドーマント化: 時間外の tick は何もしない)。
 *  true にしても影響するのは **newsLoop だけ**で、price/alert/correlation/levels/forecast の
 *  ゲートは一切変わらない(取引の判断に入る系統は時間外に動かさない、という v0.7.5 の設計を維持する)。
 *  ★冪等: loadConfig() を読むだけの純粋関数。呼ぶ回数で結果が変わらない。 */
export function resolveNewsOffHoursEnabled(): boolean {
  return loadConfig().newsOffHoursEnabled === true;
}
