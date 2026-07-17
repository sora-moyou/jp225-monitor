import { describe, it, expect } from 'vitest';
import { applyVariantVisibility, normalizeVariant, type ToggleableEl } from './variant.js';

// jsdom を導入していないため、hidden/style だけを持つモック要素で純関数を検証する。
function mockEl(): ToggleableEl {
  return { hidden: false, style: { display: '' } };
}

describe('normalizeVariant', () => {
  it("'lite' のみ lite、それ以外(欠落/full/不明)は full", () => {
    expect(normalizeVariant('lite')).toBe('lite');
    expect(normalizeVariant('full')).toBe('full');
    expect(normalizeVariant(undefined)).toBe('full');
    expect(normalizeVariant(null)).toBe('full');
    expect(normalizeVariant('LITE')).toBe('full');
  });
});

describe('applyVariantVisibility', () => {
  it('lite は 4 要素(履歴/ログ/params/AIエントリー)を隠す', () => {
    const els = {
      alertsHistoryBtn: mockEl(),
      openLogsBtn: mockEl(),
      paramsBtn: mockEl(),
      scalpFieldset: mockEl(),
    };
    applyVariantVisibility('lite', els);
    for (const el of Object.values(els)) {
      expect(el.hidden).toBe(true);
      expect(el.style.display).toBe('none');
    }
  });

  it('full は何も隠さない(全要素そのまま)', () => {
    const els = {
      alertsHistoryBtn: mockEl(),
      openLogsBtn: mockEl(),
      paramsBtn: mockEl(),
      scalpFieldset: mockEl(),
    };
    applyVariantVisibility('full', els);
    for (const el of Object.values(els)) {
      expect(el.hidden).toBe(false);
      expect(el.style.display).toBe('');
    }
  });

  it('null 要素はスキップして落ちない', () => {
    expect(() =>
      applyVariantVisibility('lite', { alertsHistoryBtn: null, paramsBtn: undefined }),
    ).not.toThrow();
  });
});
