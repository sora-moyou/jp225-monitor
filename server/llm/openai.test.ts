import { describe, it, expect } from 'vitest';
import { formatCrossAsset } from './openai.js';
import type { Mover } from '../marketSnapshot.js';

describe('formatCrossAsset', () => {
  it('returns a "no linkage" line when there are no movers', () => {
    expect(formatCrossAsset([])).toBe('【他資産】同時刻に目立った連動なし。');
  });

  it('formats movers with arrow, signed percent, window and z', () => {
    const movers: Mover[] = [
      { symbol: 'NQ=F', label: 'ナスダック100先物', changePercent: -1.85, windowSeconds: 300, z: 4.3, direction: 'down' },
      { symbol: 'JPY=X', label: 'ドル円', changePercent: 0.42, windowSeconds: 60, z: 4.1, direction: 'up' },
    ];
    const out = formatCrossAsset(movers);
    expect(out).toContain('【同時刻に大きく動いた他資産(z>=4.0)】');
    expect(out).toContain('- ナスダック100先物 ▼ -1.85% (5分, z=4.3)');
    expect(out).toContain('- ドル円 ▲ +0.42% (1分, z=4.1)');
  });
});
