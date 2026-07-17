import { describe, it, expect } from 'vitest';
import { resolveVariant } from './variant.js';

// variant 解決の純関数テスト。MONITOR_VARIANT が未設定/その他なら full(安全側)、
// 'lite' のときだけ lite を返す。
describe('resolveVariant', () => {
  it('MONITOR_VARIANT 未設定なら full(既定=現行と同一)', () => {
    expect(resolveVariant({})).toBe('full');
  });

  it("MONITOR_VARIANT='lite' なら lite", () => {
    expect(resolveVariant({ MONITOR_VARIANT: 'lite' })).toBe('lite');
  });

  it('その他の値(full や空文字含む)は full にフォールバック', () => {
    expect(resolveVariant({ MONITOR_VARIANT: 'full' })).toBe('full');
    expect(resolveVariant({ MONITOR_VARIANT: '' })).toBe('full');
    expect(resolveVariant({ MONITOR_VARIANT: 'LITE' })).toBe('full');
  });
});
