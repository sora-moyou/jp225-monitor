import { describe, it, expect } from 'vitest';

// ─── ★epoch の入力は「実験の条件」だけ(D6) ────────────────────────────────────
//
// 何を守っているか:
//   epoch が /api/settings 丸ごとを食っていたため、**アラート閾値・ニュース設定・chromePath など
//   決済と無関係な設定を触るだけで期が割れた**。期が割れやすいと停止規則の分母
//   (「②で7,000エントリー」)が計算不能になる。
//   一方で **関係あるものを落とす方が、関係ないものを入れるより危険** なので、
//   実験の条件(AI エントリーの質問を決めるノブ・標本の作られ方)は必ず期を割ること。
//
// ★否定対照: git show HEAD:server/generator/epoch.ts で旧版(丸ごと食う版)に差し替えると
//   「無関係な設定では期が変わらない」5件が全部赤になる(旧版はどのキーでも割れる)。

import {
  freezeSettings, buildEpochInput, computeEpoch, isExperimentSettingsKey,
  EXPERIMENT_SETTINGS_PREFIXES, EXPERIMENT_SETTINGS_KEYS,
} from './epoch.js';

const exit = { impl: 'private', variantImpl: 'private', configHash: 'abc123def456' };
const gen = {
  intervalMs: 120_000, controlEvery: 5, retryMinMs: 15_000, retryMaxMs: 20_000,
  requestTimeoutMs: 180_000, tallyIntervalMs: 1_800_000,
};

/** 実際の /api/settings に近い形(実験条件 + 無関係な設定が混在する)。 */
const SETTINGS = {
  // ── 実験の条件
  scalpBias: 'none', scalpLcFloorYen: 45, scalpLcCeilingYen: 65, scalpLcHardMaxEnabled: true,
  scalpTrendVetoYen: 100, scalpCooldownSec: 300, scalpRangeEnabled: false, scalpChartFallbackText: true,
  scalpLcFloorSource: 'manual', indicatorsEnabled: true, aiTechnicalEnabled: true,
  dotenEnabled: false, rangeReevalEnabled: true,
  signalB: {}, signalBEffective: { scalpLcFloorYen: 45 },
  generatorKeySources: { gemini: 'own', groq: 'own', openai: 'own' }, generatorDailyBudget: 800,
  // ── 実験と無関係な設定(触っても期を割ってはいけない)
  shockMove1Yen: 30, breakScore: 3, slopeConfluenceBonus: 2, nwaveMinSwingYen: 120,
  levelTol: 15, doubleFormingEnabled: false, nwaveEnabled: true, cooldownMin: 10,
  newsPollMs: 60_000, pricePollMs: 2_000, port: 5177, webSearchModel: 'x',
  basedataSaveDir: 'C:/dl', basedataAutoPublish: false, githubTokenSet: true, chromePath: 'C:/chrome.exe',
  providers: [{ name: 'gemini', paused: false }], basedataAutoLastRun: 'ok 12:00',
};

const epochOf = (s: unknown): string => computeEpoch(buildEpochInput(s, exit, gen));

describe('★実験と無関係な設定では期が割れない', () => {
  const irrelevant: Array<[string, unknown]> = [
    ['shockMove1Yen', 40],          // アラート閾値
    ['breakScore', 5],              // 検知チューニング
    ['levelTol', 20],               // 節目の許容
    ['newsPollMs', 120_000],        // ニュース設定
    ['chromePath', 'D:/chrome.exe'],// 撮影に使う実行ファイルのパス
    ['basedataSaveDir', 'D:/dl'],   // 基礎データの保存先
    ['cooldownMin', 20],            // アラートのクールダウン
  ];
  for (const [key, value] of irrelevant) {
    it(`${key} を変えても epoch は同じ`, () => {
      expect(epochOf({ ...SETTINGS, [key]: value })).toBe(epochOf(SETTINGS));
    });
  }
  it('★新しく足された無関係なキーが増えても epoch は同じ(将来の設定追加で勝手に割れない)', () => {
    expect(epochOf({ ...SETTINGS, someFutureUiToggle: true })).toBe(epochOf(SETTINGS));
  });
});

describe('★実験の条件を変えたら必ず期が割れる(B2 の性質を壊さない)', () => {
  const relevant: Array<[string, unknown]> = [
    ['scalpBias', 'long'],                 // バイアス(ライブで切り替えるのが常態)
    ['scalpLcFloorYen', 50],               // 初期LC下限
    ['scalpLcCeilingYen', 70],             // 初期LC上限
    ['scalpLcHardMaxEnabled', false],      // LC安全上限
    ['scalpTrendVetoYen', 0],              // トレンド veto
    ['scalpRangeEnabled', true],           // レンジ両面
    ['scalpChartFallbackText', false],     // 撮影失敗時のテキスト縮退(標本の作られ方)
    ['scalpLcFloorSource', 'ai'],          // 委任(手動/AI)
    ['indicatorsEnabled', false],          // 指標ブロックを AI に供給するか
    ['aiTechnicalEnabled', false],         // 指標をタイミング判断に使ってよいか
    ['dotenEnabled', true],                // 迷って入れた側
    ['rangeReevalEnabled', false],         // 迷って入れた側
    ['generatorDailyBudget', 400],         // 1日に何本取れるか
  ];
  for (const [key, value] of relevant) {
    it(`${key} を変えると epoch が変わる`, () => {
      expect(epochOf({ ...SETTINGS, [key]: value })).not.toBe(epochOf(SETTINGS));
    });
  }
  it('★生成器の専用キーの出どころが共通キーに落ちたら期が変わる(誰が答えたかが変わる)', () => {
    const fallen = { ...SETTINGS, generatorKeySources: { gemini: 'shared', groq: 'own', openai: 'own' } };
    expect(epochOf(fallen)).not.toBe(epochOf(SETTINGS));
  });
  it('★System B の設定も期を割る(迷ったら入れる: 落として後悔しない側)', () => {
    expect(epochOf({ ...SETTINGS, signalB: { scalpLcFloorYen: 55 } })).not.toBe(epochOf(SETTINGS));
  });
});

describe('凍結設定に何が残るか(判断の可読性)', () => {
  it('実験の条件だけが残り、無関係な設定と揺れる値は落ちる', () => {
    const f = freezeSettings(SETTINGS);
    for (const k of ['scalpBias', 'indicatorsEnabled', 'signalB', 'generatorDailyBudget', 'dotenEnabled']) {
      expect(Object.keys(f)).toContain(k);
    }
    for (const k of ['shockMove1Yen', 'chromePath', 'newsPollMs', 'providers', 'basedataAutoLastRun', 'port']) {
      expect(Object.keys(f)).not.toContain(k);
    }
  });
  it('判定は純関数で読める(接頭辞 + 完全一致 + 揺れる値の除外)', () => {
    expect(EXPERIMENT_SETTINGS_PREFIXES).toContain('scalp');
    expect(EXPERIMENT_SETTINGS_KEYS).toContain('indicatorsEnabled');
    expect(isExperimentSettingsKey('scalpLcHardMaxYen')).toBe(true);
    expect(isExperimentSettingsKey('generatorKeySources')).toBe(true);
    expect(isExperimentSettingsKey('shockMove1Yen')).toBe(false);
    // 接頭辞に当たっても「揺れる値」は入れない(providers は 'p' 始まりで当たらないが規約として固定)。
    expect(isExperimentSettingsKey('providers')).toBe(false);
  });
});
