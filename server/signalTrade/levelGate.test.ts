import { describe, it, expect } from 'vitest';
import { shouldRearmOnLevel, rearmBounds, type RearmLevels } from './levelGate.js';

// アンカー=38000。上側節目 38120 / 38300、下側節目 37900 / 37700。
const levels: RearmLevels = {
  up: [{ price: 38120 }, { price: 38300 }],
  down: [{ price: 37900 }, { price: 37700 }],
};

describe('rearmBounds', () => {
  it('アンカー直近の上側(最小)/下側(最大)節目を境界にする', () => {
    const b = rearmBounds(38000, levels);
    expect(b.upper).toBe(38120);
    expect(b.lower).toBe(37900);
    expect(b.usedFallback).toBe(false);
    expect(b.upperTrigger).toBe(38120);
    expect(b.lowerTrigger).toBe(37900);
  });

  it('up/down はアンカー相対で振り分ける(アンカー≠現値でも正しい)', () => {
    // levels の up/down 区分に依らず、アンカー基準で上下を計算する。
    const mixed: RearmLevels = { up: [{ price: 37950 }], down: [{ price: 38100 }] };
    const b = rearmBounds(38000, mixed);
    expect(b.upper).toBe(38100);   // アンカーより上
    expect(b.lower).toBe(37950);   // アンカーより下
  });

  it('片側しか節目が無ければ両側 ±fallback にフォールバック', () => {
    const onlyUp: RearmLevels = { up: [{ price: 38200 }], down: [] };
    const b = rearmBounds(38000, onlyUp, 50);
    expect(b.usedFallback).toBe(true);
    expect(b.upperTrigger).toBe(38050);
    expect(b.lowerTrigger).toBe(37950);
  });

  it('節目が全く無ければ ±fallback', () => {
    const b = rearmBounds(38000, { up: [], down: [] }, 40);
    expect(b.usedFallback).toBe(true);
    expect(b.upperTrigger).toBe(38040);
    expect(b.lowerTrigger).toBe(37960);
  });
});

describe('shouldRearmOnLevel', () => {
  it('上側節目未満・下側節目超なら抑止継続(false)', () => {
    expect(shouldRearmOnLevel(38000, 38050, levels)).toBe(false);
    expect(shouldRearmOnLevel(38000, 37950, levels)).toBe(false);
  });

  it('上側節目以上で再武装(true)', () => {
    expect(shouldRearmOnLevel(38000, 38120, levels)).toBe(true);
    expect(shouldRearmOnLevel(38000, 38500, levels)).toBe(true);
  });

  it('下側節目以下で再武装(true)', () => {
    expect(shouldRearmOnLevel(38000, 37900, levels)).toBe(true);
    expect(shouldRearmOnLevel(38000, 37600, levels)).toBe(true);
  });

  it('節目が無い/null なら ±50 フォールバックで判定', () => {
    expect(shouldRearmOnLevel(38000, 38049, null)).toBe(false);
    expect(shouldRearmOnLevel(38000, 38050, null)).toBe(true);
    expect(shouldRearmOnLevel(38000, 37950, undefined)).toBe(true);
  });

  it('片側のみの節目でも ±50 フォールバックで詰まらない', () => {
    const onlyDown: RearmLevels = { up: [], down: [{ price: 37000 }] };
    expect(shouldRearmOnLevel(38000, 38050, onlyDown)).toBe(true);   // +50 で再武装(節目 37000 まで待たない)
  });

  it('anchor/price が非有限なら詰まり防止で true', () => {
    expect(shouldRearmOnLevel(NaN, 38000, levels)).toBe(true);
    expect(shouldRearmOnLevel(38000, NaN, levels)).toBe(true);
  });
});
