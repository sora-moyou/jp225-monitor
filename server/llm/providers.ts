import OpenAI from 'openai';
import { LLM_PROVIDERS } from '../config.js';
import type { LLMProvider } from '../config.js';
import { resolveApiKeyForPool, resolveGeneratorKeySource } from '../configStore.js';
import type { GeneratorKeySource, GeneratorProviderName } from '../configStore.js';
import { DEFAULT_CALLER, type LlmCaller } from './caller.js';
import { notifyDefaultQuota } from './generatorGate.js';
import { isAnalysisEnabled } from '../analysisGate.js';
import { sanitizeErrorForOutput, stripParsedInputSnippet } from './redact.js';
// ★V8 断片の除去は redact.ts(葉モジュール)へ移した: ログと HTTP 応答の両方で同じ規則・
//   同じ順序を使うため。ここからの再エクスポートは維持する(既存の import 元は不変)。
export { stripParsedInputSnippet };

// ─── プロバイダ状態は「プール別」(default / generator) ───────────────────
//
// ★以前はモジュール単位のシングルトン(`let providers = LLM_PROVIDERS.map(buildProvider)`)で、
//   プロセス内の全呼び出し元が circuitOpenUntil を共有していた。そのため
//   **分析用の実験系が 429 を踏むと、実弾(A)の経路が PAUSE_LADDER の最大 8 時間まで止まる**。
//   別プロセス化しても解決しない(/api/scalp-plan の LLM 呼び出しは monitor のプロセス内で起きる)。
//
// そこで状態を LlmCaller をキーにしたプールへ分ける。プールは
//   - **それぞれ独立した circuitOpenUntil / consecutiveFails / lastFailAt** を持つ
//   - **プール別に API キーを解決する**(resolveApiKeyForPool)。今は generator 用キー未設定なら
//     共通キーへフォールバックするので挙動は同じだが、キーを入れるだけで上流クォータまで分離できる。
//
// ★default の不変性の担保:
//   - default プールは従来どおり **モジュール読み込み時に1回だけ**構築し、同じ1行をログする。
//   - generator プールは **遅延構築**(初めて generator が呼ばれた時)。使わなければ存在しない。
//   - 引数を増やした公開関数はすべて **既定値 'default'**。既存の呼び出し側は無改変で同じ経路を通る。
type PoolKey = LlmCaller;

interface ProviderState {
  config: LLMProvider;
  client: OpenAI | null;
  circuitOpenUntil: number;
  consecutiveFails: number;
  lastFailAt: number;
  /** この状態がどのプールのものか。ログの体裁と ★従属規則の発火判定に使う。 */
  pool: PoolKey;
}

const PAUSE_LADDER_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 8 * 3600_000];
const CONSECUTIVE_WINDOW_MS = 10 * 60_000;
// 一過性エラー(5xx / タイムアウト / ネットワーク)の短時間ポーズ。429(quota)の長い ladder とは別扱い:
// 503 等はすぐ復帰するので、そのプロバイダを少しだけ休ませて次に回す(8時間も止めない)。
const TRANSIENT_PAUSE_MS = 30_000;

/** LLM エラーを分類。'quota'=429/枯渇(長 ladder), 'oversize'=413/コンテキスト超過(ポーズせず次へ),
 *  'transient'=5xx/timeout/network(短ポーズ), 'config'=401/403/404・モデル不明/権限/キー無効(★長ポーズして次へ),
 *  null=その他(即 throw)。quota/oversize/transient/config はいずれも「次プロバイダへフォールバック」する。 */
export function classifyLLMError(msg: string): 'quota' | 'oversize' | 'transient' | 'config' | null {
  if (/429|rate[_ ]limit|exhausted|quota/i.test(msg)) return 'quota';
  // 413=単一リクエストがそのモデルの上限(TPM/コンテキスト長)を超過。ペーシングでは直らない=
  // 「そのモデルでは絶対に通らない」ので、より大きいモデル(openai/gemini)へフォールバックする。
  // (Groq on_demand tier の "Request too large ... TPM Limit" が本番の主因。)
  if (/\b413\b|request too large|context length|maximum context|too many tokens|reduce the (?:length|size)/i.test(msg)) return 'oversize';
  if (/\b50[0-4]\b|\b52\d\b|timeout|timed out|aborted|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|overloaded|temporarily unavailable/i.test(msg)) return 'transient';
  // ★config(2026-07-28で null→フォールバック化): 401/403(キー無効/権限)・404(モデル不明)等。そのプロバイダは
  //   設定不備で使えない=長くポーズして**次へフォールバック**する(1プロバイダの誤設定で全滅させない=Kimi 404で
  //   連鎖が壊れ news 説明が全滅した事故対策)。誤設定はログ+⚙️「キーを検証」で可視化されるので隠蔽にならない。
  if (/\b40[134]\b|not found the model|permission denied|incorrect api key|invalid[_ ].*api|no such model|unauthorized|model.*not.*(?:found|exist)/i.test(msg)) return 'config';
  return null;
}

function buildProvider(config: LLMProvider, pool: PoolKey): ProviderState {
  const name = config.name as 'gemini' | 'groq' | 'openai' | 'kimi';
  const key = resolveApiKeyForPool(name, pool);
  const isPlaceholder = !key || key.includes('your-key');
  return {
    config,
    client: !isPlaceholder ? new OpenAI({ apiKey: key, baseURL: config.baseURL }) : null,
    circuitOpenUntil: 0,
    consecutiveFails: 0,
    lastFailAt: 0,
    pool,
  };
}

/** プール別のプロバイダ状態。default は起動時に構築、generator は初回利用時に遅延構築する。 */
const pools = new Map<PoolKey, ProviderState[]>();

function buildPool(pool: PoolKey): ProviderState[] {
  return LLM_PROVIDERS.map(c => buildProvider(c, pool));
}

/** プールを取得(未構築なら構築)。default は必ず構築済みなので遅延ログは出ない=起動ログは従来と同一。
 *  ★公開版(lite)では **分析用の generator プールを構築しない**(2つ目の API キーを持たない)。
 *    空配列を返すと callWithFallback は「キー未設定」と同じ扱いになり、外部へは1回も出ない。
 *    full では isAnalysisEnabled()===true なのでこの分岐は無く、挙動は従来と完全に同一。 */
function poolOf(pool: PoolKey): ProviderState[] {
  if (pool !== DEFAULT_CALLER && !isAnalysisEnabled()) return [];
  let s = pools.get(pool);
  if (!s) {
    s = buildPool(pool);
    pools.set(pool, s);
    logEnabled(pool);
  }
  return s;
}

pools.set(DEFAULT_CALLER, buildPool(DEFAULT_CALLER));
logEnabled(DEFAULT_CALLER);

/** 有効プロバイダのログ。★default は従来と **byte 単位で同一の1行**(タグ無し)。 */
function logEnabled(pool: PoolKey = DEFAULT_CALLER): void {
  const enabled = poolProviders(pool).filter(p => p.client !== null).map(p => p.config.name);
  const tag = pool === DEFAULT_CALLER ? '[LLM]' : `[LLM:${pool}]`;
  console.log(`${tag} enabled providers: ${enabled.join(', ') || '(none)'}`);
}

/** ログ用の非構築アクセサ(logEnabled が poolOf を呼ぶと再帰するため分離)。 */
function poolProviders(pool: PoolKey): ProviderState[] {
  return pools.get(pool) ?? [];
}

// 設定保存後に呼んでクライアントを差し替える
export function reloadProviders(): void {
  // ★default は従来どおり即時再構築し、同じ1行をログする(挙動不変)。
  pools.set(DEFAULT_CALLER, buildPool(DEFAULT_CALLER));
  logEnabled(DEFAULT_CALLER);
  // generator プールは破棄するだけ(次に generator が呼ばれた時に新しいキーで遅延再構築される)。
  // 使っていないプールの構築ログを設定保存のたびに出さない。
  pools.delete('generator');
}

export function isLLMEnabled(): boolean {
  return poolOf(DEFAULT_CALLER).some(p => p.client !== null);
}

/** プロバイダ状態(設定/診断画面用)。引数なしは従来どおり **default プール**。 */
export function getProviderStatus(pool: PoolKey = DEFAULT_CALLER) {
  return poolOf(pool).map(p => ({
    name: p.config.name,
    enabled: p.client !== null,
    paused: Date.now() < p.circuitOpenUntil,
    pausedUntil: p.circuitOpenUntil,
  }));
}

function isAvailable(p: ProviderState): boolean {
  return p.client !== null && Date.now() >= p.circuitOpenUntil;
}

/** ログ行の接頭辞(**末尾の空白まで含む**)。
 *  ★default プールでは従来と byte 単位で同一の `[LLM:<name>] `。generator プールだけ `@generator` が付く。
 *    こうしないと「どちらのプールのポーズか」がログから判別できず、事故の切り分けができない。 */
function logPrefix(p: ProviderState): string {
  return p.pool === DEFAULT_CALLER ? `[LLM:${p.config.name}] ` : `[LLM:${p.config.name}@${p.pool}] `;
}

/** ログに載せるエラー本文の長さ上限。
 *  ★240 は「**実文の全体が入る長さ**」ではなく「**診断に要る数値が確実に入る長さ**」。
 *    Groq の 413(稼働機で1日2,500回以上)の要点は `on tokens per minute (TPM): Limit N, Requested M` で、
 *    実文ではモデル名・organization id・service tier の後、おおよそ **137〜200 文字目**に現れる
 *    (id やモデル名の長さで前後する)。従来の 60 文字はモデル名の途中で切れており、
 *    「どれだけ超過したか」が毎回捨てられていた(=打つ手が決まらない)。
 *  ★実文はここで切れて構わない: 実文は `Limit/Requested` の後ろにも続くことが確認されている
 *    (`… please reduce your message size and try again. Need more …`)。240 でも末尾は落ちる。
 *    落としてよい部分(定型の依頼文)と、絶対に残す部分(数値)を分けた値、という位置づけ。
 *  ★この機体の server.log には 60 字で切られた形しか残っていない(=旧実装で捨てられた後の姿)。
 *    実文の続きは同期フォルダ側の記録で確認したもので、ここの数値はその観測に基づく。 */
const ERR_LOG_MAX = 240;

/** ログ用にエラー本文を整形する(純関数)。
 *  ★順序が重要: **伏字 → アプリデータの除去 → 切り詰め**。前二段は sanitizeErrorForOutput が
 *    SSOT(ログと HTTP 応答で同じ規則・同じ順序を使う)。ここが足すのは「切り詰め」だけ。
 *    切ってから伏せると、伏せる前の文字列長で切った結果にキーの断片が残りうる。 */
export function formatErrForLog(msg: string, max: number = ERR_LOG_MAX): string {
  const cleaned = sanitizeErrorForOutput(msg);
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`;
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

/** 指定プロバイダのキーが実際に有効か、1トークンの ping で確認する。キー未設定は notset。
 *  ★引数なしは従来どおり **default プールのキー**を検証する(既存の呼び出し側は無改変で同じ経路)。
 *  ★pool='generator' を渡すと **生成器プールのキー**(専用キー→env→共通キーのフォールバック結果)で
 *    ping する。プールごとに resolveApiKeyForPool でクライアントを組んでいるので、専用キーがある
 *    プロバイダの検証で共通キーを消費することはない。 */
export async function testProvider(name: string, pool: PoolKey = DEFAULT_CALLER): Promise<KeyTestResult> {
  return testProviderState(poolOf(pool).find(x => x.config.name === name), name);
}

/** 全プロバイダのキー有効性を並列に ping で確認する(LLM_PROVIDERS 順)。各プロバイダ1トークン消費。
 *  引数なしは default プール(従来と同一)。 */
export async function testAllProviders(pool: PoolKey = DEFAULT_CALLER): Promise<KeyTestResult[]> {
  return Promise.all(LLM_PROVIDERS.map(cfg => testProvider(cfg.name, pool)));
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
 *  scalp-plan が「画像を撮るべきか」を事前判断するために使う(callWithFallback の選択順と同じ優先順)。
 *  ★プールを指定すると **そのプールの** ポーズ状態で判断する(引数なしは従来どおり default)。
 *    生成器が「default がポーズ中だから撮らない」と誤判断しない/その逆もない、を保つため。 */
export function firstAvailableVisionProvider(pool: PoolKey = DEFAULT_CALLER): { name: string; chatModel: string } | null {
  for (const p of poolOf(pool)) {
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
//   config(401/403/404)→ 長ポーズ(30分)+ フォールバック(誤設定のプロバイダを避けて他で継続)
//
// ★プールの独立性: p は呼び出し元のプールの状態オブジェクトなので、ここでのポーズは **そのプールにしか効かない**。
//   生成器が 429 を踏んでも default プールの circuitOpenUntil は 0 のままで、実弾(A)は止まらない。
function tripCircuit(p: ProviderState, err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const kind = classifyLLMError(msg);
  if (!kind) return false;
  const now = Date.now();
  if (kind === 'oversize') {
    // この要求だけがモデル上限(TPM/コンテキスト)を超過。プロバイダ自体は健全なので
    // ポーズしない(小さい chat/explain は同プロバイダで通り続ける)。より大きいモデルへ流すだけ。
    console.warn(`${logPrefix(p)}oversize (${formatErrForLog(msg)}) — ポーズせず次(大きいモデル)へフォールバック`);
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
    console.warn(`${logPrefix(p)}429 #${p.consecutiveFails + 1} — paused for ${human}`);
    // ★従属規則(作業4-2)の発火点: **default プールが quota を踏んだ瞬間**だけ生成器を止める。
    //   transient(5xx)/config(401/403/404)/oversize(413) では発火しない(枠の枯渇ではない)。
    //   ★停止の長さは **A が実際に入れたポーズ(pause)と同じ**。危険なのは「A がポーズしている間に
    //     生成器が同じ上流を食うこと」なので、危険が続く時間 = A のポーズ時間。ラダーが深くなれば
    //     停止も自動で深くなる(=保護の目的は弱まらない)。旧実装のようにセッションの残り全部は捨てない。
    //   ★default 経路の挙動はこの呼び出しで1ミリも変わらない(このカウンタを読むのは生成器だけ)。
    //   ★2026-08-03 修正: **キーの共有を見る**。生成器がこのプロバイダで専用キー(own/env)を
    //     使っているなら上流クォータは分かれており、A の429は生成器の枠について何も語らない。
    //     判定と「止める/止めない」の決定は generatorGate 側(=生成器の政策が1か所にある)。
    //     ここは事実(どのプロバイダが・どれだけポーズし・生成器のキーはどこ由来か)を渡すだけ。
    if (p.pool === DEFAULT_CALLER) {
      notifyDefaultQuota(p.config.name, now, pause, generatorKeySourceOf(p.config.name),
        generatorKeySourcesAll());
    }
  } else if (kind === 'config') {
    // 設定不備(401/403/404): 再試行しても直らないので長くポーズ(30分)して次へフォールバック。
    //   これで Kimi 404 等の誤設定プロバイダを避けて他プロバイダで継続できる(連鎖全滅を防ぐ)。
    p.lastFailAt = now;
    p.circuitOpenUntil = now + 30 * 60_000;
    console.warn(`${logPrefix(p)}config error (${formatErrForLog(msg)}) — paused 30min → 次へフォールバック(キー/モデルを確認)`);
  } else {
    // 一過性: ladder を進めず短時間だけ休ませる(枠切れと違い恒久化させない)。
    p.lastFailAt = now;
    p.circuitOpenUntil = now + TRANSIENT_PAUSE_MS;
    console.warn(`${logPrefix(p)}transient (${formatErrForLog(msg)}) — paused ${Math.round(TRANSIENT_PAUSE_MS / 1000)}s → 次へフォールバック`);
  }
  return true;
}

/** ★生成器プールが **そのプロバイダで** 実際に使うキーの出どころ(値は返さない)。
 *  従属停止(generatorGate)が「A の429は生成器の枠について語るのか」を判断する唯一の材料。
 *
 *  ★絶対に throw させない: tripCircuit は callWithFallback の catch の **中** で呼ばれるので、
 *    ここで例外が出ると **A が次プロバイダへフォールバックできなくなる**(実弾経路の破壊)。
 *    解決できなかった場合は undefined を返し、generatorGate は従来どおり止める(保護側に倒す)。 */
function generatorKeySourceOf(name: string): GeneratorKeySource | undefined {
  try {
    return resolveGeneratorKeySource(name as GeneratorProviderName);
  } catch (e) {
    console.warn(`[LLM] 生成器キーの出どころを解決できません(${name}): `
      + `${e instanceof Error ? e.message : String(e)} — 共有とみなして従属停止します`);
    return undefined;
  }
}

/** ★生成器が **フォールバックで通りうる全プロバイダ** のキー出どころ(値は返さない)。
 *
 *  なぜ要るか: 従属停止は生成器 **全体** に効くので、守る対象も全体。
 *  「429 を踏んだプロバイダが専用キーだから止めない」だけでは、
 *  gemini=専用 / openai=共有 のときに生成器がフォールバックで共有 openai を食える。
 *  ここは **事実を渡すだけ**(止める/止めないの決定は generatorGate 側=生成器の政策は1か所)。
 *  ★generatorKeySourceOf と同じく絶対に throw しない(A のフォールバック経路を壊さない)。 */
function generatorKeySourcesAll(): Record<string, GeneratorKeySource | undefined> {
  const out: Record<string, GeneratorKeySource | undefined> = {};
  for (const c of LLM_PROVIDERS) out[c.name] = generatorKeySourceOf(c.name);
  return out;
}

function recordSuccess(p: ProviderState): void {
  if (p.consecutiveFails > 0) {
    console.log(`${logPrefix(p)}success — circuit reset`);
    p.consecutiveFails = 0;
  }
}

// プロバイダを順に試して、最初に成功したものの応答を返す
//
// ★caller(=プール)は **既定 'default'**。引数を渡さない既存の呼び出し元(chat/explain/translate/scalp-plan)は
//   従来と完全に同じ default プールを、従来と同じ順序・同じ判定・同じメッセージで使う。
// ★caller='generator' を渡した時だけ generator プールの状態を使う。生成器がここで 429 を積んでも
//   default プールの circuitOpenUntil には触れない=実弾(A)は止まらない。
export async function callWithFallback(
  task: (p: ProviderState) => Promise<string>,
  label: string,
  caller: LlmCaller = DEFAULT_CALLER,
): Promise<string> {
  const enabled = poolOf(caller).filter(p => p.client !== null);
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
