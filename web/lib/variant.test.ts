import { describe, it, expect } from 'vitest';
import { applyVariantVisibility, normalizeVariant, type ToggleableEl } from './variant.js';

// jsdom を導入していないため、hidden/style だけを持つモック要素で純関数を検証する。
function mockEl(): ToggleableEl {
  return { hidden: false, style: { display: '' } };
}
// index.html で最初から hidden の要素(lite 専用の説明・注記)を模す。
function hiddenEl(): ToggleableEl {
  return { hidden: true, style: { display: '' } };
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
  // lite で隠す単体要素(履歴/ログ/B系統セレクタ/Web検索モデル/データ/基礎データ公開/詳細設定の右カラム)。
  // ★詳細設定ボタン(🎛️)と AIエントリー fieldset は lite でも表示する(4項目だけに絞って見せる)ので
  //   ここには含めない=applyVariantVisibility は触らない。
  function allEls() {
    return {
      alertsHistoryBtn: mockEl(),
      openLogsBtn: mockEl(),
      signalTradesSystem: mockEl(),
      webSearchModelFieldset: mockEl(),
      dataFieldset: mockEl(),
      basedataPublishFieldset: mockEl(),
      paramsOtherCol: mockEl(),
    };
  }

  it('lite は 7 要素(履歴/ログ/B系統セレクタ/Web検索モデル/データ/基礎データ公開/詳細設定の右カラム)を隠す', () => {
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
      applyVariantVisibility('lite', { alertsHistoryBtn: null, paramsOtherCol: undefined }),
    ).not.toThrow();
  });

  // ─── ★lite: AIエントリーを4項目(A系統のみ)に絞る ─────────────────────────
  function scalpEls() {
    return {
      scalpHideRows: [mockEl(), mockEl()],    // 4項目以外の行(トレンドveto/クールダウン等)
      scalpHideInRows: [mockEl(), mockEl()],  // 残す行の B列 / A タグ(★委任モード select は隠さない)
      scalpFullHints: [mockEl(), mockEl()],   // full 向けの A/B・AI委任 の説明
      scalpLiteHints: [hiddenEl(), hiddenEl()], // lite 専用の簡潔な説明(既定 hidden)
    };
  }

  it('lite は 4項目以外の行 / B列・Aタグ / full向け説明 を隠し、lite用説明だけ出す', () => {
    const els = scalpEls();
    applyVariantVisibility('lite', els);
    for (const el of [...els.scalpHideRows, ...els.scalpHideInRows, ...els.scalpFullHints]) {
      expect(el.hidden).toBe(true);
      expect(el.style.display).toBe('none');
    }
    for (const el of els.scalpLiteHints) {
      expect(el.hidden).toBe(false);
      expect(el.style.display).toBe('');
    }
  });

  it('full は AIエントリー関連も一切触らない(lite用説明は hidden のまま=表示が現状と同一)', () => {
    const els = scalpEls();
    applyVariantVisibility('full', els);
    for (const el of [...els.scalpHideRows, ...els.scalpHideInRows, ...els.scalpFullHints]) {
      expect(el.hidden).toBe(false);
      expect(el.style.display).toBe('');
    }
    for (const el of els.scalpLiteHints) {
      expect(el.hidden).toBe(true);     // index.html の既定のまま=full には出ない
      expect(el.style.display).toBe('');
    }
  });

  it('AIエントリーの配列が未指定/null でも落ちない', () => {
    expect(() => applyVariantVisibility('lite', { scalpHideRows: null, scalpLiteHints: [null, undefined] }))
      .not.toThrow();
  });
});
