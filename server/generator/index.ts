// 分析用の **開発用 CLI 入口**。
//
//   npm run generator:dev        (接続先は既定 localhost / GENERATOR_MONITOR_URL で変更)
//
// ★ループ本体は server/generator/run.ts。配布物に同梱するサイドカー(server/generator/sidecar.ts)も
//   同じ関数を呼ぶ=「開発では動くが配布物では違う」を作らない。
// ★この入口は **設定の有効/無効を見ない**(手で叩いたのだから走る)。既定で走り出してはいけないのは
//   同梱されるサイドカーの方で、そちらが resolveGeneratorEnabled() を見る。

import { runGenerator, GeneratorHalt } from './run.js';

runGenerator().catch((e) => {
  if (e instanceof GeneratorHalt) {
    // 理由は既に die() がログに出している(異常終了ではない=わざと止めた)。
    process.exitCode = 1;
    return;
  }
  console.error('[generator] 異常終了:', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
