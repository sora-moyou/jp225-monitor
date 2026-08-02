import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── プロバイダ状態のプール分離(default / generator) ─────────────────────
//
// ★これが無いと何が起きるか(このテストが守っている実害):
//   providers.ts のプロバイダ状態は **モジュール単位のシングルトン**で、プロセス内の全呼び出し元が
//   circuitOpenUntil を共有していた。分析用の「提案生成器」(2分間隔で1日700〜1,600回の
//   チャート画像つき LLM 呼び出し)が 429 を踏むと、PAUSE_LADDER_MS の最大 8 時間まで
//   **実弾(A)のエントリー経路が止まる**。過去に全プロバイダ429で取引が全停止した事故がある。
//   別プロセス化しても解決しない: /api/scalp-plan の LLM 呼び出しは monitor のプロセス内で起きるため。
//
// ★否定対照(修正前のコードでこのテストが赤くなること):
//   修正前は callWithFallback の第3引数が存在せず(渡しても無視され)、getProviderStatus も引数を
//   取らない単一の配列を返した。したがって「generator が429を踏んだ後に default が非ポーズ」は
//   **成立しえない**(同じ配列を見ているので両方ポーズ)。下の ★核心 のテストが必ず失敗する。

// キーは実際に使わない(task を自前で渡すので client は一度も呼ばれない)が、
// client !== null にしないとプロバイダが「未設定」扱いで除外されるため、プール別のダミーキーを返す。
vi.mock('../configStore.js', () => ({
  resolveApiKeyForPool: (name: string, pool: string) => `dummy-key-${pool}-${name}`,
  // ★否定対照を「モジュールが読めない」ではなく「アサーションが落ちる」形にするために、
  //   プール分離前の解決関数もモックしておく(分離後のコードでは呼ばれない)。
  resolveApiKey: (name: string) => `dummy-key-default-${name}`,
  resolveGeneratorDailyBudget: () => 1000,
}));

import { callWithFallback, getProviderStatus, reloadProviders } from './providers.js';
import { resetGeneratorGateForTest, checkGeneratorGate } from './generatorGate.js';

/** そのプールで必ず 429 を投げるタスク(client には触れない=外部LLMは絶対に叩かない)。 */
const throw429 = async (): Promise<string> => { throw new Error('429 Too Many Requests: rate limit exceeded'); };
/** 一過性エラー(5xx)。quota とは扱いが違うことの確認用。 */
const throw503 = async (): Promise<string> => { throw new Error('503 Service Unavailable'); };

function pausedNames(pool?: 'default' | 'generator'): string[] {
  return getProviderStatus(pool).filter(p => p.paused).map(p => p.name);
}

describe('providers: プール別のサーキットブレーカー', () => {
  beforeEach(() => {
    reloadProviders();              // default を再構築 + generator プールを破棄(全状態リセット)
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('前提: プロバイダが有効に構築されている(client あり)', () => {
    expect(getProviderStatus().length).toBeGreaterThan(0);
    expect(getProviderStatus().every(p => p.enabled)).toBe(true);
    expect(pausedNames()).toEqual([]);
  });

  it('★核心(否定対照): 生成器が全プロバイダで429を踏んでも default プールはポーズしない', async () => {
    await expect(callWithFallback(throw429, 'generator-task', 'generator')).rejects.toThrow(/429/);

    // generator プールは(全プロバイダが429で落ちたので)ポーズしている
    expect(pausedNames('generator').length).toBe(getProviderStatus('generator').length);
    // ★default プールは1つもポーズしていない = 実弾(A)は止まらない
    expect(pausedNames('default')).toEqual([]);
    // 引数なしの getProviderStatus(=既存の呼び出し側)も default を見る
    expect(pausedNames()).toEqual([]);
  });

  it('★逆向き: default が429を踏んでも generator プールはポーズしない(状態は完全に独立)', async () => {
    await expect(callWithFallback(throw429, 'default-task')).rejects.toThrow(/429/);

    expect(pausedNames('default').length).toBe(getProviderStatus('default').length);
    expect(pausedNames('generator')).toEqual([]);
  });

  it('既存挙動の不変: caller を渡さない呼び出しは default プールを使い、429で従来どおりポーズする', async () => {
    // 第3引数を省略 = 従来の呼び出し形。ポーズ対象は default。
    await expect(callWithFallback(throw429, 'legacy')).rejects.toThrow();
    expect(pausedNames('default').length).toBeGreaterThan(0);
  });

  it('既存挙動の不変: 明示的に \'default\' を渡しても省略時と同じ(default をポーズ)', async () => {
    await expect(callWithFallback(throw429, 'explicit', 'default')).rejects.toThrow();
    expect(pausedNames('default').length).toBeGreaterThan(0);
    expect(pausedNames('generator')).toEqual([]);
  });

  it('既存挙動の不変: 成功する呼び出しは caller 省略で従来どおり結果を返す', async () => {
    const out = await callWithFallback(async () => 'ok-text', 'legacy-ok');
    expect(out).toBe('ok-text');
    expect(pausedNames('default')).toEqual([]);
  });

  it('全プロバイダがポーズ済みの default は従来と同じ 429 メッセージを投げる(文言不変)', async () => {
    await expect(callWithFallback(throw429, 'first')).rejects.toThrow();
    await expect(callWithFallback(async () => 'never', 'second'))
      .rejects.toThrow(/^429 \(all providers paused, retry in \d+s\)$/);
  });

  it('default がポーズ中でも generator は自分のプールで走れる(逆も同様)', async () => {
    await expect(callWithFallback(throw429, 'default-dies')).rejects.toThrow();
    // generator プールは無傷なので task が実際に走って成功する
    await expect(callWithFallback(async () => 'gen-ok', 'gen', 'generator')).resolves.toBe('gen-ok');
  });

  it('★従属規則の発火: default の quota は生成器を止める / generator 自身の quota は止めない', async () => {
    // ① generator が429を踏んでも従属停止は起きない(自分の429では止まらない)
    await expect(callWithFallback(throw429, 'gen', 'generator')).rejects.toThrow();
    expect(checkGeneratorGate().allowed).toBe(true);

    resetGeneratorGateForTest();
    reloadProviders();

    // ② default が quota を踏むと生成器は停止する(★A の429で止まる)
    await expect(callWithFallback(throw429, 'default', 'default')).rejects.toThrow();
    const gate = checkGeneratorGate();
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toBe('default-quota');
  });

  it('★従属規則は quota 限定: default の transient(5xx)では生成器を止めない', async () => {
    await expect(callWithFallback(throw503, 'default-transient')).rejects.toThrow();
    expect(checkGeneratorGate().allowed).toBe(true);
  });
});
