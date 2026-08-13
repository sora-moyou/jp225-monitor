// ★分析用のキー設定 UI: 「今どちらのキーが効いているか」の表示と、保存ペイロードの往復。
//
// この画面の一番の仕事は **専用キーが効いているのか共通キーに落ちているのかが一目で分かること**。
// 専用キーが無いと分析用は黙って共通キーへフォールバックし、ローカルのポーズは分離されるのに
// 上流のクォータは実取引(A)と共有されたまま=「分離したつもりで分離できていない」が無音で成立する。
//
// ★否定対照(修正前のコードでこのテストが赤くなること):
//   修正前は generatorKeys に UI が無く、status.ts に generatorKeyLabel も、form.ts に分析用キーの
//   apply/build も存在しなかった(import 解決ができず collect で落ちる)。文言の規約
//   (shared を「未設定」と書かない)も、保存ペイロードの往復も、どこにも存在しなかった。

import { describe, it, expect } from 'vitest';
import { applySettingsToForm, buildSavePayload } from './form.js';
import { generatorKeyLabel } from './status.js';
import type { SettingsElements, SettingsResponse } from './types.js';

// setKeyStatus / setKeySourceLabel が document.getElementById を触るため最小スタブ(jsdom は導入しない)。
(globalThis as { document?: unknown }).document = { getElementById: () => null };

function stub() {
  return { value: '', checked: false, disabled: false, placeholder: '', title: '', max: '',
    innerHTML: '', textContent: '', style: { opacity: '' } };
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

const BASE: SettingsResponse = {
  kimiSet: false, geminiSet: true, groqSet: false, openaiSet: true,
  kimiFromEnv: false, geminiFromEnv: false, groqFromEnv: false, openaiFromEnv: false,
  webSearchKeySet: false, webSearchModel: '', webSearchOpenaiModel: '',
  scalpLcFloorYen: 45, scalpLcCeilingYen: 65, scalpBias: 'none',
  scalpLcHardMaxEnabled: true, scalpLcHardMaxYen: 150,
  scalpCooldownSec: 90, scalpTrendVetoYen: 100, scalpRangeEnabled: false,
  scalpLcFloorSource: 'manual', scalpLcCeilingSource: 'manual', scalpTrendVetoSource: 'manual',
  scalpCooldownSource: 'manual', scalpBiasSource: 'manual', scalpRangeSource: 'manual',
  pricePollMs: 2000, newsPollMs: 60000, port: 3000, cooldownMin: 15,
  providers: [], configFile: 'x.json',
};

describe('★分析用キーの「どのキーが効いているか」表示', () => {
  it('共通キーへのフォールバックは「共通キーを使用中」と書く(「未設定」と書かない)', () => {
    const l = generatorKeyLabel('shared');
    expect(l.text).toBe('共通キーを使用中');
    expect(l.text).not.toContain('未設定');
    expect(l.shared).toBe(true);
    // ツールチップで「上流クォータは共有」まで伝える(=分離できていないことの明示)。
    expect(l.title).toContain('クォータは共有');
  });

  it('専用キーは「専用キー設定済み」= 分離されていることが分かる', () => {
    expect(generatorKeyLabel('own').text).toBe('専用キー設定済み');
    expect(generatorKeyLabel('own').shared).toBe(false);
    expect(generatorKeyLabel('env').text).toContain('専用キー設定済み');
    expect(generatorKeyLabel('env').shared).toBe(false);
  });

  it('キーそのものが無い場合だけ「未設定」と書く(shared と混ざらない)', () => {
    const l = generatorKeyLabel('none');
    expect(l.text).toContain('未設定');
    expect(l.shared).toBe(false);
    expect(l.mark).not.toBe(generatorKeyLabel('shared').mark);   // マークも見分けが付く
  });

  it('専用キーと共通キーでマークが違う(⚪未設定と読み違えない)', () => {
    expect(generatorKeyLabel('own').mark).toBe('🟢');
    expect(generatorKeyLabel('shared').mark).not.toBe('⚪');
    expect(generatorKeyLabel('shared').mark).not.toBe('🟢');
  });
});

describe('★分析用キー欄の反映と保存ペイロード', () => {
  it('専用キー設定済み/フォールバック中でプレースホルダが変わる', () => {
    const el = makeElements();
    applySettingsToForm(el, { ...BASE, generatorKeySources: { openai: 'own', gemini: 'shared' } });
    expect(el.inputGenOpenai.placeholder).toContain('専用キー設定済み');
    expect(el.inputGenGemini.placeholder).toContain('共通キーを使用');
  });

  it('何も入力しなければ generatorKeys を送らない(=既存の専用キーを消さない)', () => {
    const el = makeElements();
    applySettingsToForm(el, { ...BASE, generatorKeySources: { openai: 'own' } });
    const body = buildSavePayload(el);
    expect(body.generatorKeys).toBeUndefined();
  });

  it('入力したプロバイダだけ送る(他は変更なし)', () => {
    const el = makeElements();
    applySettingsToForm(el, { ...BASE, generatorKeySources: { openai: 'shared', gemini: 'shared' } });
    el.inputGenOpenai.value = '  sk-generator  ';
    const body = buildSavePayload(el);
    expect(body.generatorKeys).toEqual({ openai: 'sk-generator' });
  });

  it('★消去チェックで未入力分を null にして送る(=共通キーの使用へ戻せる)', () => {
    const el = makeElements();
    applySettingsToForm(el, { ...BASE, generatorKeySources: { openai: 'own', gemini: 'own' } });
    el.checkGenKeysClear.checked = true;
    el.inputGenGemini.value = 'AIza-new';   // 入力がある行は消去より入力が優先
    const body = buildSavePayload(el);
    expect(body.generatorKeys).toEqual({ gemini: 'AIza-new', groq: null, openai: null, kimi: null });
  });

  it('反映のたびにキー入力と消去チェックは初期化される(意図しない消去を作らない)', () => {
    const el = makeElements();
    el.inputGenOpenai.value = 'typed-but-not-saved';
    el.checkGenKeysClear.checked = true;
    applySettingsToForm(el, { ...BASE, generatorKeySources: { openai: 'own' } });
    expect(el.inputGenOpenai.value).toBe('');
    expect(el.checkGenKeysClear.checked).toBe(false);
  });

  it('日次予算は実効値を表示し、空欄なら null(既定に戻す)で送る', () => {
    const el = makeElements();
    applySettingsToForm(el, { ...BASE, generatorDailyBudget: 800, generatorDailyBudgetDefault: 200, generatorDailyBudgetMax: 5000 });
    expect(el.inputGeneratorBudget.value).toBe('800');
    expect(el.inputGeneratorBudget.placeholder).toBe('200 (既定)');
    expect(el.inputGeneratorBudget.max).toBe('5000');
    expect(buildSavePayload(el).generatorDailyBudget).toBe(800);
    el.inputGeneratorBudget.value = '';
    expect(buildSavePayload(el).generatorDailyBudget).toBeNull();
    el.inputGeneratorBudget.value = '0';   // 0=分析用を無効化(既定に戻すではない)
    expect(buildSavePayload(el).generatorDailyBudget).toBe(0);
  });
});
