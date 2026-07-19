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
  // ★v0.8.2: lite で隠す全要素(履歴/ログ/params/AIエントリー + B関連 + Web検索モデル/データ fieldset)。
  function allEls() {
    return {
      alertsHistoryBtn: mockEl(),
      openLogsBtn: mockEl(),
      paramsBtn: mockEl(),
      scalpFieldset: mockEl(),
      signalPanelB: mockEl(),
      signalTradesSystem: mockEl(),
      webSearchModelFieldset: mockEl(),
      dataFieldset: mockEl(),
    };
  }

  it('lite は 8 要素(履歴/ログ/params/AIエントリー/Bパネル/B系統セレクタ/Web検索モデル/データ)を隠す', () => {
    const els = allEls();
    applyVariantVisibility('lite', els);
    for (const el of Object.values(els)) {
      expect(el.hidden).toBe(true);
      expect(el.style.display).toBe('none');
    }
  });

  it('lite は System B 関連(Bパネル/B系統セレクタ)を確実に隠す', () => {
    const els = allEls();
    applyVariantVisibility('lite', els);
    expect(els.signalPanelB.hidden).toBe(true);
    expect(els.signalTradesSystem.hidden).toBe(true);
  });

  it('full は何も隠さない(全要素そのまま=B も表示)', () => {
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
