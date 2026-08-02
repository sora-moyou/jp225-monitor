import { describe, it, expect } from 'vitest';
import {
  EXIT_VARIANTS, DEFAULT_EXIT_VARIANT, normalizeExitVariant,
  describeExitLogic, describeExitLogicVariant, describeExitLogicSimple,
  loadExitImpl, type ExitVariant,
} from './index.js';

// ─── 決済仕様の「名前付き変種」(公開側は名前と型だけ) ─────────────────────────
//
// ★否定対照(この機能を実装する前のコードでの結果):
//   EXIT_VARIANTS / normalizeExitVariant / describeExitLogicVariant が存在しないため
//   import 段で解決できず、このファイルの全テストが赤になる。
//
// ★このファイルは公開リポにも載る。**決済の実数値は一切書かない・一切 assert しない。**
//   検証するのは「変種が名前で選べること」「現行(既定)の説明文が変種経由でも byte 一致すること」
//   「候補は現行と異なる説明文になること」という構造だけ。

describe('normalizeExitVariant(外部入力 → 変種名)', () => {
  it('未指定 / null / 空文字 は既定(current)', () => {
    for (const v of [undefined, null, '']) {
      const r = normalizeExitVariant(v);
      expect(r).toEqual({ ok: true, variant: DEFAULT_EXIT_VARIANT });
    }
  });

  it('既知の変種名はそのまま受理する', () => {
    for (const name of EXIT_VARIANTS) {
      expect(normalizeExitVariant(name)).toEqual({ ok: true, variant: name });
    }
  });

  it('未知の変種名は **拒否** する(黙って current に倒さない)', () => {
    for (const bad of ['CURRENT', 'candidate_a', 'candidate-b', 'x', 42, {}, true]) {
      const r = normalizeExitVariant(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/exitVariant/);
    }
  });

  it('エラーメッセージに数値の羅列を出さない(受信値は 32 文字で切る)', () => {
    const r = normalizeExitVariant('x'.repeat(200));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeLessThan(120);
  });

  it('既定は current で、変種一覧に含まれる', () => {
    expect(DEFAULT_EXIT_VARIANT).toBe('current');
    expect(EXIT_VARIANTS).toContain(DEFAULT_EXIT_VARIANT);
  });
});

describe('describeExitLogicVariant(変種ごとの説明文)', () => {
  it('private 未ロード(公開フォールバック)でも current は既存の説明文と完全一致', () => {
    expect(describeExitLogicVariant('current')).toBe(describeExitLogicSimple());
  });

  it('private ロード後も current は describeExitLogic() と **byte 一致**(既存プロンプトが変わらない)', async () => {
    await loadExitImpl();
    expect(describeExitLogicVariant('current')).toBe(describeExitLogic());
  });

  it('candidate-a は current と異なる説明文になる(=AI に違う仕様が渡る)', async () => {
    await loadExitImpl();
    const cur = describeExitLogicVariant('current');
    const cand = describeExitLogicVariant('candidate-a');
    expect(cand).not.toBe(cur);
    expect(cand.length).toBeGreaterThan(0);
  });

  it('全変種で説明文が生成でき、互いに重複しない', async () => {
    await loadExitImpl();
    const texts = EXIT_VARIANTS.map((v: ExitVariant) => describeExitLogicVariant(v));
    expect(new Set(texts).size).toBe(EXIT_VARIANTS.length);
  });
});
