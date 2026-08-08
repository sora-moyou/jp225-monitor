// ★テストが「実ユーザーの環境」を最初から一度も見ないようにする(setupFiles = 各テストファイルの直前に実行)。
//
//   これが無いと何が起きるか(実測 2026-08-04〜08-08):
//     実 DB `%APPDATA%/jp225-monitor/jp225.db` の signal_plans 689行のうち 688行がテストの書き込み。
//     原因は engine 系テストの `afterEach` が `process.env.APPDATA` を **実値へ戻す** 一方で、engine の
//     台帳書き込みが非同期だったこと。テストが終わって環境変数を戻した後に、まだ飛んでいた書き込みが
//     実 DB へ着地していた。4日間だれも気づかなかった。
//
//   ここで **テストファイルが1行も走る前に** APPDATA/USERPROFILE/HOME をそのファイル専用の一時ディレクトリへ
//   向けておくと、テストが `const ORIG = process.env.APPDATA` として控える「元の値」自体が一時ディレクトリになる。
//   つまり **afterEach で元へ戻しても実環境は指さない**。遅れて到着した書き込みも一時ディレクトリに落ちる。
//   → 新しいテストが「環境変数を控えて戻す」という同じ書き方をしても、二度と実 DB には届かない。
//
//   これは1枚目の防壁。2枚目は server/appDataDir.ts の隔離(tmpdir の外を指したら強制的に差し替える)で、
//   setupFiles が外れた/新しい vitest プロジェクトが増えた場合でも実パスは選べない。
//   3枚目は vitest.globalSetup.ts のトリップワイヤ(実 DB の行数差分と、実パスへ触った記録)。

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(tmpdir(), 'jp225-testenv');
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, 'f-'));

// ★DB/ログ/pid の置き場(%APPDATA%/jp225-monitor)。
process.env.APPDATA = dir;
// ★ユーザー設定(~/.jp225-monitor/config.json)は os.homedir() 由来。Windows は USERPROFILE、他は HOME。
process.env.USERPROFILE = dir;
process.env.HOME = dir;
