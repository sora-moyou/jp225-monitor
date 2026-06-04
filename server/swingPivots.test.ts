import { describe, it, expect } from 'vitest';
import { extractSwingPivots, type SwingBar } from './swingPivots.js';

const M = 60_000;
const bar = (i: number, l: number, h: number): SwingBar => ({ t: i * M, l, h });

describe('extractSwingPivots', () => {
  it('安値→(後続足で)reclaim戻しで押し安値を固定確定', () => {
    const bars = [bar(0, 120, 130), bar(1, 100, 115), bar(2, 98, 110), bar(3, 115, 128)];
    // 底98(bar2)、bar3 の高値128 が 98+25=123 以上 → 押し安値98 を確定
    expect(extractSwingPivots(bars, 25)).toContainEqual({ price: 98, kind: 'low', t: 2 * M });
  });

  it('同一バーのレンジ(高安幅>reclaim)だけでは確定しない(後続足が要る)', () => {
    expect(extractSwingPivots([bar(0, 100, 140)], 25)).toEqual([]);             // 1本=確定なし
    expect(extractSwingPivots([bar(0, 100, 105), bar(1, 98, 103)], 25)).toEqual([]); // まだ戻していない
  });

  it('一方向の下落中は押し安値を量産しない(=ダブルボトム乱発の元を断つ)', () => {
    // ユーザー事例の階段状下落: 安値が下げ続け、各足レンジ~30、戻りは reclaim(25)未満
    const bars = [
      bar(0, 67345, 67360), bar(1, 67320, 67350), bar(2, 67295, 67325),
      bar(3, 67290, 67315), bar(4, 67285, 67305),
    ];
    const lows = extractSwingPivots(bars, 25).filter(p => p.kind === 'low');
    expect(lows).toEqual([]);   // 下落中に「固定支持(押し安値)」は確定しない
  });

  it('確定済みピボットは固定値(末尾の未確定 leg は返さない)', () => {
    // 直近で底85を付けたが、まだ reclaim 戻していない → その底は返らない(=値が動かない)
    const bars = [bar(0, 120, 130), bar(1, 100, 110), bar(2, 128, 132), bar(3, 90, 95), bar(4, 85, 92)];
    const ps = extractSwingPivots(bars, 25);
    expect(ps.some(p => p.kind === 'low' && p.price === 85)).toBe(false);   // 末尾の未確定底は含めない
  });

  it('ガード: 2本未満 / reclaim<=0 は空', () => {
    expect(extractSwingPivots([bar(0, 1, 2)], 25)).toEqual([]);
    expect(extractSwingPivots([bar(0, 1, 2), bar(1, 1, 2)], 0)).toEqual([]);
  });
});
