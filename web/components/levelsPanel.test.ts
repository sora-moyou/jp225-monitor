import { describe, it, expect } from 'vitest';
import { buildLevelsHtml } from './levelsPanel.js';
import type { LevelsResult, Level } from '../types.js';

// buildLevelsHtml は DOM 非依存の純関数。socket 停止(現値 stale)時も水準行を残すことを検証する。

function lvl(price: number, over: Partial<Level> = {}): Level {
  return { price, dist: 0, labels: ['水準'], strong: false, score: 1, tier: 0, confluence: false, ...over };
}
function result(over: Partial<LevelsResult> = {}): LevelsResult {
  return { current: 67000, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 1, ...over };
}

describe('buildLevelsHtml — 水準パネルのグレースフル劣化', () => {
  it('水準が一つも無ければ「蓄積中…」', () => {
    const html = buildLevelsHtml(result({ up: [], down: [] }), 67000, false, '');
    expect(html).toContain('蓄積中…');
    expect(html).not.toContain('現値');
  });

  it('未受信(latest=null)は「蓄積中…」', () => {
    expect(buildLevelsHtml(null, 67000, false, '')).toContain('蓄積中…');
  });

  it('fresh 現値: 水準行 + 「現値 <price>」を出す', () => {
    const r = result({ up: [lvl(67200, { labels: ['上値'] })], down: [lvl(66800, { labels: ['下値'] })] });
    const html = buildLevelsHtml(r, 67000, false, '');
    expect(html).toContain('67,200');
    expect(html).toContain('66,800');
    expect(html).toContain('現値');
    expect(html).toContain('67,000');
    expect(html).not.toContain('取得不能');
  });

  it('星は独立カラム(lv-star)にして価格(lv-price)と分離する(縦揃えの前提・★★でも桁がズレない)', () => {
    const r = result({
      up: [lvl(67200, { tier: 2, labels: ['合流'] })],    // ★★
      down: [lvl(66800, { tier: 1, labels: ['節目'] })],  // ★
    });
    const html = buildLevelsHtml(r, 67000, false, '');
    expect(html).toContain('<span class="lv-star">★★</span>');
    expect(html).toContain('<span class="lv-star">★</span>');
    expect(html).toContain('<span class="lv-price">67,200</span>');
    expect(html).toContain('<span class="lv-price">66,800</span>');
    // 星が価格スパンに混入していない(旧バグ: '★★ 67,200' が同枠で桁ズレ)。
    expect(html).not.toContain('★★67,200');
    expect(html).not.toContain('★★ 67,200');
  });

  it('現値 stale: 水準行は残し、現値行だけ「現値 取得不能」に置換(蓄積中…にはしない)', () => {
    const r = result({ up: [lvl(67200)], down: [lvl(66800)] });
    const html = buildLevelsHtml(r, 67000, true, '');   // stale=true(凍結値でも)
    expect(html).toContain('67,200');    // 水準行は残る
    expect(html).toContain('66,800');
    expect(html).toContain('取得不能');   // 現値マーカーは取得不能
    expect(html).toContain('levels-cur-stale');
    expect(html).not.toContain('蓄積中');
  });

  it('現値 null(未取得)でも水準ありなら行を残し「取得不能」を出す', () => {
    const r = result({ up: [lvl(67200)], down: [lvl(66800)] });
    const html = buildLevelsHtml(r, null, false, '');
    expect(html).toContain('67,200');
    expect(html).toContain('取得不能');
    expect(html).not.toContain('蓄積中');
  });

  it('stale 時は latest.current を行の位置分けに使う(空白化しない)', () => {
    // current=67000。67200 は上、66800 は下に来るはず(両方描画される)。
    const r = result({ current: 67000, up: [lvl(67200)], down: [lvl(66800)] });
    const html = buildLevelsHtml(r, 99999, true, '');   // currentPrice は使わない(stale)
    const idx200 = html.indexOf('67,200');
    const idxCur = html.indexOf('取得不能');
    const idx800 = html.indexOf('66,800');
    expect(idx200).toBeGreaterThanOrEqual(0);
    expect(idx800).toBeGreaterThanOrEqual(0);
    expect(idx200).toBeLessThan(idxCur);   // 上値は現値行の前
    expect(idxCur).toBeLessThan(idx800);   // 下値は現値行の後
  });
});
