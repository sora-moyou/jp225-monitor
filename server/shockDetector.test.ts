import { describe, it, expect } from 'vitest';
import { detectShock, DEFAULT_SHOCK_PARAMS } from './shockDetector.js';

// 30本の微小ジグザグ(±1円)で平均変化を小さくし、最後に+45円ジャンプ → 上急変。
function quietThenJump(jump: number): number[] {
  const c: number[] = []; let p = 30000;
  for (let i = 0; i < 33; i++) { p += (i % 2 === 0 ? 1 : -1); c.push(p); }
  c.push(p + jump);
  return c;
}

describe('detectShock', () => {
  it('fires up on a sharp jump after a quiet stretch', () => {
    const sig = detectShock(quietThenJump(45), DEFAULT_SHOCK_PARAMS);
    expect(sig).not.toBeNull();
    expect(sig!.dir).toBe('up');
    expect(sig!.d1).toBeGreaterThanOrEqual(DEFAULT_SHOCK_PARAMS.shock1);
  });

  it('fires down on a sharp drop', () => {
    const sig = detectShock(quietThenJump(-45), DEFAULT_SHOCK_PARAMS);
    expect(sig).not.toBeNull();
    expect(sig!.dir).toBe('down');
  });

  it('does not fire on a flat series', () => {
    const flat = Array.from({ length: 40 }, () => 30000);
    expect(detectShock(flat, DEFAULT_SHOCK_PARAMS)).toBeNull();
  });

  it('does not fire when there are too few bars', () => {
    expect(detectShock([30000, 30050], DEFAULT_SHOCK_PARAMS)).toBeNull();
  });

  it('does not fire on a tie (no dominant direction)', () => {
    // 緩やかな単調上昇: スコアは出るが急変条件未満になるよう小さめの傾き
    const c = Array.from({ length: 40 }, (_, i) => 30000 + i * 2);
    const sig = detectShock(c, DEFAULT_SHOCK_PARAMS);
    // 2円/分の単調上昇は move1=25 等に届かず急変にならない
    expect(sig).toBeNull();
  });
});
