// /api/explain の検知種別 allowlist の回帰テスト(実HTTP)。
//
// 事故(v0.9.36 出荷時から): 検知種別リストが core/types.ts の union と手書きで二重化しており、
// 新種別 nwave / dailyband が allowlist に入っていなかったため、アラートをクリックすると
// /api/explain が HTTP 400 を返し、バナーが常に「説明取得失敗」になっていた。
//
// このテストは「union にある全種別が allowlist を通ること」を実 HTTP(express + listen)で検証する。
// 対象リストは routes/explain.ts の DETECTION_KINDS を使うが、この定数は同ファイル内で
// core/types.ts の union に対する漏れが型エラーになるよう縛ってある(_allKindsListed)ので、
// 種別を足して足し忘れれば typecheck が、通れば本テストが実際の HTTP で守る。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

// LLM/DB には触らない(allowlist の通過可否だけを見る)。
const explainMock = vi.fn(async () => ({ text: '(stub explanation)', newsMaxPublishedAt: 0 }));
vi.mock('../llm/openai.js', () => ({ explain: (...args: unknown[]) => explainMock(...(args as [])) }));
vi.mock('../llm/explainInput.js', () => ({ buildExplainInput: (a: unknown) => a }));
vi.mock('../cache.js', () => ({ getNews: () => [] }));
vi.mock('../shockWindow.js', () => ({ noteReferencedNews: () => {} }));

import { explainHandler, DETECTION_KINDS } from './explain.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/api/explain', explainHandler);
  server = app.listen(0);
  await new Promise<void>(resolve => server.on('listening', () => resolve()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function post(detectionKind: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/api/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'NIY=F', symbolLabel: '日経平均先物', changePercent: 0, windowSeconds: 60,
      detectionKind, direction: 'up', change15min: null, pa15min: null, range1h: null,
    }),
  });
  return { status: res.status, body: await res.text() };
}

describe('/api/explain detectionKind allowlist (real HTTP)', () => {
  // 全種別を網羅。次に種別を足したときに同じ事故が起きないよう、リストは DETECTION_KINDS 由来。
  it.each(DETECTION_KINDS.map(k => [k]))('accepts detectionKind=%s (not 400)', async (kind) => {
    const { status, body } = await post(kind);
    expect({ kind, status, body }).toMatchObject({ status: 200 });
    expect(body).not.toContain('invalid body');
  });

  // 出荷時から壊れていた 2 種別(v0.9.36)。上の全網羅に含まれるが、事故の再発を名指しで残す。
  it('accepts the v0.9.36 kinds nwave / dailyband that used to 400', async () => {
    expect((await post('nwave')).status).toBe(200);
    expect((await post('dailyband')).status).toBe(200);
  });

  it('still rejects an unknown detectionKind with 400', async () => {
    const { status, body } = await post('not_a_kind');
    expect(status).toBe(400);
    expect(body).toContain('invalid body');
  });
});
