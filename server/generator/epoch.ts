// 標本の「期」(epoch)。
//
// ■ 何のためにあるか
//   1年ぶんの提案を1つの山に積むと、途中で設定を触った瞬間に **別物が同じ山に混ざる**。
//   混ざったことに誰も気づけないのが最悪なので、期を決める入力を全部ハッシュに食わせ、
//   **入力が動けば epoch が自動で変わる** ようにする(人が手で版を上げる運用にしない=
//   上げ忘れた瞬間に静かに嘘になる)。
//
// ■ 何を入れたか
//   ① 実験の条件に関わる設定 … /api/settings のうち **実験の条件に関係する項目だけ**
//      (下の EXPERIMENT_SETTINGS_* が SSOT・★取引記録から推測しない)。
//   ② 決済設定の指紋 … exit.configHash(一方向・実数値は復元できない)と実装種別。
//   ③ 生成器自身の設定 … 間隔・対照の頻度・再試行・タイムアウト。標本の作り方が変われば別の期。
//
// ■ ★なぜ /api/settings 丸ごとを止めたか(2026-08-03)
//   丸ごと食わせると、アラート閾値・ニュース設定・chromePath など **実験と無関係な設定** を
//   触るだけで期が割れる。期が割れやすいと停止規則の分母(「②で7,000エントリー」)が計算不能になる。
//   → 関係する項目だけを入力にする。ただし **関係あるものを落とす方が、関係ないものを入れるより
//     危険** なので、迷ったものは入れて、その旨をここに書く(下の「迷って入れたもの」)。
//   ★丸ごとの生スナップショットは今までどおり runs.settings_json に **毎回** 残る。
//     epoch から外したことで観測が消えるわけではない(後から差分で必ず読める)。
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

/** epoch の計算方式そのものの版。★計算方式を変えたらここを上げる(過去の期と繋がらなくなるため)。
 *
 *  ★2026-08-03 に 'g1' → 'g2' へ。設定の入力を「丸ごと」から allowlist へ変え、
 *    同時に生成器のプロンプトから A の紙成績を外した(= 計算方式が変わった)。
 *
 *    ハッシュは入力構成が変わった時点で必ず変わるので、旧標本と衝突はしない。
 *    それでも接頭辞を上げるのは、**この接頭辞の存在理由が「方式が変わったこと」を
 *    記録することだから**。上げないと、1年後に2つの 'g1:' を比べた人が
 *    「差は入力によるものか、方式によるものか」を判別できない。
 *
 *    ★方式を変えたら必ずここを上げること。liveRun.test.ts が接頭辞を固定しているので、
 *      無自覚に変えるとテストが落ちる(意図的な変更なら、そこも一緒に直す)。 */
export const EPOCH_SCHEMA = 'g2';

/** ★実験の条件に関係する設定キーの **接頭辞**。ここに当たるキーだけが epoch の入力に入る。
 *  - 'scalp'     … AI エントリーの質問そのものを決める(バイアス / LC 下限・上限・安全上限 /
 *                  トレンド veto / クールダウン / レンジ両面 / 各項目の委任(手動・AI) /
 *                  撮影失敗時のテキスト縮退)。提案の中身と見送り率が直接動く。
 *  - 'signalB'   … System B(紙専用)の設定。★迷って入れた: 生成器の要求は profile を渡さない
 *                  ので B の値はプロンプトに入らない。しかし B のエンジンも同じ関門(busy)を
 *                  使い、B の設定変更は「この時期に何をしていたか」の一部でもある。
 *                  落として後悔するより入れる(サブリーダーの指示: 迷ったら入れる)。
 *  - 'generator' … 生成器プールのキーの出どころ・日次予算。標本の作られ方(どのプロバイダが
 *                  答えるか・1日に何本取れるか)を直接決める。 */
export const EXPERIMENT_SETTINGS_PREFIXES: readonly string[] = ['scalp', 'signalB', 'generator'];

/** ★接頭辞では拾えない、実験の条件に関係するキー(完全一致)。
 *  - indicatorsEnabled  … テクニカル指標ブロック(G)を AI に供給するか = プロンプトが変わる。
 *  - aiTechnicalEnabled … その指標をエントリーのタイミング判断に使ってよいか = 質問が変わる。
 *  - dotenEnabled / rangeReevalEnabled … 保有中の反転評価 / 未約定レンジの再評価の許可。
 *    生成器は flat-plan しか投げないので直接は効かないが、A/B の行動(=関門 busy と紙の建玉)を
 *    変える。★迷って入れた側。
 *  - tradeBias          … ★バイアスの **別名**。monitor の /api/settings は 'scalpBias' を返すので
 *    通常は現れないが、同じノブの名前として入れておく(接続先が別名で返す版でも期が割れるように。
 *    関係あるものを落とす方が危険、の規則どおり)。 */
export const EXPERIMENT_SETTINGS_KEYS: readonly string[] =
  ['indicatorsEnabled', 'aiTechnicalEnabled', 'dotenEnabled', 'rangeReevalEnabled', 'tradeBias'];

/** ★入れなかったもの(理由つき・将来ここに足すか迷ったときの判断材料)。
 *  - アラート/節目の検知閾値(shock* / level* / break* / slope* / nwave* / doubleForming* 等)
 *    … 直近アラートは AI 文脈のブロックに入るので **無関係ではない**。ただしこの実験の主比較は
 *      「同じサイクル・同じ時刻・同じ画像で ① と ② に何を答えたか」の **対応比較** で、
 *      共有の文脈は両腕に等しく効くため対比には入らない。閾値を触るたびに期が割れると
 *      停止規則の分母が計算できなくなるので、期の分割対象からは外す(サブリーダーの指示)。
 *      触った事実は runs.settings_json に毎回残るので、後から時期を切って調べられる。
 *  - ニュース/翻訳/Web検索/基礎データ/GitHub/chromePath/ポート/各ポーリング間隔/共通キーの有無
 *    … 提案の質問文にも生成器の標本の作り方にも入らない。
 *  - providers(プロバイダのポーズ状態)/ basedataAutoLastRun … 数分で変わる(下の VOLATILE)。 */
export const VOLATILE_SETTINGS_KEYS: readonly string[] = ['providers', 'basedataAutoLastRun'];

/** そのキーが「実験の条件」か(純関数)。 */
export function isExperimentSettingsKey(key: string): boolean {
  if (VOLATILE_SETTINGS_KEYS.includes(key)) return false;   // 揺れる値は接頭辞に当たっても入れない
  if (EXPERIMENT_SETTINGS_KEYS.includes(key)) return true;
  return EXPERIMENT_SETTINGS_PREFIXES.some(p => key.startsWith(p));
}

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

/** 凍結設定 = /api/settings のうち **実験の条件に関係する項目だけ**(揺れる値は落とす)。
 *  ★ここから漏れたキーは epoch を動かさない。設定 UI に項目を足すときは、それが
 *    「提案の質問文 / 見送りの強制 / 標本の作られ方」に効くなら
 *    EXPERIMENT_SETTINGS_PREFIXES か EXPERIMENT_SETTINGS_KEYS へ足すこと(迷ったら足す)。 */
export function freezeSettings(settings: unknown): Record<string, unknown> {
  if (!settings || typeof settings !== 'object') return {};
  const src = settings as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (!isExperimentSettingsKey(k)) continue;
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
