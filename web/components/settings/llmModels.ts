// ─── LLM プロバイダのモデル欄(⚙️ APIキーの直下) ──────────────────────────────
//
// ★なぜ画面に出すか: モデル名は提供元の都合で廃止/改名され、しかも **キーごとに使えるモデルが違う**
//   (Moonshot の "Not found the model … or Permission denied")。コードに固定していると、
//   その都度アプリをリリースしないと直せない。設定にすれば保存だけで直る。
//
// ★空欄=既定(=従来と同じモデル)。既定値はプレースホルダに出す(空欄の意味が画面で分かる)。
//
// ★要素は id 参照(index.html の model-<provider>)にしている。SettingsElements(main.ts の要素表)に
//   足さないのは、この4欄がキー行にぶら下がる同型の欄で、要素表を膨らませる価値が無いため
//   (キー状態マーク status.ts / setKeyStatus と同じ流儀)。要素が無い環境では静かに何もしない。

import type { SettingsResponse, SavePayload } from './types.js';

export const LLM_MODEL_PROVIDERS = ['gemini', 'groq', 'kimi', 'openai'] as const;
export type LlmModelProvider = typeof LLM_MODEL_PROVIDERS[number];

/** プロバイダ → 保存ペイロードのフィールド名(サーバ側 EXPLICIT_PARAM_KEYS と同名)。 */
const PAYLOAD_KEY = {
  gemini: 'geminiModel', groq: 'groqModel', kimi: 'kimiModel', openai: 'openaiModel',
} as const satisfies Record<LlmModelProvider, keyof SavePayload>;

function modelInput(name: LlmModelProvider): HTMLInputElement | null {
  const el = document.getElementById(`model-${name}`);
  return el && 'value' in el ? (el as HTMLInputElement) : null;
}

/** サーバの現在値をモデル欄へ反映する。value=保存値(空欄=未設定)/ placeholder=既定 / title=実効値。 */
export function applyLlmModelsToForm(current: SettingsResponse | null): void {
  for (const n of LLM_MODEL_PROVIDERS) {
    const el = modelInput(n);
    if (!el) continue;
    el.value = current?.llmModels?.[n] ?? '';
    const def = current?.llmModelDefaults?.[n];
    el.placeholder = def ? `${def} (既定・空欄でOK)` : '空欄で既定';
    const eff = current?.llmModelsEffective?.[n];
    el.title = eff ? `いま実際に使うモデル: ${eff}` : '';
  }
}

/** モデル欄を保存ペイロードへ載せる。可視フィールドなので **常に送る**(空欄='' → サーバで既定に戻る)。
 *  欄が DOM に無いプロバイダは送らない(=変更なし。画面に無い設定を勝手に消さない)。 */
export function collectLlmModels(body: SavePayload): void {
  for (const n of LLM_MODEL_PROVIDERS) {
    const el = modelInput(n);
    if (!el) continue;
    body[PAYLOAD_KEY[n]] = el.value.trim();
  }
}
