import OpenAI from 'openai';
import type { NewsItem, Price } from '../types.js';
import {
  LLM_PROVIDERS, LLM_SYSTEM_PROMPT,
  NEWS_RECENT_WINDOW_MS, NEWS_RECENCY_DECAY_MIN,
  NEWS_PROXIMITY_TIGHT_MIN, NEWS_PROXIMITY_LOOSE_MIN,
  INSTRUMENT_KEYWORDS, HIGH_IMPACT_KEYWORDS,
  INSTRUMENTS,
} from '../config.js';
import type { LLMProvider } from '../config.js';
import type { Mover } from '../marketSnapshot.js';
import {
  resolveApiKey,
  resolveScalpLcFloorDirective, resolveScalpLcCeilingDirective, resolveScalpTrendVetoDirective,
  resolveScalpBiasDirective, resolveScalpRangeDirective, resolveScalpLcHardMax, resolveScalpCooldownDirective,
  type ScalpBias, type KnobSource,
} from '../configStore.js';
import { tokyoCashOpen } from '../../collector/session.js';
import { isWebSearchEnabled, webSearch } from './webSearch.js';
import { openDb, resolveDbPath, getRecentAlerts, getSessionOHLC, getRecentBars, type AlertRow } from '../db/store.js';
import { rowKind, summarize } from '../alertHistory.js';
import { crashDrawdown } from '../crash.js';
import { getPrices } from '../cache.js';
import { buildExplainInput } from './explainInput.js';
import { noteReferencedNews } from '../shockWindow.js';

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
  const name = config.name as 'gemini' | 'groq' | 'openai';
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
async function callWithFallback(
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

export interface ExplainInput {
  symbol: string;
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: 'magnitude' | 'slope' | 'shock' | 'dtb' | 'granville' | 'break' | 'ma' | 'swingdtb'
    | 'double' | 'ma_sr' | 'level_sr' | 'pivot' | 'trend' | 'crash';
  direction?: 'up' | 'down';
  change15min: number | null;
  pa15min: { open: number; high: number; low: number; current: number } | null;
  range1h: { high: number; low: number } | null;
  news: NewsItem[];
  crossAsset?: Mover[];
  newsSince?: number;     // ①: これ以降のニュースのみ参照(直前の急変以降)。0/未指定=従来の固定窓。
  l2Recent?: string;      // ①: 直近のテクニカル状態(L2シグナル)要約。テクニカル判定時に併記。
  newsWindowMs?: number;  // 暴落(crash)等で参照ニュース窓を広げる(未指定=既定4h)。
}

export function scoreNews(news: NewsItem, keywords: string[], now: number): number {
  const title = news.title.toLowerCase();
  let kwHits = 0;
  for (const kw of keywords) if (title.includes(kw.toLowerCase())) kwHits++;
  let highImpactHits = 0;
  for (const kw of HIGH_IMPACT_KEYWORDS) if (title.includes(kw.toLowerCase())) highImpactHits++;
  const ageMin = (now - news.publishedAt) / 60000;
  const recency = Math.max(0, 1 - ageMin / NEWS_RECENCY_DECAY_MIN);
  return kwHits * 2 + highImpactHits * 6 + recency;
}

// 急変近接プール選別 (v0.3.9)
// 4h 全体から拾うと「4h 前のキーワード豊富な記事 > 直近の正体不明短文」となり、的外れな引用が増える。
// ±15min → ±60min → 4h の段階フォールバックで、急変直前の材料を最優先する。
export function selectNewsPool(news: NewsItem[], now: number, sinceFloor = 0, windowMs = NEWS_RECENT_WINDOW_MS): NewsItem[] {
  // ①: 直前の急変以降に限定したい場合 sinceFloor を渡す。固定窓と「直前の急変以降」の遅い方を採用。
  // 暴落(crash)等は windowMs を広げて参照(ユーザー指定: ニュース期間を広く)。
  const cutoff = Math.max(now - windowMs, sinceFloor);
  const recent = news.filter(n => n.publishedAt >= cutoff);
  const tightMs = NEWS_PROXIMITY_TIGHT_MIN * 60_000;
  const looseMs = NEWS_PROXIMITY_LOOSE_MIN * 60_000;
  const tight = recent.filter(n => now - n.publishedAt <= tightMs);
  if (tight.length > 0) return tight;
  const loose = recent.filter(n => now - n.publishedAt <= looseMs);
  if (loose.length > 0) return loose;
  return recent;
}

export function formatCrossAsset(movers: Mover[]): string {
  if (movers.length === 0) return '【他資産】同時刻に目立った連動なし。';
  const lines = movers.map(m => {
    const arrow = m.direction === 'up' ? '▲' : '▼';
    const win = m.windowSeconds >= 300 ? '5分' : '1分';
    const sign = m.changePercent >= 0 ? '+' : '';
    return `- ${m.label} ${arrow} ${sign}${m.changePercent.toFixed(2)}% (${win}, z=${m.z.toFixed(1)})`;
  });
  return `【同時刻に大きく動いた他資産(z>=4.0)】\n${lines.join('\n')}`;
}

function rankAndFormatNews(pool: NewsItem[], symbol: string, now: number): string {
  const keywords = INSTRUMENT_KEYWORDS[symbol] ?? [];
  const ranked = [...pool]
    .map(n => ({ n, s: scoreNews(n, keywords, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map(x => x.n);
  if (ranked.length === 0) return '(直近4時間のニュース取得なし)';
  return ranked.map(n => {
    const ageMin = Math.max(0, Math.round((now - n.publishedAt) / 60000));
    return `- [${ageMin}分前] [${n.source}] ${n.title}`;
  }).join('\n');
}

export async function explain(input: ExplainInput): Promise<{ text: string; newsMaxPublishedAt: number }> {
  const now = Date.now();
  // ①: 参照プールを一度だけ確定し、実提示ニュースの最大 publishedAt を呼び出し側へ返す(アンカー前進用)。
  const pool = selectNewsPool(input.news, now, input.newsSince ?? 0, input.newsWindowMs ?? NEWS_RECENT_WINDOW_MS);
  const newsMaxPublishedAt = pool.reduce((m, n) => Math.max(m, n.publishedAt), 0);
  const kindLabel = input.detectionKind === 'slope' ? 'フラッシュ'
    : input.detectionKind === 'shock' ? '急変'
    : input.detectionKind === 'dtb' ? 'ダブル天井/大底'
    : input.detectionKind === 'granville' ? 'グランビル'
    : input.detectionKind === 'break' ? '水準ブレイク'
    : input.detectionKind === 'ma' ? 'MA抜け'
    : input.detectionKind === 'swingdtb' || input.detectionKind === 'double' ? 'ダブル天底'
    : input.detectionKind === 'ma_sr' ? 'MAサポレジ'
    : input.detectionKind === 'level_sr' ? '水準サポレジ'
    : input.detectionKind === 'pivot' ? 'スイング形成'
    : input.detectionKind === 'trend' ? 'トレンド転換'
    : input.detectionKind === 'crash' ? '暴落' : 'トレンド';
  // 方向は direction を真の源とし(dtb は changePercent=0 のため符号では判定不可)、無ければ符号で代替。
  const dir = input.direction ?? (input.changePercent >= 0 ? 'up' : 'down');
  const dirJa = dir === 'up' ? '上昇' : '下落';
  const windowHours = Math.round(NEWS_RECENT_WINDOW_MS / 3600_000);
  const ctx15Line = input.change15min !== null
    ? `【15分変化率】${input.change15min >= 0 ? '+' : ''}${input.change15min.toFixed(2)}%\n`
    : '';
  const pa15Line = input.pa15min
    ? `【15分OHLC】始値 ${fmt(input.pa15min.open)} / 高値 ${fmt(input.pa15min.high)} / 安値 ${fmt(input.pa15min.low)} / 現値 ${fmt(input.pa15min.current)}\n`
    : '';
  const range1hLine = input.range1h
    ? `【1時間レンジ】高値 ${fmt(input.range1h.high)} / 安値 ${fmt(input.range1h.low)}\n`
    : '';
  const dirEmphasis = dir === 'up' ? '⬆ 上昇方向' : '⬇ 下落方向';
  // テクニカル系(dtb/granville/break)は値幅(%)ではなくパターン局面なので、
  // 急変文・ノイズ注記(急変幅判定)を出さない。
  const isTechnicalPattern = input.detectionKind === 'dtb'
    || input.detectionKind === 'granville' || input.detectionKind === 'break'
    || input.detectionKind === 'ma' || input.detectionKind === 'swingdtb'
    || input.detectionKind === 'double' || input.detectionKind === 'ma_sr'
    || input.detectionKind === 'level_sr' || input.detectionKind === 'pivot'
    || input.detectionKind === 'trend';
  const smallMag = !isTechnicalPattern && Math.abs(input.changePercent) <= 0.15;
  const ultraShort = input.detectionKind === 'slope' || input.windowSeconds <= 60;
  const noiseNotes = [
    smallMag ? '※ 急変幅が小さい (≤0.15%)。ノイズの可能性を考慮し、無理に材料を結びつけない。' : '',
    ultraShort ? '※ 超短期(〜1分)の動き。ニュース起因はまれ。同方向に動いた他資産が無ければ短期需給/テクニカルを既定とする。' : '',
  ].filter(Boolean).join('\n');
  // テクニカル系(dtb/granville/break)は「X秒でY%」の急変文ではなく、テクニカル局面として導入する。
  const headline = input.detectionKind === 'crash'
    ? `【暴落】${input.symbolLabel} がセッション高値から ${Math.abs(input.changePercent).toFixed(1)}% 急落しました(${dirEmphasis})。直近の材料を広く確認し、原因(ファンダ/需給/外部要因)を簡潔に。\n`
    : input.detectionKind === 'dtb'
    ? `【${kindLabel}】${input.symbolLabel} が主要な価格水準に ${dirEmphasis}(反転狙い)で接近しました(ダブルトップ/ボトム形成・ネック未達)。\n`
    : isTechnicalPattern
    ? `【${kindLabel}】${input.symbolLabel} がテクニカル局面(${kindLabel})にあります(${dirEmphasis})。\n`
    : `【急変・${kindLabel}】${input.symbolLabel} が ${input.windowSeconds}秒で ${input.changePercent.toFixed(2)}% ${dirJa} (${dirEmphasis}) しました。\n`;
  // ①ファンダ/テクニカル判定: 値動き(急変/フラッシュ)で、直前の急変以降に参照すべきニュースが
  // 1件も無ければ、LLMを呼ばず「テクニカル要因の可能性」と明示し、直近のテクニカル状態(L2)を併記する。
  // ※ 暴落(crash)は重大イベントなので短絡せず、必ず広いニュース窓でLLMに原因を分析させる(ユーザー指定)。
  if (!isTechnicalPattern && input.detectionKind !== 'crash' && pool.length === 0) {
    const l2 = input.l2Recent ? ` 直近のテクニカル状況: ${input.l2Recent}。` : '';
    return { text: `直前の急変以降、該当する材料ニュースなし → テクニカル要因の可能性。${l2}`, newsMaxPublishedAt };
  }
  const oppositeExample = dir === 'down'
    ? '「停戦/地政学リスク後退/利下げ観測/円安/米株高」は株高(⬆)要因なので、下落の説明に使わない'
    : '「地政学緊張・戦闘激化/利上げ・金利上昇/円高/弱い指標/米株安」は株安(⬇)要因なので、上昇の説明に使わない';
  const userPrompt =
    headline +
    (noiseNotes ? noiseNotes + '\n' : '') +
    ctx15Line + pa15Line + range1hLine +
    `\n${formatCrossAsset(input.crossAsset ?? [])}\n` +
    `\n【直近${windowHours}時間のニュース（関連性順、重大マクロは古くても上位）】\n${rankAndFormatNews(pool, input.symbol, now)}\n\n` +
    `[材料の方向(株式の一般則)]\n` +
    `・株高(⬆)要因: 停戦/地政学リスク後退, 利下げ観測, 良い経済指標, 円安, 米株高, リスクオン\n` +
    `・株安(⬇)要因: 地政学緊張・戦闘激化, 利上げ/金利上昇, 悪い経済指標, 円高, 米株安, リスクオフ\n` +
    `[手順]\n` +
    `1) まず「他資産」を見る。${dirEmphasis} と同方向に大きく動いた資産があれば、連動(リスクオン/オフ・金利・為替)として最優先で説明に使う。\n` +
    `2) 次に候補ニュースを上から見て、上の方向則で「その材料の極性」を判定し、${dirEmphasis} と一致するかを必ず確認する。\n` +
    `3) 極性が一致する材料(他資産 or ニュース)だけを選び「○○分前のXX、(方向の根拠)」形式で説明。\n` +
    `4) 極性が逆の材料は絶対に引用しない(例: ${oppositeExample})。一致する材料が無ければ「整合する明確な材料なし、短期需給/テクニカルの可能性」と書く。無理に結びつけない。\n` +
    `5) OHLCで下髭/上髭/サポート反転等が読めれば併記してよい。\n\n` +
    `出力は必ず200文字以内、1〜2文で。矛盾(株高要因で下落を説明する等)は禁止。`;

  const text = await callWithFallback(async (p) => {
    const completion = await p.client!.chat.completions.create({
      model: p.config.model,
      temperature: 0.3,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    const choice = completion.choices[0];
    const t = choice?.message?.content?.trim() ?? '(no response)';
    if (choice?.finish_reason === 'length') {
      console.warn(`[explain:${p.config.name}] TRUNCATED. usage=${JSON.stringify(completion.usage)}`);
      return t + ' …(token切れ)';
    }
    return t;
  }, 'explain');
  return { text, newsMaxPublishedAt };
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(2);
  return n.toFixed(3);
}

// ─── チャット ─────────────────────────────────────────

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }
// v0.3.34: AI に渡す「相関の高い1銘柄」。急変が外部要因(ファンダ)か日経固有(テクニカル)かの切り分け用。
export interface Correlate { label: string; corr: number; samples: number; changePercent: number; }
export interface ChatInput { messages: ChatMessage[]; prices: Price[]; news: NewsItem[]; technical?: string | null; correlate?: Correlate; }

function formatCorrelate(c: Correlate | undefined): string {
  if (!c) return '';
  const sign = c.changePercent >= 0 ? '+' : '';
  const rel = c.corr >= 0 ? '同方向に連動' : '逆方向に連動';
  return `■ 最相関銘柄 (急変要因の切り分け用):\n` +
    `- ${c.label} (日経との相関 ${c.corr.toFixed(2)}, n=${c.samples}, 通常は${rel}) 現在 ${sign}${c.changePercent.toFixed(2)}%\n` +
    `  → この銘柄が相関どおり動いていれば外部(マクロ/ファンダ)要因、動いていなければ日経固有(テクニカル/需給)要因の可能性。`;
}

const LABEL_MAP = new Map(INSTRUMENTS.map(i => [i.symbol as string, i]));

function formatPricesForChat(prices: Price[], now: number): string {
  if (prices.length === 0) return '(価格未取得)';
  const cashOpen = tokyoCashOpen(now);
  return prices.map(p => {
    const meta = LABEL_MAP.get(p.symbol);
    const label = meta?.labelJa ?? p.symbol;
    const sign = p.changePercent >= 0 ? '+' : '';
    // 東証個別株(.T)は 9:00-15:30 のみ取引。場外は前回終値で動かないので「今動いた」材料に誤用させない。
    const tokyoClosed = meta?.category === 'heavyweight' && !cashOpen;
    const staleMark = tokyoClosed ? ' ※東証クローズ中・前回終値(値動きなし)' : (p.stale ? ' (stale)' : '');
    const chgLabel = tokyoClosed ? '前場引け比' : '';
    return `- ${label} ${p.symbol}: ${fmt(p.price)} (${sign}${p.changePercent.toFixed(2)}%${chgLabel ? ' ' + chgLabel : ''})${staleMark}`;
  }).join('\n');
}

/** 文字バイグラム集合(空白・記号除去)。日本語は語分割が無いので2文字シングルで類似を測る。 */
function bigrams(s: string): string[] {
  const c = s.toLowerCase().replace(/[\s、。,.!?？！「」（）()・:：;；'"’”]/g, '');
  const out: string[] = [];
  for (let i = 0; i + 2 <= c.length; i++) out.push(c.slice(i, i + 2));
  return out;
}

export function formatNewsForChat(news: NewsItem[], now: number, queryText = ''): string {
  if (news.length === 0) return '(ニュースなし)';
  // ③: 最新発話と文字バイグラムが重なるニュースを優先。重なりゼロなら直近にフォールバック。
  const qGrams = new Set(bigrams(queryText));
  const scored = news.map(n => {
    const title = n.title.toLowerCase();
    let hits = 0;
    for (const g of qGrams) if (title.includes(g)) hits++;
    return { n, hits };
  });
  const relevant = scored.filter(s => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.n.publishedAt - a.n.publishedAt)
    .slice(0, 12)
    .map(s => s.n);
  const list = relevant.length > 0 ? relevant : news.slice(0, 15);
  return list.map(n => {
    const ageMin = Math.max(0, Math.round((now - n.publishedAt) / 60000));
    return `- [${ageMin}分前] [${n.source}] ${n.title}`;
  }).join('\n');
}

const CHAT_SYSTEM_PROMPT = `あなたは日経先物トレーダー向けの市場分析アシスタントです。
ユーザーから現在の相場や銘柄について質問が来るので、以下の【市場の現状】を踏まえて日本語で簡潔に答えてください。

- 日本語で、結論先出し、簡潔に
- 出力はプレーンテキスト。マークダウンの見出し(#・##・###)や強調(**太字**)は使わない。箇条書きは行頭「*」、見出し的な区切りは記号なしの短い語(例: 上値メド)で示す
- 数字を出すときは現状データから具体的に引用する
- 上値メド・下値メドは「+80円」のような距離ではなく価格(例 67,000円)で示す
- 推測や仮説は「〜と推察される」「〜の可能性が高い」と明示
- 不明な場合は素直に「データなし」と答える
- 銘柄間の連動性、テクニカル要因（サポレジ・ボラ）、ファンダ材料を組み合わせて分析する
- 急変について問われたら、最相関銘柄の動きから「外部(ファンダ)要因か、日経固有(テクニカル/需給)要因か」を必ず一言示す
- 【重要】東証個別株(キーエンス/ファストリ/ディスコ/SMC/東京エレクトロン/ソフトバンクG/キオクシア等の .T 銘柄)は 9:00-15:30 JST のみ取引。それ以外(昼休み・夜間・早朝=先物のNightセッション等)は前回終値で固定され動かない。「※東証クローズ中」の銘柄は、その時点で「今動いた/今の材料」として絶対に引用しない(夜間の日経先物の動きの理由に個別株を持ち出さない)。場中(9:00-15:30)のみ連動材料として扱う
- web_search ツールが使える場合、手元の【市場の現状】で足りない最新の出来事・ニュースは検索して確認し、引用時は「(出典/日時)」を簡潔に添える。手元で足りる時は無理に検索しない`;

const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: '最新の市況・ニュース・出来事を調べる。価格や材料を聞かれて手元のコンテキストに無い/古い時に使う。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '検索クエリ(日本語可)' } }, required: ['query'] },
  },
};
// ─── monitor 自身のデータ参照ツール(外部キー不要・常時有効) ───
const NIKKEI_SYMBOL = 'NIY=F';   // チャット/テクニカルと同じ日経シンボル(config INSTRUMENTS の main)

const EXPLAIN_MOVE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'explain_move',
    description: '直近の急変(急落/急騰)の原因を分析する。「なぜ急落した?」等、値動きの理由を問われたら使う。ニュース近接・他資産連動・極性から原因文を返す。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '銘柄シンボル(省略時は日経 NIY=F)' },
        sinceMinutes: { type: 'number', description: '何分前までの急変を対象にするか(省略時60)' },
      },
    },
  },
};

const QUERY_ALERTS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'query_alerts',
    description: '直近のアラート履歴(暴落/急変/節目抜け/トレンド転換等)と種別別の継続率・戻り率・平均リターンを要約する。「最近どんなアラートが出た?」等に使う。',
    parameters: {
      type: 'object',
      properties: {
        withinMinutes: { type: 'number', description: '何分前までを対象にするか(省略時120)' },
        limit: { type: 'number', description: '最大件数(省略時10)' },
      },
    },
  },
};

const PRICE_HISTORY_TOOL = {
  type: 'function' as const,
  function: {
    name: 'price_history',
    description: '価格履歴を要約する。本日のセッションOHLC(today)か直近N分の値動き(recent)を返す。「本日の高安は?」「直近の値動きは?」等に使う。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '銘柄シンボル(例 NIY=F)' },
        window: { type: 'string', enum: ['today', 'recent'], description: 'today=本日OHLC / recent=直近N分(省略時 today)' },
        minutes: { type: 'number', description: 'recent の対象分数(省略時60)' },
      },
      required: ['symbol'],
    },
  },
};

const MAX_TOOL_ROUNDS = 3;

type CreateFn = (params: Record<string, unknown>) => Promise<any>;
/** ツール名→ハンドラ。引数は JSON.parse 済みオブジェクト。短い説明文字列を返す(例外を投げない)。 */
export type ToolHandlers = Record<string, (args: any) => Promise<string>>;

/** ツール実行ループ。tool_calls が出る限りハンドラへディスパッチ→再投入。上限到達時は tools 無しで最終回答。
 *  テスト可能な純ループ。handlers は tool_call の function.name で引く(未知名は「unknown tool」を返しループ継続)。 */
export async function runChatWithTools(
  create: CreateFn, messages: any[], tools: unknown[], handlers: ToolHandlers, maxRounds = MAX_TOOL_ROUNDS,
): Promise<string> {
  const msgs = [...messages];
  for (let round = 0; round < maxRounds; round++) {
    const completion = await create({ messages: msgs, tools, tool_choice: 'auto' });
    const choice = completion.choices?.[0];
    const msg = choice?.message;
    const calls = msg?.tool_calls;
    if (!calls || calls.length === 0) {
      const text = msg?.content?.trim() ?? '(no response)';
      return choice?.finish_reason === 'length' ? text + ' …(token切れ)' : text;
    }
    msgs.push(msg);
    for (const tc of calls) {
      const name = tc.function?.name ?? '';
      const handler = handlers[name];
      let result: string;
      if (!handler) {
        result = `(unknown tool: ${name || 'unnamed'})`;
      } else {
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch { args = {}; }
        // ハンドラ自身が try/catch する規約だが、二重の安全網としてここでも握る。
        try { result = await handler(args); } catch (e) { result = `(ツール失敗: ${e instanceof Error ? e.message : String(e)})`; }
      }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  // 上限到達: tools 無しで必ず1回答
  const final = await create({ messages: msgs });
  return final.choices?.[0]?.message?.content?.trim() ?? '(no response)';
}

// ─── monitor データ参照: 常時注入ブロック & ツールハンドラ ───

function hhmm(t: number): string {
  return new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
}

/** チャット system prompt に常時注入する monitor データ要約(直近アラート + 本日OHLC)。
 *  DB 不在/データ無しでも例外を投げず、出せるブロックだけ返す(空なら '')。 */
export function buildMonitorContext(now = Date.now()): string {
  const blocks: string[] = [];
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    // 直近アラート(60分以内・最大8件)
    try {
      const recent = getRecentAlerts(db, 8).filter(a => now - a.triggered_at <= 60 * 60_000);
      if (recent.length > 0) {
        const lines = recent.map(a => {
          const arrow = a.direction === 'up' ? '▲' : a.direction === 'down' ? '▼' : '';
          const price = a.price != null ? Math.round(a.price).toLocaleString('ja-JP') : '-';
          return `- ${hhmm(a.triggered_at)} ${rowKind(a.detection_kind, a.window_seconds)} ${arrow} ${price}`;
        });
        blocks.push(`■ 直近アラート(60分以内):\n${lines.join('\n')}`);
      }
    } catch { /* アラート要約は欠落許容 */ }
    // 本日のセッションOHLC(日経 NIY)
    try {
      const s = getSessionOHLC(db, NIKKEI_SYMBOL, 1)[0];
      if (s) {
        blocks.push(`■ 本日の日経(${s.session}): 高値 ${Math.round(s.high).toLocaleString('ja-JP')}(${hhmm(s.highT)}) / `
          + `安値 ${Math.round(s.low).toLocaleString('ja-JP')}(${hhmm(s.lowT)}) / 現値 ${Math.round(s.close).toLocaleString('ja-JP')}`);
      }
    } catch { /* OHLC は欠落許容 */ }
  } catch { /* DB 不在は無視(注入なし) */ }
  finally { try { db?.close(); } catch { /* ignore */ } }
  return blocks.join('\n\n');
}

/** explain_move の入力組立(DB 読みのみ・LLM 非依存=テスト可能)。直近の crash/shock 行、
 *  無ければセッション高値 vs 現在値を crashDrawdown で算出して BuildExplainArgs を返す。該当無しは null。 */
export function resolveExplainMoveArgs(
  db: ReturnType<typeof openDb>, symbol: string, sinceMs: number, now: number,
): import('./explainInput.js').BuildExplainArgs | null {
  const meta = LABEL_MAP.get(symbol);
  const symbolLabel = meta?.labelJa ?? symbol;
  // 1) 直近の crash/shock アラート行を探す(対象シンボル・期間内)
  const row = getRecentAlerts(db, 30).find(a =>
    a.symbol === symbol && (a.detection_kind === 'crash' || a.detection_kind === 'shock')
    && now - a.triggered_at <= sinceMs);
  if (row) {
    return {
      symbol, symbolLabel,
      changePercent: row.change_percent ?? 0,
      windowSeconds: row.window_seconds ?? 60,
      detectionKind: row.detection_kind as ExplainInput['detectionKind'],
      direction: row.direction === 'up' || row.direction === 'down' ? row.direction : undefined,
      change15min: null, pa15min: null, range1h: null,
    };
  }
  // 2) アラート行が無ければセッション高値 vs 現在値を crashDrawdown で算出
  const s = getSessionOHLC(db, symbol, 1)[0];
  const current = getPrices().find(pp => pp.symbol === symbol)?.price ?? s?.close ?? 0;
  if (!s || current <= 0) return null;
  const dd = crashDrawdown(s.high, current);   // 高値からの下落率(0〜1)
  const changePercent = -dd * 100;             // 下落=負
  return {
    symbol, symbolLabel, changePercent, windowSeconds: 300,
    detectionKind: dd >= 0.03 ? 'crash' : 'shock',
    direction: changePercent >= 0 ? 'up' : 'down',
    change15min: null, pa15min: null, range1h: null,
  };
}

/** explain_move: 直近の crash/shock 行(無ければセッション高値 vs 現在値)を特定し explain() で原因文を返す。 */
async function handleExplainMove(args: { symbol?: string; sinceMinutes?: number }): Promise<string> {
  const now = Date.now();
  const symbol = typeof args.symbol === 'string' && args.symbol ? args.symbol : NIKKEI_SYMBOL;
  const sinceMs = (typeof args.sinceMinutes === 'number' && args.sinceMinutes > 0 ? args.sinceMinutes : 60) * 60_000;
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    const moveArgs = resolveExplainMoveArgs(db, symbol, sinceMs, now);
    if (!moveArgs) return '該当する急変データなし。';
    const result = await explain(buildExplainInput(moveArgs));
    if (result.newsMaxPublishedAt > 0) noteReferencedNews(result.newsMaxPublishedAt);
    return result.text;
  } catch (e) {
    return `(原因分析に失敗: ${e instanceof Error ? e.message : String(e)})`;
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** query_alerts: 直近アラート一覧 + 種別別 継続率/戻り率/平均リターンの要約。 */
async function handleQueryAlerts(args: { withinMinutes?: number; limit?: number }): Promise<string> {
  const now = Date.now();
  const withinMs = (typeof args.withinMinutes === 'number' && args.withinMinutes > 0 ? args.withinMinutes : 120) * 60_000;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : 10;
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    const rows: AlertRow[] = getRecentAlerts(db, Math.max(limit, 50)).filter(a => now - a.triggered_at <= withinMs);
    if (rows.length === 0) return `直近${Math.round(withinMs / 60_000)}分のアラートなし。`;
    const list = rows.slice(0, limit).map(a => {
      const arrow = a.direction === 'up' ? '▲' : a.direction === 'down' ? '▼' : '';
      const price = a.price != null ? Math.round(a.price).toLocaleString('ja-JP') : '-';
      return `- ${hhmm(a.triggered_at)} ${rowKind(a.detection_kind, a.window_seconds)} ${arrow} ${price}`;
    });
    const stats = summarize(rows).map(s =>
      `- ${s.label}(${s.count}件): 継続${(s.hitRate * 100).toFixed(0)}% 戻り${(s.revertRate * 100).toFixed(0)}% 15分平均${s.avgRet15 >= 0 ? '+' : ''}${s.avgRet15.toFixed(2)}%`);
    return `直近アラート:\n${list.join('\n')}\n\n種別別統計(15分基準):\n${stats.join('\n')}`;
  } catch (e) {
    return `(アラート照会に失敗: ${e instanceof Error ? e.message : String(e)})`;
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** price_history: 本日OHLC(today)か直近N分(recent)の値動きを要約。 */
async function handlePriceHistory(args: { symbol?: string; window?: 'today' | 'recent'; minutes?: number }): Promise<string> {
  const symbol = typeof args.symbol === 'string' && args.symbol ? args.symbol : NIKKEI_SYMBOL;
  const meta = LABEL_MAP.get(symbol);
  const label = meta?.labelJa ?? symbol;
  const window = args.window === 'recent' ? 'recent' : 'today';
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    if (window === 'today') {
      const s = getSessionOHLC(db, symbol, 1)[0];
      if (!s) return `${label}: 本日のデータなし。`;
      const move = s.open > 0 ? ((s.close - s.open) / s.open) * 100 : 0;
      return `${label} 本日(${s.session}): 始値 ${fmt(s.open)} / 高値 ${fmt(s.high)}(${hhmm(s.highT)}) / `
        + `安値 ${fmt(s.low)}(${hhmm(s.lowT)}) / 現値 ${fmt(s.close)}(始値比 ${move >= 0 ? '+' : ''}${move.toFixed(2)}%)`;
    }
    const minutes = typeof args.minutes === 'number' && args.minutes > 0 ? Math.min(Math.floor(args.minutes), 1440) : 60;
    const bars = getRecentBars(db, symbol, Date.now() - minutes * 60_000);
    if (bars.length === 0) return `${label}: 直近${minutes}分のデータなし。`;
    const open = bars[0]!.o;
    const last = bars[bars.length - 1]!.c;
    let high = -Infinity, low = Infinity;
    for (const b of bars) { if (b.h > high) high = b.h; if (b.l < low) low = b.l; }
    const move = open > 0 ? ((last - open) / open) * 100 : 0;
    return `${label} 直近${minutes}分: 始値 ${fmt(open)} / 高値 ${fmt(high)} / 安値 ${fmt(low)} / `
      + `現値 ${fmt(last)}(${move >= 0 ? '+' : ''}${move.toFixed(2)}%)`;
  } catch (e) {
    return `(価格履歴に失敗: ${e instanceof Error ? e.message : String(e)})`;
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** データツールのハンドラマップ(外部キー不要・常時有効)。 */
export function buildDataToolHandlers(): ToolHandlers {
  return {
    explain_move: handleExplainMove,
    query_alerts: handleQueryAlerts,
    price_history: handlePriceHistory,
  };
}

export async function chat(input: ChatInput): Promise<string> {
  const now = Date.now();
  const lastUser = [...input.messages].reverse().find(m => m.role === 'user')?.content ?? '';
  const monitorCtx = buildMonitorContext(now);
  const systemPrompt =
    `${CHAT_SYSTEM_PROMPT}\n\n` +
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(input.prices, now)}\n\n` +
    (input.technical ? `${input.technical}\n\n` : '') +
    (input.correlate ? `${formatCorrelate(input.correlate)}\n\n` : '') +
    (monitorCtx ? `${monitorCtx}\n\n` : '') +
    `■ 関連ニュース:\n${formatNewsForChat(input.news, now, lastUser)}`;

  // データツール(explain_move/query_alerts/price_history)は外部キー不要ゆえ常時有効。
  // web_search は Gemini グラウンディング用キー(webSearchKey か共通 geminiKey)がある時のみ追加する。
  const tools: unknown[] = [EXPLAIN_MOVE_TOOL, QUERY_ALERTS_TOOL, PRICE_HISTORY_TOOL];
  const handlers: ToolHandlers = buildDataToolHandlers();
  if (isWebSearchEnabled()) {
    tools.push(WEB_SEARCH_TOOL);
    handlers.web_search = async (a: { query?: string }) => {
      const q = typeof a.query === 'string' ? a.query : '';
      return q ? await webSearch(q) : '(クエリ空)';
    };
  }
  return callWithFallback(async (p) => {
    // 8000: スイング分析など長文の途中切れ対策。推論モデルは thinking トークンもこの枠を消費するため余裕を持たせる。
    // 注: 静的オブジェクトに messages が無いと SDK オーバーロード解決で TS2769。as any でキャスト。
    const create: CreateFn = (params) => p.client!.chat.completions.create({
      model: p.config.chatModel, temperature: 0.5, max_tokens: 8000, ...params,
    } as any);
    const baseMessages = [{ role: 'system', content: systemPrompt }, ...input.messages];
    // データツールが常に存在するため、常に tool ループを通す(web_search はキーがある時のみ tools に含まれる)。
    return runChatWithTools(create, baseMessages, tools, handlers);
  }, 'chat');
}

// ─── スキャル計画 (POST /api/scalp-plan) ─────────────────────────────
// 兄弟アプリ jp225-trade2(AI トレーダー)が呼ぶ。monitor の LLM を「固定のスキャル戦略質問」で走らせ、
// buildMonitorContext + データツール(explain_move/query_alerts/price_history/web_search)を使って
// ライブデータに基づく構造化プランを返す。既存の chat と同じプロバイダ選択・キー解決・tool ループを再利用する。

/** レンジ両面ストラドルの1レッグ(実験・紙で別枠計測)。現在値の上/下に1つずつ置く。
 *  side=buy/sell × type=limit(レンジ内逆張り指値)/stop(抜け追随逆指値)。entry=新規価格・stopLoss=初期LC。 */
export interface RangeLeg {
  side: 'buy' | 'sell';
  type: 'limit' | 'stop';
  entry: number;
  stopLoss: number;
}

/** trade2 が受け取る構造化スキャルプラン。
 *  direction==='none' は「見送り(良い場面が無い)」で、価格フィールドは不要(rationale + refPrice のみ)。
 *  direction==='range' は「レンジ両面ストラドル」で、range に上下2レッグ(片レッグ落ちも可)を持つ。 */
export interface AiPlan {
  direction: 'buy' | 'sell' | 'none' | 'range';
  limitEntry?: number;        // 指値(押し目/戻り側の新規)。none/range の時は不要。
  stopEntry?: number;         // 逆指値(ブレイク側の新規)。none/range の時は不要。
  stopLossForLimit?: number;  // 指値約定時の損切り逆指値。none/range の時は不要。
  stopLossForStop?: number;   // 逆指値約定時の損切り逆指値。none/range の時は不要。
  rationale: string;         // 判断理由(日本語)。none の時は見送り理由。
  refPrice: number;          // 計画時に見た現在値(NIY=F)
  // ★AI自己レジーム/確信度(v0.7.54・記録のみ=ゲートには使わない)。AI が「まず自分で相場観を述べてから
  //   計画を出す」ための構造化出力。欠落/不正は undefined(後方互換)。決済時に signal_trades.meta へ保存し、
  //   後で「確信度は勝率と相関するか」「自己regimeは実際と合うか」を実測する。
  regime?: 'trend_up' | 'trend_down' | 'range' | 'unclear';
  confidence?: number;       // 0-100(この計画/レジーム判断への確信度)。
  // direction==='range' の時のみ。upper.entry>refPrice>lower.entry。enforce/parse で片レッグに
  // 落ちることがある(その場合 upper か lower が undefined=実質片面)。
  range?: { upper?: RangeLeg; lower?: RangeLeg };
}

// vetoFired(v0.7.54): buildScalpPlan が enforcePlanConstraints のトレンド veto が発火したかを surface する
//   (挙動は不変=記録のみ)。regime/confidence は plan 側に載る。engine が meta へ保存し A/B 計測に使う。
export type ScalpPlanResult = { ok: true; plan: AiPlan; vetoFired?: boolean } | { ok: false; error: string };

// 初期 LC(損切り)幅の既定レンジ。呼び出し側(trade2)が /api/scalp-plan で lcFloorYen/lcCeilingYen を
// 指定しない時のフォールバック。★v0.7.39: 旧「原則45〜75/上限95」の二段を撤去し、
// 単一上限「45〜65 に収める・65 超は出さない」へ collapse。パラメータで上下限を可変にする。
export const DEFAULT_LC_FLOOR_YEN = 45;
export const DEFAULT_LC_CEILING_YEN = 65;

/** LC 幅の下限/上限を受けてスキャル戦略質問(ユーザー指定・日本語)を生成する。
 *  初期 LC 幅を {floor}〜{ceiling} 円に収め、{ceiling} 円超は出さない(単一上限)。
 *  上限はレッグ独立(v0.7.37)・指値のみ/逆指値のみの回避を保持。 */
export function buildScalpQuestion(
  floorYen: number = DEFAULT_LC_FLOOR_YEN,
  ceilingYen: number = DEFAULT_LC_CEILING_YEN,
  rangeEnabled = true,
  trendVetoYen: number = DEFAULT_TREND_VETO_YEN,
): string {
  // レンジ両面ストラドルの追記(実験・紙で別枠計測)。rangeEnabled=false のときは range を禁止する。
  const rangeNote = rangeEnabled
    ? '⑤明確な方向性が無く、上下に反応帯があるレンジと判断したら direction:"range" で、' +
      '現在値の上と下に1レッグずつ置いてよい(両面ストラドル)。各レッグは side/type/entry/stopLoss。' +
      'レンジ内で逆張りするなら指値(上=売り指値/下=買い指値)、抜けに追随するなら逆指値(上=買い逆指値/下=売り逆指値)。' +
      '上レッグ(upper)の entry は現在値超・下レッグ(lower)の entry は現在値未満。各レッグの初期LCも上限内に収めること。'
    : 'direction は buy/sell/none のみ、range(両面)は出さないこと。';
  return (
    'あなたが考える現在のスキャル戦略を教えてください。' +
    '①最初に買い/売りのどちらかを判断(良い場面が無ければ無理に作らず direction:"none" で見送ってよい) ' +
    '②指値と逆指値の両方の新規注文を作り、先に約定した方で取引します ' +
    '(指値と逆指値は、現在値からそれぞれ少なくとも50円以上離すこと) ' +
    '③それぞれのストップ(逆指値の損切り)を定めてください。ただしストップ幅に5円加えること。' +
    '損切りは必ずエントリーの外側に置く(買いは各エントリーより下・売りは各エントリーより上)。指値レッグの損切りは limitEntry の外側・逆指値レッグの損切りは stopEntry の外側。内側/反対側には置かないこと。' +
    '④この建玉は、利が乗ると段階的に利益を確定し損切りを引き上げる決済方式を使う。' +
    `ゆえに初期の損切り(LC)幅は${floorYen}〜${ceilingYen}円に収め、1回の損切りが積み上げた利益を飛ばさない(コツコツドカンを避ける)。` +
    '損切りは直近の節目/スイングの外側に置き、狭すぎ(往復ビンタ)・広すぎ(ドカン)を避ける。' +
    `${ceilingYen}円を超える損切りは出さない。` +
    `この LC 上限(≤${ceilingYen}円)は、指値レッグ・逆指値レッグ それぞれ独立に満たすこと。` +
    rangeNote +
    '逆指値(ブレイク追随)の新規は現在値/節目から離れるほど LC が広がりやすい。' +
    `逆指値レッグの LC が${ceilingYen}円を超える場合は、(a)逆指値の新規価格を SL 側に近づけて LC≤${ceilingYen} に収めるか、` +
    '(b)逆指値レッグを出さず「指値のみ」で取引する(stopEntry と stopLossForStop を出さない)。' +
    `対称に、指値レッグが構造上どうしても${ceilingYen}円超になるなら、指値レッグを省いて逆指値のみにしてもよい。` +
    `どちらのレッグも${ceilingYen}円超の LC は絶対に出さない。両レッグとも${ceilingYen}円以内に収まらなければ direction:"none" で見送ること。` +
    trendGuidance(trendVetoYen)
  );
}

// トレンド veto の初期閾値[円]。config resolveScalpTrendVetoYen と揃える(0=veto 無効)。
export const DEFAULT_TREND_VETO_YEN = 100;

/** レジーム/トレンド逆行フェードを禁じる補助プロンプト(遵守はコードの enforcePlanConstraints で担保)。
 *  trendVetoYen<=0(=veto 無効)のときは空文字(=注入なし)。 */
function trendGuidance(trendVetoYen: number): string {
  if (!(trendVetoYen > 0)) return '';
  return (
    `『レンジ』は直近10〜30分がほぼ横ばい(±${trendVetoYen}円未満)のときだけと判断すること。` +
    '直近が一方向に強く動いていればレンジではない=トレンド方向の順張り(ブレイク逆指値/押し目・戻りの順張り)か、' +
    'direction:"none" で見送りにする。トレンドに逆行する新規(順トレンドの高値売り/安値買いの戻り売買)は出さない。' +
    '上で渡す『直近の勢い』の数値を必ず判断に使うこと。'
  );
}

// 固定のスキャル戦略質問(既定 LC 幅 45〜65)。プロンプト文言テストや後方互換のための既定インスタンス。
export const SCALP_QUESTION = buildScalpQuestion();

/** LC 幅の下限/上限を受けてスキャルの system prompt を生成する。
 *  ★v0.7.37 のレッグ独立/指値のみ回避、v0.7.38 のギャップ検証済み知見ガードレールを保持。 */
export function buildScalpSystemPrompt(
  floorYen: number = DEFAULT_LC_FLOOR_YEN,
  ceilingYen: number = DEFAULT_LC_CEILING_YEN,
  rangeEnabled = true,
  trendVetoYen: number = DEFAULT_TREND_VETO_YEN,
): string {
  // レンジ両面ストラドル(実験・紙で別枠計測)の指示行。rangeEnabled=false は range を明示禁止する。
  const rangeLine = rangeEnabled
    ? `\n- direction は buy / sell / none / range のいずれか。明確な方向性が無く上下に反応帯があるレンジと判断したら direction:"range" を返してよい(両面ストラドル・実験扱い)。range の時は range.upper / range.lower にそれぞれ side(buy/sell)・type(limit=レンジ内逆張り指値 / stop=抜け追随逆指値)・entry・stopLoss を出す。upper.entry は現在値超・lower.entry は現在値未満。レンジ内逆張りは 上=売り指値 / 下=買い指値、抜け追随は 上=買い逆指値 / 下=売り逆指値。各レッグの初期LCも上限(≤${ceilingYen}円)内に収める。方向性が明確なら従来どおり buy/sell を優先。`
    : `\n- direction は buy / sell / none のみ。range(両面ストラドル)は出さないこと。`;
  return `あなたは日経225先物(NIY=F)のスキャルピングを専門とするトレーダーです。
手元の【市場の現状】(現在価格・テクニカル節目・直近アラート・本日OHLC・ニュース)と、
利用可能なデータツール(explain_move / query_alerts / price_history / web_search)を必要に応じて使い、
現在の相場に対する具体的なスキャルのエントリー計画を1つ立ててください。

制約:
- ★まず自分で現在のレジーム(regime: trend_up=上昇トレンド / trend_down=下降トレンド / range=レンジ / unclear=不明)と、その判断・計画への確信度(confidence: 0〜100)を下し、JSON の regime と confidence に入れてから direction 以下の計画を出すこと(自分の相場観を明示してから計画する)。渡された構造化データ(数値の足/節目/ボラ/スイング/アラート結果/自分の成績)を最優先の根拠にする。
- direction は buy / sell / none のいずれか。良いエントリー場面が無ければ無理にプランを作らず direction:"none"(見送り)を返してよい。その場合 rationale に見送り理由を書き、価格(limitEntry/stopEntry/stopLossForLimit/stopLossForStop)は不要。${rangeLine}
- buy/sell の時: 指値(limitEntry)は押し目買い/戻り売り側の新規、逆指値(stopEntry)はブレイク追随側の新規。原則として両方の価格を出すが、下記のとおり片方だけ(指値のみ/逆指値のみ)でもよい。
- それぞれの約定時の損切り逆指値(stopLossForLimit / stopLossForStop)を出す。損切りは「本来のストップ幅に5円を加えた」水準にする。指値レッグは limitEntry+stopLossForLimit、逆指値レッグは stopEntry+stopLossForStop を対で出す(片方だけは不可)。
- ★【損切りの向き(必須)】損切り(stopLossForLimit / stopLossForStop)は必ずエントリーの外側に置くこと: 買い(long)は各エントリーより下、売り(short)は各エントリーより上。指値レッグの損切りは limitEntry の外側、逆指値レッグの損切りは stopEntry の外側に置く。損切りをエントリーの内側や反対側(買いなのに上・売りなのに下)に置いてはならない(その建玉を保護しない不正なストップになる)。range の各レッグも同様に、buy レッグの stopLoss は entry の下・sell レッグの stopLoss は entry の上に置く。
- この建玉は、利が乗ると段階的に利益を確定し損切りを引き上げる決済方式を使う。ゆえに初期の損切り(LC)幅は${floorYen}〜${ceilingYen}円に収め、1回の損切りが積み上げた利益を飛ばさない(コツコツドカンを避ける)ようにする。損切りは直近の節目/スイングの外側に置き、狭すぎ(往復ビンタ)・広すぎ(ドカン)を避ける。${ceilingYen}円を超える損切りは出さない。
- ★この LC 上限(≤${ceilingYen}円)は 指値レッグ・逆指値レッグ それぞれ独立に 満たすこと。逆指値(ブレイク追随)は現在値/節目から離れるほど LC が広がりやすい。逆指値レッグの LC が${ceilingYen}円を超えるなら、(a)逆指値の新規価格を SL 側に近づけて LC≤${ceilingYen} に収めるか、(b)逆指値レッグを省いて「指値のみ」で取引する(stopEntry / stopLossForStop を出さない=省略)。対称に、指値レッグが構造上${ceilingYen}円超になるなら指値レッグを省いて逆指値のみにしてもよい。どちらのレッグも${ceilingYen}円超の LC は絶対に出さない。両レッグとも収まらなければ direction:"none" で見送る。
- ★【検証済みの知見(9年バックテストで確認・従うこと)】寄り付きギャップ(前セッション終値と当セッション始値の乖離)を主要根拠とする戦略は優位性ゼロと確認済み。「ギャップ埋め狙いの逆張り」「ギャップ反転の追随」「ギャップ継続の追随」いずれも期待値マイナス。よって『ギャップが埋まる/反転する/継続する』を主な根拠にしたエントリーは提案しないこと(該当する局面は他に明確な根拠が無ければ direction:"none" で見送る)。ギャップの大小に方向エッジは無い(大きいギャップほど有利ということはない)。※これはギャップを根拠にした売買を禁じるもので、ギャップと無関係の節目/トレンド/アラート根拠のエントリーは通常どおり可。
- すべての価格は円単位の実数(NIY=F の実値レンジ)で、refPrice(現在値)と整合させる。
- rationale は日本語で判断根拠を簡潔に述べる。${trendVetoYen > 0 ? `
- ★【レジーム/勢い】${trendGuidance(trendVetoYen)}` : ''}`;
}

// 固定のスキャル system prompt(既定 LC 幅 45〜65)。プロンプト文言テストや後方互換のための既定インスタンス。
export const SCALP_SYSTEM_PROMPT = buildScalpSystemPrompt();

/** 各 knob の委任モード。全 knob 'manual'(既定)なら委任ノートは空=プロンプト不変(回帰なし)。 */
export interface KnobModes {
  lcFloor: KnobSource; lcCeiling: KnobSource; trendVeto: KnobSource;
  cooldown: KnobSource; bias: KnobSource; range: KnobSource;
}

/** ★v0.7.56: AI に委任した knob だけ「この値はあなたが決める(自由・根拠を述べよ)」を動的に注入する。
 *  全 knob 手動(既定)なら '' を返す=system prompt は従来と byte 単位で不変。追記(additive)方式で、
 *  ai の knob については上の手動制約文を上書きする旨を明示する(コードの enforce も同時に制約を外す)。 */
export function buildDelegationNote(
  modes: KnobModes,
  ctx: { floorYen: number; ceilingYen: number; hardMax: LcHardMax },
): string {
  // ★AI委任は「制約を外すだけ」でなく、その項目が本来担っていた判断ロジック(狙い・基準・なぜ・使うデータ)を
  //   AI に正確に転写する。そうしないと AI は"意味を知らないまま自由になる"だけになる(=判断が盲目化する)。
  //   ※非公開の phase-exit の具体数値は書かない(公開リポ)。転写は定性的に留める。
  const lines: string[] = [];
  if (modes.lcCeiling === 'ai') {
    const cap = ctx.hardMax.enabled
      ? `ただし実弾の暴走防止として安全上限 ${ctx.hardMax.value}円 だけは絶対に超えないこと。`
      : '';
    lines.push(
      `最大初期LC(損切り幅): あなたが決める。狙い=この建玉は利が乗ると段階的に利確し損切りを引き上げる決済方式のため、` +
      `初期LCは「1回の損切りが積み上げた利益を飛ばさない」幅に収める(コツコツドカン回避)。損切りは直近の節目/スイングの外側に置き、` +
      `広すぎ(ドカン)・狭すぎ(往復ビンタ)を避けて、相場構造から妥当な幅を自分で決め根拠を述べること。上の固定的なLC上限の数値指示は無視してよい。${cap}`,
    );
  }
  if (modes.lcFloor === 'ai') {
    lines.push('初期LC下限: 下限は課さない。ただし狭すぎるLCは往復ビンタで負けやすいので、その点も踏まえて幅を決めること。');
  }
  if (modes.trendVeto === 'ai') {
    lines.push(
      `トレンド/レンジの見極め: 固定の数値閾値は課さない=あなたが判定する。判断ロジック: 直近10〜30分がほぼ横ばいのときだけ「レンジ」とみなし逆張り(フェード指値)してよい。` +
      `直近が一方向に明確に動いていれば「トレンド」であり、それに逆行する新規(順トレンドの高値を売る/安値を買う戻り売買)は出さないこと。` +
      `★根拠: 生きたトレンドをフェードすると負ける(monitorの実データで勝率約2割・9年バックテストでも不利)ことが確認済み。` +
      `上で渡す「直近の勢い(10分/30分の値動き・MA20傾き・直近高安内の位置)」の数値を必ず根拠に使い、regime と confidence を自分で下すこと。` +
      `トレンドなら順張り(押し目/戻りの順張り or ブレイク追随)か direction:"none" で見送りにする。`,
    );
  }
  if (modes.bias === 'ai') {
    lines.push('売買方向(buy/sell): あなたが自由に決めてよい(バイアスの強制なし)。ただし明確な逆行トレンドには逆らわないこと(上のトレンド判断を優先)。');
  }
  if (modes.range === 'ai') {
    lines.push('レンジ両面: 明確な方向性が無く上下に反応帯があると判断すれば range(両面=現在値の上下に指値/逆指値を1本ずつ)を提案してよい。ただしフェード両面は過去に不利だった実績があるため、真に横ばいのときだけに限ること。');
  }
  if (modes.cooldown === 'ai') {
    lines.push('再エントリー: 決済直後でも明確な好機があれば提案してよい(クールダウンの強制なし)。ただし直近で損切りした直後に同じ理由で突入し直すことは避けること。');
  }
  if (lines.length === 0) return '';
  return '\n\n【AI委任(以下の項目はあなたの裁量。上のロジックを踏まえ、必ず根拠を述べること)】\n- ' + lines.join('\n- ');
}

// LLM に構造化 JSON を強制するための出力指示。JSON モード非対応プロバイダでも効くよう厳格な文言で指示し、パースで検証する。
// LC 幅注記に floor/ceiling を反映する(テスト可能なよう export)。
export function scalpJsonInstruction(
  refPrice: number,
  floorYen: number = DEFAULT_LC_FLOOR_YEN,
  ceilingYen: number = DEFAULT_LC_CEILING_YEN,
  rangeEnabled = true,
): string {
  const lcNote = `ストップ幅+5円・LC幅${floorYen}〜${ceilingYen}円・レッグ独立で${ceilingYen}円超は出さない・損切りはエントリーの外側(買いは下/売りは上)`;
  const dirEnum = rangeEnabled ? `"buy" | "sell" | "none" | "range"` : `"buy" | "sell" | "none"`;
  // レンジ両面ストラドルの JSON 形(direction:"range" の時のみ)。数値は円単位の実数。
  const rangeShape = rangeEnabled
    ? `  "range": {                  // direction:"range"(レンジ両面ストラドル)の時のみ。現在値の上下に1レッグずつ\n` +
      `    "upper": { "side": "buy"|"sell", "type": "limit"|"stop", "entry": number, "stopLoss": number },  // entry は現在値超\n` +
      `    "lower": { "side": "buy"|"sell", "type": "limit"|"stop", "entry": number, "stopLoss": number }   // entry は現在値未満\n` +
      `  },\n`
    : '';
  return `最終的な回答は、次のスキーマに厳密に一致する JSON オブジェクトのみを出力してください(前後の説明文・コードフェンス・マークダウンは一切付けない)。\n` +
    `{\n` +
    `  "regime": "trend_up" | "trend_down" | "range" | "unclear",  // まず自分で現在の相場レジームを判定して入れる\n` +
    `  "confidence": number,        // このレジーム判断と計画への確信度(0〜100の整数)\n` +
    `  "direction": ${dirEnum},  // none=見送り(良い場面が無い)。none の時は下の価格4つは不要(rationale と refPrice のみ)${rangeEnabled ? '。range=レンジ両面(range フィールドを使い buy/sell 用の価格4つは不要)' : ''}\n` +
    `  "limitEntry": number,        // 指値(押し目/戻り側の新規)。none/range または指値レッグ不採用(逆指値のみ)の時は省略(stopLossForLimit と対で省く)\n` +
    `  "stopEntry": number,         // 逆指値(ブレイク側の新規)。none/range または逆指値レッグ不採用(指値のみ)の時は省略(stopLossForStop と対で省く)\n` +
    `  "stopLossForLimit": number,  // 指値約定時の損切り逆指値(${lcNote})。指値レッグを出さない/none の時は limitEntry と対で省略\n` +
    `  "stopLossForStop": number,   // 逆指値約定時の損切り逆指値(${lcNote})。逆指値レッグを出さない/none の時は stopEntry と対で省略\n` +
    rangeShape +
    `  "rationale": string,         // 判断理由(日本語)。none の時は見送り理由\n` +
    `  "refPrice": number           // 計画時に見た現在値(${refPrice})\n` +
    `}\n` +
    `refPrice は ${refPrice} を使うこと。数値はすべて円単位の実数(引用符なし)。`;
}

/** レンジ両面ストラドルの1レッグを検証する純関数。side/type の enum・entry/stopLoss の有限性を確認。
 *  不正(型違い・非有限・欠落)なら null。幾何(現在値の上下)の判定は呼び出し側の責務。 */
export function parseRangeLeg(v: unknown): RangeLeg | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.side !== 'buy' && o.side !== 'sell') return null;
  if (o.type !== 'limit' && o.type !== 'stop') return null;
  const entry = typeof o.entry === 'number' && Number.isFinite(o.entry) ? o.entry : null;
  const stopLoss = typeof o.stopLoss === 'number' && Number.isFinite(o.stopLoss) ? o.stopLoss : null;
  if (entry === null || stopLoss === null) return null;
  return { side: o.side, type: o.type, entry, stopLoss };
}

const SCALP_REGIMES = new Set(['trend_up', 'trend_down', 'range', 'unclear']);

/** AI 自己レジームを寛容にパース(enum 外/非文字列は undefined)。記録のみ=後方互換。 */
export function parseAiRegime(v: unknown): AiPlan['regime'] {
  return typeof v === 'string' && SCALP_REGIMES.has(v) ? v as AiPlan['regime'] : undefined;
}

/** AI 確信度を寛容にパース(有限数を 0-100 にクランプ・非有限/非数値は undefined)。記録のみ=後方互換。 */
export function parseAiConfidence(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, v));
}

/** 損切り(stopLoss)がエントリーの正しい外側にあるか(幾何・向き検証)。純関数。
 *  買い(long)は損切りがエントリーの「下」、売り(short)は「上」に置く(建玉を保護する向き)。
 *  境界(stopLoss===entry=幅0)は実質ストップにならないので不正(false)。
 *  ★実害バグ対策: 買いなのに損切りが上(逆側)のプランは trade2 のサニティが拒否し実弾ゼロになる。
 *    発生源(parse/enforce)でこの向きを検証し、違反レッグを落とすことで紙エンジンと実弾を一致させる。 */
export function stopSideOk(side: 'buy' | 'sell', entry: number, stopLoss: number): boolean {
  return side === 'buy' ? stopLoss < entry : stopLoss > entry;
}

/** LLM のテキスト応答から AiPlan を抽出・検証する純関数。refPrice は monitor 側の現在値で必ず上書きする。
 *  コードフェンスや前後の説明文が混じっていても最初の { … } を拾ってパースする。失敗時は { ok:false }。 */
export function parseScalpPlan(raw: string, refPrice: number): ScalpPlanResult {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'empty response' };
  // ```json … ``` を剥がし、最初の { から最後の } までを候補にする。
  const fenced = text.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON object found' };
  let obj: unknown;
  try {
    obj = JSON.parse(fenced.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof obj !== 'object' || obj === null) return { ok: false, error: 'not an object' };
  const o = obj as Record<string, unknown>;
  if (o.direction !== 'buy' && o.direction !== 'sell' && o.direction !== 'none' && o.direction !== 'range') return { ok: false, error: 'invalid direction' };
  const rationale = typeof o.rationale === 'string' ? o.rationale.trim() : '';
  if (!rationale) return { ok: false, error: 'missing rationale' };
  // ★AI自己レジーム/確信度(記録のみ)。寛容にパースし、成立した全 plan(none/range/directional)に載せる。
  //   ゲートには使わない=既存の direction/価格の検証挙動は完全に不変。
  const regime = parseAiRegime(o.regime);
  const confidence = parseAiConfidence(o.confidence);
  const withMeta = (p: AiPlan): AiPlan => {
    if (regime !== undefined) p.regime = regime;
    if (confidence !== undefined) p.confidence = confidence;
    return p;
  };
  // ★見送り(direction:"none"): 価格は不要。rationale + refPrice のみで ok:true の正当な「見送り」応答。
  //   これはエラー(ok:false)ではない=plan-failed とは区別される。
  if (o.direction === 'none') {
    return { ok: true, plan: withMeta({ direction: 'none', rationale, refPrice }) };
  }
  // ★レンジ両面ストラドル(direction:"range"): range.upper / range.lower を各レッグ検証。
  //   幾何(upper.entry>refPrice>lower.entry)を満たさない/壊れているレッグは落とす。片レッグでも残れば range として通す。
  //   両レッグとも無効なら「見送り(none)」として ok:true を返す(エラーにはしない)。
  if (o.direction === 'range') {
    const rangeObj = typeof o.range === 'object' && o.range !== null ? o.range as Record<string, unknown> : {};
    let upper = parseRangeLeg(rangeObj.upper);
    let lower = parseRangeLeg(rangeObj.lower);
    // 現在値の上下の幾何を満たさないレッグは落とす(upper は現在値超・lower は現在値未満)。
    if (upper && !(upper.entry > refPrice)) upper = null;
    if (lower && !(lower.entry < refPrice)) lower = null;
    // ★損切りの向き検証: 各レッグは自分の side を持つ → buy レッグは stopLoss<entry・sell レッグは stopLoss>entry。
    //   内側/反対側(境界=幅0 も)の損切りを持つレッグは落とす(不正プランを出さない)。幾何(向き)のみ=LC 幅は enforce の責務。
    if (upper && !stopSideOk(upper.side, upper.entry, upper.stopLoss)) upper = null;
    if (lower && !stopSideOk(lower.side, lower.entry, lower.stopLoss)) lower = null;
    if (!upper && !lower) {
      return { ok: true, plan: withMeta({ direction: 'none', rationale, refPrice }) };
    }
    const range: { upper?: RangeLeg; lower?: RangeLeg } = {};
    if (upper) range.upper = upper;
    if (lower) range.lower = lower;
    return { ok: true, plan: withMeta({ direction: 'range', rationale, refPrice, range }) };
  }
  const num = (v: unknown): number | null =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const limitEntry = num(o.limitEntry);
  const stopEntry = num(o.stopEntry);
  const stopLossForLimit = num(o.stopLossForLimit);
  const stopLossForStop = num(o.stopLossForStop);
  // ★レッグ単位の検証: 指値レッグ=limitEntry+stopLossForLimit の対、逆指値レッグ=stopEntry+stopLossForStop の対。
  //   各レッグは「両方あり」か「両方なし」のみ有効(片方だけは不整合=invalid)。少なくとも1レッグあれば ok。
  //   LC≤95 等の数値強制はここではしない(trade2 側の責務)。ここは幾何的なレッグ対の整合のみ。
  const hasLimitLeg = limitEntry !== null && stopLossForLimit !== null;
  const hasStopLeg = stopEntry !== null && stopLossForStop !== null;
  // 片側だけ埋まっているレッグ(対の不整合)は不正。
  if ((limitEntry !== null) !== (stopLossForLimit !== null)) {
    return { ok: false, error: 'invalid limit leg (limitEntry/stopLossForLimit must be paired)' };
  }
  if ((stopEntry !== null) !== (stopLossForStop !== null)) {
    return { ok: false, error: 'invalid stop leg (stopEntry/stopLossForStop must be paired)' };
  }
  // 両レッグとも欠落(direction≠none なのに価格皆無)は不正。
  if (!hasLimitLeg && !hasStopLeg) {
    return { ok: false, error: 'invalid price field(s): at least one leg required' };
  }
  // ★損切りの向き検証(orientation): buy は損切りが各エントリーの下・sell は上。境界(SL==entry=幅0)も不正。
  //   違反レッグは落とす(既存の「片レッグ落とし」と同じ機構=entry+SL を省く)。ここは幾何(向き)のみで、
  //   LC 幅≤上限の強制は enforce の責務(不変)。両レッグとも向き違反で落ちたら「見送り(none)」を ok:true で返す。
  const limitLegOk = hasLimitLeg && stopSideOk(o.direction, limitEntry!, stopLossForLimit!);
  const stopLegOk = hasStopLeg && stopSideOk(o.direction, stopEntry!, stopLossForStop!);
  if (!limitLegOk && !stopLegOk) {
    return { ok: true, plan: withMeta({ direction: 'none', rationale, refPrice }) };
  }
  // refPrice は LLM の自己申告ではなく monitor の現在値を正とする。
  // 存在し、かつ向きが正しいレッグの価格のみ plan に入れる(欠落/向き違反レッグは省略=undefined)。
  const plan: AiPlan = { direction: o.direction, rationale, refPrice };
  if (limitLegOk) {
    plan.limitEntry = limitEntry!;
    plan.stopLossForLimit = stopLossForLimit!;
  }
  if (stopLegOk) {
    plan.stopEntry = stopEntry!;
    plan.stopLossForStop = stopLossForStop!;
  }
  return { ok: true, plan: withMeta(plan) };
}

/** マルチモーダルなユーザメッセージ content を組み立てる。画像があればテキスト+image_url の配列、
 *  無ければ従来どおりプレーン文字列(テキストのみ)を返す。OpenAI/Gemini(OpenAI 互換)共通形式。
 *  data URL は `data:image/png;base64,<...>`。テスト可能な純関数。 */
export function buildScalpUserContent(userPrompt: string, imageDataUrl?: string | null): any {
  if (!imageDataUrl) return userPrompt;
  return [
    { type: 'text', text: userPrompt },
    { type: 'image_url', image_url: { url: imageDataUrl } },
  ];
}

/** スキャルプラン生成の純ループ(LLM 非依存=テスト可能)。tool ループで回答→parse、失敗なら tools 無しで
 *  厳格に1回だけ再要求→再parse。成功で AiPlan、失敗で例外。create/handlers を注入してテストする。
 *  imageDataUrl を渡すと初回・再要求ともにチャート画像を添付する(ビジョン対応プロバイダ時のみ呼び出し側で渡す)。 */
export async function runScalpPlan(
  create: CreateFn, systemPrompt: string, userPrompt: string,
  tools: unknown[], handlers: ToolHandlers, refPrice: number,
  imageDataUrl?: string | null,
): Promise<AiPlan> {
  const userContent = buildScalpUserContent(userPrompt, imageDataUrl);
  const baseMessages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const first = await runChatWithTools(create, baseMessages, tools, handlers);
  const parsed = parseScalpPlan(first, refPrice);
  if (parsed.ok) return parsed.plan;
  // パース失敗 → 厳格に1回だけ再要求(tools 無し・JSON のみ)。
  const retry = await create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
      { role: 'assistant', content: first },
      { role: 'user', content: `直前の応答は指定 JSON スキーマに一致していません(${parsed.error})。説明やコードフェンスを一切付けず、スキーマに厳密一致する JSON オブジェクトだけを出力し直してください。` },
    ],
  });
  const retryText = retry.choices?.[0]?.message?.content?.trim() ?? '';
  const parsed2 = parseScalpPlan(retryText, refPrice);
  if (parsed2.ok) return parsed2.plan;
  throw new Error(`parse failed after retry: ${parsed2.error}`);
}

export interface ScalpPlanInput {
  symbol?: string;
  prices?: Price[];
  news?: NewsItem[];
  technical?: string | null;
  /** チャート画像(data URL: `data:image/png;base64,<...>`)。渡されるとビジョン対応プロバイダに添付する。 */
  chartImageDataUrl?: string | null;
  /** 初期 LC(損切り)幅の下限[円]。未指定は DEFAULT_LC_FLOOR_YEN(45)。プロンプトにのみ反映(数値強制はしない)。 */
  lcFloorYen?: number;
  /** 初期 LC(損切り)幅の上限[円]。未指定は monitor 設定(resolveScalpLcCeiling・既定65)。プロンプト指示＋コードで強制。 */
  lcCeilingYen?: number;
  /** エントリー方向のバイアス。未指定は monitor 設定(resolveScalpBias・既定'none')。'long'=売り新規veto / 'short'=買い新規veto。 */
  bias?: ScalpBias;
  /** レンジ両面ストラドルを許可するか。未指定は monitor 設定(resolveScalpRangeEnabled・既定true)。false=range を出させない/万一出ても none 化。 */
  rangeEnabled?: boolean;
  /** 生きたトレンド(勢い)のヒント。runner が barsFor から computeRegime で算出して渡す。
   *  strong のときトレンドに逆行するフェード新規を enforcePlanConstraints が落とす。未指定は veto なし(現行挙動)。 */
  trend?: TrendHint;
}

/** トレンド veto に渡す最小形。openai を signalTrade/regime に依存させないため、Regime 全体ではなく
 *  {dir,strong} のみ受ける(構造的タイピング)。strong=false または未指定なら veto は完全に無効(現行挙動一致)。 */
export interface TrendHint { dir: 'up' | 'down' | 'flat'; strong: boolean; }

/** AIエントリー制御のハード適用(純関数・最終保証)。monitor 設定の最大初期LC(ceilingYen)・バイアス(bias)・
 *  生きたトレンド(trend)をコードで強制する。プロンプト指示の保険ではなく確定的保証。
 *  合成順は **トレンド veto → バイアス veto → LC上限 → 空なら none**(トレンド veto を先行ステージとして追加)。
 *  0. トレンド veto: trend.strong のとき、トレンドに逆行する side の脚を落とす。
 *     dir='up' → side='sell' を落とす(上昇の高値を売らない)/ dir='down' → side='buy' を落とす。
 *     directional(buy/sell)は side=direction なので、逆行なら plan 全体を direction:'none' にする(順行は維持)。
 *     range は各脚の side で個別に落とす(強上昇なら上=売り指値を落とし、下=買い側を残す=実質片面)。
 *     trend 未指定 or !strong は null=無効で、以降は従来と完全一致(後方互換)。
 *  1. LC上限: 各レッグの初期LC幅 = |entry − stopLoss| が ceilingYen を「超える」ならそのレッグを落とす(境界=ちょうどは許可)。
 *     両レッグとも落ちたら direction:'none'(見送り)。
 *  2. バイアス: bias='long' かつ direction='sell' → 'none' / bias='short' かつ direction='buy' → 'none' / 'none'は素通し。
 *  direction==='none' は何もしない。 */
/** ★v0.7.56: LC安全上限(policy とは独立の安全系)。enabled のとき手動/AI とも超過レッグを落とす。 */
export interface LcHardMax { enabled: boolean; value: number; }

/** enforce の opts。ceilingMode/lcHardMax は v0.7.56 の追加(いずれも省略時は現状=manual/上限なし)。
 *  - ceilingMode: 'manual'(既定)→従来の超過レッグ落とし / 'ai'→LC上限では落とさない。
 *  - lcHardMax: 有効時は ceilingMode に関係なく |entry−SL| が value 超のレッグを落とす(最後の安全網)。 */
export interface EnforceOpts {
  ceilingYen: number;
  bias: ScalpBias;
  trend?: TrendHint;
  ceilingMode?: KnobSource;
  lcHardMax?: LcHardMax;
}

export function enforcePlanConstraints(plan: AiPlan, opts: EnforceOpts): AiPlan {
  // 後方互換の薄いラッパ。挙動(返る plan)は enforcePlanConstraintsReport と完全一致=既存の全呼び出し/テスト不変。
  return enforcePlanConstraintsReport(plan, opts).plan;
}

/** ★v0.7.56: レッグの初期LC幅 w がドロップ対象か。
 *  - ceilingMode!=='ai'(=manual) かつ w>ceilingYen なら落とす(従来の LC 上限)。
 *  - lcHardMax.enabled かつ w>lcHardMax.value なら落とす(mode 無関係の安全網)。
 *  既定(ceilingMode 省略=manual・lcHardMax 省略)では w>ceilingYen のみ=従来と完全一致。 */
export function lcLegExceeds(w: number, opts: { ceilingYen: number; ceilingMode?: KnobSource; lcHardMax?: LcHardMax }): boolean {
  const overCeiling = opts.ceilingMode !== 'ai' && w > opts.ceilingYen;
  const overHard = !!opts.lcHardMax?.enabled && w > opts.lcHardMax.value;
  return overCeiling || overHard;
}

/** enforcePlanConstraints と同一の enforce を行い、さらに **トレンド veto が発火したか(vetoFired)** を surface する
 *  (v0.7.54・計測フック)。返る plan は enforcePlanConstraints と byte 単位で同一(挙動不変)。
 *  vetoFired=true は「トレンド veto ステージが 脚を落とした or plan 全体を none に強制した」場合のみ。
 *  LC上限/バイアス由来の drop/none は vetoFired に含めない(veto の効き目だけを計測するため)。 */
export function enforcePlanConstraintsReport(
  plan: AiPlan,
  opts: EnforceOpts,
): { plan: AiPlan; vetoFired: boolean } {
  if (plan.direction === 'none') return { plan, vetoFired: false };
  const { ceilingYen, bias, trend, ceilingMode, lcHardMax } = opts;
  // ★v0.7.56: レッグの LC 幅ドロップ判定(mode 分岐 + 安全網)。既定(引数省略)は従来と完全一致。
  const lcExceeds = (w: number): boolean => lcLegExceeds(w, { ceilingYen, ceilingMode, lcHardMax });

  // ★トレンド veto(最優先ステージ): 生きた強トレンドに逆行する side を落とす。
  //   up→sell を落とす / down→buy を落とす。trend 未指定 or !strong なら null=無効(現行挙動と完全一致)。
  const dropSide: 'buy' | 'sell' | null =
    trend && trend.strong
      ? (trend.dir === 'up' ? 'sell' : trend.dir === 'down' ? 'buy' : null)
      : null;

  // ★レンジ両面ストラドル: 各レッグに (0)トレンド veto・(a)LC上限・(b)バイアス veto を独立適用。両レッグ落ちたら none、
  //   片レッグ残れば その単レッグの range(=実質片面)として通す。既存の buy/sell 強制とは別経路。
  if (plan.direction === 'range') {
    let upper = plan.range?.upper;
    let lower = plan.range?.lower;
    // (0) トレンド veto: トレンドに逆行する side の脚を落とす(bias/LC より先)。存在した脚を落としたら vetoFired。
    let vetoFired = false;
    if (dropSide) {
      if (upper?.side === dropSide) { upper = undefined; vetoFired = true; }
      if (lower?.side === dropSide) { lower = undefined; vetoFired = true; }
    }
    // (a') 向きの二重防御: 損切りがエントリーの内側/反対側(境界=幅0 含む)のレッグを落とす(parse で落ちている想定=冪等)。
    //      これはトレンド veto ではないので vetoFired には計上しない(veto の効き目だけを計測する)。
    if (upper && !stopSideOk(upper.side, upper.entry, upper.stopLoss)) upper = undefined;
    if (lower && !stopSideOk(lower.side, lower.entry, lower.stopLoss)) lower = undefined;
    // (a) 初期LC幅 |entry−stopLoss| が上限超のレッグを落とす(境界=ちょうどは許可)。
    //     ★v0.7.56: manual→ceilingYen 超 / ai→ceiling では落とさない。ただし lcHardMax 有効時は mode 無関係に安全網。
    if (upper && lcExceeds(Math.abs(upper.entry - upper.stopLoss))) upper = undefined;
    if (lower && lcExceeds(Math.abs(lower.entry - lower.stopLoss))) lower = undefined;
    // (b) バイアス veto: long→sell レッグ落とし / short→buy レッグ落とし。
    if (bias === 'long') {
      if (upper?.side === 'sell') upper = undefined;
      if (lower?.side === 'sell') lower = undefined;
    } else if (bias === 'short') {
      if (upper?.side === 'buy') upper = undefined;
      if (lower?.side === 'buy') lower = undefined;
    }
    if (!upper && !lower) {
      return { plan: { direction: 'none', rationale: plan.rationale, refPrice: plan.refPrice }, vetoFired };
    }
    const range: { upper?: RangeLeg; lower?: RangeLeg } = {};
    if (upper) range.upper = upper;
    if (lower) range.lower = lower;
    return { plan: { direction: 'range', rationale: plan.rationale, refPrice: plan.refPrice, range }, vetoFired };
  }

  // ★directional(buy/sell): leg side === direction。逆行(dropSide===direction: 強上昇の sell / 強下降の buy)なら
  //   plan 全体を見送り(none)に。順行はそのまま以降の LC・バイアス処理へ進む。
  if (dropSide && dropSide === plan.direction) {
    return { plan: { direction: 'none', rationale: plan.rationale, refPrice: plan.refPrice }, vetoFired: true };
  }

  const out: AiPlan = { ...plan };

  // 1. レッグ単位の LC 上限(境界=ちょうどは許可)+ 向きの二重防御。上限超 or 向き違反のレッグは対で落とす。
  //    向き(stopSideOk): directional は leg side === direction。損切りが内側/反対側(境界=幅0 含む)なら落とす
  //    (parse で落ちている想定=冪等)。既に向きが正しい正常プランには影響しない。
  const limitOk =
    out.limitEntry != null && out.stopLossForLimit != null &&
    !lcExceeds(Math.abs(out.limitEntry - out.stopLossForLimit)) &&
    stopSideOk(plan.direction, out.limitEntry, out.stopLossForLimit);
  const stopOk =
    out.stopEntry != null && out.stopLossForStop != null &&
    !lcExceeds(Math.abs(out.stopEntry - out.stopLossForStop)) &&
    stopSideOk(plan.direction, out.stopEntry, out.stopLossForStop);
  if (!limitOk) { out.limitEntry = undefined; out.stopLossForLimit = undefined; }
  if (!stopOk) { out.stopEntry = undefined; out.stopLossForStop = undefined; }

  // 両レッグ落ちたら見送り(価格を持たない none)。
  if (out.limitEntry == null && out.stopEntry == null) {
    return { plan: { direction: 'none', rationale: out.rationale, refPrice: out.refPrice }, vetoFired: false };
  }

  // 2. バイアス veto。
  if ((bias === 'long' && out.direction === 'sell') ||
      (bias === 'short' && out.direction === 'buy')) {
    return { plan: { direction: 'none', rationale: out.rationale, refPrice: out.refPrice }, vetoFired: false };
  }

  return { plan: out, vetoFired: false };
}

// LC 幅の下限/上限の受理可能レンジ(サニタイズ用)。この範囲外・非有限・floor>ceiling は既定に戻す。
export const LC_YEN_MIN = 20;
export const LC_YEN_MAX = 300;

/** lcFloorYen/lcCeilingYen をサニタイズ・クランプして [floor, ceiling] を返す。
 *  非数値/非有限、LC_YEN_MIN..LC_YEN_MAX の範囲外、floor>ceiling のいずれかなら既定(45/65)へフォールバック。 */
export function resolveLcRange(
  floorYen?: number,
  ceilingYen?: number,
): { floorYen: number; ceilingYen: number } {
  const inRange = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= LC_YEN_MIN && v <= LC_YEN_MAX;
  const floor = inRange(floorYen) ? floorYen : DEFAULT_LC_FLOOR_YEN;
  const ceiling = inRange(ceilingYen) ? ceilingYen : DEFAULT_LC_CEILING_YEN;
  // ceiling を既定 floor(45)より小さく締めた場合、floor を ceiling まで下げて **ユーザーの厳しい上限を尊重** する。
  // ★従来は両方を既定(45/65)へ戻していたため、締めた上限が黙って無視され「緩む方向」へサイレント失敗するフットガンだった
  //   (呼び出し側は floor 未指定=45 で呼ぶため、ceiling を 20〜44 にすると発火)。ceiling を単一の真実として優先する。
  if (floor > ceiling) return { floorYen: ceiling, ceilingYen: ceiling };
  return { floorYen: floor, ceilingYen: ceiling };
}

/** 固定のスキャル質問で LLM を走らせ、構造化 AiPlan を返す。既存の chat と同じ tool ループ・プロバイダ選択・
 *  キー解決を再利用する。キー未設定は { ok:false, error:'LLM未設定' }。パース失敗は1回だけ厳格に再要求する。
 *  refPrice は monitor の現在 NIY=F 価格。 */
export async function buildScalpPlan(input: ScalpPlanInput = {}): Promise<ScalpPlanResult> {
  if (!isLLMEnabled()) return { ok: false, error: 'LLM未設定' };
  const now = Date.now();
  const symbol = typeof input.symbol === 'string' && input.symbol ? input.symbol : NIKKEI_SYMBOL;
  const prices = input.prices ?? getPrices();
  const news = input.news ?? [];
  const refPrice = prices.find(p => p.symbol === symbol)?.price ?? 0;
  // ★v0.7.56: 各 knob の directive(manual/ai)を解決。既定は全て manual=現状の挙動を一切変えない。
  //   manual は数値/enum を強制(従来どおり)/ ai は該当制約を課さず AI に委任する。LC安全上限は独立の安全系。
  const floorD = resolveScalpLcFloorDirective();
  const ceilingD = resolveScalpLcCeilingDirective();
  const biasD = resolveScalpBiasDirective();
  const rangeD = resolveScalpRangeDirective();
  const trendD = resolveScalpTrendVetoDirective();
  const hardMax = resolveScalpLcHardMax();
  // 初期 LC 幅の上限とバイアスは、要求で明示されなければ monitor 設定を既定に使う(＝直呼びのシグナルエンジンも
  // monitor 設定に従う=単一の真実)。上限はサニタイズ・クランプ後にプロンプトへ反映し、最終保証は enforcePlanConstraints。
  const ceilingMode = ceilingD.mode;
  const ceilingInput = input.lcCeilingYen ?? ceilingD.value;
  // バイアス/レンジ: manual は設定(override 優先)を適用 / ai は制約なし(bias='none'・range 許可)。
  const bias: ScalpBias = biasD.mode === 'manual' ? (input.bias ?? biasD.value) : 'none';
  const rangeEnabled = rangeD.mode === 'manual' ? (input.rangeEnabled ?? rangeD.value) : true;
  const { floorYen, ceilingYen } = resolveLcRange(input.lcFloorYen ?? floorD.value, ceilingInput);
  // レジーム/トレンド veto の閾値[円](0=無効)。manual は閾値・ai は数値veto無効(=0)。プロンプト文言に反映し、
  // トレンド veto 自体は input.trend で駆動する(0 のとき trend を渡さない=veto なし)。
  const trendVetoYen = trendD.mode === 'manual' ? trendD.value : 0;
  // ★委任ノート: AI に委任した knob だけ「この値はあなたが決める(自由・根拠を述べよ)」を追記する。
  //   全 knob 手動(既定)では '' = プロンプトは従来と byte 単位で不変(回帰なし)。
  const cooldownD = resolveScalpCooldownDirective();
  const delegationNote = buildDelegationNote(
    { lcFloor: floorD.mode, lcCeiling: ceilingD.mode, trendVeto: trendD.mode,
      cooldown: cooldownD.mode, bias: biasD.mode, range: rangeD.mode },
    { floorYen, ceilingYen, hardMax },
  );
  const biasNote =
    bias === 'long'  ? '\n\n【エントリー方向の制約】買い中心。売り(sell)の新規は原則見送り(direction:"none")とし、買い(buy)の好機のみ提案すること。'
  : bias === 'short' ? '\n\n【エントリー方向の制約】売り中心。買い(buy)の新規は原則見送り(direction:"none")とし、売り(sell)の好機のみ提案すること。'
  : '';
  const monitorCtx = buildMonitorContext(now);
  const scalpQuestion = buildScalpQuestion(floorYen, ceilingYen, rangeEnabled, trendVetoYen);
  const systemPrompt =
    `${buildScalpSystemPrompt(floorYen, ceilingYen, rangeEnabled, trendVetoYen)}${biasNote}${delegationNote}\n\n` +
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(prices, now)}\n\n` +
    (input.technical ? `${input.technical}\n\n` : '') +
    (monitorCtx ? `${monitorCtx}\n\n` : '') +
    `■ 関連ニュース:\n${formatNewsForChat(news, now, scalpQuestion)}`;

  // chat と同じデータツール(常時有効)+ web_search(Gemini グラウンディング・キーがある時のみ)。
  const tools: unknown[] = [EXPLAIN_MOVE_TOOL, QUERY_ALERTS_TOOL, PRICE_HISTORY_TOOL];
  const handlers: ToolHandlers = buildDataToolHandlers();
  if (isWebSearchEnabled()) {
    tools.push(WEB_SEARCH_TOOL);
    handlers.web_search = async (a: { query?: string }) => {
      const q = typeof a.query === 'string' ? a.query : '';
      return q ? await webSearch(q) : '(クエリ空)';
    };
  }

  // チャート画像がある時は判断材料にするよう明示的に指示する(ビジョン対応プロバイダ時のみ添付される)。
  const img = input.chartImageDataUrl && input.chartImageDataUrl.startsWith('data:image/')
    ? input.chartImageDataUrl : null;
  const visionNote = img ? '添付のチャート画像(当日の日経225先物のローソク足・主要水準・直近アラート)も判断材料にすること。\n\n' : '';
  const userPrompt = `${scalpQuestion}\n\n${visionNote}${scalpJsonInstruction(refPrice, floorYen, ceilingYen, rangeEnabled)}`;

  try {
    const raw = await callWithFallback(async (p) => {
      const create: CreateFn = (params) => p.client!.chat.completions.create({
        model: p.config.chatModel, temperature: 0.4, max_tokens: 8000, ...params,
      } as any);
      // ビジョン非対応プロバイダに切り替わった場合は画像を外す(image_url をテキスト専用モデルへ送らない)。
      const imgForThis = img && isVisionCapableProvider(p.config.name, p.config.chatModel) ? img : null;
      // 成功時は整形済み plan JSON 文字列を返す(callWithFallback は string 契約)。
      return JSON.stringify(await runScalpPlan(create, systemPrompt, userPrompt, tools, handlers, refPrice, imgForThis));
    }, 'scalp-plan');
    // callWithFallback から返った plan JSON を再パースし、monitor 設定の LC 上限・バイアスをコードで最終保証してから返す。
    const parsed = parseScalpPlan(raw, refPrice);
    if (!parsed.ok) return parsed;
    // トレンド veto: 閾値>0 かつ runner が trend を渡した時だけ効かせる(未指定/0=ai は現行挙動=veto なし)。
    const trend = trendVetoYen > 0 ? input.trend : undefined;
    // ★v0.7.56: LC上限は ceilingMode(manual→落とす / ai→落とさない)で分岐し、LC安全上限(hardMax)は
    //   mode 無関係に常時適用(有効時)。バイアスは ai なら 'none'(上で解決済)=veto なし。
    const enforced = enforcePlanConstraintsReport(parsed.plan, {
      ceilingYen, bias, trend, ceilingMode, lcHardMax: hardMax,
    });
    let finalPlan = enforced.plan;
    // 防御多重化: レンジ無効設定で万一 range が返っても none に落とす(プロンプト指示の保険)。
    if (!rangeEnabled && finalPlan.direction === 'range') {
      finalPlan = { direction: 'none', rationale: finalPlan.rationale, refPrice: finalPlan.refPrice };
    }
    // AI 自己レジーム/確信度(記録のみ)を最終 plan に保持する。enforce/none 化で新規オブジェクトになり
    // 落ちることがあるため parsed.plan から再付与する(ゲートには使わない=挙動不変)。
    if (parsed.plan.regime !== undefined) finalPlan.regime = parsed.plan.regime;
    if (parsed.plan.confidence !== undefined) finalPlan.confidence = parsed.plan.confidence;
    return { ok: true, plan: finalPlan, vetoFired: enforced.vetoFired };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── 翻訳 ─────────────────────────────────────────
// 英文ニュースタイトルを簡潔な日本語に翻訳。同一テキストは LRU でキャッシュ。

const TRANSLATE_CACHE_MAX = 500;
const translateCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const v = translateCache.get(key);
  if (v !== undefined) {
    // LRU: 再アクセス時に最新化
    translateCache.delete(key);
    translateCache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, value: string): void {
  if (translateCache.has(key)) translateCache.delete(key);
  translateCache.set(key, value);
  if (translateCache.size > TRANSLATE_CACHE_MAX) {
    const oldest = translateCache.keys().next().value;
    if (oldest !== undefined) translateCache.delete(oldest);
  }
}

export async function translate(text: string): Promise<string> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const cached = cacheGet(trimmed);
  if (cached !== undefined) return cached;

  const systemPrompt = '英文を簡潔で自然な日本語に訳すアシスタント。ニュースのタイトルを訳すので、主語の省略 OK、改行なし、引用符・句読点は最低限、訳文のみを返す。';

  const result = await callWithFallback(async (p) => {
    const completion = await p.client!.chat.completions.create({
      model: p.config.model,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
    });
    return completion.choices[0]?.message?.content?.trim() ?? '';
  }, 'translate');

  if (result) cacheSet(trimmed, result);
  return result;
}
