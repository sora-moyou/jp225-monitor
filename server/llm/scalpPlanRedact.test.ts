import { describe, it, expect, vi } from 'vitest';
import type { Price } from '../types.js';

// ─── ★既に存在していた漏洩経路: /api/scalp-plan の error がキーを素通しする ──────────
//
// buildScalpPlan の catch は `e.message` を**そのまま** `{ok:false, error}` に載せていた。
// その応答は trade2 が受け取り `chrono_kabu.log` に `monitorError=` として記録し、
// **同期フォルダへ出る**。実測(同期フォルダ): 401 のキーエコー 1,758件 / 413 1,019件。
// 実キー文字が出ていなかったのは **提供元が `****` で伏せていたから**で、こちら側の防御は無かった。
// 提供元が伏せ方を変えれば、そのまま同期フォルダに出る=運任せだった。
//
// ★否定対照(修正前のコードでこのファイルが赤くなること):
//   修正前は `error: e instanceof Error ? e.message : String(e)` で redactSecrets が無い。
//   下の「キーが応答に出ない」アサーションは成立しえない。
//   実証手順: git show HEAD:server/llm/scalpPlan.ts で差し替えて実行。
//
// ★実在のキーは1文字も書かない。すべて架空の文字列。
// ★外部 LLM は叩かない: callWithFallback をモックして必ず投げる。

const failWith = { msg: '' };
vi.mock('./providers.js', () => ({
  // ★providers.js の実物が持つエラー型。scalpPlan.ts が import するのでモックにも要る
  //   (無いと `extends undefined` で読み込みに失敗する)。検証の強さには関与しない。
  NoFallbackError: class NoFallbackError extends Error {},
  isLLMEnabled: () => true,
  isVisionCapableProvider: () => false,
  callWithFallback: async () => { throw new Error(failWith.msg); },
}));
vi.mock('./webSearch.js', () => ({ isWebSearchEnabled: () => false, webSearch: async () => '' }));
vi.mock('./dataTools.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  buildMonitorContext: () => '',
}));

const { buildScalpPlan } = await import('./scalpPlan.js');

const PRICES: Price[] = [
  { symbol: 'NIY=F', price: 38250, changePercent: 0, timestamp: Date.now(), stale: false } as Price,
];
/** 架空のキー(実在のキーではない)。 */
const FAKE_KEY = 'sk-proj-FAKE0123456789abcdefGHIJ';

async function errorFor(msg: string): Promise<string> {
  failWith.msg = msg;
  const r = await buildScalpPlan({ symbol: 'NIY=F', prices: PRICES, news: [] });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('失敗するはずが成功した');
  return r.error;
}

describe('buildScalpPlan の ok:false error — キーを載せない(発生源での伏字)', () => {
  it('★401 のキーエコーが応答に出ない', async () => {
    const err = await errorFor(`401 Incorrect API key provided: ${FAKE_KEY}. See docs`);
    expect(err).not.toContain(FAKE_KEY);
    expect(err).toContain('<キー伏字>');
    // ★診断情報は失われない(切り詰めない)
    expect(err).toContain('401');
    expect(err).toContain('Incorrect API key provided');
    expect(err).toContain('See docs');
  });

  it('★413 の実文は1文字も変わらない(切り詰めない=画面の診断値を落とさない)', async () => {
    const msg = '413 Request too large for model `llama-3.3-70b-versatile` in organization `org_xxx` '
      + 'service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 13500, '
      + 'please reduce your message size and try again. Need more tokens per minute (TPM)? '
      + 'Upgrade to Dev Tier: https://console.groq.com/settings/billing';
    expect(await errorFor(msg)).toBe(msg);
  });

  it('404(モデル不明)もそのまま残る', async () => {
    const msg = '404 Not found the model kimi-latest or Permission denied';
    expect(await errorFor(msg)).toBe(msg);
  });
});
