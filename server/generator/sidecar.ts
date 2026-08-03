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
//
// ★★ファイルログは **何よりも先に** 有効にする(server/generator/sidecarLog.ts)。
//   生成器の出力は Rust のコンソールにしか出ず、運用PC(別マシン)では読めない。前提検証で
//   即終了する経路では「何も残らずに消える」ため、症状(有効なのに台帳が1行も無い)に対して
//   理由を見る手段がゼロだった。落ちてから書くのでは間に合わないので、最初の1行を先に書く。

import './sidecarLogInstall.js';   // ★1行目: これより後の import が評価される前にログを開く
import { runSidecar } from './sidecarRun.js';

runSidecar().catch((e) => {
  console.error('[generator-sidecar] 異常終了:', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
