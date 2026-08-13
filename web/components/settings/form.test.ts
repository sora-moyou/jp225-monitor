// 設定フォームの往復(サーバ値 → 入力反映 → 保存ペイロード)を検証する。
// ★lite では AIエントリーの一部の行を DOM で隠すが、入力要素そのものは残して同じ保存経路を通す。
//   隠した行の値がサーバから読んだ値のまま往復する(=書き換わらない)ことをここで担保する。

import { describe, it, expect } from 'vitest';
import { applySettingsToForm, buildSavePayload } from './form.js';
import type { SettingsElements, SettingsResponse } from './types.js';

// setKeyStatus が document.getElementById を触るため、最小のスタブを置く(jsdom は導入しない)。
(globalThis as { document?: unknown }).document = { getElementById: () => null };

// 入力要素のスタブ。value/checked/placeholder/disabled/style/innerHTML だけを持つ。
function stub() {
  return { value: '', checked: false, disabled: false, placeholder: '', title: '', innerHTML: '', textContent: '', style: { opacity: '' } };
}
// SettingsElements は数十フィールドあるので、参照されたプロパティだけ遅延生成する Proxy で用意する。
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
  kimiSet: false, geminiSet: true, groqSet: false, openaiSet: true,
  kimiFromEnv: false, geminiFromEnv: false, groqFromEnv: false, openaiFromEnv: false,
  webSearchKeySet: false, webSearchModel: '', webSearchOpenaiModel: '',
  // ★lite で表示する4項目
  scalpLcFloorYen: 50, scalpLcCeilingYen: 70,
  scalpBias: 'long', scalpLcHardMaxEnabled: true, scalpLcHardMaxYen: 140,
  // ★lite で隠す項目(往復で不変であることを確認する対象)
  scalpCooldownSec: 120, scalpTrendVetoYen: 80, scalpRangeEnabled: false,
  dotenEnabled: true, rangeReevalEnabled: false, indicatorsEnabled: false,
  aiTechnicalEnabled: false, scalpChartFallbackText: false,
  scalpLcFloorSource: 'manual', scalpLcCeilingSource: 'manual', scalpTrendVetoSource: 'ai',
  scalpCooldownSource: 'ai', scalpBiasSource: 'manual', scalpRangeSource: 'manual',
  signalB: { scalpLcFloorYen: 33, scalpBias: 'short', scalpCooldownSource: 'ai' },
  pricePollMs: 2000, newsPollMs: 60000, port: 3000, cooldownMin: 15,
  providers: [], configFile: 'x.json',
};

describe('applySettingsToForm → buildSavePayload の往復', () => {
  const el = makeElements();
  applySettingsToForm(el, SERVER);
  const body = buildSavePayload(el);

  it('lite で表示する4項目はサーバ値のまま往復する', () => {
    expect(body.scalpLcFloorYen).toBe(50);
    expect(body.scalpLcCeilingYen).toBe(70);
    expect(body.scalpBias).toBe('long');
    expect(body.scalpLcHardMaxEnabled).toBe(true);
    expect(body.scalpLcHardMaxYen).toBe(140);
  });

  it('★lite で隠す行(トレンドveto/クールダウン/レンジ/ドテン等)の値も壊れず往復する', () => {
    expect(body.scalpCooldownSec).toBe(120);
    expect(body.scalpTrendVetoYen).toBe(80);
    expect(body.scalpRangeEnabled).toBe(false);
    expect(body.dotenEnabled).toBe(true);
    expect(body.rangeReevalEnabled).toBe(false);
    expect(body.indicatorsEnabled).toBe(false);
    expect(body.aiTechnicalEnabled).toBe(false);
    expect(body.scalpChartFallbackText).toBe(false);
  });

  // ★初期LC下限は委任対象外(モード select が無い)。保存では常に 'manual' へ正規化する
  //   =過去に 'ai' が保存されていても、書き出しの knob スナップショットが「委任」と嘘をつかない。
  it('★初期LC下限の source は常に manual を送る(委任対象外)/ B は A追従(空)', () => {
    expect(body.scalpLcFloorSource).toBe('manual');
    expect((body.signalB as Record<string, unknown>).scalpLcFloorSource).toBe('');
  });

  it('★lite で隠す委任 source(A) と System B(仮想取引専用) の設定も壊れず往復する', () => {
    expect(body.scalpTrendVetoSource).toBe('ai');
    expect(body.scalpCooldownSource).toBe('ai');
    expect(body.scalpBiasSource).toBe('manual');
    expect(body.signalB).toMatchObject({
      scalpLcFloorYen: 33, scalpBias: 'short', scalpCooldownSource: 'ai',
      scalpLcCeilingYen: null, scalpBiasSource: '',   // 未設定は A追従のまま
    });
  });
});

// ★委任(AI)に切り替えても、初期LC下限の値入力は編集可のままであること。
//   下限はモードに関係なくコードが必ず強制する(server/llm/scalpPlan.ts lcLegBelowFloor)ので、
//   「委任したから灰色」は実態と正反対の表示だった。最大初期LC(委任できる項目)は従来どおり灰色になる。
describe('AI委任と入力の有効/無効', () => {
  it('★どのモードでも初期LC下限は編集可(disabled にならない)/ 最大初期LC は委任で灰色', () => {
    for (const mode of ['manual', 'ai'] as const) {
      const el = makeElements();
      applySettingsToForm(el, { ...SERVER, scalpLcFloorSource: mode, scalpLcCeilingSource: mode });
      expect(el.inputScalpLcFloor.disabled).toBe(false);
      expect(el.inputScalpLcFloorB.disabled).toBe(false);
      expect(el.inputScalpLcCeiling.disabled).toBe(mode === 'ai');
      // 下限の値は常に往復する(編集できる=保存される)。
      expect(buildSavePayload(el).scalpLcFloorYen).toBe(50);
    }
  });
});

// ★API キーの撤回導線。空欄=変更なし(=フィールドごと送らない)の既存の約束は保ったまま、
//   「消去」チェックが入っているときだけ空欄の欄を null で送る(=サーバで未設定に戻る)。
describe('API キーの消去チェック', () => {
  function payloadWith(clear: boolean, gemini: string) {
    const el = makeElements();
    applySettingsToForm(el, SERVER);   // ここで checkKeysClear は必ず false に戻る
    el.inputGemini.value = gemini;
    el.checkKeysClear.checked = clear;
    return buildSavePayload(el);
  }

  it('チェック無し(既定)では空欄のキーは送らない=変更なし(うっかり全消去しない)', () => {
    const body = payloadWith(false, '');
    for (const k of ['geminiKey', 'groqKey', 'kimiKey', 'openaiKey', 'webSearchKey']) {
      expect(k in body).toBe(false);
    }
  });

  it('★チェックすると空欄のキーだけ null で送る(=消去)。入力した欄はその値で保存される', () => {
    const body = payloadWith(true, 'AIza-new');
    expect(body.geminiKey).toBe('AIza-new');
    expect(body.groqKey).toBeNull();
    expect(body.kimiKey).toBeNull();
    expect(body.openaiKey).toBeNull();
    expect(body.webSearchKey).toBeNull();
  });

  it('チェックは設定を読み直すたびに外れる(消去が次の保存へ持ち越されない)', () => {
    const el = makeElements();
    el.checkKeysClear.checked = true;
    applySettingsToForm(el, SERVER);
    expect(el.checkKeysClear.checked).toBe(false);
  });
});
