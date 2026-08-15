import { describe, it, expect } from 'vitest';
import {
  bandwidthOf, bandwidthExtremes, squeezeStateOf, computeSqueezeSeries, buildSqueezeSnapshot,
} from './indicators.js';
import { SQUEEZE_BB_PERIOD, SQUEEZE_BW_LOOKBACK } from '../core/indicatorSpec.js';

// ─── ★スクイーズ用バンド(20本/2σ)の純関数 ───────────────────────────────────
//
// 定義(仕様 docs/superpowers/specs/2026-08-15-bb-squeeze-bulge-design.md):
//   Bandwidth = (上−下)/中央 ×100
//   BWhigh/low = **現在足を含む**直近125本の最大/最小
//   スクイーズ = BW <= BWlow / バルジ = BW >= BWhigh(= 125本の新記録に達した足)
//
// ★ここで守る核心は「本数が足りない間は判定しない」こと。
//   足りない窓の最大最小は「その時点まで」でしかなく、序盤は数本で最大/最小が決まるので
//   **開始直後に必ずスクイーズかバルジになる**(無意味な発火が毎朝出る)。

describe('bandwidthOf', () => {
  it('(上−下)/中央 ×100', () => {
    expect(bandwidthOf(102, 100, 98)).toBeCloseTo(4, 10);
    expect(bandwidthOf(110, 100, 90)).toBeCloseTo(20, 10);
  });
  it('未算出・中央0以下は null', () => {
    expect(bandwidthOf(null, 100, 98)).toBeNull();
    expect(bandwidthOf(102, null, 98)).toBeNull();
    expect(bandwidthOf(102, 100, null)).toBeNull();
    expect(bandwidthOf(102, 0, 98)).toBeNull();
    expect(bandwidthOf(102, -1, 98)).toBeNull();
  });
  it('幅0(全同値)は 0(null にしない=「収縮しきっている」は観測値)', () => {
    expect(bandwidthOf(100, 100, 100)).toBe(0);
  });
});

describe('bandwidthExtremes', () => {
  it('★現在足を含む直近 lookback 本の最大・最小', () => {
    const r = bandwidthExtremes([5, 1, 3, 9, 2], 3);   // 直近3本 = [3,9,2]
    expect(r.high).toBe(9);
    expect(r.low).toBe(2);
    expect(r.ready).toBe(true);
  });
  it('本数が足りない間は「その時点まで」の最大最小 + ready:false', () => {
    const r = bandwidthExtremes([4, 6], SQUEEZE_BW_LOOKBACK);
    expect(r.high).toBe(6);
    expect(r.low).toBe(4);
    expect(r.ready).toBe(false);
  });
  it('null は無視する(算出できない足で極値が壊れない)', () => {
    const r = bandwidthExtremes([null, 7, null, 3], 4);
    expect(r.high).toBe(7);
    expect(r.low).toBe(3);
  });
  it('全部 null なら null(0 にしない)', () => {
    expect(bandwidthExtremes([null, null], 2)).toEqual({ high: null, low: null, ready: false });
  });
  it('空配列でも壊れない', () => {
    expect(bandwidthExtremes([], 125)).toEqual({ high: null, low: null, ready: false });
  });
});

describe('squeezeStateOf', () => {
  it('BW <= low はスクイーズ / BW >= high はバルジ', () => {
    expect(squeezeStateOf(1.0, 3.0, 1.0)).toBe('squeeze');
    expect(squeezeStateOf(0.9, 3.0, 1.0)).toBe('squeeze');
    expect(squeezeStateOf(3.0, 3.0, 1.0)).toBe('bulge');
    expect(squeezeStateOf(3.1, 3.0, 1.0)).toBe('bulge');
    expect(squeezeStateOf(2.0, 3.0, 1.0)).toBeNull();
  });
  it('未算出は null', () => {
    expect(squeezeStateOf(null, 3, 1)).toBeNull();
    expect(squeezeStateOf(2, null, 1)).toBeNull();
    expect(squeezeStateOf(2, 3, null)).toBeNull();
  });
});

describe('computeSqueezeSeries', () => {
  it('本数不足の先頭は null、20本目から値が出る', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + (i % 3));
    const r = computeSqueezeSeries(closes);
    expect(r.bw).toHaveLength(25);
    expect(r.bw[SQUEEZE_BB_PERIOD - 2]).toBeNull();
    expect(r.bw[SQUEEZE_BB_PERIOD - 1]).not.toBeNull();
    expect(r.pctB[SQUEEZE_BB_PERIOD - 1]).not.toBeNull();
  });
  it('全同値なら幅0 → bw=0 / pctB=null(0除算を作らない)', () => {
    const r = computeSqueezeSeries(Array.from({ length: 21 }, () => 100));
    expect(r.bw[20]).toBe(0);
    expect(r.pctB[20]).toBeNull();
  });
});

describe('buildSqueezeSnapshot', () => {
  /** 前半は静か・後半は荒い系列(BW が広がる)。 */
  const closes = Array.from({ length: 140 }, (_, i) => 100 + Math.sin(i / 2) * (i < 70 ? 0.5 : 6));

  it('★確定足の系列から現在値・前値・極値を出す', () => {
    const s = buildSqueezeSnapshot(closes);
    expect(s.bw).not.toBeNull();
    expect(s.prevBw).not.toBeNull();
    expect(s.pctB).not.toBeNull();
    expect(s.bwHigh! >= s.bw!).toBe(true);
    expect(s.bwLow! <= s.bw!).toBe(true);
    expect(s.ready).toBe(true);
  });

  it('★本数が足りない間は ready:false かつ state は必ず null(毎朝の誤発火を作らない)', () => {
    const s = buildSqueezeSnapshot([100, 101, 102]);
    expect(s.ready).toBe(false);
    expect(s.state).toBeNull();
    const s2 = buildSqueezeSnapshot(Array.from({ length: 30 }, (_, i) => 100 + i % 2));
    expect(s2.ready).toBe(false);       // 125本に満たない
    expect(s2.state).toBeNull();
  });

  it('★125本揃っていれば、最大に達した足でバルジになる', () => {
    // 最後の足で幅が最大になるよう、末尾だけ大きく振らせる。
    const c = Array.from({ length: 130 }, (_, i) => 100 + (i % 2 ? 0.2 : -0.2));
    c[129] = 200;
    const s = buildSqueezeSnapshot(c);
    expect(s.ready).toBe(true);
    expect(s.state).toBe('bulge');
  });

  it('t を渡すと最後の確定足の時刻が入る', () => {
    const times = closes.map((_, i) => 1_700_000_000_000 + i * 300_000);
    const s = buildSqueezeSnapshot(closes, times);
    expect(s.t).toBe(times[times.length - 1]);
  });
});
