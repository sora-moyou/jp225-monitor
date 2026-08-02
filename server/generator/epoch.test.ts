import { describe, it, expect } from 'vitest';

// ─── epoch(標本の期)─────────────────────────────────────────────────────────
//
// 何を守っているか:
//   1年ぶんの提案を1つの山に積むと、途中で設定を触った瞬間に別物が同じ山に混ざる。
//   混ざったことに誰も気づけないのが最悪なので、期を決める入力が動けば epoch が **自動で** 変わる。
//
// ★否定対照: computeEpoch を「固定文字列を返す」実装に変えると、下の
//   「設定/決済指紋/生成器設定を動かすと epoch が変わる」3件がすべて赤になる。

import {
  EPOCH_SCHEMA, VOLATILE_SETTINGS_KEYS, canonicalJson, freezeSettings, buildEpochInput, computeEpoch,
} from './epoch.js';

const exit = { impl: 'private', variantImpl: 'private', configHash: 'abc123def456' };
const gen = { intervalMs: 120_000, controlEvery: 5, retryMinMs: 15_000, retryMaxMs: 20_000, requestTimeoutMs: 180_000, tallyIntervalMs: 1_800_000 };
const settings = { scalpLcFloorYen: 45, scalpBias: 'none', generatorDailyBudget: 800 };

const epochOf = (s: unknown, e = exit, g: unknown = gen) => computeEpoch(buildEpochInput(s, e, g));

describe('canonicalJson — キー順で値が揺れない', () => {
  it('入れ子のキー順が違っても同じ文字列になる', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it('配列の順序は保つ(順序に意味がある)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('freezeSettings — 本質的に揺れる値は期の入力に入れない', () => {
  it('providers / basedataAutoLastRun を落とす', () => {
    const f = freezeSettings({ ...settings, providers: [{ paused: true }], basedataAutoLastRun: 'ok 12:00' });
    expect(f).toEqual(settings);
    expect(VOLATILE_SETTINGS_KEYS).toContain('providers');
  });
  it('★プロバイダのポーズ状態が変わっても epoch は動かない(期の概念が消えないこと)', () => {
    const a = epochOf({ ...settings, providers: [{ name: 'gemini', paused: false, pausedUntil: 0 }] });
    const b = epochOf({ ...settings, providers: [{ name: 'gemini', paused: true, pausedUntil: 999 }] });
    expect(a).toBe(b);
  });
});

describe('computeEpoch — 入力が動けば自動で上がる', () => {
  it('同じ入力なら同じ epoch(方式の版が接頭辞に付く)', () => {
    expect(epochOf(settings)).toBe(epochOf(settings));
    expect(epochOf(settings).startsWith(`${EPOCH_SCHEMA}:`)).toBe(true);
  });
  it('★凍結設定を1つ変えると epoch が変わる', () => {
    expect(epochOf({ ...settings, scalpLcFloorYen: 50 })).not.toBe(epochOf(settings));
  });
  it('★決済設定の指紋が変わると epoch が変わる', () => {
    expect(epochOf(settings, { ...exit, configHash: 'ffffffffffffffff' })).not.toBe(epochOf(settings));
  });
  it('★決済実装が公開フォールバックに落ちると epoch が変わる', () => {
    expect(epochOf(settings, { ...exit, variantImpl: 'fallback' })).not.toBe(epochOf(settings));
  });
  it('★生成器の設定(間隔・対照の頻度)が変わると epoch が変わる', () => {
    expect(epochOf(settings, exit, { ...gen, intervalMs: 60_000 })).not.toBe(epochOf(settings));
    expect(epochOf(settings, exit, { ...gen, controlEvery: 10 })).not.toBe(epochOf(settings));
  });
  it('設定のキー順が違うだけでは epoch は変わらない', () => {
    expect(epochOf({ generatorDailyBudget: 800, scalpBias: 'none', scalpLcFloorYen: 45 })).toBe(epochOf(settings));
  });
  it('★決済設定の「版番号」は入力に含まない(未採番→1 の採番だけで期が割れないこと)', () => {
    // buildEpochInput は configVersion を受け取らない=採番の有無が epoch に現れない。
    const input = buildEpochInput(settings, exit, gen) as { exit: Record<string, unknown> };
    expect(Object.keys(input.exit).sort()).toEqual(['configHash', 'impl', 'variantImpl']);
  });
});
