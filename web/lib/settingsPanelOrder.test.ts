// ★設定モーダル(⚙️)の並び順を index.html のマークアップで固定する(v0.9.59・ユーザー指示)。
//   「更新(バージョン確認)」は設定パネルの一番上=左カラムの最初の fieldset に置く。
//   ここが緑でも「表示が壊れていない」ことまでは言えないので、同じファイルで
//   **lite で隠れる/出る要素の集合が変わっていないこと** も併せて固定する
//   (今回の変更は並べ替えだけ=lite の見え方は 1バイトも変わってはいけない)。
//
// jsdom は導入していないため、依存済みの cheerio で静的にパースする(描画はしない)。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { LITE_SCALP } from './variant.js';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const $ = cheerio.load(html);

/** 設定モーダル(⚙️)の左カラム。詳細設定(🎛️)の .settings-cols と取り違えないよう #settings-modal で限定する。 */
const settingsCols = $('#settings-modal .settings-cols');
const leftCol = settingsCols.children('.scol').first();
const legendsOf = (col: typeof leftCol) =>
  col.children('fieldset.settings-section').children('legend').toArray().map(el => $(el).text().trim());

describe('設定モーダルの並び(index.html)', () => {
  it('★「更新」は設定パネルの一番上(左カラムの最初の fieldset)', () => {
    expect(settingsCols.length).toBe(1);
    expect(legendsOf(leftCol)[0]).toBe('更新');
  });

  it('更新の中身(id/ボタン/文言)は移動しても不変=イベント配線が外れていない', () => {
    const fs = leftCol.children('fieldset.settings-section').first();
    expect(fs.find('#settings-current-version').length).toBe(1);
    expect(fs.find('#settings-check-update').text().trim()).toBe('更新をチェック');
    expect(fs.find('#settings-update-result').length).toBe(1);
    // 設定モーダル全体でも重複していない(移動でコピーが残っていない)。
    expect($('#settings-check-update').length).toBe(1);
    expect($('#settings-current-version').length).toBe(1);
    expect($('#settings-update-result').length).toBe(1);
  });

  it('設定モーダルの fieldset 一式は「更新」が先頭に来ただけ(増減なし)', () => {
    const all = settingsCols.children('.scol')
      .children('fieldset.settings-section').children('legend').toArray()
      .map(el => $(el).text().trim());
    expect(all.slice().sort()).toEqual(
      ['APIキー（無料）', 'APIキー（有料）', '提案生成器（分析用・実弾とは別プール）',
        '更新', '基礎データ(225labo)', '終了', '売買シグナル'].slice().sort(),
    );
    expect(all[0]).toBe('更新');
  });
});

// ─── lite で隠す/出す要素の集合(main.ts が applyVariantVisibility へ渡すもの)───────────────
//   main.ts は id と LITE_SCALP セレクタだけで要素を集める=DOM の並び順に依存しない。
//   その「集合」をここで名指しで固定することで、fieldset を並べ替えても lite の見え方が
//   変わらないことを構造的に保証する(並べ替えでこの集合が動いたらこのテストが落ちる)。
const LITE_HIDE_IDS = [
  'alerts-history-btn', 'open-logs', 'signal-trades-system-row',
  'websearch-model-fieldset', 'data-fieldset', 'basedata-publish-fieldset',
  'generator-keys-fieldset', 'params-col2',
] as const;

describe('lite で隠れる/出る要素の集合(並べ替えの前後で不変)', () => {
  it('lite で隠す id はすべて index.html に1つずつ存在する', () => {
    for (const id of LITE_HIDE_IDS) expect($(`#${id}`).length, id).toBe(1);
  });

  it('★「更新」fieldset は lite の非表示対象ではない(隠す要素の中にも外にも入っていない)', () => {
    const updateFs = leftCol.children('fieldset.settings-section').first();
    for (const id of LITE_HIDE_IDS) {
      const el = $(`#${id}`);
      expect(updateFs.find(`#${id}`).length, `更新が ${id} を含んでいる`).toBe(0);
      expect(el.find('#settings-check-update').length, `${id} が更新を含んでいる`).toBe(0);
    }
    // AIエントリー側(詳細設定モーダル)の lite 制御とも無関係。
    expect(updateFs.closest(LITE_SCALP.fieldset).length).toBe(0);
  });

  it('AIエントリーの lite 制御(隠す行/部品/説明)の件数は従来どおり', () => {
    const fieldset = $(LITE_SCALP.fieldset);
    // 設定モーダルの並べ替えは詳細設定モーダルに触れていない=件数が動いていないことを固定する。
    expect(fieldset.find(LITE_SCALP.keepRow).length).toBe(4);
    expect(fieldset.find(LITE_SCALP.dropRow).length).toBeGreaterThan(0);
    expect(fieldset.find(LITE_SCALP.fullHint).length).toBe(2);
    expect(fieldset.find(LITE_SCALP.liteHint).length).toBe(5);
  });
});
