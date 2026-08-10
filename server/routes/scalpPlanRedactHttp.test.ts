import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

// ─── ★/api/scalp-plan の応答が秘密を持ち出さないこと(実 HTTP) ────────────────────
//
// この応答は trade2 が受け取り `chrono_kabu.log` に `monitorError=` として記録し、
// **同期フォルダへ出る**。実測(同期フォルダ): 401 のキーエコー 1,758件 / 413 1,019件。
// 実キー文字が出ていなかったのは提供元が `****` で伏せていたからで、こちら側の防御は無かった。
//
// 落とすものは2種:
//   ① APIキー
//   ② V8 が JSON.parse 失敗メッセージに埋め込む **モデルの生出力の断片**
//      (describeExitLogic が実行時注入する **非公開の決済ロジックの数値** を運びうる)
// sanitizeErrorForOutput を **発生源(llm/scalpPlan.ts の catch)** と
// **プロセスから出る境界(この route)** の両方で通す(冪等なので二重適用でも文字列は同じ)。
// ここは境界の担保: 発生源が将来増えても、HTTP から出る時点で必ず通る。
//
// ★否定対照(修正前の routes/scalpPlan.ts): `error: result.error` をそのまま返しており、
//   下の「本文にキー文字列が出ない」は成立しえない。
//   実証手順: git show HEAD:server/routes/scalpPlan.ts で差し替えて実行。
//
// ★実在のキーは1文字も書かない。すべて架空の文字列。外部へは一切出ない(runner はモック)。

const runMock = vi.fn();
vi.mock('../llm/scalpPlanRunner.js', () => ({
  runScalpPlanWithChart: (...a: unknown[]) => runMock(...a),
}));
vi.mock('../configStore.js', () => ({ resolveGeneratorDailyBudget: () => 1000 }));
vi.mock('../signalTrade/exitVariantImpl.js', () => ({
  exitVariantImplKind: () => 'private',
  exitVariantImplKindAll: () => 'private',
}));

import { scalpPlanHandler } from './scalpPlan.js';
import { resetGeneratorGateForTest } from '../llm/generatorGate.js';

/** 架空のキー(実在のキーではない)。 */
const FAKE = {
  openaiProj: 'sk-proj-FAKE0123456789abcdefGHIJ',
  groq: 'gsk_FAKEkey0123456789abcdef',
  google: 'AIzaSyFAKE0123456789abcdefGHIJ',
};
/** Groq 413 の形(末尾まで含む)。伏字対象は無いので**1文字も変わってはいけない**。 */
const GROQ_413 = '413 Request too large for model `llama-3.3-70b-versatile` in organization `org_xxx` '
  + 'service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 13500, '
  + 'please reduce your message size and try again.';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/api/scalp-plan', scalpPlanHandler);
  server = app.listen(0);
  await new Promise<void>(resolve => server.on('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

beforeEach(() => {
  runMock.mockReset();
  resetGeneratorGateForTest();
  vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
  vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
  vi.spyOn(console, 'error').mockImplementation(() => { /* noop */ });
});

/** 実 HTTP で叩き、**生の本文文字列**とパース結果を返す(フィールド単位の見落としを防ぐ)。 */
async function post(): Promise<{ status: number; raw: string; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/scalp-plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const raw = await res.text();
  return { status: res.status, raw, body: JSON.parse(raw) as Record<string, unknown> };
}

describe('/api/scalp-plan の error にキーを載せない(実 HTTP)', () => {
  it('★ok:false の 401 キーエコー → 本文にキー文字列が出ない', async () => {
    runMock.mockResolvedValue({
      ok: false,
      error: `401 Incorrect API key provided: ${FAKE.openaiProj}. You can find your API key at https://platform.openai.com/account/api-keys`,
    });
    const { status, raw, body } = await post();
    expect(status).toBe(200);
    expect(raw).not.toContain(FAKE.openaiProj);          // 生の本文にも出ない
    expect(body.error).toContain('<キー伏字>');
    // ★診断情報は失われない(切り詰めていない)
    expect(body.error).toContain('401');
    expect(body.error).toContain('Incorrect API key provided');
    expect(body.error).toContain('https://platform.openai.com/account/api-keys');
  });

  it('★他プロバイダのキー形式(gsk_ / AIza)も出ない', async () => {
    for (const key of [FAKE.groq, FAKE.google]) {
      runMock.mockResolvedValue({ ok: false, error: `401 invalid key: ${key}` });
      const { raw, body } = await post();
      expect(raw).not.toContain(key);
      expect(body.error).toContain('<キー伏字>');
    }
  });

  it('★413 の実文は1文字も変わらない(診断値を落とさない)', async () => {
    runMock.mockResolvedValue({ ok: false, error: GROQ_413 });
    const { body } = await post();
    expect(body.error).toBe(GROQ_413);
    expect(body.error).toContain('Limit 12000');
    expect(body.error).toContain('Requested 13500');
  });

  it('404 / チャート未生成 / LLM未設定 の文言も変わらない(既存の見送り記録を壊さない)', async () => {
    for (const msg of ['404 Not found the model kimi-latest or Permission denied',
      'chart-not-generated', 'LLM未設定', '現在値が使えない(NIY=F の現在値がキャッシュに無い)']) {
      runMock.mockResolvedValue({ ok: false, error: msg });
      expect((await post()).body.error).toBe(msg);
    }
  });

  // ★V8 の JSON.parse 失敗メッセージは **入力(=モデルの生出力)の断片** を埋め込む。
  //   scalp-plan のプロンプトには describeExitLogic() が **非公開の決済ロジックの実数値** を
  //   実行時注入しており、モデルは根拠文でその数値を言い直す。断片がそれを含む可能性は
  //   否定できず、この応答は trade2 → chrono_kabu.log → 同期フォルダ、と外へ出る。
  // ★ここに実数値は書かない(検査そのものが漏洩になっては本末転倒)。下は**架空**の数値で、
  //   「数値を含む断片が丸ごと消えること」だけを見る。
  it('★パース失敗の応答に、モデル生出力の断片(架空の決済数値)が載らない', async () => {
    const FAKE_EXIT_NOTE = '含み益+9999円で逆指値を+8888円へ、以降1111円刻み';   // ★架空
    let v8 = '';
    try { JSON.parse(`{"pad":"${'y'.repeat(200)}","legs":["${FAKE_EXIT_NOTE}",あ]}`); }
    catch (e) { v8 = e instanceof Error ? e.message : String(e); }
    // 前提: この Node で断片にアプリのデータが入っている(窓は約30字なので入る数値は形次第)
    expect(/9999|8888|1111|刻み/.test(v8)).toBe(true);
    runMock.mockResolvedValue({ ok: false, error: `parse failed after retry: JSON parse failed: ${v8}` });

    const { raw, body } = await post();
    for (const n of ['9999', '8888', '1111', '刻み', '逆指値']) expect(raw).not.toContain(n);
    expect(body.error).toContain('<入力省略>');
    // ★失敗した事実と例外の種類は残る(診断は死なない)
    expect(body.error).toContain('parse failed after retry');
    expect(body.error).toContain('Unexpected token');
    expect(body.error).toContain('is not valid JSON');
  });

  it('★500 経路(handler が例外)でもキーが出ない', async () => {
    runMock.mockRejectedValue(new Error(`401 Incorrect API key provided: ${FAKE.openaiProj}`));
    const { status, raw, body } = await post();
    expect(status).toBe(500);
    expect(raw).not.toContain(FAKE.openaiProj);
    expect(body.error).toContain('<キー伏字>');
  });

  it('ok:true の応答は従来どおり(伏字は ok:false 経路だけ)', async () => {
    const plan = { direction: 'buy', rationale: '押し目', refPrice: 38250 };
    runMock.mockResolvedValue({ ok: true, plan });
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, plan });
  });
});
