// ★副作用だけのモジュール: **読み込まれた瞬間に** 生成器のファイルログを有効にする。
//
// なぜ関数呼び出しではなく import なのか:
//   ESM でも(SEA の CJS バンドルでも)import は **本文の実行より先に、書いた順に** 評価される。
//   sidecar.ts の1行目でこれを読み込めば、本体(sidecarRun とその依存)が評価されるより前に
//   ログが開く = 起動直後に落ちる経路でも1行は必ず残る。
//   installGeneratorFileLog() を本文で呼ぶ形だと、依存モジュールの評価が全部終わってからになる。
//
// ★import しただけで console を横取りするので、**サイドカーの入口以外から読み込まないこと**
//   (テストは installGeneratorFileLog() を直接呼ぶ)。

import { installGeneratorFileLog } from './sidecarLog.js';

const installed = installGeneratorFileLog();
if (installed.ok) console.log(`[generator-sidecar] ログ: ${installed.path}`);
