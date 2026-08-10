// 計画サイクル台帳(signal_plans)の行ビルダーの単体テスト(純関数)。
//
// ■ ★否定対照(この実装前のコードでの結果)
//   git show HEAD:server/signalTrade/engine.ts > <tmp> には signal_plans も buildSignalPlanInsert も
//   存在せず、見送り(none)もレッグ脱落も **DB のどこにも行が無い**(実測: サーバログに
//   plan-suppress 415件 / plan-legdrop 46件 あるのに signal_trades には0件)。
//   このファイルは import に失敗して赤くなる。

import { describe, it, expect } from 'vitest';
import { buildSignalPlanInsert, trimRationale, PLAN_RATIONALE_MAX_CHARS } from './planLedger.js';
import type { SignalSettingsSnapshot } from '../types.js';

const SETTINGS: SignalSettingsSnapshot = {
  lcFloor: { mode: 'manual', value: 45 },
  lcCeiling: { mode: 'ai' },
  lcHardMax: { enabled: true, value: 159 },
  trendVeto: { mode: 'ai' },
  cooldown: { mode: 'ai' },
  bias: { mode: 'manual', value: 'none' },
  range: { mode: 'manual', value: false },
};

describe('buildSignalPlanInsert', () => {
  it('見送り(none): 理由の語彙(NoneReason)と veto をそのまま写す', () => {
    const row = buildSignalPlanInsert({
      t: 1000, system: 'B',
      result: {
        ok: true,
        plan: { direction: 'none', rationale: '  方向感が\n無い  ', refPrice: 38250, regime: 'unclear', confidence: 30 },
        vetoFired: true, noneReason: 'trend',
      },
      settings: SETTINGS,
    });
    expect(row).toEqual({
      t: 1000, system: 'B',
      direction: 'none', noneReason: 'trend', vetoFired: true,
      refPrice: 38250, regime: 'unclear', confidence: 30,
      rationale: '方向感が 無い',
      settingsJson: JSON.stringify(SETTINGS),
    });
    // 見送りは采番しない。
    expect(row.signalId).toBeUndefined();
  });

  it('ARM: 最終プランの4価格と signalId が載る', () => {
    const row = buildSignalPlanInsert({
      t: 2000, system: 'A', signalId: 537,
      result: {
        ok: true,
        plan: {
          direction: 'buy', rationale: '押し目買い', refPrice: 38250,
          limitEntry: 38200, stopLossForLimit: 38145,
          stopEntry: 38300, stopLossForStop: 38245,
        },
        vetoFired: false,
      },
      settings: SETTINGS,
    });
    expect(row.signalId).toBe(537);
    expect(row.direction).toBe('buy');
    expect(row.limitEntry).toBe(38200);
    expect(row.stopEntry).toBe(38300);
    expect(row.stopLossForLimit).toBe(38145);
    expect(row.stopLossForStop).toBe(38245);
    expect(row.noneReason).toBeUndefined();
    expect(row.legDropsJson).toBeUndefined();
  });

  it('レッグ脱落: 生成器の台帳(proposals.leg_drops_json)と同じ書き方で JSON 配列にする', () => {
    const legDrops = [{ name: 'stop' as const, reason: 'missing' as const }];
    const row = buildSignalPlanInsert({
      t: 3000, system: 'A', signalId: 538,
      result: {
        ok: true,
        plan: { direction: 'buy', rationale: '押し目買い', refPrice: 38250, limitEntry: 38200, stopLossForLimit: 38145 },
        legDrops,
      },
    });
    expect(JSON.parse(row.legDropsJson!)).toEqual(legDrops);
    // 落ちていないレッグは列ごと NULL(空配列は書かない=proposals と同じ規約)。
    expect(buildSignalPlanInsert({ t: 1, system: 'A', result: { ok: true, plan: { direction: 'none', rationale: 'x', refPrice: 1 }, legDrops: [] } }).legDropsJson)
      .toBeUndefined();
  });

  it('計画が得られなかった回: direction は NULL・error に理由が残る(見送りと混ざらない)', () => {
    const row = buildSignalPlanInsert({
      t: 4000, system: 'B', result: { ok: false, error: 'chart-not-generated' }, settings: SETTINGS,
    });
    expect(row.direction).toBeUndefined();
    expect(row.noneReason).toBeUndefined();
    expect(row.error).toBe('chart-not-generated');
    // ★設定は取れた回と同じく残す(「どの設定の下でサイクルが空振りしたか」も実験の母数に要る)。
    expect(row.settingsJson).toBe(JSON.stringify(SETTINGS));
  });

  it('rationale は上限文字数で切る(裾だけを止める)', () => {
    const long = 'あ'.repeat(PLAN_RATIONALE_MAX_CHARS + 50);
    const row = buildSignalPlanInsert({
      t: 5000, system: 'A', result: { ok: true, plan: { direction: 'none', rationale: long, refPrice: 1 } },
    });
    expect(row.rationale!.length).toBe(PLAN_RATIONALE_MAX_CHARS);
    expect(trimRationale('   ')).toBeNull();
    expect(trimRationale(undefined)).toBeNull();
  });
});

// ─── ★v0.9.70: チャート画像の群を settings_json に残す(列は増やさない) ───────────────
//
//  ★記録の出所が要点: 設定(config)ではなく **結果(result.chartVision)** から取る。
//   記録すべきは「実際に送ったか」であって「送る設定だったか」ではない
//   (ビジョン非対応プロバイダへフォールバックして画像が外れた回は sent=false)。
describe('★チャート画像の群(settings_json へマージ・列は増やさない)', () => {
  const RESULT_OK = {
    ok: true as const,
    plan: { direction: 'buy' as const, rationale: 'x', refPrice: 38250 },
  };

  it('群が settings_json にマージされる(既存の設定キーは残る)', () => {
    const row = buildSignalPlanInsert({
      t: 1, system: 'A',
      result: { ...RESULT_OK, chartVision: { mode: 'ab', requested: true, sent: true } },
      settings: SETTINGS,
    });
    const s = JSON.parse(row.settingsJson!);
    expect(s.chartVision).toEqual({ mode: 'ab', requested: true, sent: true });
    expect(s.lcFloor).toEqual(SETTINGS.lcFloor);   // 既存キーは壊さない
  });

  it('★「撮ろうとしたが送れなかった」回も残る(requested:true / sent:false)', () => {
    const row = buildSignalPlanInsert({
      t: 2, system: 'A',
      result: { ok: false, error: 'chart-not-generated', chartVision: { mode: 'ab', requested: true, sent: false } },
      settings: SETTINGS,
    });
    expect(JSON.parse(row.settingsJson!).chartVision).toEqual({ mode: 'ab', requested: true, sent: false });
    expect(row.error).toBe('chart-not-generated');
  });

  it('群が無い結果(旧経路/直呼び)では settings_json は従来どおり(キーが増えない)', () => {
    const row = buildSignalPlanInsert({ t: 3, system: 'A', result: RESULT_OK, settings: SETTINGS });
    expect(JSON.parse(row.settingsJson!)).toEqual(SETTINGS);
  });
});

// ─── ★v0.9.70: 実際に答えた LLM プロバイダ/モデルを残す ────────────────────────────
//
//  ★なぜ要るか: チャート画像の A/B は「画像 × モデル」が完全に絡む(画像を送る回は必ず
//   ビジョン対応=gemini/openai へ行き、送らない回は groq/kimi でも通る)。この2列が無いと
//   ab で貯めた標本は後から層別できない=「測れないデータを貯める」ことになる。
describe('★答えたプロバイダ/モデル(planLedger)', () => {
  const OK = { ok: true as const, plan: { direction: 'buy' as const, rationale: 'x', refPrice: 38250 } };

  it('答えたプロバイダとモデルが行に載る', () => {
    const row = buildSignalPlanInsert({
      t: 1, system: 'A', result: { ...OK, provider: { name: 'gemini', model: 'gemini-flash-latest' } },
    });
    expect(row.provider).toBe('gemini');
    expect(row.providerModel).toBe('gemini-flash-latest');
  });

  it('★答えが得られなかった回は載せない(=列は NULL・「誰も答えなかった」が形から読める)', () => {
    const row = buildSignalPlanInsert({ t: 2, system: 'A', result: { ok: false, error: 'LLM未設定' } });
    expect(row.provider).toBeUndefined();
    expect(row.providerModel).toBeUndefined();
  });

  it('★答えは返ったが計画が不成立(ok:false)の回も、どのモデルが返したかは残る', () => {
    const row = buildSignalPlanInsert({
      t: 3, system: 'A',
      result: { ok: false, error: 'parse failed after retry', provider: { name: 'groq', model: 'llama-x' } },
    });
    expect(row.error).toBe('parse failed after retry');
    expect(row.provider).toBe('groq');
  });
});
