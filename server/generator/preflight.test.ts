import { describe, it, expect } from 'vitest';

// ─── 起動時の検証(満たさなければ **走らない**)──────────────────────────────────
//
// 何を守っているか:
//   前提が崩れたまま1年走ると、溜まるのは「測ったふりをした標本」。しかも捨てられるのは
//   崩れていたことに気づけた場合だけ。だから起動時に全部確かめ、1つでも欠ければ理由を明示して終了する。
//
// ★否定対照: evaluatePreflight を「常に ok:true を返す」に変えると、下の停止4件がすべて赤になる
//   (公開フォールバック・変種の実体なし・共通キーへのフォールバック・monitor 不到達)。

import { evaluatePreflight, runPreflight } from './preflight.js';

const okStatus = {
  exit: { impl: 'private', variantImpl: 'private', configVersion: 3, configHash: 'e01dde67fe62b2f8' },
};
const okSettings = {
  generatorKeySources: { gemini: 'own', groq: 'own', openai: 'env', kimi: 'own' },
  scalpLcFloorYen: 45,
};

describe('evaluatePreflight — 前提が揃ったときだけ走る', () => {
  it('全部揃えば ok:true。決済の版と指紋、凍結設定を返す', () => {
    const r = evaluatePreflight(okStatus, okSettings);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exit).toEqual({ impl: 'private', variantImpl: 'private', configVersion: 3, configHash: 'e01dde67fe62b2f8' });
    expect(r.settings).toBe(okSettings);   // ★/api/settings の生スナップショット(取引記録から推測しない)
  });

  it('版が未採番(null)でも走る(指紋があれば実体は一意)', () => {
    const r = evaluatePreflight({ exit: { ...okStatus.exit, configVersion: null } }, okSettings);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.exit.configVersion).toBeNull();
  });

  it('★決済実装が公開フォールバック → 走らない', () => {
    const r = evaluatePreflight({ exit: { ...okStatus.exit, impl: 'fallback' } }, okSettings);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('決済実装が非公開実装ではありません');
  });

  it('★変種の実装が実体を持たない → 走らない(①と②が同じ質問になる)', () => {
    const r = evaluatePreflight({ exit: { ...okStatus.exit, variantImpl: 'fallback' } }, okSettings);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('変種が実体を持ちません');
  });

  it('★専用キーが共通キーへフォールバックしている → 走らない(A が429を踏む)', () => {
    const r = evaluatePreflight(okStatus, {
      generatorKeySources: { gemini: 'shared', groq: 'own', openai: 'own', kimi: 'own' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('gemini=shared');
      expect(r.reason).toContain('専用キーが未設定');
    }
  });

  it('★キーがどこにも無い(none)プロバイダがあっても走らない', () => {
    const r = evaluatePreflight(okStatus, {
      generatorKeySources: { gemini: 'own', groq: 'own', openai: 'own', kimi: 'none' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('kimi=none');
  });

  it('generatorKeySources が無い(公開版 lite の monitor)→ 走らない', () => {
    const r = evaluatePreflight(okStatus, { scalpLcFloorYen: 45 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('generatorKeySources');
  });

  it('exit ブロックが無い / 観測失敗 → 走らない', () => {
    expect(evaluatePreflight({}, okSettings).ok).toBe(false);
    const r = evaluatePreflight({ exit: { error: 'exit-status-unavailable' } }, okSettings);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('exit-status-unavailable');
  });

  it('決済設定の指紋が無い → 走らない(指紋の無い期は作らない)', () => {
    const r = evaluatePreflight({ exit: { impl: 'private', variantImpl: 'private', configVersion: 1 } }, okSettings);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('configHash');
  });
});

describe('runPreflight — 到達できないことも理由つきで返す(例外にしない)', () => {
  const jsonRes = (body: unknown, status = 200): Response =>
    ({ ok: status === 200, status, json: async () => body }) as unknown as Response;

  it('★monitor 不到達 → ok:false に理由が入る', async () => {
    const r = await runPreflight('http://127.0.0.1:1', async () => { throw new Error('ECONNREFUSED'); }, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('到達できません');
      expect(r.reason).toContain('ECONNREFUSED');
    }
  });

  it('HTTP エラー(500)も理由つきで停止する', async () => {
    const r = await runPreflight('http://x', async () => jsonRes({}, 500), 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('HTTP 500');
  });

  it('到達できれば evaluatePreflight の判定を返す', async () => {
    const r = await runPreflight('http://x', async (url) =>
      jsonRes(String(url).endsWith('/api/status') ? okStatus : okSettings), 100);
    expect(r.ok).toBe(true);
  });
});
