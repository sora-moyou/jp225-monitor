import { describe, it, expect } from 'vitest';
import { detectLevelHold, DEFAULT_HOLD_PARAMS } from './levelHold.js';
import type { HoldBar } from './levelHold.js';

const M = 60_000;
const bar = (i: number, l: number, h: number): HoldBar => ({ t: i * M, l, h });
const levels = [{ price: 65000, label: 'セッション最安値' }];

describe('detectLevelHold', () => {
  it('サポート: 水準にタッチ→上へ反発で support(up)', () => {
    // 直近5本で安値が65,000帯にタッチ、現値は +reclaim(10)以上に反発
    const bars = [bar(0, 65200, 65250), bar(1, 65040, 65120), bar(2, 65002, 65060), bar(3, 65030, 65090), bar(4, 65050, 65110)];
    const r = detectLevelHold(levels, bars, 65040, DEFAULT_HOLD_PARAMS);
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe('support');
    expect(r[0]!.level).toBe(65000);
    expect(r[0]!.label).toBe('セッション最安値');
  });

  it('レジスタンス: 水準にタッチ→下へ反落で resistance(down)', () => {
    const bars = [bar(0, 64800, 64850), bar(1, 64900, 64980), bar(2, 64950, 64999), bar(3, 64900, 64970), bar(4, 64880, 64950)];
    const r = detectLevelHold(levels, bars, 64960, DEFAULT_HOLD_PARAMS);
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe('resistance');
  });

  it('水準を明確に割ったら support は出さない(否定=③)', () => {
    // 安値が L-breakTol を超えて下抜け(64,990 < 65000-2)→ タッチでなくブレイク
    const bars = [bar(0, 65100, 65150), bar(1, 65050, 65090), bar(2, 64980, 65010), bar(3, 64970, 65000), bar(4, 64975, 65005)];
    expect(detectLevelHold(levels, bars, 65030, DEFAULT_HOLD_PARAMS)).toHaveLength(0);
  });

  it('反発が reclaim 未満(まだ水準近辺)なら出さない', () => {
    const bars = [bar(0, 65200, 65250), bar(1, 65040, 65120), bar(2, 65002, 65060), bar(3, 65004, 65030), bar(4, 65003, 65008)];
    expect(detectLevelHold(levels, bars, 65005, DEFAULT_HOLD_PARAMS)).toHaveLength(0);  // current 65005 < 65000+10
  });

  it('タッチしていない(水準まで来ていない)なら出さない', () => {
    const bars = [bar(0, 65300, 65350), bar(1, 65280, 65340), bar(2, 65270, 65330), bar(3, 65290, 65350), bar(4, 65300, 65360)];
    expect(detectLevelHold(levels, bars, 65320, DEFAULT_HOLD_PARAMS)).toHaveLength(0);
  });

  it('ガード: current<=0 / bars<2 は空', () => {
    expect(detectLevelHold(levels, [bar(0, 1, 2)], 65000)).toEqual([]);
    expect(detectLevelHold(levels, [bar(0, 64990, 65010), bar(1, 65050, 65100)], 0)).toEqual([]);
  });
});
