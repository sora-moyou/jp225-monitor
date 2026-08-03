import { describe, it, expect, beforeEach } from 'vitest';
import { applyLlmModelsToForm, collectLlmModels, LLM_MODEL_PROVIDERS } from './llmModels.js';
import type { SettingsResponse, SavePayload } from './types.js';

// ─── ★モデル欄がサーバ値と往復する(設定画面から変えられる) ───────────────────
//
// ★否定対照(修正前のコードで赤くなること): 修正前は index.html にモデル欄が無く、
//   llmModels.ts も存在しない。保存ペイロードに <provider>Model は載らない。
//
// DOM は最小スタブ(jsdom は導入しない=既存テストの流儀に合わせる)。

interface FakeInput { value: string; placeholder: string; title: string }
const inputs = new Map<string, FakeInput>();
(globalThis as { document?: unknown }).document = {
  getElementById: (id: string) => inputs.get(id) ?? null,
};

const SERVER = {
  llmModels: { kimi: 'kimi-k2-turbo-preview' },              // 保存値(gemini 等は未設定)
  llmModelsEffective: { kimi: 'kimi-k2-turbo-preview', gemini: 'gemini-flash-latest' },
  llmModelDefaults: { kimi: 'kimi-latest', gemini: 'gemini-flash-latest' },
} as unknown as SettingsResponse;

describe('LLM モデル欄の反映/保存', () => {
  beforeEach(() => {
    inputs.clear();
    for (const n of LLM_MODEL_PROVIDERS) inputs.set(`model-${n}`, { value: '', placeholder: '', title: '' });
  });

  it('保存値を value に、既定を placeholder に出す(空欄の意味が画面で分かる)', () => {
    applyLlmModelsToForm(SERVER);
    expect(inputs.get('model-kimi')!.value).toBe('kimi-k2-turbo-preview');
    expect(inputs.get('model-gemini')!.value).toBe('');                      // 未設定は空欄
    expect(inputs.get('model-kimi')!.placeholder).toContain('kimi-latest');  // 既定を明示
    expect(inputs.get('model-gemini')!.title).toContain('gemini-flash-latest');   // いま使う実効値
  });

  it('★可視フィールドなので常に送る(空欄=既定に戻す)', () => {
    applyLlmModelsToForm(SERVER);
    const body: SavePayload = {};
    collectLlmModels(body);
    expect(body.kimiModel).toBe('kimi-k2-turbo-preview');
    expect(body.geminiModel).toBe('');   // 空欄 → サーバで未設定=既定に戻る
  });

  it('入力を変えると保存ペイロードに乗る(前後空白は落とす)', () => {
    applyLlmModelsToForm(SERVER);
    inputs.get('model-kimi')!.value = '  moonshot-v1-8k  ';
    const body: SavePayload = {};
    collectLlmModels(body);
    expect(body.kimiModel).toBe('moonshot-v1-8k');
  });

  it('欄が DOM に無い(古い画面/部分DOM)ときは何も送らない=既存設定を消さない', () => {
    inputs.clear();
    const body: SavePayload = {};
    expect(() => applyLlmModelsToForm(SERVER)).not.toThrow();
    collectLlmModels(body);
    expect(body.kimiModel).toBeUndefined();
    expect(body.geminiModel).toBeUndefined();
  });

  it('サーバがモデル情報を返さない古い応答でも壊れない', () => {
    expect(() => applyLlmModelsToForm({} as SettingsResponse)).not.toThrow();
    expect(inputs.get('model-kimi')!.value).toBe('');
    expect(inputs.get('model-kimi')!.placeholder).toBe('空欄で既定');
  });
});
