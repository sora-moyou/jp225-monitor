// ★設定モーダル(⚙️)の並び順を index.html のマークアップで固定する(ユーザー指示)。
//   ★変更(今回): 上段を左右に分ける。左半分=プロバイダ状態(#settings-status-area・従来は2カラムの外で全幅)、
//   右半分=「更新」(従来は左カラムの先頭 fieldset)。「更新」の下に「基礎データ」が続く。
//   右カラムは 更新 → 終了 → 売買シグナル → 基礎データ の順(基礎データは monitor2 メンテナ専用で
//   lite では非表示。末尾に置くと lite では最後の1つが消えるだけ=末尾に隙間ができない)。
//   期待する見え方:  [ プロバイダ状態 ] [ 更新 ]
//                    [ APIキー(無料)… ] [ 終了 / 売買シグナル / 基礎データ ]
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
const rightCol = settingsCols.children('.scol').eq(1);
const legendsOf = (col: typeof leftCol) =>
  col.children('fieldset.settings-section').children('legend').toArray().map(el => $(el).text().trim());

describe('設定モーダルの並び(index.html)', () => {
  it('★上段は左右に分かれる: 左半分=プロバイダ状態 / 右半分=「更新」', () => {
    expect(settingsCols.length).toBe(1);
    expect(settingsCols.children('.scol').length).toBe(2);
    // 左カラムの最初の要素がプロバイダ状態(2カラムの外に全幅で置かれていない)。
    expect(leftCol.children().first().attr('id')).toBe('settings-status-area');
    expect($('#settings-modal > .modal-content > #settings-status-area').length).toBe(0);
    // 右カラムの最初の fieldset が「更新」、最後が「基礎データ」(lite で消えるのは末尾の1つだけ)。
    expect(legendsOf(rightCol)[0]).toBe('更新');
    expect(legendsOf(rightCol).at(-1)).toBe('基礎データ(225labo)');
  });

  it('★プロバイダ状態の枠は1つだけ(移動でコピーが残っていない)・中身は JS が流し込む空 div のまま', () => {
    expect($('#settings-status-area').length).toBe(1);
    expect($('#settings-status-area').prop('tagName')).toBe('DIV');
    expect($('#settings-status-area').html()).toBe('');
  });

  it('更新の中身(id/ボタン/文言)は移動しても不変=イベント配線が外れていない', () => {
    const fs = rightCol.children('fieldset.settings-section').first();
    expect(fs.find('#settings-current-version').length).toBe(1);
    expect(fs.find('#settings-check-update').text().trim()).toBe('更新をチェック');
    expect(fs.find('#settings-update-result').length).toBe(1);
    // 設定モーダル全体でも重複していない(移動でコピーが残っていない)。
    expect($('#settings-check-update').length).toBe(1);
    expect($('#settings-current-version').length).toBe(1);
    expect($('#settings-update-result').length).toBe(1);
  });

  it('設定モーダルの fieldset 一式は増減なし(左=APIキー系 / 右=更新・終了・売買シグナル・基礎データ)', () => {
    const all = settingsCols.children('.scol')
      .children('fieldset.settings-section').children('legend').toArray()
      .map(el => $(el).text().trim());
    expect(all.slice().sort()).toEqual(
      ['APIキー（無料）', 'APIキー（有料）', '提案生成器（分析用・実弾とは別プール）',
        '更新', '基礎データ(225labo)', '終了', '売買シグナル'].slice().sort(),
    );
    expect(legendsOf(leftCol)[0]).toBe('APIキー（無料）');
    expect(legendsOf(rightCol)).toEqual(['更新', '終了', '売買シグナル', '基礎データ(225labo)']);
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
    const updateFs = rightCol.children('fieldset.settings-section').first();
    for (const id of LITE_HIDE_IDS) {
      const el = $(`#${id}`);
      expect(updateFs.find(`#${id}`).length, `更新が ${id} を含んでいる`).toBe(0);
      expect(el.find('#settings-check-update').length, `${id} が更新を含んでいる`).toBe(0);
    }
    // AIエントリー側(詳細設定モーダル)の lite 制御とも無関係。
    expect(updateFs.closest(LITE_SCALP.fieldset).length).toBe(0);
  });

  it('★lite で隠れる #basedata-publish-fieldset は右カラムの最後(=消えても間に穴が空かない)', () => {
    const rightFs = rightCol.children('fieldset.settings-section').toArray();
    expect($(rightFs.at(-1)!).attr('id')).toBe('basedata-publish-fieldset');
    // lite で残る3つ(更新/終了/売買シグナル)は隠す id を1つも含まない=詰まって並ぶ。
    for (const fs of rightFs.slice(0, -1)) {
      for (const id of LITE_HIDE_IDS) expect($(fs).find(`#${id}`).length, id).toBe(0);
      expect($(fs).attr('id')).not.toBe('basedata-publish-fieldset');
    }
  });

  it('AIエントリーの lite 制御(隠す行/部品/説明)の件数は従来どおり', () => {
    const fieldset = $(LITE_SCALP.fieldset);
    // 設定モーダルの並べ替えは詳細設定モーダルに触れていない=件数が動いていないことを固定する。
    // ★v0.9.70: A/B の4項目 + チャート画像の送信モード(全体設定)= 5行。
    expect(fieldset.find(LITE_SCALP.keepRow).length).toBe(5);
    expect(fieldset.find(LITE_SCALP.keepAbRow).length).toBe(4);
    expect(fieldset.find(LITE_SCALP.dropRow).length).toBeGreaterThan(0);
    expect(fieldset.find(LITE_SCALP.fullHint).length).toBe(3);   // ★チャート画像の説明を独立した div にした
    expect(fieldset.find(LITE_SCALP.liteHint).length).toBe(6);
  });
});
