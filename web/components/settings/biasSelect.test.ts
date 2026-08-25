import { describe, it, expect } from 'vitest';
import { applyBiasSelect, applyBiasSelectB } from './form.js';

// ★2026-08-25(ユーザー指示 + エバリュエーターのブロッカー2): 目線 select を空欄にしない。
//
// ■ 何が壊れていたか(エバリュエーターが実Chrome で再現)
//   `<option value="none">` を消したのに `select.value = 'none'` を代入していたため、
//   ブラウザは **selectedIndex = -1(表示は空欄)** にする。
//   `scalpBias` は既定で未設定なので、**目線を一度も触っていない全ユーザー** が空欄で開いた。
//   そのまま保存すると '' が送られ 'none' で保存され、手動なのに A を呼ぶ「第6のルート」に居続ける。
//
// ■ ★なぜ既存の form.test.ts がすり抜けたか(この検査を別に立てた理由)
//   あちらの入力要素スタブは `value` がただの文字列で、**存在しない option を代入できてしまう**。
//   ここでは **ブラウザの `<select>` と同じ規則**(候補に無い値を入れたら '' になる)を持つスタブで殴る。
//   ★スタブが本物と同じ規則であることは、下の「①スタブ自身の検査」で先に固定する。

/** ブラウザの `<select>` と同じ規則を持つ最小スタブ。
 *  ★2026-08-25(エバリュエーター3周目): **selectedIndex も持たせる**。
 *    `value` だけだと「空欄(-1)」と「実在する '' の option(0)」が **同じ ''** に潰れ、
 *    B 側の旧実装(`bias ?? ''`)に戻す変異が **生き残った**(実Chrome なら区別できる)。 */
function selectStub(values: readonly string[]) {
  // ★本物の規則: 代入した値が候補に無ければ **selectedIndex = -1**、そのとき value は '' を返す。
  //   ★indexOf(value) で後から計算してはいけない: `''` が実在の option の場合(B系統)、
  //     「空欄(-1)」と「'' の option(0)」が同じ 0 に潰れる。**選択位置そのものを持つ**。
  let idx = 0;
  return {
    options: values,
    get value(): string { return idx >= 0 ? values[idx]! : ''; },
    set value(x: string) { idx = values.indexOf(x); },
    get selectedIndex(): number { return idx; },
  };
}
/** A の目線 select(実際の index.html と同じ候補)。 */
const aSelect = () => selectStub(['long', 'short', 'range']);
/** B の目線 select('' = A追従 が実在する)。 */
const bSelect = () => selectStub(['', 'long', 'short', 'range']);
const modeStub = () => selectStub(['manual', 'ai']);
const modeStubB = () => selectStub(['', 'manual', 'ai']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const A = (bias: string | undefined, source: string | undefined) => {
  const s = aSelect(), m = modeStub();
  applyBiasSelect(s as any, m as any, bias, source);
  return { value: s.value, mode: m.value };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const B = (bias: string | undefined, source: string | undefined) => {
  const s = bSelect(), m = modeStubB();
  applyBiasSelectB(s as any, m as any, bias, source);
  return { value: s.value, mode: m.value };
};

describe('★目線 select を空欄にしない(2026-08-25 ブロッカー2)', () => {
  it('① スタブ自身が本物と同じ規則(候補に無い値は空欄になる)', () => {
    const s = aSelect();
    s.value = 'long';  expect(s.value).toBe('long');
    s.value = 'none';  expect(s.value).toBe('');       // ★これが実Chrome の selectedIndex=-1 に相当
  });

  it('★★未設定(目線を一度も触っていない全ユーザー)で空欄にならない', () => {
    const r = A(undefined, undefined);
    expect(r.value).not.toBe('');            // ★直す前はここが '' だった
    expect(r.value).toBe('long');
    expect(r.mode).toBe('ai');               // ★「固定しない」= AI委任(挙動は従来と同じ)
  });

  it("★★レガシー 'none' + 手動 も空欄にならず、AI委任へ倒れる(第6のルートを消す)", () => {
    const r = A('none', 'manual');
    expect(r.value).toBe('long');
    expect(r.mode).toBe('ai');
  });

  it('★固定している回は保存値と mode をそのまま出す(倒し先に巻き込まない)', () => {
    expect(A('long', 'manual')).toEqual({ value: 'long', mode: 'manual' });
    expect(A('short', 'manual')).toEqual({ value: 'short', mode: 'manual' });
    expect(A('range', 'manual')).toEqual({ value: 'range', mode: 'manual' });
    // AI委任のまま固定値が残っている回も、値は消さない(委任なので select は無効化されるだけ)
    expect(A('range', 'ai')).toEqual({ value: 'range', mode: 'ai' });
  });

  it('★B: 未設定/none は A追従の空文字(実在の option)へ倒れる', () => {
    expect(B(undefined, undefined)).toEqual({ value: '', mode: '' });
    expect(B('none', 'manual')).toEqual({ value: '', mode: 'ai' });   // 明示 manual は AI委任へ
    expect(B('none', '')).toEqual({ value: '', mode: '' });           // ★元から A追従なら触らない
  });

  it('★★B: 空欄(-1)ではなく **実在の option** が選ばれている(value だけでは区別できない)', () => {
    // ★B の select には '' が実在するので、value=='' だけでは
    //   「A追従が選ばれている(index 0)」と「空欄(index -1)」が見分けられない。
    //   ★実Chrome で区別できるものを、ここでも区別する。
    for (const [bias, source] of [[undefined, undefined], ['none', 'manual'], ['none', '']] as const) {
      const s = bSelect(), m = modeStubB();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      applyBiasSelectB(s as any, m as any, bias, source);
      expect(s.selectedIndex, `bias=${bias} source=${source}`).toBeGreaterThanOrEqual(0);
    }
    // ★否定対照: 旧実装(素直に代入)なら 'none' は候補に無いので -1(空欄)になる。
    const bad = bSelect();
    bad.value = 'none';
    expect(bad.selectedIndex).toBe(-1);
  });

  it('★B: 固定している回はそのまま', () => {
    expect(B('range', 'manual')).toEqual({ value: 'range', mode: 'manual' });
    expect(B('short', 'ai')).toEqual({ value: 'short', mode: 'ai' });
  });

  it('★★否定対照: 旧実装(素直に代入)なら空欄になる', () => {
    const s = aSelect();
    const stored: string | undefined = undefined;          // 保存値=未設定(既定)
    s.value = stored ?? 'none';                            // ★旧実装: current?.scalpBias ?? 'none'
    expect(s.value).toBe('');                               // ← これが不具合そのもの
  });
});
