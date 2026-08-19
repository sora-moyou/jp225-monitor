// 「いま走っている版」と「その版のプロンプトの型の指紋(pb1)」を、**依存なしで読める**ようにする葉。
//
// ■ なぜ registry(publish/read)にするか — 依存の向きを壊さないため
//   pb1 の計算(server/llm/promptBuild.ts)はプロンプトの描画関数を必要とし、それは LLM スタック
//   (scalpPlan → providers の barrel)に繋がっている。一方 pb1 を **書きたい/読みたい** のは
//     ・db/store.ts(台帳。collector やティック保管など LLM と無関係な経路からも読まれる)
//     ・routes/scalpPlan.ts と llm/scalpPlanRunner.ts(どちらも openai.js の barrel をモックする
//       テストが多数あり、barrel を迂回する新しい静的 import を足すとモックをすり抜けて実体が載る)
//   ここで直接 import すると
//     ・DB を触るだけで LLM プロバイダの初期化が走る(engine.ts の遅延ロード設計が壊れる)
//     ・既存のテストが barrel をモックしても実体が読み込まれて落ちる
//   → 値だけを置く葉を挟む。**計算する側が publish し、使う側は読むだけ**。
//
// ■ 未設定(null)は嘘をつかない
//   publish されていないプロセス(collector 等)では null のまま = 台帳では NULL。
//   「この行を書いたプロセスはプロンプトを組む側ではなかった」が形から読める(0 や '' を捏造しない)。
//
// ■ app_version は常に読める(葉の定数なので registry を経由しない)。

import { APP_VERSION } from './appVersion.js';

/** 質問文の変種名 → pb1 指紋。未登録は空。 */
let promptBuilds: Readonly<Record<string, string>> = {};
/** 既定の変種(v1)の指紋。台帳の既定値に使う。未登録は null。 */
let defaultPromptBuild: string | null = null;

/** pb1 指紋を登録する。★計算できる側(server/llm/promptBuild.ts)だけが呼ぶ。
 *  defaultVariant はその中で「稼働機が使う質問文」の名前(= 'v1')。 */
export function publishPromptBuilds(map: Record<string, string>, defaultVariant: string): void {
  promptBuilds = { ...map };
  defaultPromptBuild = map[defaultVariant] ?? null;
}

/** 記録層が読む既定値。未登録なら promptBuild は null(=台帳では NULL)。 */
export function currentBuildIdentity(): { appVersion: string; promptBuild: string | null } {
  return { appVersion: APP_VERSION, promptBuild: defaultPromptBuild };
}

/** 変種を指定して読む(応答のエコー用)。未登録/未知の変種は null。 */
export function promptBuildFor(variant: string): string | null {
  return promptBuilds[variant] ?? null;
}

/** 登録済みの全変種(meta / 診断用)。 */
export function allPublishedPromptBuilds(): Readonly<Record<string, string>> {
  return promptBuilds;
}

/** テスト用: 登録を消す(プロセス内グローバルなので、テスト間で漏らさない)。 */
export function resetPromptBuildForTest(): void {
  promptBuilds = {};
  defaultPromptBuild = null;
}
