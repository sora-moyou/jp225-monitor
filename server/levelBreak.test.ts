import { describe, it, expect } from 'vitest';
import { detectLevelBreak, type BrkBar } from './levelBreak.js';

const L = [{ price: 70000, label: '70000節目' }];
const bars = (h: number, l: number, n = 5): BrkBar[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * 60_000, h, l }));

describe('detectLevelBreak', () => {
  it('上抜け: 窓内でL以下に触れ、現値がL+breakTolを超えたら up', () => {
    const r = detectLevelBreak(L, bars(70005, 69990), 70010);   // minLow 69990<=L, current 70010>70002
    expect(r).toEqual([{ kind: 'up', level: 70000, label: '70000節目' }]);
  });

  it('下抜け: 窓内でL以上に届き、現値がL-breakTolを下回ったら down', () => {
    const r = detectLevelBreak(L, bars(70010, 69995), 69985);   // maxHigh 70010>=L, current 69985<69998
    expect(r).toEqual([{ kind: 'down', level: 70000, label: '70000節目' }]);
  });

  it('breakTol 以内の僅差では発火しない', () => {
    expect(detectLevelBreak(L, bars(70005, 69990), 70001)).toEqual([]);   // 70001 は L+2 を超えない
    expect(detectLevelBreak(L, bars(70010, 69995), 69999)).toEqual([]);
  });

  it('窓内でレベルを跨いでいない(ずっと上)なら発火しない', () => {
    // 全足が L より上 → minLow > L。現値が更に上でも「新規の抜け」ではない。
    expect(detectLevelBreak(L, bars(70030, 70020), 70010)).toEqual([]);
  });

  it('クロスが直近crossBars(3本)より前なら発火しない(=今は達していないレベルを拾わない)', () => {
    // 古い足では L 以下に触れたが、直近3本はすべて L より十分上 → 新規クロスではない。
    const mixed: BrkBar[] = [
      { t: 0, h: 70005, l: 69990 },   // 過去に L=70000 へ到達(古い)
      { t: 1, h: 70005, l: 69990 },
      { t: 2, h: 70005, l: 69990 },
      { t: 3, h: 70120, l: 70080 },   // 直近3本は L から離れて上
      { t: 4, h: 70120, l: 70080 },
      { t: 5, h: 70120, l: 70080 },
    ];
    expect(detectLevelBreak(L, mixed, 70100)).toEqual([]);   // 直近3本の安値70080 > L → 跨いでいない
  });

  it('山/谷の形成なしの素通り(継続)では発火しない', () => {
    // 上から L=70000 へ一直線に下落し割る。Lに到達後の戻り(山)が無い → 無意味な継続なので出さない。
    const straightDown: BrkBar[] = [
      { t: 0, h: 70080, l: 70060 },
      { t: 1, h: 70060, l: 70040 },
      { t: 2, h: 70040, l: 70020 },
      { t: 3, h: 70020, l: 70000 },   // L へ到達(タッチ)
      { t: 4, h: 70005, l: 69990 },   // そのまま割る(戻りの山なし)
      { t: 5, h: 69995, l: 69980 },
    ];
    expect(detectLevelBreak(L, straightDown, 69985)).toEqual([]);
  });

  it('安値タッチ→山形成→再下落で割ると down(構造ありのみ発火)', () => {
    const formedThenBreak: BrkBar[] = [
      { t: 0, h: 70020, l: 70000 },   // L へ到達(谷1)
      { t: 1, h: 70015, l: 69995 },
      { t: 2, h: 70030, l: 70010 },   // 戻って山形成(高値 70030 ≥ L+10)
      { t: 3, h: 70025, l: 70005 },
      { t: 4, h: 70010, l: 69998 },   // L へ戻る
      { t: 5, h: 70002, l: 69980 },   // 再下落して割る
    ];
    expect(detectLevelBreak(L, formedThenBreak, 69985))
      .toEqual([{ kind: 'down', level: 70000, label: '70000節目' }]);
  });

  it('現値0・バー不足はガード', () => {
    expect(detectLevelBreak(L, bars(70005, 69990), 0)).toEqual([]);
    expect(detectLevelBreak(L, bars(70005, 69990, 2), 70010)).toEqual([]);
  });
});
