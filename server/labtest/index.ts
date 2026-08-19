// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  臨時テスト用 monitor(プロンプト検証台) — 起動口
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ■ 何をするものか
//   本番の scalp-plan が AI に渡している **データの組み立てをそのまま再利用** し、
//   ユーザーが書いた 2 つの質問(A: 目線 / B: 戦略と価格)を **1 プロンプト 1 仕事** で連鎖させて、
//   返ってきた全文をそのまま画面に出すだけの、使い捨ての検証台。
//   売買しない・発注しない・本番のコードを1バイトも変えない。
//
// ■ 使い方
//   npm run labtest        → http://127.0.0.1:5199
//   環境変数(任意):
//     LABTEST_PORT     … 待受ポート(既定 5199)
//     LABTEST_SRC_DB   … 種にする DB(既定: 候補から **最新のもの** を自動選択)
//     LABTEST_OUT      … 実行記録の保存先(既定 <tmp>/jp225-labtest/runs)
//
// ★ここでは本番モジュールを **静的 import しない**。APPDATA を砂箱へ差し替えた後で動的に読む
//   (先に読むと、モジュール初期化のどこかが実 %APPDATA% を掴む余地が残る)。

import { refreshSandbox, rememberRealAppData, SANDBOX_BASE } from './sandbox.js';

async function main(): Promise<void> {
  rememberRealAppData(process.env.APPDATA ?? process.env.HOME ?? process.cwd());
  const info = refreshSandbox();
  // ★ここから先、このプロセスの %APPDATA% は砂箱。実 DB のパスは解決できない。
  process.env.APPDATA = SANDBOX_BASE;

  const ageMin = Math.round((Date.now() - info.srcMtime) / 60_000);
  console.log('[labtest] ─────────────────────────────────────────────');
  console.log(`[labtest] 種 DB : ${info.srcDb}`);
  console.log(`[labtest]         ${(info.srcBytes / 1024 / 1024).toFixed(1)} MB / 更新 `
    + `${new Date(info.srcMtime).toLocaleString('ja-JP')} (${ageMin}分前)`);
  console.log(`[labtest] 砂箱  : ${info.sandboxDb}`);
  console.log('[labtest] 実 DB へは1バイトも書きません(APPDATA を砂箱へ差し替え済み)');
  console.log('[labtest] ─────────────────────────────────────────────');

  const { startLabtestServer } = await import('./server.js');
  await startLabtestServer();
}

main().catch(err => {
  console.error('[labtest] 起動失敗:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
