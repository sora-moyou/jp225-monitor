import { describe, it, expect } from 'vitest';
import { shouldAutoImport } from './basedata.js';

describe('shouldAutoImport', () => {
  it('公開版が無い(null)なら常に false', () => {
    expect(shouldAutoImport(null, null)).toBe(false);
    expect(shouldAutoImport('2026-07-01T00:00:00.000Z', null)).toBe(false);
  });

  it('取り込み済みが無く(未取り込み)公開版があれば true', () => {
    expect(shouldAutoImport(null, '2026-07-01T00:00:00.000Z')).toBe(true);
  });

  it('公開版と取り込み済み版が一致(最新)なら false', () => {
    expect(shouldAutoImport('2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')).toBe(false);
  });

  it('公開版が取り込み済みと異なる(新着)なら true', () => {
    expect(shouldAutoImport('2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')).toBe(true);
  });
});
