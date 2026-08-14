#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 非公開ファイル(gitignore された決済ロジック等)のバックアップ照合 / 更新。
//
//   node scripts/private-backup.mjs verify   … 照合のみ(差異があれば exit 1)
//   node scripts/private-backup.mjs backup   … バックアップ先を現物に合わせて更新
//   node scripts/private-backup.mjs sync     … 更新 + jp225-specs へ commit/push まで
//
// ★sync が自動で進めるのは **コメントだけの差分** と manifest(ハッシュ記録)に限る。
//   コードが1行でも変わっていたら **止めて人間に見せる**。自動化の目的は
//   「用語を直しただけで手が止まる」を無くすことであって、決済の変更を黙って
//   控えへ流すことではない(判定は scripts/lib/commentOnlyDiff.mjs・テストあり)。
//
// ★設計の核: **対象ファイルをこのスクリプトに列挙しない。**
//   「何が秘密か」は .gitignore の PRIVATE-BACKUP マーカー区間が唯一の定義で、
//   どの ignore 行が効いたかは git 自身(git check-ignore -v)に答えさせる。
//   手書きリストは必ず実態から遅れる。ここでは機械が判定できる範囲を正とする。
//
// ★秘密を漏らさない: 比較は SHA-256 のみ。ファイル名と状態は出すが、中身は
//   ログにもエラーメッセージにも一切出さない。
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import {
  createHash,
} from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBackupDiff } from './lib/commentOnlyDiff.mjs';

/** このリポジトリのバックアップ名前空間(2リポの同名ファイル衝突を防ぐ接頭辞)。 */
const REPO_KEY = 'monitor';

const BEGIN_MARK = 'PRIVATE-BACKUP:BEGIN';
const END_MARK = 'PRIVATE-BACKUP:END';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backupRoot = process.env.PRIVATE_BACKUP_DIR
  ? resolve(process.env.PRIVATE_BACKUP_DIR)
  : resolve(repoRoot, '..', 'jp225-specs', 'private-backup');
const manifestPath = join(backupRoot, 'manifest.json');

const mode = (process.argv[2] ?? 'verify').toLowerCase();
if (mode !== 'verify' && mode !== 'backup' && mode !== 'sync') {
  console.error(`❌ 不明なモード "${mode}"。verify / backup / sync を指定してください。`);
  process.exit(2);
}

// ── 1. .gitignore の「秘密」区間(行番号レンジ)を求める ───────────────────────
function secretLineRange() {
  const gitignorePath = join(repoRoot, '.gitignore');
  if (!existsSync(gitignorePath)) fail('.gitignore が見つかりません: ' + gitignorePath);
  const lines = readFileSync(gitignorePath, 'utf-8').split(/\r?\n/);
  let begin = -1; let end = -1;
  lines.forEach((line, i) => {
    if (line.includes(BEGIN_MARK)) begin = i + 1;      // 1-origin
    if (line.includes(END_MARK)) end = i + 1;
  });
  if (begin < 0 || end < 0 || end <= begin) {
    fail(
      `.gitignore に ${BEGIN_MARK} / ${END_MARK} のマーカー区間がありません。\n` +
      '   秘密ファイルの定義はこの区間です。区間を復元してください。',
    );
  }
  return { begin, end }; // マーカー行そのものは含めない(begin < line < end)
}

// ── 2. git に「どの ignore 行が効いたか」を答えさせて対象を導出する ───────────
function git(args, input) {
  const r = spawnSync('git', args, { cwd: repoRoot, input, encoding: 'utf-8' });
  if (r.error) fail(`git 実行に失敗: ${r.error.message}`);
  return r;
}

/** ignore されているパス一覧(ディレクトリは畳んで返る = node_modules を掘らない)。 */
function ignoredEntries() {
  const r = git(['ls-files', '-o', '-i', '--exclude-standard', '--directory']);
  if (r.status !== 0) fail(`git ls-files が失敗しました:\n${r.stderr}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** ディレクトリなら中身を再帰展開(将来「秘密ディレクトリ」を足しても効くように)。 */
function expand(entry) {
  const abs = join(repoRoot, entry);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [entry.replace(/\/$/, '')];
  const out = [];
  for (const name of readdirSync(abs)) {
    out.push(...expand(`${entry.replace(/\/$/, '')}/${name}`));
  }
  return out;
}

function secretFiles() {
  const { begin, end } = secretLineRange();
  const entries = ignoredEntries();
  if (entries.length === 0) return [];
  const r = git(['check-ignore', '-v', '--stdin'], entries.join('\n') + '\n');
  // check-ignore は「1つもマッチしない」とき exit 1。ここでは全件 ignore 済みなので 0 のはず。
  if (r.status !== 0 && r.status !== 1) fail(`git check-ignore が失敗しました:\n${r.stderr}`);
  const hits = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    // 形式: <source>:<line>:<pattern>\t<path>
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const src = line.slice(0, tab);
    const path = line.slice(tab + 1).trim();
    const m = /^(.*):(\d+):(.*)$/.exec(src);
    if (!m) continue;
    const [, sourceFile, lineNoStr] = m;
    // ルート直下の .gitignore の、マーカー区間内の行だけを「秘密」と見なす。
    if (sourceFile !== '.gitignore') continue;
    const lineNo = Number(lineNoStr);
    if (lineNo <= begin || lineNo >= end) continue;
    hits.push(...expand(path));
  }
  return [...new Set(hits)].sort();
}

// ── 3. ハッシュ / 名前付け ────────────────────────────────────────────────────
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const backupNameFor = (rel) => `${REPO_KEY}__${rel.replace(/\//g, '__')}`;

function readManifest() {
  if (!existsSync(manifestPath)) return { repos: {} };
  try {
    const j = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (!j || typeof j !== 'object' || typeof j.repos !== 'object') throw new Error('形式が不正');
    return j;
  } catch (e) {
    fail(
      `manifest.json を読めません(${e.message}): ${manifestPath}\n` +
      '   手で壊れた可能性があります。修復してから再実行してください' +
      '(他リポの記録も入っているため自動再生成はしません)。',
    );
  }
}

function fail(msg) {
  console.error(`❌ private-backup: ${msg}`);
  process.exit(1);
}

// ── 4. 本体 ──────────────────────────────────────────────────────────────────
const files = secretFiles();
const now = new Date().toISOString();

/** 控えリポジトリ(jp225-specs)のルート。 */
const specsRoot = resolve(backupRoot, '..');

/** 人が手で同期するときのコマンド(案内用・1か所)。 */
function manualSyncCommand() {
  return `git -C "${specsRoot}" add private-backup && git -C "${specsRoot}" commit -m "chore(private-backup): sync ${REPO_KEY}" && git -C "${specsRoot}" push`;
}

function specsGit(args, opts = {}) {
  return spawnSync('git', ['-C', specsRoot, ...args], { encoding: 'utf-8', ...opts });
}

/** 控えの差分が「自動で進めてよい」ものだけかを確かめ、そうなら commit + push する。
 *  ★止める条件は3つ。いずれも **中身は出さない**(件数と種別だけ)。
 *    ① 控えリポが git でない / 差分の取得に失敗
 *    ② 新規・削除・改名の控えファイルがある(= 秘密ファイルが増減した重大な変化)
 *    ③ コメント以外の変更が1行でもある(= 決済の中身が動いた可能性) */
function syncBackupRepo() {
  if (!existsSync(join(specsRoot, '.git'))) {
    console.log('');
    console.log(`ℹ️  控え先は git リポジトリではありません(${specsRoot})。commit/push は行いません。`);
    return;
  }
  const status = specsGit(['status', '--porcelain', '--', 'private-backup']);
  if (status.status !== 0) {
    fail(`控えリポジトリの状態を読めません(git status が失敗)。手動で同期してください:\n     ${manualSyncCommand()}`);
  }
  const lines = (status.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) {
    console.log('');
    console.log('✅ 控えは既に同期済み(コミットすべき変更なし)。');
    return;
  }
  // ② 追加/削除/改名は自動にしない(秘密ファイルの増減は人が見るべき変化)。
  const structural = lines.filter(l => !l.startsWith('M ') && !l.startsWith(' M') && !l.startsWith('MM'));
  if (structural.length > 0) {
    console.error('');
    console.error(`⛔ 控えに **追加/削除/改名** があります(${structural.length} 件)。自動同期は行いません。`);
    console.error('   秘密ファイルが増減した可能性があるため、内容を確認してから手で同期してください:');
    console.error(`     ${manualSyncCommand()}`);
    process.exit(1);
  }
  // ③ 変更が「コメントだけ」か(中身は見せない・件数のみ)。
  const diff = specsGit(['diff', '--', 'private-backup']);
  if (diff.status !== 0) {
    fail(`控えの差分を読めません(git diff が失敗)。手動で同期してください:\n     ${manualSyncCommand()}`);
  }
  const cls = classifyBackupDiff(diff.stdout ?? '');
  console.log('');
  console.log(`🔎 控えの差分: コメント ${cls.commentChanges} 行 / manifest ${cls.manifestChanges} 行 / **コメント以外 ${cls.codeChanges} 行**`);
  if (!cls.autoSafe) {
    console.error('');
    console.error('⛔ コメント以外の変更が含まれるため、自動同期しません(決済の中身が動いた可能性)。');
    console.error('   差分を目で確かめてから、手で同期してください:');
    console.error(`     git -C "${specsRoot}" diff -- private-backup`);
    console.error(`     ${manualSyncCommand()}`);
    process.exit(1);
  }
  const add = specsGit(['add', 'private-backup']);
  if (add.status !== 0) fail(`git add に失敗しました。手動で同期してください:\n     ${manualSyncCommand()}`);
  // ★何を運んだコミットかが1年後に読めるように、件数の内訳をそのまま件名にする。
  const what = cls.commentChanges > 0
    ? `コメント ${cls.commentChanges} 行`
    : `manifest のみ ${cls.manifestChanges} 行`;
  const msg = `chore(private-backup): sync ${REPO_KEY}(${what})`;
  const commit = specsGit(['commit', '-m', msg]);
  if (commit.status !== 0) {
    fail(`git commit に失敗しました。手動で同期してください:\n     ${manualSyncCommand()}`);
  }
  console.log(`✅ 控えを commit しました: ${msg}`);
  const push = specsGit(['push'], { stdio: 'inherit' });
  if (push.status !== 0) {
    // ★push できていない = 控えはまだ安全ではない。無音で進めない。
    fail('git push に失敗しました(控えはローカルにのみ在ります)。'
      + `\n   ネットワーク/認証を確認して、次を実行してください:\n     git -C "${specsRoot}" push`);
  }
  console.log('✅ 控えを push しました(控えはこれで安全です)。');
}

console.log(`🔐 private-backup [${mode}] repo=${REPO_KEY}`);
console.log(`   対象の定義: .gitignore の ${BEGIN_MARK}〜${END_MARK} 区間`);
console.log(`   バックアップ先: ${backupRoot}`);
console.log(`   対象ファイル: ${files.length} 件`);
for (const f of files) console.log(`     - ${f}`);

if (files.length === 0) {
  console.log('⚠️  秘密ファイルが 0 件です。.gitignore のマーカー区間が空か、現物が消えています。');
}

const manifest = readManifest();
const prevEntries = manifest.repos?.[REPO_KEY]?.files ?? {};

if (mode === 'backup' || mode === 'sync') {
  mkdirSync(backupRoot, { recursive: true });
  const entries = {};
  let copied = 0;
  for (const rel of files) {
    const buf = readFileSync(join(repoRoot, rel));
    const name = backupNameFor(rel);
    const dest = join(backupRoot, name);
    const before = existsSync(dest) ? sha256(readFileSync(dest)) : null;
    const hash = sha256(buf);
    if (before !== hash) { writeFileSync(dest, buf); copied += 1; }
    entries[rel] = { backup: name, sha256: hash, bytes: buf.length };
  }
  // このリポの旧バックアップで、もう対象でないものを掃除(名前変更・削除に追随)。
  const keep = new Set(Object.values(entries).map((e) => e.backup));
  let removed = 0;
  for (const name of readdirSync(backupRoot)) {
    if (!name.startsWith(`${REPO_KEY}__`)) continue;
    if (keep.has(name)) continue;
    rmSync(join(backupRoot, name));
    console.log(`   🗑  対象外になった控えを削除: ${name}`);
    removed += 1;
  }
  manifest.repos = manifest.repos ?? {};
  // ★中身が1バイトも変わっていないのに updatedAt だけ書き換えない。
  //   毎回書き換えると sync のたびに「差分ゼロのコミット」が積まれ、控えの履歴から
  //   「いつ本当に変わったか」が読めなくなる(記録が意味を失う)。
  const sameAsBefore = copied === 0 && removed === 0
    && JSON.stringify(prevEntries) === JSON.stringify(entries);
  if (!sameAsBefore) {
    manifest.repos[REPO_KEY] = { updatedAt: now, files: entries };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  console.log(`✅ バックアップ更新: 書込 ${copied} 件 / 削除 ${removed} 件 / 記録 ${files.length} 件`);
  if (mode === 'backup') {
    console.log('   次に jp225-specs で commit + push してください(控えは push されて初めて安全です):');
    console.log(`     ${manualSyncCommand()}`);
    console.log('   ★ `npm run private:sync` なら、コメントだけの差分に限り自動で commit/push します。');
    process.exit(0);
  }
  syncBackupRepo();   // sync モードはこの先へ進む(commit + push)
  process.exit(0);
}

// verify
const problems = [];
if (!existsSync(backupRoot)) {
  problems.push(`バックアップ先が存在しません: ${backupRoot}`);
} else {
  for (const rel of files) {
    const name = backupNameFor(rel);
    const dest = join(backupRoot, name);
    const hash = sha256(readFileSync(join(repoRoot, rel)));
    if (!existsSync(dest)) { problems.push(`未バックアップ: ${rel}  →  ${name} が無い`); continue; }
    if (sha256(readFileSync(dest)) !== hash) { problems.push(`内容が古い/相違: ${rel}  (控え ${name} と不一致)`); continue; }
    const rec = prevEntries[rel];
    if (!rec) problems.push(`manifest 未記載: ${rel}`);
    else if (rec.sha256 !== hash) problems.push(`manifest のハッシュが古い: ${rel}`);
  }
  const expected = new Set(files.map(backupNameFor));
  for (const name of readdirSync(backupRoot)) {
    if (!name.startsWith(`${REPO_KEY}__`)) continue;
    if (!expected.has(name)) problems.push(`不要な控えが残っています: ${name}(対象外)`);
  }
  for (const rel of Object.keys(prevEntries)) {
    if (!files.includes(rel)) problems.push(`manifest に対象外の記載: ${rel}`);
  }
}

if (problems.length > 0) {
  console.error('');
  console.error('❌ 非公開ファイルのバックアップが最新ではありません:');
  for (const p of problems) console.error(`   - ${p}`);
  console.error('');
  console.error('   復旧手順(1分):');
  console.error('     1) npm run private:backup');
  console.error('     2) jp225-specs で git add/commit/push');
  console.error('   ※ 控えは gitignore された唯一の実体です。push して初めて安全になります。');
  process.exit(1);
}

console.log(`✅ バックアップ一致(${files.length} 件・SHA-256 照合、manifest も一致)`);
