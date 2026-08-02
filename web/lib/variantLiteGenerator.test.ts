// ★lite: 「2つ目の API キー」欄(提案生成器 fieldset)を公開版で出さない。
//
// なぜ: lite は生成器そのものを走らせない(server の analysisGate が caller='generator' を 400 で拒否し、
//   generator プールも構築しない)。走らないものにキーを入れさせる欄は、ユーザーを誤解させるだけ。
//
// ★否定対照(修正前の web/lib/variant.ts): VariantElements に generatorKeysFieldset が無く、
//   applyVariantVisibility は渡された要素を隠さない → 本ファイルが赤(型解決の時点で落ちる)。
//   実証手順: git show HEAD:web/lib/variant.ts でファイルを差し替えて実行。
//
// jsdom は導入していないため、hidden/style だけを持つモック要素(純関数テスト)と、
// index.html の静的パース(cheerio)の2本で「セレクタとマークアップが噛み合っている」ことを見る。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { applyVariantVisibility, type ToggleableEl } from './variant.js';

function mockEl(): ToggleableEl {
  return { hidden: false, style: { display: '' } };
}

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const $ = cheerio.load(html);

describe('lite の提案生成器 fieldset(2つ目の API キー欄)', () => {
  it('lite では隠される', () => {
    const el = mockEl();
    applyVariantVisibility('lite', { generatorKeysFieldset: el });
    expect(el.hidden).toBe(true);
    expect(el.style.display).toBe('none');
  });

  it('★full では触らない(表示のまま=現行と完全同一)', () => {
    const el = mockEl();
    applyVariantVisibility('full', { generatorKeysFieldset: el });
    expect(el.hidden).toBe(false);
    expect(el.style.display).toBe('');
  });

  it('index.html 側に対応する id があり、2つ目のキー入力欄と日次予算欄をその中に持つ', () => {
    const fs = $('#generator-keys-fieldset');
    expect(fs.length).toBe(1);
    // 生成器キー4本 + 日次予算が **全て** この fieldset の内側にある(隠せば全部消える)。
    for (const id of ['#genkey-gemini', '#genkey-groq', '#genkey-openai', '#genkey-kimi', '#generator-budget']) {
      expect(fs.find(id).length).toBe(1);
    }
  });

  it('main.ts が この id を applyVariantVisibility へ渡している(配線の実在)', () => {
    const main = readFileSync(fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8');
    expect(main).toContain("generatorKeysFieldset: document.getElementById('generator-keys-fieldset')");
  });
});
