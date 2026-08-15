import { describe, it, expect } from 'vitest';
import { shouldOverwriteBar, isBaseBar, BAR_SRC_BASE, BAR_SRC_LIVE, type BarSource } from './barSource.js';

// bars_1m の (symbol, t) 衝突解決の **表** をここで固定する。
// この表が「基礎データがあるならそれを優先する」という要件の唯一の定義。

describe('shouldOverwriteBar — 既存行 × 書き込み側 の全組み合わせ', () => {
  const table: Array<{ existing: string | null; incoming: BarSource; overwrite: boolean; why: string }> = [
    { existing: 'base', incoming: 'base', overwrite: true, why: '基礎データの再取込は最新版で上書き' },
    { existing: 'live', incoming: 'base', overwrite: true, why: '基礎データが正: ライブを上書きする' },
    { existing: null, incoming: 'base', overwrite: true, why: '出所不明の行も基礎データで上書き' },
    { existing: 'base', incoming: 'live', overwrite: false, why: '★基礎データはライブで塗り替えない' },
    { existing: 'live', incoming: 'live', overwrite: true, why: 'ライブ同士は従来どおり' },
    { existing: null, incoming: 'live', overwrite: true, why: '出所不明は従来どおり(既存環境の挙動不変)' },
  ];

  for (const r of table) {
    it(`既存=${r.existing ?? 'NULL'} / 書込=${r.incoming} → ${r.overwrite ? '上書きする' : '上書きしない'}(${r.why})`, () => {
      expect(shouldOverwriteBar(r.existing, r.incoming)).toBe(r.overwrite);
    });
  }

  it('表は 3(既存) × 2(書込) の 6 通りを漏れなく網羅している', () => {
    const keys = new Set(table.map(r => `${r.existing}|${r.incoming}`));
    expect(keys.size).toBe(6);
    for (const e of ['base', 'live', null]) {
      for (const i of ['base', 'live']) expect(keys.has(`${e}|${i}`)).toBe(true);
    }
  });

  it('上書きを拒むのは「既存=base かつ 書込=live」の1通りだけ', () => {
    expect(table.filter(r => !r.overwrite)).toEqual([
      { existing: 'base', incoming: 'live', overwrite: false, why: '★基礎データはライブで塗り替えない' },
    ]);
  });
});

describe('isBaseBar', () => {
  it('base だけ true(null/undefined/live/未知の値は false)', () => {
    expect(isBaseBar(BAR_SRC_BASE)).toBe(true);
    expect(isBaseBar(BAR_SRC_LIVE)).toBe(false);
    expect(isBaseBar(null)).toBe(false);
    expect(isBaseBar(undefined)).toBe(false);
    expect(isBaseBar('BASE')).toBe(false);   // 大文字は別物(誤記を黙って通さない)
  });
});
