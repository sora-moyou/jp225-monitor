// ★TP(利確)の設定UI: マークアップ / 反映・保存の往復 / 保有中の予告。
//
// ■ ここで固定すること
//   ① index.html に TP の3部品と予告枠が **実際にある**(main.ts が参照する id と一致する)。
//   ② 部品の作りが「最大初期LC」「目線」と同じ(knob-mode select + 手動/AI委任 の2択)。
//   ③ AI委任を選んだときの数値欄の扱いが **最大初期LC と同一**(disabled + opacity 0.4)。
//   ④ 保有中に手動TP幅を触ったとき、予告が **実際に描かれる**(保有なしでは何も出ない)。
//
// jsdom は導入していないので、マークアップは cheerio(静的解析)で、描画は
// 既存の form.test.ts と同じ入力スタブで「描画関数を実際に呼んで出た文字列」を見る。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { applySettingsToForm, buildSavePayload, syncKnobDisabled } from './form.js';
import { tpHoldWarningText, renderTpHoldWarning, syncTpHoldWarning, positionFromSignalState } from './tpHoldWarn.js';
import type { SettingsElements, SettingsResponse } from './types.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const $ = cheerio.load(html);

// setKeyStatus が document.getElementById を触るため、最小のスタブを置く(form.test.ts と同じ作法)。
(globalThis as { document?: unknown }).document = { getElementById: () => null };

function stub() {
  return { value: '', checked: false, disabled: false, hidden: false, placeholder: '', title: '', innerHTML: '', textContent: '', style: { opacity: '' } };
}
function makeElements(): SettingsElements {
  const cache = new Map<string, ReturnType<typeof stub>>();
  return new Proxy({}, {
    get(_t, prop: string) {
      if (!cache.has(prop)) cache.set(prop, stub());
      return cache.get(prop)!;
    },
  }) as unknown as SettingsElements;
}

const SERVER: SettingsResponse = {
  kimiSet: false, geminiSet: false, groqSet: false, openaiSet: false,
  kimiFromEnv: false, geminiFromEnv: false, groqFromEnv: false, openaiFromEnv: false,
  webSearchKeySet: false, webSearchModel: '', webSearchOpenaiModel: '',
  scalpLcFloorYen: 55, scalpLcCeilingYen: 65, scalpBias: 'long',
  scalpLcHardMaxEnabled: true, scalpLcHardMaxYen: 159,
  scalpCooldownSec: 90, scalpTrendVetoYen: 100, scalpRangeEnabled: false,
  scalpLcFloorSource: 'manual', scalpLcCeilingSource: 'manual', scalpTrendVetoSource: 'manual',
  scalpCooldownSource: 'manual', scalpBiasSource: 'manual', scalpRangeSource: 'manual',
  pricePollMs: 2000, newsPollMs: 60000, port: 3000, cooldownMin: 15,
  providers: [], configFile: 'x.json',
};

// ─── ① / ② マークアップ ─────────────────────────────────────────────
describe('TP の設定項目(index.html)', () => {
  it('main.ts が参照する id が 1つずつ実在する', () => {
    for (const id of ['scalp-tp-enabled', 'scalp-tp-width-mode', 'scalp-tp-width', 'scalp-tp-hold-warn']) {
      expect($(`#${id}`).length, id).toBe(1);
    }
  });

  it('AIエントリー(#ai-entry-fieldset)の中にあり、行のラベルは「TPを使う(利確)」「TP幅(円)」', () => {
    const fs = $('#ai-entry-fieldset');
    expect(fs.find('#scalp-tp-enabled').length).toBe(1);
    expect(fs.find('#scalp-tp-width').length).toBe(1);
    const labelOfRow = (id: string) => $(`#${id}`).closest('.setting-row').children('label').first().text().trim();
    expect(labelOfRow('scalp-tp-enabled')).toBe('TPを使う(利確)');
    expect(labelOfRow('scalp-tp-width')).toBe('TP幅(円)');
  });

  it('★出所 select は「最大初期LC」と同じ部品(class=knob-mode・手動/AI委任 の2択・同じ並び)', () => {
    const optionsOf = (id: string) => $(`#${id} option`).toArray().map(o => [$(o).attr('value'), $(o).text()]);
    expect($('#scalp-tp-width-mode').attr('class')).toBe($('#scalp-lc-ceiling-mode').attr('class'));
    expect(optionsOf('scalp-tp-width-mode')).toEqual(optionsOf('scalp-lc-ceiling-mode'));
    expect(optionsOf('scalp-tp-width-mode')).toEqual([['manual', '手動'], ['ai', 'AI委任']]);
    // 数値欄も同じ作り(type=number / ab-col の中 / 出所 select の直後)。
    expect($('#scalp-tp-width').attr('type')).toBe('number');
    expect($('#scalp-tp-width').parent().attr('class')).toBe('ab-col');
    expect($('#scalp-tp-width').prev().attr('id')).toBe('scalp-tp-width-mode');
  });

  it('★予告枠は既定 hidden で、既存の説明(.exit-hint)には混ぜていない', () => {
    expect($('#scalp-tp-hold-warn').attr('hidden')).toBeDefined();
    expect($('#scalp-tp-hold-warn').attr('class')).toBe('setting-warn');
    expect($('#scalp-tp-hold-warn').hasClass('exit-hint')).toBe(false);
  });
});

// ─── 反映と保存の往復 ────────────────────────────────────────────────
describe('TP の反映 → 保存の往復', () => {
  it('サーバ値をそのまま反映して、そのまま送り返す', () => {
    const el = makeElements();
    applySettingsToForm(el, { ...SERVER, scalpTpEnabled: false, scalpTpWidthSource: 'manual', scalpTpWidthYen: 40 });
    expect(el.checkScalpTpEnabled.checked).toBe(false);
    expect(el.selectTpWidthMode.value).toBe('manual');
    expect(el.inputScalpTpWidth.value).toBe('40');
    const body = buildSavePayload(el);
    expect(body.scalpTpEnabled).toBe(false);
    expect(body.scalpTpWidthSource).toBe('manual');
    expect(body.scalpTpWidthYen).toBe(40);
  });

  it('★サーバが TP を返さない(古い版)ときは 使う=true / AI委任 に倒れ、幅は空欄', () => {
    const el = makeElements();
    applySettingsToForm(el, SERVER);
    expect(el.checkScalpTpEnabled.checked).toBe(true);
    expect(el.selectTpWidthMode.value).toBe('ai');   // ★TP だけ既定が 'ai'
    expect(el.inputScalpTpWidth.value).toBe('');
    expect(buildSavePayload(el).scalpTpWidthYen).toBe(null);   // 空欄=既定(80)へ戻す
  });

  it('★AI委任のとき数値欄が灰色になる挙動は「最大初期LC」と同一', () => {
    const el = makeElements();
    applySettingsToForm(el, { ...SERVER, scalpLcCeilingSource: 'ai', scalpTpWidthSource: 'ai' });
    syncKnobDisabled(el);
    expect(el.inputScalpTpWidth.disabled).toBe(el.inputScalpLcCeiling.disabled);
    expect(el.inputScalpTpWidth.style.opacity).toBe(el.inputScalpLcCeiling.style.opacity);
    expect(el.inputScalpTpWidth.disabled).toBe(true);
    expect(el.inputScalpTpWidth.style.opacity).toBe('0.4');
    // 手動に戻せば両方とも編集できる。
    applySettingsToForm(el, { ...SERVER, scalpLcCeilingSource: 'manual', scalpTpWidthSource: 'manual' });
    syncKnobDisabled(el);
    expect(el.inputScalpTpWidth.disabled).toBe(false);
    expect(el.inputScalpTpWidth.style.opacity).toBe('');
  });
});

// ─── ④ 保有中の予告 ─────────────────────────────────────────────────
const HOLD = { direction: 'buy' as const, entryPrice: 38000, unrealized: 60 };

describe('保有中に手動TP幅を変えたときの予告', () => {
  it('保有していなければ何も出さない', () => {
    expect(tpHoldWarningText({ enabled: true, source: 'manual', widthYen: 30, position: null })).toBe('');
  });

  it('★いまの含み益に届く幅にすると「すぐに成行で決済されます」と出る', () => {
    const t = tpHoldWarningText({ enabled: true, source: 'manual', widthYen: 30, position: HOLD });
    expect(t).toContain('いま買いの建玉を持っています');
    expect(t).toContain('いまの損益 +60円');
    expect(t).toContain('もう届いています');
    expect(t).toContain('すぐに成行で決済されます');
  });

  it('★境界(ちょうど同じ幅)も「すぐに決済」側に入る(決済判定が >= のため)', () => {
    expect(tpHoldWarningText({ enabled: true, source: 'manual', widthYen: 60, position: HOLD }))
      .toContain('すぐに成行で決済されます');
  });

  it('まだ届かない幅なら「あと何円で決済されるか」を出す(驚かせない)', () => {
    const t = tpHoldWarningText({ enabled: true, source: 'manual', widthYen: 100, position: HOLD });
    expect(t).toContain('あと 40円');
    expect(t).not.toContain('すぐに成行で決済されます');
  });

  it('売り建玉でも向きが出る', () => {
    const t = tpHoldWarningText({ enabled: true, source: 'manual', widthYen: 10, position: { ...HOLD, direction: 'sell' } });
    expect(t).toContain('いま売りの建玉を持っています');
  });

  it('TPを使わない設定 / AI委任 / 空欄 / 0 以下 では出さない(手動の数値が効かない場面)', () => {
    expect(tpHoldWarningText({ enabled: false, source: 'manual', widthYen: 30, position: HOLD })).toBe('');
    expect(tpHoldWarningText({ enabled: true, source: 'ai', widthYen: 30, position: HOLD })).toBe('');
    expect(tpHoldWarningText({ enabled: true, source: 'manual', widthYen: null, position: HOLD })).toBe('');
    expect(tpHoldWarningText({ enabled: true, source: 'manual', widthYen: 0, position: HOLD })).toBe('');
    expect(tpHoldWarningText({ enabled: true, source: 'manual', widthYen: Number.NaN, position: HOLD })).toBe('');
  });

  it('★予告枠に実際に描かれる: 保有ありで文言+表示 / 保有なしで空+非表示', () => {
    const el = { textContent: 'のこりかす', hidden: false } as unknown as HTMLElement;
    renderTpHoldWarning(el, { enabled: true, source: 'manual', widthYen: 30, position: HOLD });
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain('すぐに成行で決済されます');
    renderTpHoldWarning(el, { enabled: true, source: 'manual', widthYen: 30, position: null });
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');   // ★前回の文言が残らない
  });

  it('★画面の現在値から予告を出し直せる(入力を触ったときの経路)', () => {
    const el = makeElements();
    applySettingsToForm(el, { ...SERVER, scalpTpEnabled: true, scalpTpWidthSource: 'manual', scalpTpWidthYen: 100 });
    syncTpHoldWarning(el, HOLD);
    expect(el.tpHoldWarn.hidden).toBe(false);
    expect(el.tpHoldWarn.textContent).toContain('あと 40円');
    // ユーザーが幅を 30 に打ち直した → 同じ経路で予告が「すぐ決済」に変わる。
    el.inputScalpTpWidth.value = '30';
    syncTpHoldWarning(el, HOLD);
    expect(el.tpHoldWarn.textContent).toContain('すぐに成行で決済されます');
    // 保有が無くなったら消える。
    syncTpHoldWarning(el, null);
    expect(el.tpHoldWarn.hidden).toBe(true);
    expect(el.tpHoldWarn.textContent).toBe('');
  });

  it('SSE の状態から建玉を取り出す: filled のときだけ材料になる', () => {
    const pos = { direction: 'buy' as const, entryPrice: 38000, unrealized: 60 };
    expect(positionFromSignalState({ phase: 'filled', position: pos })).toEqual(pos);
    expect(positionFromSignalState({ phase: 'armed', position: pos })).toBe(null);
    expect(positionFromSignalState({ phase: 'flat' })).toBe(null);
    expect(positionFromSignalState(null)).toBe(null);
  });
});
