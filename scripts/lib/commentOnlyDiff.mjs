// 非公開ファイルの控えの差分が「コメントだけ」かを判定する純関数。
//
// ■ なぜ要るか
//   控えの同期(commit + push)を自動化すると、**意図しない変更まで黙って控えに入る**。
//   決済の数値が1文字変わっても自動で push されてしまうのは、この控えの目的
//   (「実体が消えたときに復元できる」)を壊す方向の事故になりうる。
//   → 自動でよいのは「コメントだけの差分」と「manifest(ハッシュ記録)」に限る。
//      それ以外が1行でもあれば **止めて人間に見せる**。
//
// ■ ★秘密は決して出さない
//   判定は行の**分類**だけを見る。呼び出し側は「コメント以外が N 行」としか出力しない。
//   差分の中身をログ・エラーに出してはならない(このモジュールも中身を返さない)。

/** その行(diff の +/- を除いた本文)がコメント/空行か。TypeScript/JS のみを想定。 */
export function isCommentLine(text) {
  const t = String(text).trim();
  if (t === '') return true;
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
}

/**
 * `git diff` の生テキストを分類する純関数。
 * 返すのは **件数だけ**(中身は返さない)。
 *
 * - manifest.json の変更はハッシュ記録なので「自動でよい」側に数える(codeChanges には入れない)。
 * - 新規ファイル(untracked)はこの diff に現れないので、呼び出し側が別途 **止める** こと。
 */
export function classifyBackupDiff(diffText) {
  let commentChanges = 0;
  let codeChanges = 0;
  let manifestChanges = 0;
  let inManifest = false;
  for (const raw of String(diffText ?? '').split('\n')) {
    if (raw.startsWith('diff --git ')) { inManifest = /manifest\.json/.test(raw); continue; }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@')
      || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file')
      || raw.startsWith('similarity ') || raw.startsWith('rename ')) continue;
    if (raw.startsWith('+') || raw.startsWith('-')) {
      const body = raw.slice(1);
      if (inManifest) { manifestChanges += 1; continue; }
      if (isCommentLine(body)) commentChanges += 1;
      else codeChanges += 1;
    }
  }
  return { commentChanges, codeChanges, manifestChanges, autoSafe: codeChanges === 0 };
}
