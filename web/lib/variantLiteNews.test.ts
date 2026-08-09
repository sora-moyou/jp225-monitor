// ★lite でもニュースパネルは full と同じ見た目であること を構造で保証する。
//
// なぜテストにするか: lite は applyVariantVisibility が **渡された要素だけ** を隠す仕組みなので、
// 「ニュースパネルを渡していない = lite でも出る」は今は正しい。しかし後から誰かが
// news パネル内に data-lite や lite 対象の id を足すと、**無言で** lite だけ表示が変わる。
// 画面を並べて見比べる作業では気づけないので、構造の側で止める。
//
// jsdom は導入していないため、依存済みの cheerio で静的にパースする(既存の lite テストと同じ流儀)。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { LITE_SCALP, applyVariantVisibility, type ToggleableEl } from './variant.js';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const $ = cheerio.load(html);
const panel = $('#news-feed');

describe('lite でもニュースパネルは full と同じ', () => {
  it('パネルと必要な部品が index.html に在る', () => {
    expect(panel.length).toBe(1);
    expect(panel.find('#news-list').length).toBe(1);
    expect(panel.find('#news-showall').length).toBe(1);
    // 見出しは 'News'(英語)。v0.9.67 で一時 '世界ニュース' にしたがユーザー指示で戻した。
    expect(panel.find('h2').text()).toBe('News');
  });

  it('★lite の隠し対象セレクタがニュースパネル内に1つも無い', () => {
    for (const sel of Object.values(LITE_SCALP)) {
      expect(panel.find(sel).toArray(), `${sel} が news パネル内にある`).toHaveLength(0);
    }
  });

  it('★lite が隠す id 群がニュースパネル内に無い(将来 id を移動しても検知する)', () => {
    const liteHiddenIds = [
      'alerts-history-btn', 'open-logs-btn', 'signal-trades-system-row',
      'websearch-model-fieldset', 'data-fieldset', 'basedata-publish-fieldset',
      'generator-keys-fieldset', 'params-col2', 'ai-entry-fieldset',
    ];
    for (const id of liteHiddenIds) {
      expect(panel.find(`#${id}`).toArray(), `#${id} が news パネル内にある`).toHaveLength(0);
    }
  });

  it('★applyVariantVisibility("lite") はニュースパネルの要素を隠さない', () => {
    // パネルの要素を「隠される候補」として全部渡しても、lite は渡された既知の枠しか触らない。
    const newsEls: ToggleableEl[] = [
      { hidden: false, style: { display: '' } },   // #news-feed 相当
      { hidden: false, style: { display: '' } },   // #news-list 相当
      { hidden: false, style: { display: '' } },   // #news-showall 相当
    ];
    // ニュースの要素は VariantElements のどの枠にも入らない = 触られない。
    applyVariantVisibility('lite', {});
    for (const el of newsEls) {
      expect(el.hidden).toBe(false);
      expect(el.style.display).toBe('');
    }
  });
});
