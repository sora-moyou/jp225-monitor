import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  shouldIgnoreDefaultQuota, sharedGeneratorProviders, isDedicatedGeneratorKey,
  notifyDefaultQuota, checkGeneratorGate, resetGeneratorGateForTest, generatorQuotaIgnored,
} from './generatorGate.js';

// ─── ★従属停止の見送りは「分析用 **全体** が専用キー」のときだけ ────────────────────
//
// 何が食い違っていたか(サブリーダー指摘 E):
//   generatorGate.ts のコメントは「停止そのものは従来どおり分析用 **全体** に効く。
//   共有プロバイダの枠を食う経路は分析用のフォールバック順で必ず通りうるので、そこは弱めない」
//   と書いているのに、**見送り(止めない)の判断は 429 を踏んだそのプロバイダだけ** を見ていた。
//   例) gemini=専用 / openai=共有 のとき、gemini の429で停止が丸ごと見送られ、
//       分析用はフォールバックで **共有の openai** を食える = A の枠を守れていない。
//
// ★否定対照(修正前): notifyDefaultQuota に allSources が無く、
//   `isDedicatedGeneratorKey(keySource)` だけで見送りを決めていた
//   = 下の「混在なら止める」ケースが素通り(= 止まらない)になる。
//
// ★保護を弱めない/強めすぎない:
//   ・全プロバイダが専用 … 従来どおり見送る(実際のユーザー設定はこれ = 挙動不変)
//   ・出どころを渡さない既存の呼び出し … 従来どおり踏んだプロバイダだけで決める(挙動不変)

describe('shouldIgnoreDefaultQuota(純関数)', () => {
  it('全部が専用キーなら見送る(上流クォータが完全に分かれている)', () => {
    expect(shouldIgnoreDefaultQuota('own', { gemini: 'own', groq: 'env', openai: 'own' })).toBe(true);
  });

  it('★1つでも共有が残っていれば見送らない(フォールバックでそこを食いうる)', () => {
    expect(shouldIgnoreDefaultQuota('own', { gemini: 'own', openai: 'shared' })).toBe(false);
    expect(shouldIgnoreDefaultQuota('own', { gemini: 'own', openai: 'none' })).toBe(false);
    expect(shouldIgnoreDefaultQuota('own', { gemini: 'own', openai: undefined })).toBe(false);
  });

  it('踏んだプロバイダが専用でなければ、そもそも見送らない(従来どおり)', () => {
    expect(shouldIgnoreDefaultQuota('shared', { gemini: 'own', groq: 'own' })).toBe(false);
    expect(shouldIgnoreDefaultQuota(undefined, { gemini: 'own' })).toBe(false);
  });

  it('出どころ一覧を渡さない呼び出しは踏んだプロバイダだけで決める(既存の挙動を変えない)', () => {
    expect(shouldIgnoreDefaultQuota('own')).toBe(true);
    expect(shouldIgnoreDefaultQuota('shared')).toBe(false);
    expect(shouldIgnoreDefaultQuota('own', {})).toBe(true);   // 観測できなかった = 従来どおり
  });

  it('止めた理由を名指しできる(どのプロバイダが共有なのか)', () => {
    expect(sharedGeneratorProviders({ gemini: 'own', groq: 'shared', openai: 'none' }))
      .toEqual(['groq', 'openai']);
    expect(sharedGeneratorProviders({ gemini: 'own' })).toEqual([]);
  });

  it('専用の語彙は configStore のものをそのまま使う(新しい語彙を作らない)', () => {
    expect(isDedicatedGeneratorKey('own')).toBe(true);
    expect(isDedicatedGeneratorKey('env')).toBe(true);
    expect(isDedicatedGeneratorKey('shared')).toBe(false);
  });
});

describe('notifyDefaultQuota(実際に止まる/止まらない)', () => {
  beforeEach(() => {
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('★混在(gemini=専用 / openai=共有)で gemini が429 → 分析用は止まる', () => {
    notifyDefaultQuota('gemini', Date.now(), 60_000, 'own', { gemini: 'own', openai: 'shared' });
    const g = checkGeneratorGate();
    expect(g.allowed).toBe(false);
    expect(g.allowed === false && g.reason).toBe('default-quota');
    expect(generatorQuotaIgnored().count).toBe(0);
  });

  it('全部専用なら従来どおり止まらない(ユーザーの実設定 = 挙動不変)', () => {
    notifyDefaultQuota('gemini', Date.now(), 60_000, 'own', { gemini: 'own', groq: 'own', openai: 'env' });
    expect(checkGeneratorGate().allowed).toBe(true);
    const ig = generatorQuotaIgnored();
    expect(ig.count).toBe(1);
    expect(ig.last?.provider).toBe('gemini');
  });
});
