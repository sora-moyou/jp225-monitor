import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';

// ─── ★B2: epoch と前提検証を「起動時1回」でなく **サイクルごと** に ────────────────
//
// 何が壊れていたか:
//   epoch.ts はこう宣言している —「**入力が動けば epoch が自動で変わる** ようにする(人が手で版を
//   上げる運用にしない=上げ忘れた瞬間に静かに嘘になる)」。ところが実際に計算していたのは main() の
//   **ループの外** で1回だけ。プロセスは数か月動き続け、その間バイアスや LC 安全上限をライブで
//   切り替えるのは常態なので、**設定を変えた瞬間から別条件の標本が同じ期のラベルで積まれ続ける**。
//   同じ穴が前提検証にもある(稼働中に専用キーを外しても再検証されず、共通キーへ黙って落ちる)。
//
// ★方針: 期が変わったら **止めるのではなく期を分ける**。前提が **崩れた** ら止める。
//   monitor に届かないだけ(再起動など)は前提が崩れた証拠ではないので止めない。
//
// ★否定対照(修正前): server/generator/recheck.ts が無く、index.ts は main() のループ外で
//   1回だけ computeEpoch/runPreflight を呼ぶので、このファイルは import 段で解決できず全部赤。
//
// ★外部 LLM は一切叩かない(偽 monitor を実 HTTP で立てるだけ)。

import { recheck, epochInputDiffKeys } from './recheck.js';
import { resolveGeneratorConfig } from './config.js';

const STATUS_JSON = {
  yahoo: { fallback: false, skipUntil: 0 },
  llm: [],
  exit: { impl: 'private', variantImpl: 'private', configVersion: 3, configHash: 'e01dde67fe62b2f8' },
};
const SETTINGS_JSON: Record<string, unknown> = {
  generatorKeySources: { gemini: 'own', groq: 'own', openai: 'own', kimi: 'env' },
  generatorDailyBudget: 800,
  tradeBias: 'none',
  scalpLcFloorYen: 45,
  providers: [{ name: 'gemini', enabled: true, paused: false, pausedUntil: 0 }],
};

/** 応答を差し替えられる偽 monitor。 */
function fakeMonitor(state: { status: unknown; settings: unknown }): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/status' ? state.status : state.settings));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) { try { cleanup.pop()!(); } catch { /* ignore */ } } });

describe('★稼働中の再検証(実 HTTP)', () => {
  it('設定が変わらなければ epoch も変わらない(期は割れない)', async () => {
    const state = { status: STATUS_JSON, settings: { ...SETTINGS_JSON } };
    const { server, url } = await fakeMonitor(state);
    cleanup.push(() => server.close());
    const cfg = resolveGeneratorConfig({ GENERATOR_MONITOR_URL: url }, 3000);

    const first = await recheck(cfg, fetch, 5_000, null);
    expect(first.kind).toBe('same');
    if (first.kind !== 'same') return;
    const again = await recheck(cfg, fetch, 5_000, first.epoch);
    expect(again.kind).toBe('same');
  });

  it('★設定を変えた瞬間に期が変わる(バイアスをライブで切り替える=この案件では常態)', async () => {
    const state = { status: STATUS_JSON, settings: { ...SETTINGS_JSON } };
    const { server, url } = await fakeMonitor(state);
    cleanup.push(() => server.close());
    const cfg = resolveGeneratorConfig({ GENERATOR_MONITOR_URL: url }, 3000);

    const first = await recheck(cfg, fetch, 5_000, null);
    expect(first.kind).toBe('same');
    if (first.kind !== 'same') return;

    // ── ライブでバイアスを切り替える(A の挙動が変わる=別条件の標本になる)
    state.settings = { ...SETTINGS_JSON, tradeBias: 'long' };
    const after = await recheck(cfg, fetch, 5_000, first.epoch);
    expect(after.kind).toBe('epoch-changed');
    if (after.kind !== 'epoch-changed') return;
    expect(after.epoch).not.toBe(first.epoch);
    expect(after.prevEpoch).toBe(first.epoch);
    // ★何が変わって期が割れたかが読める(値ではなくキー名)。
    expect(epochInputDiffKeys(first.epochInput, after.epochInput)).toEqual(['settings.tradeBias']);
  });

  it('★LC 安全上限を変えても期が変わる(凍結設定の一部だから)', async () => {
    const state = { status: STATUS_JSON, settings: { ...SETTINGS_JSON } };
    const { server, url } = await fakeMonitor(state);
    cleanup.push(() => server.close());
    const cfg = resolveGeneratorConfig({ GENERATOR_MONITOR_URL: url }, 3000);
    const first = await recheck(cfg, fetch, 5_000, null);
    if (first.kind !== 'same') throw new Error('前提が立たない');
    state.settings = { ...SETTINGS_JSON, scalpLcFloorYen: 60 };
    const after = await recheck(cfg, fetch, 5_000, first.epoch);
    expect(after.kind).toBe('epoch-changed');
  });

  it('揺れる値(プロバイダのポーズ状態)では期は割れない(epoch が毎回変わったら期の概念が消える)', async () => {
    const state = { status: STATUS_JSON, settings: { ...SETTINGS_JSON } };
    const { server, url } = await fakeMonitor(state);
    cleanup.push(() => server.close());
    const cfg = resolveGeneratorConfig({ GENERATOR_MONITOR_URL: url }, 3000);
    const first = await recheck(cfg, fetch, 5_000, null);
    if (first.kind !== 'same') throw new Error('前提が立たない');
    state.settings = { ...SETTINGS_JSON, providers: [{ name: 'gemini', enabled: true, paused: true, pausedUntil: 999 }] };
    expect((await recheck(cfg, fetch, 5_000, first.epoch)).kind).toBe('same');
  });

  it('★稼働中に分析用専用キーが外れたら violated(=止める)', async () => {
    const state = { status: STATUS_JSON, settings: { ...SETTINGS_JSON } };
    const { server, url } = await fakeMonitor(state);
    cleanup.push(() => server.close());
    const cfg = resolveGeneratorConfig({ GENERATOR_MONITOR_URL: url }, 3000);
    const first = await recheck(cfg, fetch, 5_000, null);
    expect(first.kind).toBe('same');

    state.settings = {
      ...SETTINGS_JSON,
      generatorKeySources: { gemini: 'shared', groq: 'own', openai: 'own', kimi: 'env' },
    };
    const after = await recheck(cfg, fetch, 5_000, first.kind === 'same' ? first.epoch : null);
    expect(after.kind).toBe('violated');
    if (after.kind === 'violated') expect(after.reason).toContain('gemini=shared');
  });

  it('★稼働中に決済実装が公開フォールバックに落ちたら violated(=止める)', async () => {
    const state = { status: STATUS_JSON, settings: { ...SETTINGS_JSON } };
    const { server, url } = await fakeMonitor(state);
    cleanup.push(() => server.close());
    const cfg = resolveGeneratorConfig({ GENERATOR_MONITOR_URL: url }, 3000);
    state.status = { ...STATUS_JSON, exit: { ...STATUS_JSON.exit, variantImpl: 'fallback' } };
    const r = await recheck(cfg, fetch, 5_000, 'g1:whatever');
    expect(r.kind).toBe('violated');
  });

  it('★monitor に届かないだけなら unreachable(=止めない。再起動で実験を殺さない)', async () => {
    const cfg = resolveGeneratorConfig({ GENERATOR_MONITOR_URL: 'http://127.0.0.1:1' }, 3000);
    const r = await recheck(cfg, fetch, 1_500, 'g1:whatever');
    expect(r.kind).toBe('unreachable');
  });
});

describe('期が割れた理由(キー名だけ)', () => {
  it('入れ子でも変わったキーの経路を返す / 同じなら空', () => {
    expect(epochInputDiffKeys({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } })).toEqual(['a.c']);
    expect(epochInputDiffKeys({ a: 1 }, { a: 1 })).toEqual([]);
    expect(epochInputDiffKeys({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
  });
});
