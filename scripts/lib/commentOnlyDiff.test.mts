import { describe, it, expect } from 'vitest';
import { classifyBackupDiff, isCommentLine } from './commentOnlyDiff.mjs';

// ─── ★控えの自動同期を「安全な差分」に限る判定 ──────────────────────────────
//
// この判定が甘いと、決済の数値の変更が **黙って** 控えへ push される。
// 判定が厳しすぎる分には止まるだけなので害はない。だから迷ったら codeChanges 側に倒す。
//
// ★このテストは差分の **中身** を扱うが、ここに書くのは架空の値だけ。
//   実物の決済数値は書かない(漏洩検査の対象になる)。

describe('isCommentLine', () => {
  it('コメントと空行だけを true にする', () => {
    for (const s of ['// あ', '  // あ', '* あ', '/* あ', '*/', '', '   ']) {
      expect(isCommentLine(s), s).toBe(true);
    }
    for (const s of ['const a = 1;', '  return 3;', 'x: 12,', 'const s = "// これは文字列";']) {
      expect(isCommentLine(s), s).toBe(false);
    }
  });
});

describe('classifyBackupDiff', () => {
  const diff = (body: string) => `diff --git a/private-backup/monitor__x.ts b/private-backup/monitor__x.ts
index 111..222 100644
--- a/private-backup/monitor__x.ts
+++ b/private-backup/monitor__x.ts
@@ -1,3 +1,3 @@
${body}`;

  it('★コメントだけの差分は自動でよい', () => {
    const r = classifyBackupDiff(diff('-// 実弾につながる経路\n+// 実取引につながる経路'));
    expect(r.codeChanges).toBe(0);
    expect(r.commentChanges).toBe(2);
    expect(r.autoSafe).toBe(true);
  });

  it('★コードが1行でも変わっていたら自動にしない(止める)', () => {
    const r = classifyBackupDiff(diff('-// 説明\n+// 説明(改)\n-  const step = 11;\n+  const step = 12;'));
    expect(r.codeChanges).toBe(2);
    expect(r.autoSafe).toBe(false);
  });

  it('manifest(ハッシュ記録)の変更は自動でよい側に数える', () => {
    const r = classifyBackupDiff(`diff --git a/private-backup/manifest.json b/private-backup/manifest.json
--- a/private-backup/manifest.json
+++ b/private-backup/manifest.json
@@ -1 +1 @@
-      "sha256": "aaa",
+      "sha256": "bbb",`);
    expect(r.manifestChanges).toBe(2);
    expect(r.codeChanges).toBe(0);
    expect(r.autoSafe).toBe(true);
  });

  it('manifest とコード変更が混ざったら止める', () => {
    const r = classifyBackupDiff(`diff --git a/private-backup/manifest.json b/private-backup/manifest.json
@@ -1 +1 @@
-      "sha256": "aaa",
+      "sha256": "bbb",
diff --git a/private-backup/monitor__x.ts b/private-backup/monitor__x.ts
@@ -1 +1 @@
-  const a = 1;
+  const a = 2;`);
    expect(r.codeChanges).toBe(2);
    expect(r.autoSafe).toBe(false);
  });

  it('ヘッダ行(index/@@/+++/---)は数えない', () => {
    const r = classifyBackupDiff(diff('+// 1行だけ'));
    expect(r.commentChanges).toBe(1);
    expect(r.codeChanges).toBe(0);
  });

  it('空の diff は「変更なし=自動でよい」', () => {
    const r = classifyBackupDiff('');
    expect(r).toEqual({ commentChanges: 0, codeChanges: 0, manifestChanges: 0, autoSafe: true });
  });
});
