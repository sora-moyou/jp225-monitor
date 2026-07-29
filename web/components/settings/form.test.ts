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

  it('★lite で隠す委任 source(A) と System B(紙専用) の設定も壊れず往復する', () => {
    expect(body.scalpTrendVetoSource).toBe('ai');
    expect(body.scalpCooldownSource).toBe('ai');
    expect(body.scalpBiasSource).toBe('manual');
    expect(body.signalB).toMatchObject({
      scalpLcFloorYen: 33, scalpBias: 'short', scalpCooldownSource: 'ai',
      scalpLcCeilingYen: null, scalpBiasSource: '',   // 未設定は A追従のまま
    });
  });
});
