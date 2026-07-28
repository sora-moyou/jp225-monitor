import { describe, it, expect } from 'vitest';
import { detectNWave, nwaveLevelCandidates } from './nwave.js';
import type { SwingPivot } from './swingPivots.js';

const P = (price: number, kind: 'low' | 'high', t = 0): SwingPivot => ({ price, kind, t });

describe('detectNWave — 上昇N波', () => {
  // A(安値)66,100 → B(高値)66,800 → C(押し安値)66,300、現値 66,900(> B)で確認。
  const up = [P(66100, 'low', 1), P(66800, 'high', 2), P(66300, 'low', 3)];

  it('確認済み(現値>B)で N/V/E を正しく算出', () => {
    const nw = detectNWave(up, 66900, 300);
    expect(nw).not.toBeNull();
    expect(nw!.direction).toBe('up');
    expect(nw!.a).toBe(66100);
    expect(nw!.b).toBe(66800);
    expect(nw!.c).toBe(66300);
    expect(nw!.bT).toBe(2);
    // N = C+(B−A)=66300+700=67000 / V = 2B−C=133600−66300=67300 / E = 2B−A=133600−66100=67500
    expect(nw!.targets).toEqual({ N: 67000, V: 67300, E: 67500 });
  });

  it('現値が B 以下(未確認)なら null', () => {
    expect(detectNWave(up, 66800, 300)).toBeNull();   // ちょうど B
    expect(detectNWave(up, 66500, 300)).toBeNull();   // B 未満
  });

  it('第1波幅 |B−A| が minSwingYen 未満なら null(浅い波は捨てる)', () => {
    expect(detectNWave(up, 66900, 800)).toBeNull();   // |B−A|=700 < 800
  });

  it('C が A と B の間に無い(higher-low でない)なら null', () => {
    const bad = [P(66100, 'low', 1), P(66800, 'high', 2), P(66050, 'low', 3)];   // C<A
    expect(detectNWave(bad, 66900, 300)).toBeNull();
  });

  it('ピボットの並びが [low,high,low] でないなら null', () => {
    const bad = [P(66100, 'high', 1), P(66800, 'high', 2), P(66300, 'low', 3)];
    expect(detectNWave(bad, 66900, 300)).toBeNull();
  });
});

describe('detectNWave — 下降N波', () => {
  // A(高値)67,500 → B(安値)66,800 → C(戻り高値)67,200、現値 66,700(< B)で確認。
  const down = [P(67500, 'high', 1), P(66800, 'low', 2), P(67200, 'high', 3)];

  it('確認済み(現値<B)で N/V/E を正しく算出', () => {
    const nw = detectNWave(down, 66700, 300);
    expect(nw).not.toBeNull();
    expect(nw!.direction).toBe('down');
    expect(nw!.a).toBe(67500);
    expect(nw!.b).toBe(66800);
    expect(nw!.c).toBe(67200);
    // N = C−(A−B)=67200−700=66500 / V = 2B−C=133600−67200=66400 / E = 2B−A=133600−67500=66100
    expect(nw!.targets).toEqual({ N: 66500, V: 66400, E: 66100 });
    // 目標は全て B(66,800)より下
    for (const t of Object.values(nw!.targets)) expect(t).toBeLessThan(66800);
  });

  it('現値が B 以上(未確認)なら null', () => {
    expect(detectNWave(down, 66800, 300)).toBeNull();
    expect(detectNWave(down, 67000, 300)).toBeNull();
  });

  it('C が B と A の間に無い(lower-high でない)なら null', () => {
    const bad = [P(67500, 'high', 1), P(66800, 'low', 2), P(67600, 'high', 3)];   // C>A
    expect(detectNWave(bad, 66700, 300)).toBeNull();
  });
});

describe('detectNWave — 退化ガード', () => {
  it('等価ピボット(A=C など)は strict 不等号で弾く', () => {
    const eq = [P(66100, 'low', 1), P(66800, 'high', 2), P(66100, 'low', 3)];   // C=A
    expect(detectNWave(eq, 66900, 300)).toBeNull();
  });
  it('ピボット3本未満/現値0/minSwing0 は null', () => {
    expect(detectNWave([P(1, 'low'), P(2, 'high')], 3, 300)).toBeNull();
    expect(detectNWave([P(66100, 'low'), P(66800, 'high'), P(66300, 'low')], 0, 300)).toBeNull();
    expect(detectNWave([P(66100, 'low'), P(66800, 'high'), P(66300, 'low')], 66900, 0)).toBeNull();
  });
});

describe('nwaveLevelCandidates — 未到達のみ・方向ラベル', () => {
  it('上昇: 現値より上の目標だけを N値(上昇)等で返す', () => {
    const nw = detectNWave([P(66100, 'low', 1), P(66800, 'high', 2), P(66300, 'low', 3)], 67100, 300)!;
    // 現値67,100 → N(67000) は到達済み=除外 / V(67300)/E(67500) は未到達=残す
    const c = nwaveLevelCandidates(nw, 67100);
    expect(c.map(x => x.price).sort((a, b) => a - b)).toEqual([67300, 67500]);
    expect(c.every(x => x.label.includes('(上昇)'))).toBe(true);
    expect(c.find(x => x.price === 67300)!.label).toBe('V値(上昇)');
  });

  it('下降: 現値より下の目標だけを (下降) ラベルで返す', () => {
    const nw = detectNWave([P(67500, 'high', 1), P(66800, 'low', 2), P(67200, 'high', 3)], 66450, 300)!;
    // 現値66,450 → N(66500) は上=除外 / V(66400)/E(66100) は下=残す
    const c = nwaveLevelCandidates(nw, 66450);
    expect(c.map(x => x.price).sort((a, b) => b - a)).toEqual([66400, 66100]);
    expect(c.every(x => x.label.includes('(下降)'))).toBe(true);
  });
});
