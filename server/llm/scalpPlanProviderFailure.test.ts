// server/llm/scalpPlanProviderFailure.test.ts
//
// ─── ★取引の計画が「プロバイダ層の故障」を生き延びることの常設テスト ──────────────────
//
// ■ 何を守っているか(稼働機・実データ 2026-08-10 13:30 〜 08-11 04:57)
//   約15時間、取引の計画が1件も作られなかった。signal_plans の error 行は
//   修正前 711件中 1件 → 事故中 487件中 411件(84%)。411件すべてが同じ1文:
//     `400 invalid temperature: only 1 is allowed for this model`
//   真因は classifyLLMError の `\b40[134]\b` が **400 を拾わない** こと。分類 null →
//   callWithFallback の「429以外は再投げ」枝 → **2番目のプロバイダを一度も試さない**。
//
// ■ ★なぜ 3,166件のテストが緑のまま見逃したか
//   スキャルプランのテスト(scalpPlanLcAudit / Pipeline / Bandwalk / Provenance / Redact /
//   OmissionAudit / ExitVariant / refPriceGate)は
//     vi.mock('./providers.js', () => ({ callWithFallback: 独自の連鎖 }))
//   で **壊れた層そのもの** を差し替えていた。モックには正当な理由がある(外部 LLM を呼ばない)。
//   問題は「プロバイダ層を差し替えた結果、**プロバイダ層が壊れたとき上位がどうなるか** を
//   誰も検証していなかった」こと。翻訳側には実物を通すテスト(badRequestFallback /
//   unusableResponseFallback)が在り、**取引側にだけ無かった**=守られていない方が取引の判断だった。
//
// ■ このファイルの立ち位置(検証の水準)
//   ★providers.js を **モックしない**。本物の classifyLLMError / tripCircuit / callWithFallback を通す。
//   ★openai SDK も本物のまま、**本物のローカル HTTP サーバ**へ向ける(unusableResponseFallback と同じ流儀)。
//     モックの create() を差し替えるだけでは「連鎖が実際に次へ進んだか」も
//     「SDK が status → 例外メッセージをどう組むか」も見ていない。事故の実文は SDK が組んだ文字列だった。
//   ★上位は buildScalpPlan まで通す。実際に壊れたのは **buildScalpPlan が error を返すところ** で、
//     それが signal_plans.error になって台帳に411行残った。だから台帳への1行まで含めて固定する。
//   ★外部へは1バイトも出ない(全プロバイダの baseURL をローカルの偽サーバへ差し替える)。
//
// ■ ★否定対照(このテストが恒真でないこと)
//   1) 「全プロバイダが落ちたら計画は出ない」を同じファイルで固定する(下の describe)。
//   2) transient(503) / quota(429) では **ポーズする**ことも固定する(=規律を一律に緩めていない)。
//   3) `git show HEAD~1:server/llm/providers.ts`(v0.9.73 以前)を当てると 400 の本命が赤くなる。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Price } from '../types.js';

/** テスト中の全 OpenAI クライアントをローカルの偽サーバへ向ける(SDK 本体はそのまま使う)。
 *  maxRetries:0 = SDK 内部の自動リトライを切る(429/5xx を1回で連鎖へ渡す)。 */
const FAKE = { baseURL: '' };
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  class Routed extends actual.default {
    constructor(opts: ConstructorParameters<typeof actual.default>[0]) {
      super({ ...opts, baseURL: FAKE.baseURL, maxRetries: 0 });
    }
  }
  return { ...actual, default: Routed };
});

// ★プロバイダ層 **以外** の外部依存だけを落とす(実物にするとユーザー環境/実DBに依存して不安定になる)。
//   providers.js は **絶対にモックしない**(それがこのファイルの存在理由)。
vi.mock('./webSearch.js', () => ({ isWebSearchEnabled: () => false, webSearch: async () => '' }));
vi.mock('./dataTools.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  buildMonitorContext: () => '',
}));
// 設定は実ユーザー環境に依存させない(LC下限=55円手動・上限65・veto/bias 無効)。
// ★resolveApiKeyForPool / resetConfigCache は実物のまま(providers.ts が使う=プロバイダ層は素通し)。
vi.mock('../configStore.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  resolveScalpLcFloorDirective: () => ({ mode: 'manual', value: 55 }),
  resolveScalpLcCeilingDirective: () => ({ mode: 'manual', value: 65 }),
  resolveScalpTrendVetoDirective: () => ({ mode: 'manual', value: 100 }),
  resolveScalpCooldownDirective: () => ({ mode: 'manual', value: 90 }),
  resolveScalpBiasDirective: () => ({ mode: 'manual', value: 'none' }),
  resolveScalpRangeDirective: () => ({ mode: 'manual', value: false }),
  resolveScalpLcHardMax: () => ({ enabled: false, value: 150 }),
  resolveScalpAiTechnicalEnabled: () => false,
}));

const { resetConfigCache } = await import('../configStore.js');
const { reloadProviders, getProviderStatus, classifyLLMError } = await import('./providers.js');
const { buildScalpPlan } = await import('./scalpPlan.js');
const { buildSignalPlanInsert } = await import('../signalTrade/planLedger.js');
const { initSchema, insertSignalPlan, getSignalPlans } = await import('../db/store.js');

// ─── 偽の LLM サーバ ────────────────────────────────────────────────
type Reply =
  | { kind: 'plan' }                                   // 正常な計画 JSON
  | { kind: 'empty'; finish: 'stop' | 'length' }       // 200 だが中身が空 / 長さ切れ
  | { kind: 'prose' }                                  // 200 で中身はあるが JSON ではない(モデルが喋ってしまった)
  | { kind: 'error'; status: number; message: string; type?: string };

const REF = 38250;
/** 下限55/上限65 を満たす売り計画(既存テストと同型)。 */
const PLAN_JSON = JSON.stringify({
  direction: 'sell',
  rationale: '戻り売り。指値レッグ 38310と38365の引き算 → LC幅は55円。',
  limitEntry: 38310, lcWidthForLimit: 55, refPrice: REF,
});

/** ★どのプロバイダが叩いたかは **API キー(Authorization ヘッダ)** で見分ける。
 *  「n 回目の要求」で見分けてはならない: runScalpPlanResult は parse 失敗時に
 *  **同じプロバイダへ厳格な再要求**をもう1回投げる(scalpPlan.ts の retry)。順番で数えると
 *  その2回目を「2番目のプロバイダ」と取り違え、フォールバックしていないのに緑になる。
 *  (実際このファイルを書く途中で一度取り違えた。) */
const KEY_OF = { kimi: 'sk-kimi_dummy_test_key_not_real', openai: 'sk-openai_dummy_test_key_not_real' } as const;
type ProviderName = keyof typeof KEY_OF;

/** プロバイダごとの応答(そのプロバイダが叩かれる限り何度でも同じものを返す)。 */
let route: Record<ProviderName, Reply>;
/** プロバイダ別の到達回数=連鎖が実際にどこへ何回出たか。 */
let hitsBy: Record<ProviderName | 'unknown', number>;
const totalHits = (): number => hitsBy.kimi + hitsBy.openai + hitsBy.unknown;
let server: Server;

function send(res: ServerResponse, r: Reply): void {
  if (r.kind === 'error') {
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: r.message, type: r.type ?? 'invalid_request_error' } }));
    return;
  }
  const content = r.kind === 'plan' ? PLAN_JSON
    : r.kind === 'prose' ? '申し訳ありませんが、現在の相場では明確な判断ができません。' : '';
  const finish = r.kind === 'empty' ? r.finish : 'stop';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 0, model: 'fake',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }],
  }));
}

/** Authorization: Bearer <key> からプロバイダ名を引く。 */
function providerOf(auth: string | undefined): ProviderName | 'unknown' {
  const key = (auth ?? '').replace(/^Bearer\s+/i, '').trim();
  for (const [name, k] of Object.entries(KEY_OF)) if (k === key) return name as ProviderName;
  return 'unknown';
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on('data', () => { /* 本文は読み捨て(プロンプト内容の検証は別ファイルの責務) */ });
    req.on('end', () => {
      const who = providerOf(req.headers.authorization);
      hitsBy[who]++;
      if (who === 'unknown') { send(res, { kind: 'error', status: 401, message: 'unknown key' }); return; }
      send(res, route[who]);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  FAKE.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

// ─── プロバイダを kimi → openai の2つだけに固定する ──────────────────────────
const ENV_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'KIMI_API_KEY', 'OPENAI_API_KEY'] as const;
const SAVED = new Map<string, string | undefined>();
const ORIG: Record<string, string | undefined> = {};
let homeDir = '';
/** console.warn を黙らせつつ記録する(型は推論に任せる=vitest の版差に引きずられない)。 */
const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
let warn: ReturnType<typeof spyWarn>;

function freshPrices(): Price[] {
  return [{ symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: Date.now(), stale: false } as Price];
}

/** 本番と同じ入口。プロバイダ層は実物・SDK も実物・HTTP も実物。 */
function planOnce() {
  return buildScalpPlan({ symbol: 'NIY=F', prices: freshPrices(), news: [] });
}

/** console.warn に出た [LLM:*] の行(プロバイダ層のログ)。 */
function llmWarnLines(): string[] {
  return warn.mock.calls.map(c => c.map(String).join(' ')).filter(l => l.includes('[LLM:'));
}

beforeEach(() => {
  route = { kimi: { kind: 'plan' }, openai: { kind: 'plan' } };
  hitsBy = { kimi: 0, openai: 0, unknown: 0 };
  homeDir = mkdtempSync(join(tmpdir(), 'scalp-provfail-'));
  ORIG.HOME = process.env.HOME; ORIG.USERPROFILE = process.env.USERPROFILE; ORIG.APPDATA = process.env.APPDATA;
  process.env.HOME = homeDir; process.env.USERPROFILE = homeDir; process.env.APPDATA = homeDir;
  for (const k of ENV_KEYS) { SAVED.set(k, process.env[k]); delete process.env[k]; }
  process.env.KIMI_API_KEY = KEY_OF.kimi;
  process.env.OPENAI_API_KEY = KEY_OF.openai;
  resetConfigCache();
  reloadProviders();                       // ★プールを作り直す=前のテストのポーズを持ち越さない
  warn = spyWarn();
});
afterEach(() => {
  warn.mockRestore();
  for (const k of ENV_KEYS) {
    const v = SAVED.get(k);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (ORIG.HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG.HOME;
  if (ORIG.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = ORIG.USERPROFILE;
  if (ORIG.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = ORIG.APPDATA;
  resetConfigCache();
  reloadProviders();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('前提(この土台が壊れていたら以下は全部無意味)', () => {
  it('有効プロバイダは kimi → openai の2つ', () => {
    expect(getProviderStatus().filter(p => p.enabled).map(p => p.name)).toEqual(['kimi', 'openai']);
  });

  it('★providers.js は実物(モックしていない)= 事故った関数がこのファイルで実行される', () => {
    // 事故の実文が **実物の分類器** に通ることを、実物の関数で確かめる。
    expect(classifyLLMError('400 invalid temperature: only 1 is allowed for this model')).toBe('badrequest');
  });

  it('全プロバイダ健全なら1番目だけで計画が出る(2番目は叩かない)', async () => {
    const r = await planOnce();
    expect(r.ok).toBe(true);
    expect(hitsBy).toEqual({ kimi: 1, openai: 0, unknown: 0 });
    if (r.ok) expect(r.plan.limitEntry).toBe(38310);
  });
});

// ─── ★本丸: 1番目のプロバイダの故障を計画が生き延びる ────────────────────────
describe('★1番目のプロバイダが壊れても計画が出る(実プロバイダ連鎖・実SDK・実HTTP)', () => {
  /** 事故の実文そのもの(serverlog / DB の 411件と同一)。 */
  const KIMI_400 = 'invalid temperature: only 1 is allowed for this model';

  const CASES: Array<{ label: string; reply: Reply; logWord: string }> = [
    { label: '★400(事故の実文): invalid temperature', reply: { kind: 'error', status: 400, message: KIMI_400 }, logWord: 'bad request' },
    { label: '400: ツール引数のスキーマ違反(稼働機に実在・scalp-plan 経路)', reply: { kind: 'error', status: 400, message: 'tool call validation failed: parameters for tool explain_move did not match schema' }, logWord: 'bad request' },
    { label: '429: quota', reply: { kind: 'error', status: 429, message: 'Rate limit reached for requests', type: 'rate_limit_exceeded' }, logWord: '429' },
    { label: '413: Request too large(oversize)', reply: { kind: 'error', status: 413, message: 'Request too large for model on tokens per minute (TPM): Limit 6000, Requested 12000', type: 'tokens_exceeded' }, logWord: 'oversize' },
    { label: '503: transient', reply: { kind: 'error', status: 503, message: 'Service Unavailable', type: 'server_error' }, logWord: 'transient' },
    { label: '500: transient', reply: { kind: 'error', status: 500, message: 'Internal server error', type: 'server_error' }, logWord: 'transient' },
  ];

  for (const c of CASES) {
    it(`${c.label} → 2番目(openai)が答えて計画が出る`, async () => {
      route.kimi = c.reply;
      const r = await planOnce();
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
      // ★連鎖が実際に次へ進んだこと。kimi で止まっていたのが事故の姿。
      expect(hitsBy.kimi).toBe(1);
      expect(hitsBy.openai).toBe(1);
      expect(r.plan.direction).toBe('sell');
      expect(r.plan.limitEntry).toBe(38310);
      // ★答えたのは2番目=「送ろうとした先」ではなく「答えた先」が記録される。
      expect((r as { provider?: { name: string } }).provider?.name).toBe('openai');
      // ログが分類を偽らないこと(どの経路で次へ回ったかが読める)。
      expect(llmWarnLines().find(l => l.includes('[LLM:kimi]'))).toContain(c.logWord);
    });
  }

  it('★400 が15時間続いても毎回 kimi から試され、毎回計画が出る(事故の再現条件)', async () => {
    for (let i = 0; i < 6; i++) {
      hitsBy = { kimi: 0, openai: 0, unknown: 0 };
      route.kimi = { kind: 'error', status: 400, message: KIMI_400 };
      const r = await planOnce();
      expect(r.ok).toBe(true);
      // 毎回 kimi → openai。連続失敗カウンタが積まれて先頭が候補から消えたりしない。
      expect(hitsBy).toEqual({ kimi: 1, openai: 1, unknown: 0 });
    }
    expect(getProviderStatus().filter(p => p.enabled).every(p => !p.paused)).toBe(true);
  });
});

// ─── ★★意図的に直していない穴: 空応答 / 壊れた JSON では次のプロバイダへ回らない ───────────
//
//  ■ 何が起きるか(この describe が固定している **現実の挙動**)
//    runChatWithTools が空文字 → '(no response)' を返す(dataTools.ts)
//      → parseScalpPlan 失敗 → **同じプロバイダへ厳格な再要求**(scalpPlan.ts の retry)
//      → それも駄目 → `throw new ScalpPlanUnparsableError('parse failed after retry: …')`
//      → classifyLLMError('parse failed after retry: …') = **null**(実測)
//      → tripCircuit が false → callWithFallback の「429以外は再投げ」枝 → **即 throw**
//    = 1番目のプロバイダで打ち切る。2番目は1度も叩かれない。
//    構造としては、400 が15時間の計画停止を起こしたのと **同じ形の穴** に見える。
//
//  ■ ★それでも直さない(2026-08-11 の決定・数字が根拠)
//    台帳 signal_plans 全1198件(2026-08-04 〜 08-11 の8日間)を数えた:
//        400 invalid temperature ... 411件  ← v0.9.73 で解決済み
//        parse failed after retry ...  1件  ← ★この経路
//        空応答 / no response ......... 0件
//    **8日で1件**。しかもその1件が「別のモデルなら正しい JSON を返した」保証は無い。
//    対してフォールバックを入れた場合の代償(実装して測った):
//        ・全滅時の外部呼び出しが 1サイクル 2回 → **最大 8回**(4プロバイダ × (tool ループ + 再要求))
//        ・★400 と違い、空応答/壊れた JSON は **トークンを実際に消費する**(400 は消費ゼロで即返る)
//        ・planning ロックが4系列ぶん延びて次のサイクルが押し出される。この経路に独自のタイムアウトは無い
//    そして払うのは「全滅が常態化したとき」= **まさに事故の再発時**。旧実装が1回で打ち切る場面で8回叩く
//    = 事故のときに最も高くつく設計になる。頻度 1/1198 に対して見合わないので **入れない**。
//
//  ■ ★次に読む人へ: 「穴が開いている、直そう」と再び判断しないこと
//    一度その判断をして実装まで進み、頻度を測って撤回した(構造だけを見て頻度を見なかった)。
//    直す前に **台帳で頻度を測る**こと。1198件中1件が10件・100件になっていたら、そのとき考え直せばよい。
//    ★`it.fails` は使わない: あれは「あるべき姿だが今は不成立」の記録で、
//      ここは「**そうすべきではない**と決めた」場所。あるべき姿として置くと次の人が同じ罠に入る。
//
//  ■ 直したのは **無音** だけ(下の最後の it)
//    以前はこの経路で [LLM:*] の warn が1行も出なかった。1件しか起きないからこそ、
//    起きた1件の原因が追えないと詰む。ログ1行だけ足した(外部呼び出しはゼロ増)。
describe('★意図的に直さない: 空応答 / 壊れた JSON ではフォールバックしない(頻度1/1198)', () => {
  for (const finish of ['stop', 'length'] as const) {
    it(`空応答(finish=${finish}) → kimi を2回叩いて諦める・openai は1度も叩かれない`, async () => {
      route.kimi = { kind: 'empty', finish };
      const r = await planOnce();
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('フォールバックが入っている=この決定を変えたなら上のコメントも書き換えること');
      expect(r.error).toContain('parse failed after retry');
      expect(hitsBy.kimi).toBe(2);        // 初回 + 厳格な再要求(どちらも同じ kimi)
      expect(hitsBy.openai).toBe(0);      // ★ここが「穴」。連鎖は一歩も進まない = **意図どおり**
    });
  }

  it('中身はあるが JSON として壊れている応答でも同じ(空だけを特別扱いしていない)', async () => {
    route.kimi = { kind: 'prose' };
    const r = await planOnce();
    expect(r.ok).toBe(false);
    expect(hitsBy).toEqual({ kimi: 2, openai: 0, unknown: 0 });
  });

  it('★外部呼び出しはゼロ増: 1サイクルの HTTP は 2回きり(ログを足しても増えていない)', async () => {
    // ★この行がフォールバック撤回の実証。偽サーバへの到達回数 = 実際の外部呼び出し回数。
    //   フォールバック版では {kimi:2, openai:1}=3回 / 全滅時は 4回 になっていた。
    route.kimi = { kind: 'empty', finish: 'stop' };
    await planOnce();
    expect(totalHits()).toBe(2);
    // 全滅(両方壊れている)でも、1番目で打ち切るので 2回のまま=2番目のトークンは1つも使わない。
    hitsBy = { kimi: 0, openai: 0, unknown: 0 };
    route = { kimi: { kind: 'prose' }, openai: { kind: 'prose' } };
    await planOnce();
    expect(totalHits()).toBe(2);
    expect(hitsBy.openai).toBe(0);
  });

  it('★無音ではない(ここだけ直した): 失敗の理由が [LLM:*] に1行残る', async () => {
    route.kimi = { kind: 'empty', finish: 'stop' };
    await planOnce();
    const line = llmWarnLines().find(l => l.includes('[LLM:kimi]'));
    expect(line).toBeDefined();
    expect(line).toContain('scalp-plan unparsable');
    expect(line).toContain('parse failed after retry');
    // ★応答の **長さ** だけを載せる(本文は載せない=モデルの生出力に非公開の決済数値が混じりうる)。
    //   長さで「空応答(len=0)」と「中身はあるが壊れた JSON(len>0)」を **本文を見ずに** 切り分けられる。
    expect(line).toContain('len1=0');
    expect(line).toContain('len2=0');
    // ★フォールバックしていないことは、ログの側からも読める(1プロバイダぶんの行しか無い)。
    expect(llmWarnLines().filter(l => l.includes('[LLM:openai]'))).toEqual([]);
  });

  it('★否定対照: このログは parse 失敗のときだけ。HTTP エラー(400)では出さない(同じ故障を2行にしない)', async () => {
    route.kimi = { kind: 'error', status: 400, message: 'invalid temperature: only 1 is allowed for this model' };
    expect((await planOnce()).ok).toBe(true);
    const kimiLines = llmWarnLines().filter(l => l.includes('[LLM:kimi]'));
    expect(kimiLines.some(l => l.includes('bad request'))).toBe(true);        // tripCircuit の行は出る
    expect(kimiLines.some(l => l.includes('scalp-plan unparsable'))).toBe(false);   // こちらは出さない
  });
});

// ─── ★健全なプロバイダを不必要にポーズしないこと ───────────────────────────
describe('★400 / oversize / 空応答では健全なプロバイダをポーズしない', () => {
  const pausedUntilOf = (name: string) => getProviderStatus().find(p => p.name === name)!.pausedUntil;

  it('400 の後も kimi は非ポーズ(pausedUntil も1ミリも動かない)', async () => {
    route.kimi = { kind: 'error', status: 400, message: 'invalid temperature: only 1 is allowed for this model' };
    expect((await planOnce()).ok).toBe(true);
    expect(getProviderStatus().find(p => p.name === 'kimi')!.paused).toBe(false);
    expect(pausedUntilOf('kimi')).toBe(0);
    expect(pausedUntilOf('openai')).toBe(0);
  });

  it('413(oversize)の後も kimi は非ポーズ', async () => {
    route.kimi = { kind: 'error', status: 413, message: 'Request too large for model on tokens per minute (TPM): Limit 6000, Requested 12000' };
    expect((await planOnce()).ok).toBe(true);
    expect(pausedUntilOf('kimi')).toBe(0);
  });

  it('空応答でも kimi はポーズされない(200 を返している=プロバイダは健全)', async () => {
    // ★計画は出ない(上の「未修正の欠陥」参照)が、**ポーズはしない**ことは今も成り立つ。
    //   ここを固定しておくと、欠陥を直すときに「ついでにポーズさせる」実装を選べなくなる。
    route.kimi = { kind: 'empty', finish: 'stop' };
    await planOnce();
    expect(pausedUntilOf('kimi')).toBe(0);
    expect(pausedUntilOf('openai')).toBe(0);
  });

  it('★否定対照: 503(transient)なら kimi はポーズされ、次回は候補から外れる(規律は緩めていない)', async () => {
    route.kimi = { kind: 'error', status: 503, message: 'Service Unavailable' };
    expect((await planOnce()).ok).toBe(true);
    expect(getProviderStatus().find(p => p.name === 'kimi')!.paused).toBe(true);
    // 次の計画では kimi を飛ばして openai だけを叩く。
    hitsBy = { kimi: 0, openai: 0, unknown: 0 };
    expect((await planOnce()).ok).toBe(true);
    expect(hitsBy).toEqual({ kimi: 0, openai: 1, unknown: 0 });
  });

  it('★否定対照: 429 なら kimi はポーズされる(400 との違いが実際に出ている)', async () => {
    route.kimi = { kind: 'error', status: 429, message: 'Rate limit reached for requests' };
    expect((await planOnce()).ok).toBe(true);
    expect(getProviderStatus().find(p => p.name === 'kimi')!.paused).toBe(true);
  });
});

// ─── ★否定対照: 全滅なら計画は出ない(「常に出る」テストになっていないことの証明) ─────
describe('★全プロバイダが落ちたら計画は出ない(=このテストは恒真ではない)', () => {
  it('両方 400 → ok:false・error に実文が残る・plan は生まれない', async () => {
    const reply: Reply = { kind: 'error', status: 400, message: 'invalid temperature: only 1 is allowed for this model' };
    route = { kimi: reply, openai: reply };
    const r = await planOnce();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('全滅したのに計画が出た');
    expect(r.error).toContain('invalid temperature');
    expect(hitsBy).toEqual({ kimi: 1, openai: 1, unknown: 0 });   // ★両方きちんと試した上で失敗している
  });

  it('両方 429 → ok:false', async () => {
    const reply: Reply = { kind: 'error', status: 429, message: 'Rate limit reached for requests' };
    route = { kimi: reply, openai: reply };
    expect((await planOnce()).ok).toBe(false);
    expect(hitsBy.kimi).toBe(1);
    expect(hitsBy.openai).toBe(1);
  });

  it('両方 空応答 → ok:false(空を計画に化けさせない)', async () => {
    const reply: Reply = { kind: 'empty', finish: 'stop' };
    route = { kimi: reply, openai: reply };
    const r = await planOnce();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('全滅したのに計画が出た');
    expect(r.error).toContain('parse failed after retry');
    // ★kimi で打ち切るので openai には届かない(意図どおり=上の「意図的に直さない」describe を参照)。
    expect(hitsBy).toEqual({ kimi: 2, openai: 0, unknown: 0 });   // 初回 + 厳格な再要求(どちらも kimi)
  });

  it('両方 503 → ok:false・両方ポーズ・次の呼び出しは1回も外へ出ない', async () => {
    const reply: Reply = { kind: 'error', status: 503, message: 'Service Unavailable' };
    route = { kimi: reply, openai: reply };
    expect((await planOnce()).ok).toBe(false);
    expect(getProviderStatus().filter(p => p.enabled).every(p => p.paused)).toBe(true);
    hitsBy = { kimi: 0, openai: 0, unknown: 0 };
    expect((await planOnce()).ok).toBe(false);
    expect(totalHits()).toBe(0);      // 全ポーズ中は外へ出ない(定型の 429 文言で即失敗)
  });

  it('★キーが1つも無ければ計画は出ない(プロバイダ不在の経路)', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    resetConfigCache();
    reloadProviders();
    const r = await planOnce();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('LLM未設定');
    expect(totalHits()).toBe(0);
  });
});

// ─── ★事故の姿そのもの: 台帳(signal_plans.error)まで見る ────────────────────
//
//  事故中は 487件中 411件が error 行だった。「計画が出ない」は **台帳の error 列** としてしか現れない
//  (scalpPlan.ts の catch も engine の flat 分岐もログを出さない=サーバログは完全に無音)。
//  ここでは同じ故障で、フォールバックが効けば **error 行が生まれない** ことを実 SQLite で示す。
describe('★台帳: 1番目が壊れても error 行にならない / 全滅では error 行になる', () => {
  let dir = '';
  let db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scalp-provfail-db-'));
    db = new DatabaseSync(join(dir, 'test.db'));
    initSchema(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('kimi が 400 → 台帳は direction=sell・error は NULL・答えたのは openai', async () => {
    route.kimi = { kind: 'error', status: 400, message: 'invalid temperature: only 1 is allowed for this model' };
    const r = await planOnce();
    insertSignalPlan(db, buildSignalPlanInsert({ t: 1000, system: 'A', result: r }));
    const row = getSignalPlans(db)[0]!;
    expect(row.error).toBeNull();
    expect(row.direction).toBe('sell');
    expect(row.limit_entry).toBe(38310);
    expect(row.provider).toBe('openai');
  });

  it('★全滅 → 台帳に error 行が立つ(事故中の411件と同じ形)', async () => {
    const reply: Reply = { kind: 'error', status: 400, message: 'invalid temperature: only 1 is allowed for this model' };
    route = { kimi: reply, openai: reply };
    const r = await planOnce();
    insertSignalPlan(db, buildSignalPlanInsert({ t: 2000, system: 'A', result: r }));
    const row = getSignalPlans(db)[0]!;
    expect(row.error).toContain('invalid temperature');
    expect(row.direction).toBeNull();
  });
});
