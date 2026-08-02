import { describe, it, expect } from 'vitest';

// 実行時設定。接続先 URL は設定可能・既定は localhost。
// ★否定対照: epochGeneratorConfig が monitorUrl を落とさないと「接続先を変えても epoch は不変」が赤。

import { resolveGeneratorConfig, epochGeneratorConfig, GENERATOR_DEFAULTS } from './config.js';

describe('resolveGeneratorConfig', () => {
  it('既定は localhost の monitor ポート + 設計どおりの既定値', () => {
    const c = resolveGeneratorConfig({}, 3100);
    expect(c.monitorUrl).toBe('http://127.0.0.1:3100');
    expect(c.intervalMs).toBe(GENERATOR_DEFAULTS.intervalMs);
    expect(c.controlEvery).toBe(GENERATOR_DEFAULTS.controlEvery);
    expect(c.retryMinMs).toBe(15_000);
    expect(c.retryMaxMs).toBe(20_000);
  });

  it('接続先を env で変えられる(末尾スラッシュは落とす)', () => {
    expect(resolveGeneratorConfig({ GENERATOR_MONITOR_URL: 'http://other:9/' }, 3000).monitorUrl).toBe('http://other:9');
  });

  it('不正値は既定へ倒す(負値/小数/文字列)', () => {
    const c = resolveGeneratorConfig({ GENERATOR_INTERVAL_MS: '-5', GENERATOR_REQUEST_TIMEOUT_MS: 'abc' }, 3000);
    expect(c.intervalMs).toBe(GENERATOR_DEFAULTS.intervalMs);
    expect(c.requestTimeoutMs).toBe(GENERATOR_DEFAULTS.requestTimeoutMs);
  });

  it('対照の頻度は 0(=対照なし)を受理する', () => {
    expect(resolveGeneratorConfig({ GENERATOR_CONTROL_EVERY: '0' }, 3000).controlEvery).toBe(0);
  });

  it('再試行の上下限が逆転していても下限を下回らせない', () => {
    const c = resolveGeneratorConfig({ GENERATOR_RETRY_MIN_MS: '20000', GENERATOR_RETRY_MAX_MS: '5000' }, 3000);
    expect(c.retryMaxMs).toBe(20_000);
  });

  it('★epoch の入力に接続先は含めない(ポートを変えただけで期が割れない)', () => {
    const a = epochGeneratorConfig(resolveGeneratorConfig({ GENERATOR_MONITOR_URL: 'http://a:1' }, 3000));
    const b = epochGeneratorConfig(resolveGeneratorConfig({ GENERATOR_MONITOR_URL: 'http://b:2' }, 3000));
    expect(a).toEqual(b);
    expect(Object.prototype.hasOwnProperty.call(a, 'monitorUrl')).toBe(false);
  });
});
