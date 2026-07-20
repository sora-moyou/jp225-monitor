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
  // lite で隠す全要素(履歴/ログ/params/AIエントリー + B系統セレクタ + Web検索モデル/データ fieldset)。
  function allEls() {
    return {
      alertsHistoryBtn: mockEl(),
      openLogsBtn: mockEl(),
      paramsBtn: mockEl(),
      scalpFieldset: mockEl(),
      signalTradesSystem: mockEl(),
      webSearchModelFieldset: mockEl(),
      dataFieldset: mockEl(),
    };
  }

  it('lite は 7 要素(履歴/ログ/params/AIエントリー/B系統セレクタ/Web検索モデル/データ)を隠す', () => {
    const els = allEls();
    applyVariantVisibility('lite', els);
    for (const el of Object.values(els)) {
      expect(el.hidden).toBe(true);
      expect(el.style.display).toBe('none');
    }
  });

  it('lite は履歴の A/B 系統セレクタを確実に隠す', () => {
    const els = allEls();
    applyVariantVisibility('lite', els);
    expect(els.signalTradesSystem.hidden).toBe(true);
  });

  it('full は何も隠さない(全要素そのまま)', () => {
    const els = allEls();
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
