// ★分析用の設定 UI が index.html に実在すること(main.ts が id で拾うので、ここが緑なら配線が繋がる)。
// あわせて **作業4の注記**(同一アカウントの別キーでは上流の枠は分かれない)が画面に書かれていることを固定する。
// これを書かないとユーザーは「キーを入れたから安全」と誤解する。
// jsdom は導入していないため、依存済みの cheerio で静的にパースする(描画はしない)。
//
// ★否定対照: 修正前の index.html には generator-keys-fieldset も genkey-* も存在しないので全て赤くなる。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { GENERATOR_PROVIDERS } from './types.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const $ = cheerio.load(html);
const fs = $('#generator-keys-fieldset');

describe('分析用の設定 UI(index.html)', () => {
  it('fieldset が設定モーダル(⚙️)の中にある', () => {
    expect(fs.length).toBe(1);
    expect($('#settings-modal').find('#generator-keys-fieldset').length).toBe(1);
  });

  it('プロバイダごとにキー欄・状態マーク・「どのキーを使うか」表示がある', () => {
    for (const n of GENERATOR_PROVIDERS) {
      expect(fs.find(`#genkey-${n}`).attr('type')).toBe('password');   // 秘密フィールド
      expect(fs.find(`#genkey-${n}-status`).hasClass('key-status')).toBe(true);   // 既存キー欄と同じ流儀
      expect(fs.find(`#genkey-${n}-src`).length).toBe(1);
    }
  });

  it('専用キーの消去・プール別の検証・日次予算の入力がある', () => {
    expect(fs.find('#genkey-clear').attr('type')).toBe('checkbox');
    expect(fs.find('#settings-test-genkeys').length).toBe(1);
    expect(fs.find('#settings-test-genkeys-result').length).toBe(1);
    const budget = fs.find('#generator-budget');
    expect(budget.attr('type')).toBe('number');
    expect(budget.attr('min')).toBe('0');
    expect(budget.attr('max')).toBe('5000');
  });

  it('★注記: 同じアカウントのキーでは提供元側の枠が共有されることを書いている', () => {
    const warn = fs.find('.gen-key-warn').text();
    expect(warn).toContain('同じアカウントのキーでは提供元側の枠は共有されます');
    expect(warn).toContain('別アカウント');
  });

  it('★日次予算の説明に根拠(600回/1,584回/既定200)と「上限で停止・記録に残る」がある', () => {
    const t = fs.text();
    expect(t).toContain('600');
    expect(t).toContain('1,584');
    expect(t).toContain('200');
    expect(t).toContain('停止');
    expect(t).toContain('記録');
  });

  it('空欄なら共通キーへフォールバックすることを書いている', () => {
    expect(fs.text()).toContain('共通キー');
  });

  it('★既存の共通キー設定(default プール)の見た目・導線は不変', () => {
    for (const n of ['gemini', 'groq', 'openai', 'kimi']) {
      expect($(`#key-${n}`).attr('type')).toBe('password');
      expect($(`#key-${n}-status`).hasClass('key-status')).toBe(true);
    }
    expect($('#settings-test-keys').text().trim()).toBe('キーを検証');
    // 既存のキー欄と分析用のキー欄が混ざっていない(分析用 fieldset の外に key-* がある)。
    expect(fs.find('#key-gemini').length).toBe(0);
  });
});
