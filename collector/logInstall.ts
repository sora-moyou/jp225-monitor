// ★副作用だけのモジュール: **読み込まれた瞬間に** collector のファイルログを有効にする。
//
// なぜ関数呼び出しではなく import なのか(分析用の server/generator/sidecarLogInstall.ts と同じ理由):
//   ESM でも(SEA の CJS バンドルでも)import は **本文の実行より先に、書いた順に** 評価される。
//   index.ts の1行目でこれを読み込めば、収集デーモン本体の依存(node:sqlite・検知エンジン・
//   フィード取得など)が評価されるより **前** にログが開く。
//   これまでは index.ts の末尾で installProcessFileLog() を呼んでいたので、
//   **import の途中で落ちた場合は1バイトも残らなかった**(SEA バイナリで起きうる代表的な失敗形:
//   バンドルに含め損ねたネイティブ依存・実行環境で解決できない require)。
//   落ちてから書くのでは間に合わない、という同じ教訓がここにも要る。
//
// ★シグナルは渡さない: このモジュールは main() より前に走るので、main() が SIGINT/SIGTERM を
//   listen するより先にここで listener を足すと **Node の既定の終了動作を止めてしまう**
//   (= Ctrl+Break で死ななくなる = 挙動が変わる)。シグナルの記録は index.ts 側で、
//   main() が自分で listen しているものだけを渡して行う(installProcessFileLog は冪等)。
//
// ★import しただけで console を横取りするので、**collector の入口以外から読み込まないこと**。

import { installProcessFileLog, resolveProcessLogPath } from '../server/processLog.js';
import { appendSpawnLog } from '../server/spawnLog.js';

installProcessFileLog({
  path: resolveProcessLogPath('collector'),
  tag: 'collector',
  onLifecycle: line => appendSpawnLog(`[collector] ${line}`),
});
