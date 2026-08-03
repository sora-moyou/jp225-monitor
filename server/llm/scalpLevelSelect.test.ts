import { describe, it, expect } from 'vitest';
import { selectPromptLevels, DEFAULT_PROMPT_LEVEL_SELECT } from './scalpLevelSelect.js';
import type { Level, LevelsResult } from '../levels.js';

function lv(price: number, tier: 0 | 1 | 2, score: number, label = '水準'): Level {
  return { price, dist: 0, labels: [label], strong: tier >= 1, score, tier, confluence: tier >= 2 };
}
function res(current: number, ...specs: [number, 0 | 1 | 2, number][]): Level[] {
  return specs.map(([off, t, s]) => lv(current + off, t, s));
}
function sup(current: number, ...specs: [number, 0 | 1 | 2, number][]): Level[] {
  return specs.map(([off, t, s]) => lv(current - off, t, s));
}
function mk(up: Level[], down: Level[]): LevelsResult {
  return { current: 0, up, down, swing: null, reversalSatisfied: false, asOf: 0 };
}
const prices = (r: ReturnType<typeof selectPromptLevels>): number[] => r.map(x => x.level.price);

const C = 38000;

describe('selectPromptLevels', () => {
  it('空/null/両側空では空配列(退化ケースで落ちない)', () => {
    expect(selectPromptLevels(null, C)).toEqual([]);
    expect(selectPromptLevels(undefined, C)).toEqual([]);
    expect(selectPromptLevels(mk([], []), C)).toEqual([]);
  });

  it('節目が1本だけでもその1本を返す', () => {
    const r = selectPromptLevels(mk(res(C, [50, 0, 1]), []), C);
    expect(prices(r)).toEqual([C + 50]);
  });

  it('片側しか無い場合でも従来と同じ 8本 まで距離順で出す', () => {
    const only = res(C, ...Array.from({ length: 12 }, (_, i) => [50 * (i + 1), 0, 1] as [number, 0, number]));
    const r = selectPromptLevels(mk(only, []), C);
    expect(r).toHaveLength(DEFAULT_PROMPT_LEVEL_SELECT.baseTotal);
    expect(prices(r)).toEqual([50, 100, 150, 200, 250, 300, 350, 400].map(d => C + d));
  });

  it('上下それぞれ最低4本を保証する(片側に密集していても反対側が潰れない)', () => {
    // レジ側が現在値のすぐ上に7本密集。従来の「距離順8本」なら サポは1本しか入らない。
    const up = res(C, [10, 0, 1], [20, 0, 1], [30, 0, 1], [40, 0, 1], [50, 0, 1], [60, 0, 1], [70, 0, 1]);
    const down = sup(C, [100, 0, 1], [200, 0, 1], [300, 0, 1], [400, 0, 1], [500, 0, 1]);
    const r = selectPromptLevels(mk(up, down), C);
    expect(r.filter(x => x.kind === 'レジ')).toHaveLength(4);
    expect(r.filter(x => x.kind === 'サポ')).toHaveLength(4);
    expect(prices(r)).toEqual([C + 10, C + 20, C + 30, C + 40, C - 100, C - 200, C - 300, C - 400]);
  });

  it('★★は距離の枠外でも入る(引きつけ先の強い節目を必ず見せる)', () => {
    // 近い4本はいずれも弱い。強い★★は5番目(=従来の距離順なら落ちうる位置より外)。
    const up = res(C, [10, 0, 0.3], [20, 0, 0.3], [30, 0, 0.3], [40, 0, 0.3], [800, 2, 9.9]);
    const down = sup(C, [10, 0, 0.3], [20, 0, 0.3], [30, 0, 0.3], [40, 0, 0.3]);
    const r = selectPromptLevels(mk(up, down), C);
    expect(prices(r)).toContain(C + 800);
    expect(r.find(x => x.level.price === C + 800)!.level.tier).toBe(2);
  });

  it('★★の別枠は片側 strongPerSide 本まで(遠方の★★でリストを埋めない)', () => {
    const up = res(C,
      [10, 0, 0.3], [20, 0, 0.3], [30, 0, 0.3], [40, 0, 0.3],
      [900, 2, 9], [1200, 2, 9], [1500, 2, 9], [1800, 2, 9]);
    const down = sup(C, [10, 0, 0.3], [20, 0, 0.3], [30, 0, 0.3], [40, 0, 0.3]);
    const r = selectPromptLevels(mk(up, down), C);
    const far = prices(r).filter(p => p > C + 100);
    expect(far).toEqual([C + 900, C + 1200]);   // 近い順に2本だけ
  });

  it('総数は maxTotal(既定12)を超えない', () => {
    const strong = (n: number, sign: 1 | -1): Level[] =>
      Array.from({ length: n }, (_, i) => lv(C + sign * (500 + 100 * i), 2, 9));
    const up = [...res(C, [10, 0, 1], [20, 0, 1], [30, 0, 1], [40, 0, 1], [50, 0, 1], [60, 0, 1]), ...strong(6, 1)];
    const down = [...sup(C, [10, 0, 1], [20, 0, 1], [30, 0, 1], [40, 0, 1], [50, 0, 1], [60, 0, 1]), ...strong(6, -1)];
    const r = selectPromptLevels(mk(up, down), C);
    expect(r.length).toBeLessThanOrEqual(DEFAULT_PROMPT_LEVEL_SELECT.maxTotal);
    expect(r).toHaveLength(12);
  });

  it('4本/4本の一般ケースでは従来(距離順8本)と同じ集合になる', () => {
    const up = res(C, [50, 1, 2], [150, 0, 1], [260, 0, 1], [420, 0, 1], [900, 0, 1]);
    const down = sup(C, [60, 1, 2], [170, 0, 1], [280, 0, 1], [430, 0, 1], [950, 0, 1]);
    const r = selectPromptLevels(mk(up, down), C);
    const old = [...up, ...down]
      .map(l => ({ l, ad: Math.abs(l.price - C) }))
      .sort((a, b) => a.ad - b.ad).slice(0, 8).map(x => x.l.price);
    expect(new Set(prices(r))).toEqual(new Set(old));
  });

  it('返り値は現在値からの距離が近い順(AI が近さを読める並び)', () => {
    const up = res(C, [120, 0, 1], [30, 0, 1], [700, 2, 9]);
    const down = sup(C, [80, 0, 1], [15, 0, 1]);
    const r = selectPromptLevels(mk(up, down), C);
    const ads = r.map(x => Math.abs(x.dist));
    expect([...ads].sort((a, b) => a - b)).toEqual(ads);
  });

  it('kind は元の up/down 配列の所属で決まる(価格の符号では判定しない)', () => {
    // 現値が節目の上に抜けた直後など、up 配列に現値より下の価格が残ることがある。
    const r = selectPromptLevels(mk([lv(C - 10, 0, 1)], [lv(C - 100, 0, 1)]), C);
    expect(r.find(x => x.level.price === C - 10)!.kind).toBe('レジ');
    expect(r.find(x => x.level.price === C - 10)!.dist).toBe(-10);
  });

  it('価格が壊れている(NaN/Infinity)節目は捨てる', () => {
    const bad = { ...lv(0, 0, 1), price: NaN } as Level;
    const r = selectPromptLevels(mk([bad, lv(C + 50, 0, 1)], []), C);
    expect(prices(r)).toEqual([C + 50]);
  });
});
