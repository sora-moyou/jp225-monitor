import { describe, it, expect } from 'vitest';
import { detectSwingDouble, DEFAULT_SWING_DOUBLE } from './swingDouble.js';
import type { SwingPivot } from './swingPivots.js';

const M = 60_000;
const lo = (i: number, price: number): SwingPivot => ({ kind: 'low', price, t: i * M });
const hi = (i: number, price: number): SwingPivot => ({ kind: 'high', price, t: i * M });

describe('detectSwingDouble', () => {
  // ユーザー実例: 谷 66950 → ネック 67770 → 谷 66930、現値 67790(ネック上抜け)
  const example: SwingPivot[] = [hi(0, 68085), lo(1, 66950), hi(2, 67770), lo(3, 66930)];

  it('ダブルボトム成立: ネック上抜けで breakout(谷差が小さくてもOK)', () => {
    const s = detectSwingDouble(example, 67790);
    expect(s?.kind).toBe('bottom');
    expect(s?.stage).toBe('breakout');
    expect(s?.neck).toBe(67770);
    expect(s?.legs).toEqual([66950, 66930]);
    expect(s?.target).toBe(67770 + (67770 - 66950));   // 浅い方(66950)基準 = 68590
  });

  it('ダブルボトム形成中: 現値がネック未満なら forming', () => {
    expect(detectSwingDouble(example, 67500)?.stage).toBe('forming');
  });

  it('谷の価格差が大きくても、ネック突出が足りれば成立(equal-lows不要)', () => {
    // 谷1=66000, 谷2=67000(差1000)。ネック68000、浅い方=67000、突出=1000≥150。
    // 既定 lowTol=2000 なら差1000は通る(ユーザー指定: 谷差は実質不問)。ここでは明示的に広げて確認。
    const piv: SwingPivot[] = [hi(0, 69000), lo(1, 66000), hi(2, 68000), lo(3, 67000)];
    expect(detectSwingDouble(piv, 68100, { ...DEFAULT_SWING_DOUBLE, lowTol: 2000 })?.stage).toBe('breakout');
  });

  it('ネックの突出が minProminence 未満なら null(浅いW=ノイズ)', () => {
    const flat: SwingPivot[] = [hi(0, 67100), lo(1, 67000), hi(2, 67050), lo(3, 67000)];  // 突出50<150
    expect(detectSwingDouble(flat, 67060)).toBeNull();
  });

  it('現値が谷を割ったら(パターン破壊)null', () => {
    expect(detectSwingDouble(example, 66800)).toBeNull();   // 66800 < min(66950,66930)
  });

  it('ダブルトップ成立: ネック下抜けで breakout', () => {
    const top: SwingPivot[] = [lo(0, 66000), hi(1, 67800), lo(2, 67000), hi(3, 67820)];
    const s = detectSwingDouble(top, 66990);
    expect(s?.kind).toBe('top');
    expect(s?.stage).toBe('breakout');
    expect(s?.neck).toBe(67000);
    expect(s?.target).toBe(67000 - (67800 - 67000));   // 浅い方の山(67800)基準
  });

  it('最後のピボットが山(=ボトム形成中でない)ならボトムは出ない', () => {
    const piv: SwingPivot[] = [lo(0, 66950), hi(1, 67770), lo(2, 66930), hi(3, 67900)];
    expect(detectSwingDouble(piv, 67950)?.kind).not.toBe('bottom');
  });

  it('ガード: ピボット3本未満 / 現値<=0 は null', () => {
    expect(detectSwingDouble([lo(0, 1), hi(1, 2)], 3)).toBeNull();
    expect(detectSwingDouble(example, 0)).toBeNull();
  });
});
