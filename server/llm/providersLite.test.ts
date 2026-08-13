import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getProviderStatus, testProvider } from './providers.js';

// ─── 公開版(lite)は generator プールを **構築しない** ────────────────────────────
//
// 分析用は分析専用。プールを組むと 2つ目の API キーを解決してクライアントまで作ってしまう。
// lite では空(=キー未設定と同じ扱い)にして、外部へは1回も出ない状態にする。
//
// ★否定対照(修正前の llm/providers.ts): lite でも poolOf('generator') が遅延構築し、
//   getProviderStatus('generator') が 4プロバイダ分の行を返す → 本ファイルが赤。
//   実証手順: git show HEAD:server/llm/providers.ts でファイルを差し替えて実行。
//
// ★外部 LLM は叩かない: testProvider は client が無いと ping せずに notset を返す経路だけを通す。

describe('LLM プロバイダ・プール — variant による分析用プールの有無', () => {
  const saved = process.env.MONITOR_VARIANT;
  beforeEach(() => { delete process.env.MONITOR_VARIANT; });
  afterEach(() => {
    if (saved === undefined) delete process.env.MONITOR_VARIANT;
    else process.env.MONITOR_VARIANT = saved;
  });

  it('lite: generator プールは空(構築されない)', () => {
    process.env.MONITOR_VARIANT = 'lite';
    expect(getProviderStatus('generator')).toEqual([]);
  });

  it('lite: 分析用プールのキー検証は必ず notset(外部へ ping しない)', async () => {
    process.env.MONITOR_VARIANT = 'lite';
    const r = await testProvider('gemini', 'generator');
    expect(r).toEqual({ name: 'gemini', ok: false, notset: true });
  });

  it('lite でも default プール(実取引につながる経路)は従来どおり存在する', () => {
    process.env.MONITOR_VARIANT = 'lite';
    expect(getProviderStatus().length).toBeGreaterThan(0);
    expect(getProviderStatus('default').length).toBeGreaterThan(0);
  });

  it('★full(未設定): generator プールは従来どおり構築される', () => {
    delete process.env.MONITOR_VARIANT;
    expect(getProviderStatus('generator').length).toBe(getProviderStatus('default').length);
  });
});
