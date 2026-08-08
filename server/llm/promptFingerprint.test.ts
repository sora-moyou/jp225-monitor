import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { promptFingerprint, isPromptFingerprint, PROMPT_FP_SCOPE, PROMPT_FP_HEX_CHARS } from './promptFingerprint.js';

// ─── プロンプトの指紋(記録専用の純関数) ─────────────────────────────────────────
//
// 何を守っているか:
//   ・同じ入力なら同じ指紋 / 1文字でも違えば違う指紋(= 突合の道具として成立する)
//   ・system と user の **境界** が曖昧でない(片方の末尾がもう片方の先頭へずれても別物になる)
//   ・指紋は本文を1バイトも含まない(DB へ落ちるのはこの値だけなので、ここが最後の砦)
//
// ★否定対照: promptFingerprint から user を外す(system だけで取る)と
//   「question だけが変わった版を別物と見なす」が赤くなる。長さの前置を外すと境界のテストが赤くなる。

const SYS = '【あなたはスキャルの戦略担当】…設定と市場文脈…';
const USR = '【質問】この場面でどう入るか JSON で答えよ';

describe('promptFingerprint — 同じ入力なら同じ・違えば違う', () => {
  it('形式は `scope:16桁hex`(記録する値の形を固定する)', () => {
    const fp = promptFingerprint(SYS, USR);
    expect(fp.startsWith(`${PROMPT_FP_SCOPE}:`)).toBe(true);
    expect(fp.slice(PROMPT_FP_SCOPE.length + 1)).toMatch(new RegExp(`^[0-9a-f]{${PROMPT_FP_HEX_CHARS}}$`));
    expect(isPromptFingerprint(fp)).toBe(true);
    expect(isPromptFingerprint('deadbeefdeadbeef')).toBe(false);   // 版タグの無い値は受け付けない
  });

  it('同じ入力 → 同じ指紋(決定論)', () => {
    expect(promptFingerprint(SYS, USR)).toBe(promptFingerprint(SYS, USR));
  });

  it('system が1文字でも違えば別の指紋', () => {
    expect(promptFingerprint(`${SYS} `, USR)).not.toBe(promptFingerprint(SYS, USR));
  });

  it('★user(question)が違えば別の指紋 = question 側だけが変わった版を同一視しない', () => {
    expect(promptFingerprint(SYS, `${USR}(追記)`)).not.toBe(promptFingerprint(SYS, USR));
  });

  it('★system と user の境界が曖昧でない(連結しただけの入力と衝突しない)', () => {
    // 単純連結なら 'ab'+'c' と 'a'+'bc' が同じ指紋になってしまう。長さの前置でそれを防ぐ。
    expect(promptFingerprint('ab', 'c')).not.toBe(promptFingerprint('a', 'bc'));
  });

  it('★指紋は本文を含まない(復元も部分一致も不可能な長さ・値)', () => {
    const fp = promptFingerprint(SYS, USR);
    expect(fp.length).toBe(PROMPT_FP_SCOPE.length + 1 + PROMPT_FP_HEX_CHARS);
    expect(fp).not.toContain('スキャル');
    expect(fp).not.toContain('JSON');
    // sha256 の先頭を切り出したものであること(独自変換で情報が混ざっていない)。
    expect(/^[0-9a-f]+$/.test(fp.split(':')[1]!)).toBe(true);
  });

  it('マルチバイトの長さは **バイト数** で数える(文字数だと別入力が同じ前置になりうる)', () => {
    const h = createHash('sha256');
    h.update(`${PROMPT_FP_SCOPE}\n`, 'utf8');
    h.update(`${Buffer.byteLength(SYS, 'utf8')}\n`, 'utf8');
    h.update(SYS, 'utf8');
    h.update(`\n${Buffer.byteLength(USR, 'utf8')}\n`, 'utf8');
    h.update(USR, 'utf8');
    expect(promptFingerprint(SYS, USR)).toBe(`${PROMPT_FP_SCOPE}:${h.digest('hex').slice(0, PROMPT_FP_HEX_CHARS)}`);
  });
});
