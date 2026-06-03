import { describe, it, expect } from 'vitest';
import { detectDoubleTopBottom, DEFAULT_DOUBLE_PARAMS, type DBar } from './doublePattern.js';

// 直近足を簡単に作る(t は分インデックス, h/l のみ重要、古い→新しい順)
function bars(seq: Array<[number, number]>): DBar[] {   // [high, low]
  return seq.map(([h, l], i) => ({ t: i * 60_000, h, l }));
}

describe('detectDoubleTopBottom', () => {
  const L = 67500;
  const levels = [{ price: L, label: '長期高' }];

  it('ダブルトップ: 髭タッチ→押し戻し→手前10円で2つ目の山 → top', () => {
    const b = bars([
      [67500, 67450],   // 1山目(髭タッチ L)
      [67460, 67390],   // 押し戻し(L-pullback=67490 を下抜け)
      [67430, 67380],
      [67470, 67440],   // 2山目形成中
    ]);
    const sigs = detectDoubleTopBottom(levels, b, 67495, DEFAULT_DOUBLE_PARAMS);
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.kind).toBe('top');
    expect(sigs[0]!.level).toBe(L);
  });

  it('左の山が水準まで手前5(到達せず5円手前)でも成立(touchTol=5)', () => {
    const b = bars([
      [67495, 67450],   // 左=L-5(手前5、到達せず)→ touchTol=5 でタッチ成立
      [67460, 67390],   // 押し戻し
      [67470, 67440],
    ]);
    expect(detectDoubleTopBottom(levels, b, 67495, DEFAULT_DOUBLE_PARAMS).length).toBe(1);
  });

  it('左の山が手前6(5円超手前)なら不成立(touchTol=5 の境界)', () => {
    const b = bars([
      [67494, 67450],   // 左=L-6(手前6)→ touch しない
      [67460, 67390],
      [67470, 67440],
    ]);
    expect(detectDoubleTopBottom(levels, b, 67495, DEFAULT_DOUBLE_PARAMS).length).toBe(0);
  });

  it('ダブルボトム: 左の谷が水準まで手前5でも成立', () => {
    const Llow = 66200;
    const lv = [{ price: Llow, label: '長期安' }];
    const b = bars([
      [66260, 66205],   // 左=L+5(手前5、到達せず)→ タッチ成立
      [66330, 66250],   // 戻り(L+pullback=66210 を上抜け)
      [66280, 66230],
    ]);
    expect(detectDoubleTopBottom(lv, b, 66205, DEFAULT_DOUBLE_PARAMS).length).toBe(1);
  });

  it('髭がレベルを超えたら不成立(ブレイク)', () => {
    const b = bars([
      [67520, 67450],   // 髭が L+breakTol を超えた → INVALID
      [67460, 67390],
      [67470, 67440],
    ]);
    expect(detectDoubleTopBottom(levels, b, 67495, DEFAULT_DOUBLE_PARAMS).length).toBe(0);
  });

  it('髭が breakTol 以内の超過なら成立(到達=タッチ扱い)', () => {
    const b = bars([
      [67502, 67450],   // L+2 = breakTol ちょうど(超過でない=タッチ)
      [67460, 67390],   // 押し戻し
      [67470, 67440],
    ]);
    expect(detectDoubleTopBottom(levels, b, 67495, DEFAULT_DOUBLE_PARAMS).length).toBe(1);
  });

  it('髭が breakTol を1円でも超えたら不成立', () => {
    const b = bars([
      [67503, 67450],   // L+3 > breakTol(2) → INVALID
      [67460, 67390],
      [67470, 67440],
    ]);
    expect(detectDoubleTopBottom(levels, b, 67495, DEFAULT_DOUBLE_PARAMS).length).toBe(0);
  });

  it('押し戻しが無い(ゾーンに留まる)なら不成立', () => {
    const b = bars([
      [67500, 67492],   // タッチ
      [67498, 67491],   // 押し戻し無し(L-pullback=67490 を割らない)
      [67497, 67493],
    ]);
    expect(detectDoubleTopBottom(levels, b, 67496, DEFAULT_DOUBLE_PARAMS).length).toBe(0);
  });

  it('谷がタッチより前にしか無いなら不成立(時系列: タッチ→谷の順が必要)', () => {
    const b = bars([
      [67485, 67380],   // 深い谷だがタッチ前(h<L-touchTol なのでタッチではない)
      [67470, 67460],
      [67500, 67470],   // タッチはこの後
      [67496, 67492],   // タッチ後は押し戻し無し(low 67492 ≥ L-pullback=67490)
    ]);
    expect(detectDoubleTopBottom(levels, b, 67495, DEFAULT_DOUBLE_PARAMS).length).toBe(0);
  });

  it('現値が手前10円ゾーン外なら出さない', () => {
    const b = bars([[67500, 67450], [67450, 67380], [67440, 67430]]);
    expect(detectDoubleTopBottom(levels, b, 67470, DEFAULT_DOUBLE_PARAMS).length).toBe(0);   // L-30
  });

  it('現値がレベルちょうど(到達)なら手前ではないので出さない', () => {
    const b = bars([[67500, 67450], [67460, 67390], [67470, 67440]]);
    expect(detectDoubleTopBottom(levels, b, 67500, DEFAULT_DOUBLE_PARAMS).length).toBe(0);   // current==L
  });

  it('ダブルボトム: 上下対称 → bottom', () => {
    const Llow = 66200;
    const lv = [{ price: Llow, label: '長期安' }];
    const b = bars([
      [66260, 66200],   // 1谷目(髭タッチ L)
      [66330, 66250],   // 戻り(L+pullback=66210 を上抜け)
      [66340, 66270],
      [66280, 66230],   // 2谷目形成中
    ]);
    const sigs = detectDoubleTopBottom(lv, b, 66205, DEFAULT_DOUBLE_PARAMS);
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.kind).toBe('bottom');
  });

  it('同一レベルで top/bottom が同時に出ない(現値==L 排他)', () => {
    const b = bars([[67500, 67450], [67460, 67390], [67470, 67440]]);
    const sigs = detectDoubleTopBottom(levels, b, 67500, DEFAULT_DOUBLE_PARAMS);
    expect(sigs.length).toBe(0);
  });
});
