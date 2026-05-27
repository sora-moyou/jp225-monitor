import { describe, it, expect } from 'vitest';
import { ChangeDetector } from './changeDetector.js';
import type { Price, InstrumentMeta } from '../types.js';

const NK_META: InstrumentMeta = {
  symbol: 'NK=F', labelJa: '日経225', labelEn: 'Nikkei',
  magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent',
};

function makePrice(symbol: any, price: number, tMs: number): Price {
  return { symbol, price, changePercent: 0, timestamp: tMs, stale: false };
}

describe('ChangeDetector', () => {
  it('returns empty array when buffer too small (single sample)', () => {
    const d = new ChangeDetector([NK_META]);
    expect(d.feed(makePrice('NK=F', 38000, 0))).toEqual([]);
  });

  it('fires slope alert when 30s move >= threshold', () => {
    const d = new ChangeDetector([NK_META]);
    d.feed(makePrice('NK=F', 38000, 0));
    const alerts = d.feed(makePrice('NK=F', 38000 * (1 - 0.0011), 25_000));
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.detectionKind).toBe('slope');
    expect(alerts[0]?.direction).toBe('down');
  });

  it('fires magnitude alert when 5min move >= threshold but slope didnt', () => {
    const d = new ChangeDetector([NK_META]);
    // 段階的に動かして傾き閾値に達さず、5分窓だけ超える
    d.feed(makePrice('NK=F', 38000, 0));
    d.feed(makePrice('NK=F', 38000 * 1.001, 60_000));    // +0.1% / 1min  → 30sでは超えない
    d.feed(makePrice('NK=F', 38000 * 1.002, 120_000));   // 累積+0.2%
    const alerts = d.feed(makePrice('NK=F', 38000 * 1.0031, 240_000));
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.detectionKind).toBe('magnitude');
  });

  it('does not fire when both within threshold', () => {
    const d = new ChangeDetector([NK_META]);
    d.feed(makePrice('NK=F', 38000, 0));
    expect(d.feed(makePrice('NK=F', 38010, 10_000))).toEqual([]); // +0.026%
  });

  it('does not double-fire within cooldown', () => {
    const d = new ChangeDetector([NK_META], { cooldownMs: 60_000 });
    d.feed(makePrice('NK=F', 38000, 0));
    d.feed(makePrice('NK=F', 38000 * 0.9985, 20_000)); // -0.15% / 20s → slope発火
    const second = d.feed(makePrice('NK=F', 38000 * 0.998, 30_000));
    expect(second).toEqual([]);
  });

  it('drops samples older than the 5-minute window', () => {
    const d = new ChangeDetector([NK_META]);
    d.feed(makePrice('NK=F', 38000, 0));
    // 6分後に来た同じ値は、古いサンプルが破棄され閾値判定の基準にならない
    const alerts = d.feed(makePrice('NK=F', 38000 * 0.997, 6 * 60 * 1000));
    expect(alerts).toEqual([]);
  });
});
