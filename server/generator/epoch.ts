// 標本の「期」(epoch)。
//
// ■ 何のためにあるか
//   1年ぶんの提案を1つの山に積むと、途中で設定を触った瞬間に **別物が同じ山に混ざる**。
//   混ざったことに誰も気づけないのが最悪なので、期を決める入力を全部ハッシュに食わせ、
//   **入力が動けば epoch が自動で変わる** ようにする(人が手で版を上げる運用にしない=
//   上げ忘れた瞬間に静かに嘘になる)。
//
// ■ 何を入れたか
//   ① 凍結設定 … /api/settings の生スナップショット(★取引記録から推測しない)。
//      ただし **本質的に揺れる値** は除く(下の VOLATILE_SETTINGS_KEYS)。プロバイダの
//      ポーズ状態や自動公開の直近結果は数分で変わるので、入れると epoch が毎回変わって
//      期の概念そのものが消える。
//   ② 決済設定の指紋 … exit.configHash(一方向・実数値は復元できない)と実装種別。
//   ③ 生成器自身の設定 … 間隔・対照の頻度・再試行・タイムアウト。標本の作り方が変われば別の期。
//
// ■ 何を **入れなかった** か(判断)
//   exit.configVersion は入れない。これは DB 台帳の採番ラベルで、**まだ一度も決済していないと
//   null**、初回決済で 1 になる。中身は何も変わっていないのに epoch が割れてしまう。
//   実体の同一性は configHash が完全に担っているので、version は runs 表に記録するだけにする。
//
// ■ 何を書かないか
//   epoch の入力には決済の実数値も API キーも現れない(monitor は変種を **名前** で、決済設定を
//   **一方向ハッシュ** で、キーを **出どころ** だけで返す)。

import { createHash } from 'node:crypto';

/** epoch の計算方式そのものの版。★計算方式を変えたらここを上げる(過去の期と繋がらなくなるため)。 */
export const EPOCH_SCHEMA = 'g1';

/** 凍結設定から **除く** キー(本質的に揺れる値)。ここを増やすと epoch が鈍くなるので慎重に。 */
export const VOLATILE_SETTINGS_KEYS: readonly string[] = ['providers', 'basedataAutoLastRun'];

/** オブジェクトのキー順で値が揺れないように、再帰的にキーを整列した JSON を作る(決定論)。 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonicalize(v));
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return v;
}

/** epoch に食わせる決済側の入力(**実数値は含まない**)。 */
export interface EpochExitInput {
  impl: string;
  variantImpl: string;
  configHash: string;
}

/** 凍結設定から揺れる値を落とす。 */
export function freezeSettings(settings: unknown): Record<string, unknown> {
  if (!settings || typeof settings !== 'object') return {};
  const src = settings as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (VOLATILE_SETTINGS_KEYS.includes(k)) continue;
    out[k] = src[k];
  }
  return out;
}

/** epoch の計算入力(そのまま runs 表にも残す=1年後に「何が変わって期が変わったか」が差分で読める)。 */
export function buildEpochInput(
  settings: unknown, exit: EpochExitInput, generatorConfig: unknown,
): Record<string, unknown> {
  return {
    schema: EPOCH_SCHEMA,
    settings: freezeSettings(settings),
    exit: { impl: exit.impl, variantImpl: exit.variantImpl, configHash: exit.configHash },
    generator: generatorConfig,
  };
}

/** epoch 文字列。方式の版を接頭辞に持つので、方式が変わったことも一目で分かる。 */
export function computeEpoch(input: unknown): string {
  const h = createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 16);
  return `${EPOCH_SCHEMA}:${h}`;
}
