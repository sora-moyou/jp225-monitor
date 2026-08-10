import { describe, it, expect } from 'vitest';
import { formatCrossAsset, explain, selectNewsPool, testProviderState, classifyLLMError } from './openai.js';
import type { LLMProvider } from '../config.js';
import type { Mover } from '../marketSnapshot.js';
import type { NewsItem } from '../types.js';

describe('classifyLLMError (5xx/timeout もフォールバック対象に)', () => {
  it('429/枯渇 → quota(長 ladder)', () => {
    expect(classifyLLMError('429 Too Many Requests')).toBe('quota');
    expect(classifyLLMError('Resource has been exhausted')).toBe('quota');
    expect(classifyLLMError('rate_limit exceeded')).toBe('quota');
  });
  it('5xx / タイムアウト / ネットワーク → transient(短ポーズ+フォールバック)', () => {
    expect(classifyLLMError('503 status code (no body)')).toBe('transient');
    expect(classifyLLMError('500 Internal Server Error')).toBe('transient');
    expect(classifyLLMError('529 overloaded')).toBe('transient');
    expect(classifyLLMError('aborted after 55000ms')).toBe('transient');
    expect(classifyLLMError('request timed out')).toBe('transient');
    expect(classifyLLMError('ECONNRESET')).toBe('transient');
    expect(classifyLLMError('fetch failed')).toBe('transient');
  });
  it('413/リクエスト過大(TPM・コンテキスト超過) → oversize(ポーズせず次の大きいモデルへ)', () => {
    // Groq 実エラー: 単一リクエストが on_demand tier の TPM を超過(=このモデルでは絶対に通らない)。
    expect(classifyLLMError('413 Request too large for model `llama-3.3-70b-versatile` in organization org_x service tier on_demand')).toBe('oversize');
    expect(classifyLLMError('Request too large ... on tokens per minute (TPM): Limit 12000, Requested 13000')).toBe('oversize');
    // OpenAI 系のコンテキスト超過表現も同カテゴリ。
    expect(classifyLLMError("This model's maximum context length is 8192 tokens")).toBe('oversize');
    expect(classifyLLMError('Please reduce the length of the messages')).toBe('oversize');
  });
  it('413 のうち rate limit 表現(429相当)は quota を優先(誤分類しない)', () => {
    expect(classifyLLMError('rate_limit_exceeded: too many requests')).toBe('quota');
  });
  it('★401/403/404・モデル不明/権限 → config(フォールバック化・2026-07-28: Kimi 404事故対策)', () => {
    expect(classifyLLMError('401 Incorrect API key provided')).toBe('config');
    expect(classifyLLMError('404 status code (no body)')).toBe('config');
    expect(classifyLLMError('404 Not found the model kimi-k2-0905-preview or Permission denied')).toBe('config');
    expect(classifyLLMError('403 permission denied')).toBe('config');
  });
  // ─── ★400(2026-08-11)。旧テストは「400 → null(即 throw)」を固定していたが、
  //     それが稼働機で 430 件のニュース翻訳を全滅させた欠陥そのものだったので **意図的に反転**する。
  //     実害: `400 invalid temperature: only 1 is allowed for this model`(kimi-k3)が
  //     未分類=即 throw となり、次プロバイダへ回らなかった(2026-08-10 13:27 JST〜)。
  //
  //     ★config(30分ポーズ)ではなく **badrequest(ポーズ無し)** にする理由:
  //       400 には「一度きりの要求ミス」(実ログ: tool call validation failed ×6)が混ざる。
  //       それで健全な gemini を 30分止めると traffic が groq(413)→ openai(有料)へ流れ、
  //       可用性のための修正が課金を増やす。413 と同じ「ポーズせず次へ」に揃える。
  //     ★文言でサブ分類しない: 「永久に通らない400」と「一度きりの400」を語で見分ける表は作らない。
  describe('★400 → badrequest(ポーズせずフォールバック・2026-08-11: Kimi temperature 400 事故対策)', () => {
    // badrequest に分類 **されなければならない** 文言(実ログから採ったもの + 同型)
    const MUST_BADREQUEST = [
      // ★稼働機の実文(serverlog_kabu.txt に 227 行)。
      '400 invalid temperature: only 1 is allowed for this model',
      // ★稼働機の実文(chrono_kabu.log・/api/scalp-plan 経由)。
      '400 tool call validation failed: parameters for tool explain_move did not match schema: errors: [`/sinceMinutes`: expected number, but got string]',
      '400 Bad Request: malformed json',
      '400 status code (no body)',
      // ★接頭辞付き(`String(err)` を渡す経路。先頭限定だと **無言で** 分類から漏れていた)
      'Error: 400 tool call validation failed: parameters did not match schema',
      'Error: 400 status code (no body)',
      'APIError: 400 unknown field: reasoning_effort',
      'BadRequestError: 400 invalid temperature',
      'Error: Error: 400 二重に文字列化された形',
      // 状態番号が落ちた形でも「要求内容が不正」と名指ししているもの。
      'invalid_request_error: unknown parameter',
      'unsupported_parameter: temperature is not supported with this model',
      'only 1 is allowed for this model',
    ];
    for (const msg of MUST_BADREQUEST) {
      it(`badrequest: ${msg.slice(0, 56)}`, () => expect(classifyLLMError(msg)).toBe('badrequest'));
    }

    // ★逆方向: badrequest に分類 **されてはいけない** 文言(400 を拾うことで横取りしていないか)。
    //   期待値は「現行の分類」を1つずつ固定する = 副作用がゼロであることの表。
    //   ★とくに 401/403/404 が badrequest に落ちていないこと(=長ポーズの規律を弱めていない)。
    const MUST_NOT_BADREQUEST: Array<[string, ReturnType<typeof classifyLLMError>]> = [
      // ── 400 で返ってくるが本質は別物 → 順序で quota/oversize が勝つこと ──
      ['400 This model\'s maximum context length is 8192 tokens, however you requested 9000', 'oversize'],
      ['400 rate_limit_exceeded: please slow down', 'quota'],
      // ── 実ログの他ステータス(1つも分類が変わらないこと) ──
      ['413 Request too large for model `llama-3.3-70b-versatile` in organization org_x service tier on_demand', 'oversize'],
      ['429 rate_limit_exceeded: Limit 6000, Used 6000, Requested 512', 'quota'],
      ['401 Incorrect API key provided: sk-proj-****…Y9EA.', 'config'],
      ['404 Not found the model kimi-latest or Permission denied', 'config'],
      ['403 permission denied', 'config'],
      ['503 status code (no body)', 'transient'],
      ['500 Internal Server Error', 'transient'],
      // ── ★アプリ由来の数値が 400 に化けないこと(既知の穴: `\b50[0-4]\b` は `41,500` を拾う) ──
      //   日経の価格帯 40,400 / 41,400 は実在する。ここが config になると健全なプロバイダを
      //   30分ポーズさせる(誤爆で取りこぼしが増える形)。
      ['parse failed after retry: JSON parse failed: Unexpected token あ in JSON at position 400', null],
      ['scalp-plan: 節目 41,400 円を上抜けたら追随, という出力が壊れていた', null],
      ['legs 40,400 / 40,600 の解釈に失敗', null],
      ['something totally unexpected', null],
      // ★接頭辞を許すときに一緒に入ってきやすい形。**エラー名以外の接頭辞は許さない**ので null のまま。
      //   (`[\s:(]400\b` のように空白を許すと、下の2つを badrequest と誤分類する)
      ['Unexpected token あ in JSON at position 400', null],
      ['scalp-plan: 400 という数字がレッグに出た', null],
      ['予測レンジ 400 pt', null],
      ['65400 は語境界を持たない', null],
    ];
    for (const [msg, want] of MUST_NOT_BADREQUEST) {
      it(`${want ?? 'null'}: ${msg.slice(0, 56)}`, () => expect(classifyLLMError(msg)).toBe(want));
    }
  });
});

describe('formatCrossAsset', () => {
  it('returns a "no linkage" line when there are no movers', () => {
    expect(formatCrossAsset([])).toBe('【他資産】同時刻に目立った連動なし。');
  });

  it('formats movers with arrow, signed percent, window and z', () => {
    const movers: Mover[] = [
      { symbol: 'NQ=F', label: 'ナスダック100先物', changePercent: -1.85, windowSeconds: 300, z: 4.3, direction: 'down' },
      { symbol: 'JPY=X', label: 'ドル円', changePercent: 0.42, windowSeconds: 60, z: 4.1, direction: 'up' },
    ];
    const out = formatCrossAsset(movers);
    expect(out).toContain('【同時刻に大きく動いた他資産(z>=4.0)】');
    expect(out).toContain('- ナスダック100先物 ▼ -1.85% (5分, z=4.3)');
    expect(out).toContain('- ドル円 ▲ +0.42% (1分, z=4.1)');
  });
});

const news = (id: string, ageMin: number): NewsItem => ({
  id, title: `news ${id}`, source: 'test', lang: 'ja', url: 'x', publishedAt: Date.now() - ageMin * 60_000,
});

describe('selectNewsPool sinceFloor (①: 直前の急変以降)', () => {
  it('sinceFloor より古いニュースは除外', () => {
    const now = Date.now();
    const items = [news('old', 50), news('new', 5)];
    const since = now - 20 * 60_000;   // 20分前以降のみ
    const pool = selectNewsPool(items, now, since);
    expect(pool.map(n => n.id)).toEqual(['new']);
  });
});

describe('testProviderState (APIキー実効性 ping)', () => {
  const cfg: LLMProvider = {
    name: 'fake', envVar: 'FAKE_KEY', baseURL: undefined,
    model: 'm', chatModel: 'fake-chat-model',
  };
  // OpenAI クライアントの chat.completions.create だけを持つ最小フェイク。
  const fakeClient = (create: (params: unknown) => Promise<unknown>) =>
    ({ chat: { completions: { create } } } as any);

  it('client が ping に成功 → { ok: true }', async () => {
    const calls: unknown[] = [];
    const p = { config: cfg, client: fakeClient(async (params) => { calls.push(params); return { choices: [] }; }) };
    const r = await testProviderState(p, 'fake');
    expect(r).toEqual({ name: 'fake', ok: true });
    // 極小 ping (1トークン・正しいモデル) で叩いている
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: 'fake-chat-model', max_tokens: 1 });
  });

  it('client が 401 を投げる → { ok: false, error にメッセージ }', async () => {
    const p = { config: cfg, client: fakeClient(async () => { throw new Error('401 Unauthorized: invalid api key'); }) };
    const r = await testProviderState(p, 'fake');
    expect(r.ok).toBe(false);
    expect(r.notset).toBeUndefined();
    expect(r.error).toContain('401');
  });

  it('client 無し(キー未設定/プレースホルダ) → { ok: false, notset: true }', async () => {
    const p = { config: cfg, client: null };
    expect(await testProviderState(p, 'fake')).toEqual({ name: 'fake', ok: false, notset: true });
    // プロバイダ状態自体が無い場合も notset
    expect(await testProviderState(undefined, 'gone')).toEqual({ name: 'gone', ok: false, notset: true });
  });
});

describe('explain ①ファンダ/テクニカル判定', () => {
  it('値動き(急変)で参照窓内にニュースが無ければ、LLMを呼ばず「テクニカル要因の可能性」+L2併記', async () => {
    const { text } = await explain({
      symbol: 'NIY=F', symbolLabel: '日経225先物', changePercent: -0.4, windowSeconds: 60,
      detectionKind: 'shock', direction: 'down', change15min: null, pa15min: null, range1h: null,
      news: [news('old', 300)], newsSince: Date.now() - 10 * 60_000,   // 窓内(10分)にニュース無し
      l2Recent: '水準ブレイク 67,470 ▼',
    });
    expect(text).toContain('テクニカル要因の可能性');
    expect(text).toContain('水準ブレイク 67,470 ▼');
  });
});
