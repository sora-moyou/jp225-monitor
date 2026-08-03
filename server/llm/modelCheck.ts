// ─── 「キーを検証」の中身: キーが有効か / そのキーで **設定中のモデルが使えるか** ──────────
//
// ★なぜ作ったか(症状):
//     kimi: 404 Not found the model kimi-latest or Permission denied
//   従来の検証は 1トークンの chat ping で ✅/❌ を返すだけだったので、この 404 が
//   「キーが無効」なのか「そのキーにそのモデルの権限が無い」のか **画面から区別できなかった**。
//   区別できないと打つ手が決まらず、こちらでモデル名を選び直して**リリース**する、を繰り返すことになる
//   (kimi-k2-0905-preview → kimi-latest で2回)。しかも Permission denied はキーごとに違うので、
//   こちらが選び直しても当たるとは限らない。
//
// ★やり方: OpenAI 互換 API の `GET /v1/models` を使う。**トークンを消費しない**うえ、
//   - 呼べた            → キーは有効
//   - 一覧に設定中のモデルがある → そのモデルが使える
//   - 無い              → 「使えるモデルはこれ」と一覧を提示できる(=次の一手が決まる)
//   401/403(や Google の "API key not valid")なら、モデル以前にキーが無効。
//
// ★一覧が取れないプロバイダ/経路のために、**従来の 1トークン ping へフォールバック**する
//   (/v1/models 非対応でも、従来と同じ ✅/❌ は必ず出る=検証機能が退化しない)。
//   ping の実装は providers.ts の testProviderState が SSOT(ここには複製しない)。

import OpenAI from 'openai';
import { LLM_PROVIDERS, DEFAULT_LLM_MODELS, type LLMProvider } from '../config.js';
import { resolveApiKeyForPool } from '../configStore.js';
import { DEFAULT_CALLER, type LlmCaller } from './caller.js';
import { isAnalysisEnabled } from '../analysisGate.js';
import { testProviderState, type KeyTestResult } from './providers.js';

/** 判定の理由。画面はこれを見て文言を変える(「404」で終わらせないため)。
 *  'ok'=モデルまで確認済 / 'key'=キーが無効 / 'model'=キーは有効だがモデルが使えない /
 *  'unknown'=一覧が取れず ping でも失敗(理由不明) */
export type ProviderCheckReason = 'ok' | 'key' | 'model' | 'unknown';

export interface ProviderModelCheck extends KeyTestResult {
  /** 実際に使われるモデル名(config の <provider>Model → 既定)。 */
  model?: string;
  /** モデル欄が未設定=コードの既定値のままか。 */
  isDefaultModel?: boolean;
  /** キー自体は通ったか(モデル一覧が取れた=有効)。 */
  keyOk?: boolean;
  /** 設定中のモデルがそのキーで使えるか。 */
  modelOk?: boolean;
  /** そのキーで使えるモデル一覧(正規化済み・昇順)。 */
  models?: string[];
  /** models を切り詰めた場合の総数。 */
  modelsTotal?: number;
  reason?: ProviderCheckReason;
  /** 判定に使った経路。'models'=一覧(無料) / 'ping'=1トークンの chat(一覧が取れなかった時のみ)。 */
  via?: 'models' | 'ping';
  /** ping へ落ちた理由(モデル一覧の取得に失敗したときのメッセージ)。 */
  listError?: string;
}

/** 画面へ返すモデル一覧の上限(多すぎる提供元の応答で設定画面を埋めない)。 */
const MAX_MODELS = 120;

/** Gemini の OpenAI 互換エンドポイントは id を "models/gemini-flash-latest" 形式で返す。
 *  設定に書くのは "gemini-flash-latest" なので、両側を同じ形に正規化してから突き合わせる
 *  (これをしないと Gemini が常に「モデルが使えません」と誤報する)。 */
export function normalizeModelId(id: string): string {
  return id.trim().replace(/^models\//, '');
}

/** キーそのものが無効か(モデル以前の問題か)。HTTP ステータス優先、無ければ本文で判定。
 *  ★Google の OpenAI 互換は無効キーを **400 "API key not valid"** で返すことがあるので本文も見る。 */
export function isKeyError(status: number | undefined, msg: string): boolean {
  if (status === 401 || status === 403) return true;
  return /\b40[13]\b|unauthorized|incorrect api key|invalid[_ ]?api[_ ]?key|api key not valid|invalid authentication|authentication[_ ]?error/i
    .test(msg);
}

/** ★エラー本文に API キーらしき文字列が混ざっていたら伏せる。
 *  実測: OpenAI の 401 は `Incorrect API key provided: sk-proj-****…Y9EA` のように
 *  自分のキーを(一部伏せて)エコーバックしてくる。設定画面にそのまま出す必要はないので、
 *  こちらで確実に落としてから返す(画面・ログ・スクショのどれにも残さない)。 */
export function redactSecrets(msg: string): string {
  return msg
    .replace(/\b(sk|gsk|sk-proj|sk-ant)[-_][A-Za-z0-9*_-]{6,}/g, '<キー伏字>')
    .replace(/\bAIza[A-Za-z0-9*_-]{6,}/g, '<キー伏字>');
}

function errMsg(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e));
}

/** モデル一覧を取得して id を正規化・昇順で返す。 */
async function listModelIds(client: OpenAI): Promise<string[]> {
  const page = await client.models.list();
  const data = (page as { data?: Array<{ id?: unknown }> }).data ?? [];
  const ids = data
    .map(m => (typeof m.id === 'string' ? normalizeModelId(m.id) : ''))
    .filter(id => id !== '');
  return [...new Set(ids)].sort();
}

async function checkOne(cfg: LLMProvider, pool: LlmCaller): Promise<ProviderModelCheck> {
  const name = cfg.name;
  const model = cfg.model;   // getter: config の <provider>Model → 既定
  const isDefaultModel = model === DEFAULT_LLM_MODELS[name as keyof typeof DEFAULT_LLM_MODELS];
  const base = { name, model, isDefaultModel };
  // ★公開版(lite)は分析用の generator プールを持たない(providers.ts の poolOf と同じ扱い)=
  //   外部へ1回も出さずに「未設定」と答える。
  if (pool !== DEFAULT_CALLER && !isAnalysisEnabled()) return { ...base, ok: false, notset: true };
  const key = resolveApiKeyForPool(name as 'gemini' | 'groq' | 'openai' | 'kimi', pool);
  // キー未設定/プレースホルダの判定は providers.ts の buildProvider と同じ規則。
  if (!key || key.includes('your-key')) return { ...base, ok: false, notset: true };

  const client = new OpenAI({ apiKey: key, baseURL: cfg.baseURL });
  let ids: string[];
  try {
    ids = await listModelIds(client);
  } catch (e) {
    const msg = errMsg(e);
    const status = (e as { status?: number } | null)?.status;
    if (isKeyError(status, msg)) {
      return { ...base, ok: false, keyOk: false, reason: 'key', via: 'models', error: msg.slice(0, 300) };
    }
    // 一覧が取れない(未対応/一時障害)=判定材料が無いので、従来どおり 1トークンの ping に落ちる。
    const ping = await testProviderState({ config: cfg, client }, name);
    return {
      ...ping, ...base, via: 'ping',
      error: ping.error ? redactSecrets(ping.error) : undefined,
      reason: ping.ok ? 'ok' : 'unknown',
      listError: msg.slice(0, 200),
    };
  }
  const modelOk = ids.includes(normalizeModelId(model));
  return {
    ...base,
    ok: modelOk,
    keyOk: true,
    modelOk,
    models: ids.slice(0, MAX_MODELS),
    modelsTotal: ids.length,
    via: 'models',
    reason: modelOk ? 'ok' : 'model',
    error: modelOk ? undefined : `モデル "${model}" はこのキーでは使えません(一覧 ${ids.length} 件に無し)`,
  };
}

/** 全プロバイダについて「キーは有効か / 設定中のモデルはそのキーで使えるか」を並列に確認する。
 *  引数なしは default プール(実弾 A のキー)。pool='generator' は生成器プールのキー。 */
export async function checkProviderModels(pool: LlmCaller = DEFAULT_CALLER): Promise<ProviderModelCheck[]> {
  return Promise.all(LLM_PROVIDERS.map(cfg => checkOne(cfg, pool)));
}
