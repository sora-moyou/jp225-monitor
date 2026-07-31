// ★lite: index.html のマークアップが variant.ts の LITE_SCALP セレクタと噛み合っているかを検証する。
// main.ts は同じ定数で要素を集めるので、ここが緑なら「lite で 4項目だけが残る」ことが構造的に保証される。
// jsdom は導入していないため、依存済みの cheerio で静的にパースする(描画はしない)。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { LITE_SCALP } from './variant.js';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const $ = cheerio.load(html);
const fieldset = $(LITE_SCALP.fieldset);
const keepRows = fieldset.find(LITE_SCALP.keepRow);
const dropRows = fieldset.find(LITE_SCALP.dropRow);
type El = Parameters<typeof $>[0];
const labelOf = (row: El) => $(row).children('label').first().text().trim();

describe('lite の AIエントリー(index.html の構造)', () => {
  it('lite に残す行はユーザー指示の4項目だけ(バイアス/初期LC下限/最大初期LC/LC安全上限)', () => {
    expect(keepRows.toArray().map(labelOf)).toEqual([
      '初期LC下限(円)', '最大初期LC(円)', 'バイアス', 'LC安全上限(円)',
    ]);
  });

  it('4項目以外の行(トレンドveto/クールダウン/レンジ等)は lite で隠す側に入る', () => {
    const dropped = dropRows.toArray().map(labelOf);
    expect(dropped).toContain('トレンドveto(円)');
    expect(dropped).toContain('クールダウン(秒)');
    expect(dropped).toContain('レンジ両面(実験)');
    // 残す4項目が「隠す側」に混ざっていないこと。
    for (const keep of ['初期LC下限(円)', '最大初期LC(円)', 'バイアス', 'LC安全上限(円)']) {
      expect(dropped).not.toContain(keep);
    }
  });

  it('残す行には B列(.ab-col-b)があり、lite ではそれを隠す対象として拾える', () => {
    for (const row of keepRows.toArray()) {
      expect($(row).find(LITE_SCALP.inRowHide).length).toBeGreaterThan(0);
      expect($(row).find('.ab-col-b').length).toBe(1);
    }
  });

  it('★lite で隠す部品に委任モード select は含めない(手動/AI委任をユーザーが選べる)', () => {
    expect(LITE_SCALP.inRowHide).not.toContain('knob-mode');
    for (const row of keepRows.toArray()) {
      // 隠す対象(B列 / A タグ)を集めても、A 側の委任モード select は入らない。
      const hidden = $(row).find(LITE_SCALP.inRowHide).toArray();
      const aMode = $(row).find('.ab-col:not(.ab-col-b) ' + LITE_SCALP.modeSelect).toArray();
      for (const m of aMode) expect(hidden).not.toContain(m);
    }
  });

  it('★委任モード select は 3項目(初期LC下限/最大初期LC/バイアス)にあり、LC安全上限には無い', () => {
    const withMode = keepRows.toArray()
      .filter(r => $(r).find('.ab-col:not(.ab-col-b) ' + LITE_SCALP.modeSelect).length > 0)
      .map(labelOf);
    expect(withMode).toEqual(['初期LC下限(円)', '最大初期LC(円)', 'バイアス']);
    const hardMax = keepRows.toArray().find(r => labelOf(r) === 'LC安全上限(円)')!;
    expect($(hardMax).find(LITE_SCALP.modeSelect).length).toBe(0);   // A/B とも無い=安全弁は委任対象外
  });

  // ★このテストは「文言が説明として揃っているか」しか見られない(DOM の静的検査なので、
  //   コードが本当に強制しているかは検証できない)。実強制そのものは
  //   server/llm/scalpPlanPipeline.test.ts「★初期LC下限の実強制」で実経路を通して固定している。
  //   ここで文言を固定するのは、実装を直したあとに説明が実態から再びずれないようにするため。
  it('★lite 冒頭の説明に「手動/AI委任」の意味が書いてある', () => {
    const top = fieldset.children(LITE_SCALP.liteHint).first().text();
    expect(top).toContain('手動');
    expect(top).toContain('設定した数値を必ず守らせます');
    expect(top).toContain('AI委任');
    expect(top).toContain('AIが場面ごとに決めます');
  });

  it('★初期LC下限は「委任の対象外=AI委任でも強制」と書いてあり、旧来の「強制はしません」が残っていない', () => {
    const floorRow = keepRows.toArray().find(r => labelOf(r) === '初期LC下限(円)')!;
    const rowHint = $(floorRow).find(LITE_SCALP.liteHint).text();
    const top = fieldset.children(LITE_SCALP.liteHint).first().text();
    // 冒頭の説明と行の説明が、同じ結論(委任しても下限は強制される)を述べていること。
    expect(top).toContain('委任の対象外');
    expect(rowHint).toContain('必ず強制されます');
    // ★同じ fieldset 内で正面から矛盾していた旧文言(「コードでの強制はしません」)は消えている。
    expect(fieldset.text()).not.toContain('コードでの強制はしません');
  });

  it('lite 専用の説明(.lite-hint)は fieldset 冒頭 + 4項目それぞれに 1つずつあり、既定は hidden(=full に出ない)', () => {
    const lite = fieldset.find(LITE_SCALP.liteHint);
    expect(lite.length).toBe(5);   // 冒頭 1 + 各行 4
    lite.each((_, el) => expect($(el).attr('hidden')).toBeDefined());
    for (const row of keepRows.toArray()) {
      expect($(row).find(LITE_SCALP.liteHint).length).toBe(1);
    }
  });

  it('full 向けの説明(.exit-hint:not(.lite-hint))は従来どおり 2つで、hidden ではない(full の表示は不変)', () => {
    const full = fieldset.find(LITE_SCALP.fullHint);
    expect(full.length).toBe(2);
    full.each((_, el) => expect($(el).attr('hidden')).toBeUndefined());
  });

  it('詳細設定の右カラム(#params-col2)が存在する(lite で丸ごと隠す=ポーリング/急変閾値/データを見せない)', () => {
    expect($('#params-modal #params-col2').length).toBe(1);
    // AIエントリーは左カラム側=右カラムを隠しても残る。
    expect($('#params-col2 #ai-entry-fieldset').length).toBe(0);
  });
});
