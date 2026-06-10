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

  // ダブルは2つの脚が「ほぼ同じ高さ」でなければ人間の認識と乖離する(谷64,455→63,755=差700の
  // 切り下げを「ダブルボトム」と誤検知していた)。谷差は突出(ネック高さ)に対する比率で判定する。
  it('谷差が突出に対して大きすぎる(切り下げ/切り上げ)なら null', () => {
    // 谷1=64455, 谷2=63755(差700・切り下げ)。ネック65090、浅い方=64455、突出=635。
    // 比率 700/635=1.10 > 0.4 → 非ダブル(ユーザー実例)。
    const piv: SwingPivot[] = [hi(0, 65800), lo(1, 64455), hi(2, 65090), lo(3, 63755)];
    expect(detectSwingDouble(piv, 64365)).toBeNull();
  });
  it('谷がほぼ同じ高さ(突出比 ≤ lowTolRatio=0.08)なら成立', () => {
    // 谷1=66000, 谷2=66050(差50)。ネック67000、浅い方=66050、突出=950。比率50/950=0.053 ≤ 0.08 → OK。
    const piv: SwingPivot[] = [hi(0, 68000), lo(1, 66000), hi(2, 67000), lo(3, 66050)];
    expect(detectSwingDouble(piv, 66800)?.stage).toBe('forming');
  });
  it('谷差が突出の8%を超えれば null(やや不揃いでも厳格に弾く)', () => {
    // 谷1=66000, 谷2=66150(差150)。突出=850。比率150/850=0.176 > 0.08 → null。
    const piv: SwingPivot[] = [hi(0, 68000), lo(1, 66000), hi(2, 67000), lo(3, 66150)];
    expect(detectSwingDouble(piv, 66800)).toBeNull();
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

  // 決着済みガード: ネックを大きく抜けて測定移動の目標に到達したら、もう「認識できる」
  // setup ではない(古いブレイクの再発火)。actionable=ネック近傍だけ通知する。
  describe('決着済みガード(目標到達で打ち切り)', () => {
    // example: neck 67770, 浅い谷 66950, 突出 820, target 68590
    it('ダブルボトム: 目標(68590)以上では null', () => {
      expect(detectSwingDouble(example, 68590)).toBeNull();
      expect(detectSwingDouble(example, 68700)).toBeNull();
    });
    it('ダブルボトム: 目標手前のブレイクは breakout のまま', () => {
      expect(detectSwingDouble(example, 68500)?.stage).toBe('breakout');
      expect(detectSwingDouble(example, 67790)?.stage).toBe('breakout');
    });
    it('ダブルトップ: 目標(66200)以下では null', () => {
      // neck 67000, 浅い山 67800, 突出 800, target 66200
      const top: SwingPivot[] = [lo(0, 66000), hi(1, 67800), lo(2, 67000), hi(3, 67820)];
      expect(detectSwingDouble(top, 66200)).toBeNull();
      expect(detectSwingDouble(top, 66000)).toBeNull();
      expect(detectSwingDouble(top, 66300)?.stage).toBe('breakout');
    });
    it('breakoutExtensionRatio を狭めると、より早く打ち切る', () => {
      // ratio 0.5 → 目標の半分(neck+410=68180)以上で null
      expect(detectSwingDouble(example, 68200, { ...DEFAULT_SWING_DOUBLE, breakoutExtensionRatio: 0.5 })).toBeNull();
      expect(detectSwingDouble(example, 68000, { ...DEFAULT_SWING_DOUBLE, breakoutExtensionRatio: 0.5 })?.stage).toBe('breakout');
    });
  });
});
