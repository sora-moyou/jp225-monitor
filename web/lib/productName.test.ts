// 製品名の表示: full=JP225 Monitor2 / lite=JP225 Monitor。
// 名前を決めるのは server(/api/version の name)1箇所だけ。web は受け取って反映するだけ。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyProductNameTo, type ProductNameEls } from './variant.js';

const els = (title: string, heading: string): ProductNameEls & {
  titleText: () => string | null; headText: () => string | null;
} => {
  const t = { textContent: title as string | null };
  const h = { firstChild: { nodeValue: heading as string | null } };
  return { title: t, heading: h, titleText: () => t.textContent, headText: () => h.firstChild.nodeValue };
};

describe('applyProductNameTo', () => {
  it('full の name でタイトルと見出しを差し替える', () => {
    const e = els('JP225 Monitor', 'JP225 Monitor ');
    applyProductNameTo(e, 'JP225 Monitor2');
    expect(e.titleText()).toBe('JP225 Monitor2');
    expect(e.headText()).toBe('JP225 Monitor2 ');   // 末尾の空白=版タグとの間隔を保つ
  });

  it('lite の name は静値と同じ=見た目が変わらない', () => {
    const e = els('JP225 Monitor', 'JP225 Monitor ');
    applyProductNameTo(e, 'JP225 Monitor');
    expect(e.titleText()).toBe('JP225 Monitor');
    expect(e.headText()).toBe('JP225 Monitor ');
  });

  // ★name が来ない経路(古い server / 取得失敗 / 型違い)は静値のまま。
  //   ここで variant から名前を組み立てて補完すると、名前の決定が2箇所になり
  //   片方だけ直したときに黙ってズレる。欠落は「lite 名のまま」= 安全側に倒す。
  it.each([undefined, null, '', '   ', 42, {}])('name が %o なら何もしない', (bad) => {
    const e = els('JP225 Monitor', 'JP225 Monitor ');
    applyProductNameTo(e, bad);
    expect(e.titleText()).toBe('JP225 Monitor');
    expect(e.headText()).toBe('JP225 Monitor ');
  });

  it('要素が無くても落ちない', () => {
    expect(() => applyProductNameTo({ title: null, heading: null }, 'JP225 Monitor2')).not.toThrow();
    expect(() => applyProductNameTo({ title: null, heading: { firstChild: null } }, 'X')).not.toThrow();
  });
});

describe('index.html の静値', () => {
  const html = readFileSync(join(process.cwd(), 'web', 'index.html'), 'utf-8');

  // ★静値は lite 名にしておく: lite は書き換え不要(ちらつかない)、full だけ起動時に差し替わる。
  //   静値を full 名にすると、lite で一瞬 "Monitor2" が見える。
  it('title と h1 の静値は lite 名', () => {
    expect(html).toContain('<title>JP225 Monitor</title>');
    expect(/<h1>JP225 Monitor <span id="app-version"/.test(html)).toBe(true);
  });

  // 見出しの firstChild がテキストであることに依存しているので、構造が変わったら気づけるようにする。
  it('h1 の先頭はテキストで、版タグは span', () => {
    const m = html.match(/<h1>([^<]*)<span id="app-version"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('JP225 Monitor ');
  });
});
