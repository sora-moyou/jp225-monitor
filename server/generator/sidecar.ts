// 提案生成器サイドカーの **入口**(配布物に同梱する第3の externalBin = binaries/jp225-generator)。
//
// ■ なぜ同梱するのか
//   生成器は monitor を HTTP で叩くので **同じ PC に居る必要がある**。運用PCにはインストーラしか
//   入らないので、開発用スクリプト(`tsx server/generator/index.ts`)のままでは提案が1件も記録されない。
//   → コレクタ(binaries/jp225-collector)と **同じ流儀** で SEA バイナリにして同梱する
//     (scripts/build-generator.mjs / scripts/copy-generator.mjs / src-tauri/src/lib.rs の spawn)。
//
// ★ロジックは server/generator/sidecarRun.ts。ここは「起動されたら走る」だけ
//   (index.ts が run.ts を呼ぶのと同じ形。テストから import しても勝手に走り出さない)。

import { runSidecar } from './sidecarRun.js';

runSidecar().catch((e) => {
  console.error('[generator-sidecar] 異常終了:', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
