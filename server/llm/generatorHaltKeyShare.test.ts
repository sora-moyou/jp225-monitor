import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── ★従属停止は「キーを共有しているとき」だけ ────────────────────────────────
//
// 何が壊れていたか(実売買PC monitor2 full v0.9.53 の実ログ 2026-08-03 00:04〜01:11):
//   00:04 60秒 → 00:05 300秒 → 00:11 1800秒 → 00:26 7200秒(2時間)。
//   A(実弾につながる default プール)は数分おきに 429 を踏むので、段が2時間まで伸びて
//   生成器は大半の時間止まり、標本が溜まらなかった。
//   ところが従属停止は **キーが共有かどうかを一切見ずに** 発火していた。ユーザーは4プロバイダ全てに
//   生成器専用キーを設定済み(検証も緑)で、上流のクォータは分かれている
//   = A の429は生成器のクォータについて **何も語らない**。存在しない危険のために止めていた。
//
// ★否定対照(修正前 = git show HEAD:server/llm/providers.ts / server/llm/generatorGate.ts):
//   notifyDefaultQuota に出どころが渡らず、専用キーでも必ず停止する。
//   → 下の「専用キー(own/env)なら止まらない」3件が **赤** になる。
//   実証手順: git show HEAD:server/llm/providers.ts > /tmp/old-providers.ts で差し替えて実行。
//
// ★保護は弱めない: 'shared'(共通キーへフォールバック中)と 'none'、そして
//   「解決できなかった」は従来どおり止まる ことも同時に検査する。

const h = vi.hoisted(() => ({ source: 'own' as string, throws: false }));

// キーは実際には使わない(task を自前で渡すので client は一度も呼ばれない)。
// client !== null にするためだけにダミー値を返す(外部LLMには絶対に出ない)。
vi.mock('../configStore.js', () => ({
  resolveApiKeyForPool: (name: string, pool: string) => `dummy-key-${pool}-${name}`,
  resolveGeneratorKeySource: () => {
    if (h.throws) throw new Error('config.json が壊れています');
    return h.source;
  },
  resolveGeneratorDailyBudget: () => 1000,
}));

import { callWithFallback, reloadProviders } from './providers.js';
import {
  checkGeneratorGate, resetGeneratorGateForTest, generatorGateSnapshot, generatorQuotaIgnored,
  notifyDefaultQuota, isDedicatedGeneratorKey,
} from './generatorGate.js';

/** 必ず 429 を投げるタスク(client には触れない=外部LLMは絶対に叩かない)。 */
const throw429 = async (): Promise<string> => { throw new Error('429 Too Many Requests: rate limit exceeded'); };

/** default プールで A に 429 を踏ませ、そのあと生成器が通れるかを返す。 */
async function generatorAllowedAfterDefault429(): Promise<boolean> {
  await expect(callWithFallback(throw429, 'default-task')).rejects.toThrow();
  return checkGeneratorGate().allowed;
}

describe('★従属停止は「生成器が A と同じキーを使っているとき」だけ発火する', () => {
  beforeEach(() => {
    h.source = 'own';
    reloadProviders();
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('★専用キー(own)なら A の429で生成器を止めない(存在しない危険で実験を殺さない)', async () => {
    h.source = 'own';
    expect(await generatorAllowedAfterDefault429()).toBe(true);
    expect(generatorGateSnapshot().haltedSessionKey).toBeNull();
    // ★無音にしない: 止めなかった事実と根拠が残る。
    const ig = generatorQuotaIgnored();
    expect(ig.count).toBeGreaterThan(0);
    expect(ig.last?.source).toBe('own');
    expect(ig.last?.provider).toBeTruthy();
  });

  it('★専用キー(env)でも同じ(環境変数由来の専用キーも上流は分かれている)', async () => {
    h.source = 'env';
    expect(await generatorAllowedAfterDefault429()).toBe(true);
  });

  it('★共有キー(shared)なら従来どおり止める(保護を弱めない)', async () => {
    h.source = 'shared';
    expect(await generatorAllowedAfterDefault429()).toBe(false);
    const g = checkGeneratorGate();
    expect(g.allowed === false && g.reason).toBe('default-quota');
    expect(generatorQuotaIgnored().count).toBe(0);
  });

  it("共通キーも無い(none)なら止める(「専用と証明できない」は止める側に倒す)", async () => {
    h.source = 'none';
    expect(await generatorAllowedAfterDefault429()).toBe(false);
  });

  it('出どころを解決できない(設定が壊れている等)なら止める=保護側に倒す', async () => {
    // ★同時に「A のフォールバックが壊れない」ことも見る: 例外が callWithFallback を貫通すると
    //   A は次プロバイダへ行けなくなる(実弾経路の破壊)。ここは 429 として素通しされねばならない。
    h.throws = true;
    try {
      expect(await generatorAllowedAfterDefault429()).toBe(false);
    } finally {
      h.throws = false;
    }
  });

  it('判定そのものは純関数(own/env だけが専用・undefined は専用ではない)', () => {
    expect(isDedicatedGeneratorKey('own')).toBe(true);
    expect(isDedicatedGeneratorKey('env')).toBe(true);
    expect(isDedicatedGeneratorKey('shared')).toBe(false);
    expect(isDedicatedGeneratorKey('none')).toBe(false);
    expect(isDedicatedGeneratorKey(undefined)).toBe(false);
  });

  it('★出どころを渡さない既存の呼び出しは従来どおり止まる(挙動不変)', () => {
    notifyDefaultQuota('gemini');
    const g = checkGeneratorGate();
    expect(g.allowed).toBe(false);
    expect(g.allowed === false && g.reason).toBe('default-quota');
  });

  it('★A(default プール)の挙動は不変: 専用キーでも429のポーズ/フォールバックは従来どおり', async () => {
    h.source = 'own';
    // 全プロバイダが429 → 従来と同じ文言で throw する(A の経路は1ミリも変わらない)。
    await expect(callWithFallback(throw429, 'first')).rejects.toThrow();
    await expect(callWithFallback(async () => 'never', 'second'))
      .rejects.toThrow(/^429 \(all providers paused, retry in \d+s\)$/);
  });
});
