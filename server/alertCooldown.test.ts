import { describe, it, expect, beforeEach } from 'vitest';
import { canFire, markFired, COOLDOWN_MS, _reset } from './alertCooldown.js';

describe('alertCooldown (共有・同方向30分・逆方向は起点越えで解禁)', () => {
  beforeEach(() => _reset());
  const T0 = 1_000_000;

  it('COOLDOWN_MS は 30 分', () => {
    expect(COOLDOWN_MS).toBe(30 * 60 * 1000);
  });

  it('記録なしなら発火可', () => {
    expect(canFire('NIY=F', 'up', 67000, T0)).toBe(true);
  });

  it('同方向はクールダウン中ブロック、明けたら可', () => {
    markFired('NIY=F', 'up', 67000, T0);
    expect(canFire('NIY=F', 'up', 67100, T0 + 60_000)).toBe(false);      // 1分後・同方向
    expect(canFire('NIY=F', 'up', 67100, T0 + COOLDOWN_MS)).toBe(true);  // 30分後
  });

  it('逆方向(down): up発火の起点を割れば解禁、超えていればブロック', () => {
    markFired('NIY=F', 'up', 67000, T0);
    expect(canFire('NIY=F', 'down', 67010, T0 + 60_000)).toBe(false);   // 起点超 → 不可
    expect(canFire('NIY=F', 'down', 66990, T0 + 60_000)).toBe(true);    // 起点割れ → 可
  });

  it('逆方向(up): down発火の起点を超えれば解禁', () => {
    markFired('NIY=F', 'down', 67000, T0);
    expect(canFire('NIY=F', 'up', 66990, T0 + 60_000)).toBe(false);
    expect(canFire('NIY=F', 'up', 67010, T0 + 60_000)).toBe(true);
  });

  it('共有: どの種別が鳴っても銘柄単位で1記録 (別銘柄は独立)', () => {
    markFired('NIY=F', 'up', 67000, T0);
    expect(canFire('NQ=F', 'up', 30000, T0 + 60_000)).toBe(true);
  });
});
