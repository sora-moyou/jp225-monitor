// ★「取引時間外もニュースを取得」トグルが **lite でも見える** ことを構造で保証する。
//
// なぜテストにするか(variantLiteNews.test.ts と同じ理由):
//   lite は applyVariantVisibility が「渡された枠」だけを隠す仕組みなので、後から誰かが
//   このトグルを詳細設定(#params-col2)へ移したり、枠内に lite 対象の id / data-lite を足すと、
//   **無言で lite だけ消える**。画面を並べて見比べる作業では気づけないので構造の側で止める。
//   ユーザー指示は「簡易版(lite)にも出す」なので、消えたら仕様違反になる。
//
// jsdom は導入していないため、依存済みの cheerio で静的にパースする(既存の lite テストと同じ流儀)。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { LITE_SCALP } from './variant.js';
import { offHoursEnabledFrom } from '../components/newsOffHours.js';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const $ = cheerio.load(html);
const panel = $('#news-feed');
const toggleBox = $('#news-offhours');

// applyVariantVisibility('lite') が隠す枠の id(variantLiteNews.test.ts と同じ一覧)。
const LITE_HIDDEN_IDS = [
  'alerts-history-btn', 'open-logs-btn', 'signal-trades-system-row',
  'websearch-model-fieldset', 'data-fieldset', 'basedata-publish-fieldset',
  'generator-keys-fieldset', 'params-col2', 'ai-entry-fieldset',
];

describe('時間外ニュース取得トグルは lite でも見える', () => {
  it('トグルはニュースパネル(lite/full 同一の枠)の中に在る', () => {
    expect(toggleBox.length).toBe(1);
    expect(panel.find('#news-offhours').length).toBe(1);
    expect(panel.find('#news-offhours-toggle').attr('type')).toBe('checkbox');
    // 既定は未チェック(=OFF)。HTML に checked を書き込むと、設定を読む前の一瞬 ON に見える。
    expect(panel.find('#news-offhours-toggle').attr('checked')).toBeUndefined();
    // 保存の成否を出す場所(無言の失敗を作らないため)。
    expect(panel.find('#news-offhours-status').length).toBe(1);
  });

  it('★lite が隠す id の中に入っていない(祖先も含めて)', () => {
    for (const id of LITE_HIDDEN_IDS) {
      expect($(`#${id}`).find('#news-offhours').toArray(), `#${id} の中にトグルがある`).toHaveLength(0);
    }
  });

  it('★lite の隠し対象セレクタがトグルの枠内に無い', () => {
    for (const sel of Object.values(LITE_SCALP)) {
      expect(toggleBox.find(sel).toArray(), `${sel} がトグルの枠内にある`).toHaveLength(0);
    }
    // 枠そのものが隠し対象に一致していないこと(#news-offhours 自身が .setting-row 等でない)。
    for (const sel of Object.values(LITE_SCALP)) {
      expect(toggleBox.is(sel), `トグルの枠自体が ${sel} に一致する`).toBe(false);
    }
    expect(toggleBox.attr('data-lite')).toBeUndefined();
  });

  it('★詳細設定(🎛️)側には同じ設定の重複コントロールを置かない(2箇所で食い違わせない)', () => {
    expect($('#params-col2').find('#news-offhours-toggle').toArray()).toHaveLength(0);
    expect($('input[id*="news-offhours"]').toArray()).toHaveLength(1);
  });
});

describe('offHoursEnabledFrom — 表示の既定は OFF(現行挙動)側', () => {
  it('true のときだけ ON', () => {
    expect(offHoursEnabledFrom({ newsOffHoursEnabled: true })).toBe(true);
  });
  it('未設定 / false / 非boolean / 取得失敗は OFF', () => {
    expect(offHoursEnabledFrom({})).toBe(false);
    expect(offHoursEnabledFrom({ newsOffHoursEnabled: false })).toBe(false);
    expect(offHoursEnabledFrom({ newsOffHoursEnabled: 'true' })).toBe(false);
    expect(offHoursEnabledFrom(null)).toBe(false);
    expect(offHoursEnabledFrom(undefined)).toBe(false);
  });
});
