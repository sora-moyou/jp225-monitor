// ─── ★v1f 質問文(= v1 マイナス「LC の理由の箱の書かせ方」) ─────────────────────────────
//
// ■ 何を測る腕か
//   v0.9.88 で `lcWhyForLimit` / `lcWhyForStop`(LC 幅の理由の箱)を新設したが、実測で
//   **8割が検算で埋まる**(「幅の根拠」ではなく引き算がそのまま入る)。
//   仮説(機構): selfCheckNote が「その引き算を rationale に書き、答えと **lcWidthFor…** の数値が
//   一致しているか」と言っており、新設の箱 **lcWhyFor…** と1文字違いで隣接している
//   = ★**宛先の取り違え**。
//   ⇒ v1f は「箱の書かせ方だけを変えたら、判断が書かれるようになるか」を1変数で測る腕。
//
// ■ ★文面をどう決めたか(ユーザー指示・逐語「rationaleに書いたのち、検算に類するものを削除」)
//   最初の案は「検算は rationale に書くので、**ここには書かない**」= **禁止(否定文)** だった。
//   このプロジェクトは「数値や語は **否定文の中でも供給される**」という実測を持つ
//   (v0.9.64: 「LC幅の下限に5円を足す という意味ではない」という否定文が 5 の供給源になっていた)。
//   ⇒ 禁止をやめ **手順** にする。さらに「削除」だけでは箱が **空になる** ので、
//     手順の真ん中に「何を書くか」を置く(①検算は rationale へ →②根拠に選んだ節目と なぜそこか →③残った検算は削除)。
//
// ■ このテストが固定する不変条件
//   (1) v1 と v1f の差分は **lcWhyFor* の2行だけ**(実プロンプト全文の行差分で実証する)
//   (2) 新しい注記に **否定語・新しい数値・長さアンカー** が無い
//   (3) 手順に「何を書くか」が入っている(削除だけで終わらせない)
//   (4) `rationale` の検算要求は **両腕とも** 外れていない(外すと符号ミス3倍という実測)
//   (5) 位置の規則 Ｃ は **両腕に入る**(そうでないと対照が2変数になる)
//   (6) 変種の受け口・予算の帳簿・候補腕の接続
//   (7) lcWhyJudgment を立てる分岐は scalpPlan.ts の1箇所だけ(無条件で立っていない)
//   (8) 稼働機(engine の3経路)は promptVariant を1度も渡さない=v1f は実取引に触れない

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildScalpQuestion, buildScalpSystemPrompt, scalpJsonInstruction, buildVisionNote, lcWhyNote,
} from './openai.js';
import { PROMPT_VARIANTS, normalizePromptVariant, generatorArmKey } from './promptVariant.js';
import { planCycleArms } from '../generator/cycle.js';

const FLOOR = 55;
const CEIL = 160;
const REF = 38250;

/** その腕が実際に送る user プロンプト全文(質問文 + 画像注記 + JSON 契約)。 */
const userOf = (judgment: boolean): string => {
  const q = buildScalpQuestion(FLOOR, CEIL, true, 100);
  const j = scalpJsonInstruction(REF, FLOOR, CEIL, true, undefined, judgment);
  return `${q}\n\n${buildVisionNote(false)}${j}`;
};
const V1 = () => userOf(false);
const V1F = () => userOf(true);
/** 行単位の差分(片方にしか無い行)。 */
const changedLines = (a: string, b: string): { removed: string[]; added: string[] } => {
  const la = a.split('\n');
  const lb = b.split('\n');
  return {
    removed: la.filter((l, i) => lb[i] !== l),
    added: lb.filter((l, i) => la[i] !== l),
  };
};

describe('v1f 質問文 — v1 との差分は「LC の理由の箱の書かせ方」1点だけ', () => {
  it('(1) 差分は lcWhyForLimit / lcWhyForStop の2行だけ', () => {
    const { removed, added } = changedLines(V1(), V1F());
    expect(removed).toHaveLength(2);
    expect(added).toHaveLength(2);
    expect(removed[0]).toContain('"lcWhyForLimit"');
    expect(removed[1]).toContain('"lcWhyForStop"');
    expect(added[0]).toContain('"lcWhyForLimit"');
    expect(added[1]).toContain('"lcWhyForStop"');
    // 行数は変わらない(足しても削ってもいない=同じ2行の中身だけ)。
    expect(V1F().split('\n')).toHaveLength(V1().split('\n').length);
  });

  it('(2) 新しい注記に 否定語 / 新しい数値 / 長さアンカー が無い', () => {
    for (const f of ['lcWidthForLimit', 'lcWidthForStop'] as const) {
      const note = lcWhyNote(f, true);
      // ★否定形は使わない(このプロジェクトは「否定文の中でも語が供給される」実測を持つ)。
      for (const w of ['書かない', '書くな', '禁止', '不可', 'してはならない', 'ではない', '入れない']) {
        expect(note, `注記に否定語「${w}」がある: ${note}`).not.toContain(w);
      }
      // ★長さアンカーを新設しない(「1行」は理由を 47% 削っていた実測)。
      for (const w of ['1行', '一行', '簡潔', '短く', '字以内', '文字以内']) {
        expect(note, `注記に長さの指示「${w}」がある: ${note}`).not.toContain(w);
      }
      // ★新しい数値を足さない(手順番号の丸数字だけで、算用数字は現れない)。
      expect(note.match(/\d/g), `注記に数値がある: ${note}`).toBeNull();
    }
  });

  it('(3) 手順に「何を書くか」が入っている(削除だけで終わらせない)', () => {
    const note = lcWhyNote('lcWidthForLimit', true);
    expect(note).toContain('検算は rationale に書く');            // ①宛先の明示(肯定形の割り当て)
    expect(note).toContain('根拠に選んだ節目');                    // ②この欄に書く中身
    expect(note).toContain('削除');                                // ③ユーザー指示の「検算に類するものを削除」
    // 順序であることが読める(①→②→③)。
    expect(note.indexOf('①')).toBeLessThan(note.indexOf('②'));
    expect(note.indexOf('②')).toBeLessThan(note.indexOf('③'));
    // 省略の規約は残す(レッグ落ちと欠測を区別するため)。
    expect(note).toContain('lcWidthForLimit と対で省略');
  });

  // ★v0.9.94: 自己検算③ から「引き算して rationale に書く」を外した(AI に **存在しない価格** を
  //   想像させていたため)。★rationale の引き算要求そのものは **別の SSOT**(lcFloorRule /
  //   JSON 契約の rationale 注記)に残っており、両腕とも外れていない=ここで守る不変条件は不変。
  // ★v0.9.94: 引き算の申告要求そのものを削除した(AI が出すのは幅だけ/価格はこちらで付ける)。
  //   ★この it が守る不変条件は「両腕で同じ」に読み替える: **幅の下限の要求** は両腕とも外れていない。
  it('(4) 幅の下限の要求は 両腕とも 外れていない(引き算の申告は両腕とも消えた)', () => {
    for (const [name, t] of [['v1', V1()], ['v1f', V1F()]] as const) {
      expect(t, `${name}: 幅の下限の要求が消えている`).toContain('★【最優先: 損切りの幅(無条件・例外なし)】');
      expect(t, `${name}: 自己検算が消えている`).toContain('★【出力前の自己検算(必須)】');
      expect(t, `${name}: 引き算の申告が残っている`).not.toContain('その引き算をそのまま書くこと');
    }
  });

  it('(5) 位置の規則 Ｃ は 両腕に入る(対照が2変数にならない)', () => {
    for (const [name, t] of [['v1', V1()], ['v1f', V1F()]] as const) {
      expect(t, `${name}: Ｃ が入っていない`).toContain('★【Ｃ: Ｘ・Ｙ の価格の決め方(位置の規則)】');
    }
    // system プロンプトは v1/v1f で同一(動かした変数は JSON 契約の2行だけ)。
    const sys = buildScalpSystemPrompt(FLOOR, CEIL, true, 100, true);
    expect(sys).toContain('★【Ｃ: Ｘ・Ｙ の価格の決め方(位置の規則)】');
  });

  it('(6) 変種の受け口・予算の帳簿・候補腕の接続', () => {
    // ★旧変種は語彙から消さない(台帳に過去の行が残っている)。
    expect(PROMPT_VARIANTS).toEqual(['v1', 'v2', 'v1d', 'v1e', 'v1f']);
    expect(normalizePromptVariant('v1f')).toEqual({ ok: true, variant: 'v1f' });
    expect(normalizePromptVariant('v1g').ok).toBe(false);
    // 予算の帳簿は v1 と別(先着の腕が取引日の残りを食い切らない)。
    expect(generatorArmKey('current', 'v1f')).toBe('current+v1f');
    expect(generatorArmKey('current', 'v1f')).not.toBe(generatorArmKey('current', 'v1'));
    // 候補腕だけが v1f を送る(①①' は v1)。決済仕様は3本とも同じ=動かす変数は質問文だけ。
    const arms = planCycleArms(0, 1);
    expect(arms.map(a => a.arm)).toEqual(['current', 'control', 'prompt-v1f']);
    expect(arms.map(a => a.promptVariant)).toEqual(['v1', 'v1', 'v1f']);
    expect(new Set(arms.map(a => a.exitVariant))).toEqual(new Set(['current']));
  });

  it('(7) lcWhyJudgment を立てる分岐は scalpPlan.ts の1箇所だけ(無条件で立っていない)', () => {
    const src = readFileSync(fileURLToPath(new URL('./scalpPlan.ts', import.meta.url)), 'utf8');
    const lines = src.split('\n').filter(l => l.includes(`promptVariant === 'v1f'`));
    expect(lines, `v1f を立てる箇所は1つだけ`).toHaveLength(1);
    // 既定は false(引数省略で v1 と byte 一致)。
    expect(scalpJsonInstruction(REF, FLOOR, CEIL, true)).toBe(scalpJsonInstruction(REF, FLOOR, CEIL, true, undefined, false));
  });

  it('(8) 稼働機(engine)は promptVariant を1度も渡さない=v1f は実取引に触れない', () => {
    const src = readFileSync(fileURLToPath(new URL('../signalTrade/engine.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('promptVariant');
  });
});
