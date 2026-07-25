import OpenAI from 'openai';
import { LLM_PROVIDERS } from '../config.js';
import type { LLMProvider } from '../config.js';
import { resolveApiKey } from '../configStore.js';

interface ProviderState {
  config: LLMProvider;
  client: OpenAI | null;
  circuitOpenUntil: number;
  consecutiveFails: number;
  lastFailAt: number;
}

const PAUSE_LADDER_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 8 * 3600_000];
const CONSECUTIVE_WINDOW_MS = 10 * 60_000;
// 一過性エラー(5xx / タイムアウト / ネットワーク)の短時間ポーズ。429(quota)の長い ladder とは別扱い:
// 503 等はすぐ復帰するので、そのプロバイダを少しだけ休ませて次に回す(8時間も止めない)。
const TRANSIENT_PAUSE_MS = 30_000;

/** LLM エラーを分類。'quota'=429/枯渇(長 ladder), 'oversize'=413/コンテキスト超過(ポーズせず次へ),
 *  'transient'=5xx/timeout/network(短ポーズ),
 *  null=恒久/設定エラー(401/404 等=フォールバックせず即 throw=誤設定を隠さない)。
 *  quota/oversize/transient はいずれも「次プロバイダへフォールバック」する(1つが落ちても他で継続)。 */
export function classifyLLMError(msg: string): 'quota' | 'oversize' | 'transient' | null {
  if (/429|rate[_ ]limit|exhausted|quota/i.test(msg)) return 'quota';
  // 413=単一リクエストがそのモデルの上限(TPM/コンテキスト長)を超過。ペーシングでは直らない=
  // 「そのモデルでは絶対に通らない」ので、より大きいモデル(openai/gemini)へフォールバックする。
  // (Groq on_demand tier の "Request too large ... TPM Limit" が本番の主因。)
  if (/\b413\b|request too large|context length|maximum context|too many tokens|reduce the (?:length|size)/i.test(msg)) return 'oversize';
  if (/\b50[0-4]\b|\b52\d\b|timeout|timed out|aborted|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|overloaded|temporarily unavailable/i.test(msg)) return 'transient';
  return null;
}

function buildProvider(config: LLMProvider): ProviderState {
  const name = config.name as 'gemini' | 'groq' | 'openai' | 'kimi';
  const key = resolveApiKey(name);
  const isPlaceholder = !key || key.includes('your-key');
  return {
    config,
    client: !isPlaceholder ? new OpenAI({ apiKey: key, baseURL: config.baseURL }) : null,
    circuitOpenUntil: 0,
    consecutiveFails: 0,
    lastFailAt: 0,
  };
}

let providers: ProviderState[] = LLM_PROVIDERS.map(buildProvider);
logEnabled();

function logEnabled(): void {
  const enabled = providers.filter(p => p.client !== null).map(p => p.config.name);
  console.log(`[LLM] enabled providers: ${enabled.join(', ') || '(none)'}`);
}

// 設定保存後に呼んでクライアントを差し替える
export function reloadProviders(): void {
  providers = LLM_PROVIDERS.map(buildProvider);
  logEnabled();
}

export function isLLMEnabled(): boolean {
  return providers.some(p => p.client !== null);
}

export function getProviderStatus() {
  return providers.map(p => ({
    name: p.config.name,
    enabled: p.client !== null,
    paused: Date.now() < p.circuitOpenUntil,
    pausedUntil: p.circuitOpenUntil,
  }));
}

function isAvailable(p: ProviderState): boolean {
  return p.client !== null && Date.now() >= p.circuitOpenUntil;
}

// ─── APIキーの実効性テスト(ライブ ping) ───
// 「設定済み(=キー文字列がある)」と「実際に有効(=そのキーで叩ける)」は別問題なので、
// プロバイダごとに1トークンだけの極小 chat リクエストを投げてキーの有効性を確認する。
// 検知/アラート/チャットのロジックには一切触れない、設定画面専用の診断機能。
export interface KeyTestResult { name: string; ok: boolean; notset?: boolean; error?: string; }

/** client を持つプロバイダ状態に対し、1トークンの ping を投げて有効性を判定する(テスト可能な純ヘルパ)。
 *  client が無ければ notset。成功で ok:true。失敗はエラーメッセージ(300字まで)を返す。 */
export async function testProviderState(
  p: { config: LLMProvider; client: OpenAI | null } | undefined,
  name: string,
): Promise<KeyTestResult> {
  if (!p || !p.client) return { name, ok: false, notset: true };   // キー未設定/プレースホルダ
  try {
    await p.client.chat.completions.create({
      model: p.config.chatModel,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });
    return { name, ok: true };
  } catch (e) {
    return { name, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

/** 指定プロバイダのキーが実際に有効か、1トークンの ping で確認する。キー未設定は notset。 */
export async function testProvider(name: string): Promise<KeyTestResult> {
  return testProviderState(providers.find(x => x.config.name === name), name);
}

/** 全プロバイダのキー有効性を並列に ping で確認する(LLM_PROVIDERS 順)。各プロバイダ1トークン消費。 */
export async function testAllProviders(): Promise<KeyTestResult[]> {
  return Promise.all(LLM_PROVIDERS.map(cfg => testProvider(cfg.name)));
}

// ─── ビジョン(チャート画像入力)対応判定 ───
// Gemini(OpenAI 互換エンドポイント)と OpenAI(gpt-4o 系)はマルチモーダル対応。
// Groq(llama-3.3-70b, テキスト専用)は非対応。プロバイダ名で判定する(chatModel も参照)。
const VISION_PROVIDERS = new Set(['gemini', 'openai']);

/** プロバイダ名(+チャットモデル)がチャート画像入力に対応するか。テキスト専用(groq)は false。 */
export function isVisionCapableProvider(name: string, chatModel = ''): boolean {
  if (!VISION_PROVIDERS.has(name)) return false;
  // モデル名に画像非対応が明示されていれば除外(将来のモデル差し替え対策)。
  if (/text-only|-tts|whisper|embedding/i.test(chatModel)) return false;
  return true;
}

/** 現在「利用可能(キーあり・非ポーズ)」で、かつビジョン対応の先頭プロバイダ名。無ければ null。
 *  scalp-plan が「画像を撮るべきか」を事前判断するために使う(callWithFallback の選択順と同じ優先順)。 */
export function firstAvailableVisionProvider(): { name: string; chatModel: string } | null {
  for (const p of providers) {
    if (!isAvailable(p)) continue;
    if (isVisionCapableProvider(p.config.name, p.config.chatModel)) {
      return { name: p.config.name, chatModel: p.config.chatModel };
    }
  }
  return null;
}

// エラーに応じてプロバイダを一時停止し「次へフォールバックすべきか」を返す。
//   quota(429)      → 連続回数に応じた長い ladder(枠回復まで待つ)+ フォールバック
//   oversize(413)   → ポーズ無し + フォールバック(この要求だけが上限超過。小さい要求は通り続ける)
//   transient(5xx等)→ 短い固定ポーズ(すぐ復帰想定)+ フォールバック
//   それ以外(401/404)→ false(=フォールバックせず即 throw。誤設定を握り潰さない)
function tripCircuit(p: ProviderState, err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const kind = classifyLLMError(msg);
  if (!kind) return false;
  const now = Date.now();
  if (kind === 'oversize') {
    // この要求だけがモデル上限(TPM/コンテキスト)を超過。プロバイダ自体は健全なので
    // ポーズしない(小さい chat/explain は同プロバイダで通り続ける)。より大きいモデルへ流すだけ。
    console.warn(`[LLM:${p.config.name}] oversize (${msg.slice(0, 60)}) — ポーズせず次(大きいモデル)へフォールバック`);
    return true;
  }
  if (kind === 'quota') {
    if (now - p.lastFailAt < CONSECUTIVE_WINDOW_MS) {
      p.consecutiveFails = Math.min(p.consecutiveFails + 1, PAUSE_LADDER_MS.length - 1);
    } else {
      p.consecutiveFails = 0;
    }
    p.lastFailAt = now;
    const pause = PAUSE_LADDER_MS[p.consecutiveFails]!;
    p.circuitOpenUntil = now + pause;
    const human = pause < 90_000 ? `${Math.round(pause / 1000)}s` : `${Math.round(pause / 60_000)}min`;
    console.warn(`[LLM:${p.config.name}] 429 #${p.consecutiveFails + 1} — paused for ${human}`);
  } else {
    // 一過性: ladder を進めず短時間だけ休ませる(枠切れと違い恒久化させない)。
    p.lastFailAt = now;
    p.circuitOpenUntil = now + TRANSIENT_PAUSE_MS;
    console.warn(`[LLM:${p.config.name}] transient (${msg.slice(0, 60)}) — paused ${Math.round(TRANSIENT_PAUSE_MS / 1000)}s → 次へフォールバック`);
  }
  return true;
}

function recordSuccess(p: ProviderState): void {
  if (p.consecutiveFails > 0) {
    console.log(`[LLM:${p.config.name}] success — circuit reset`);
    p.consecutiveFails = 0;
  }
}

// プロバイダを順に試して、最初に成功したものの応答を返す
export async function callWithFallback(
  task: (p: ProviderState) => Promise<string>,
  label: string,
): Promise<string> {
  const enabled = providers.filter(p => p.client !== null);
  if (enabled.length === 0) return '(LLM disabled — APIキーが未設定です。右上⚙️から設定してください)';
  const available = enabled.filter(isAvailable);
  if (available.length === 0) {
    const next = enabled.map(p => p.circuitOpenUntil).sort((a, b) => a - b)[0]!;
    const waitSec = Math.max(0, Math.round((next - Date.now()) / 1000));
    throw new Error(`429 (all providers paused, retry in ${waitSec}s)`);
  }
  let lastErr: unknown = null;
  for (const p of available) {
    try {
      const text = await task(p);
      recordSuccess(p);
      return text;
    } catch (err) {
      const tripped = tripCircuit(p, err);
      if (tripped) {
        console.warn(`[LLM] ${label}: ${p.config.name} failed → trying next`);
        lastErr = err;
        continue;
      }
      // 429以外のエラーは再投げ (キー無効など)
      throw err;
    }
  }
  // 全プロバイダが429だった
  throw lastErr ?? new Error('all providers failed');
}
