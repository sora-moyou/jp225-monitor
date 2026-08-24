// 計画サイクル台帳(signal_plans)の行ビルダーの単体テスト(純関数)。
//
// ■ ★否定対照(この実装前のコードでの結果)
//   git show HEAD:server/signalTrade/engine.ts > <tmp> には signal_plans も buildSignalPlanInsert も
//   存在せず、見送り(none)もレッグ脱落も **DB のどこにも行が無い**(実測: サーバログに
//   plan-suppress 415件 / plan-legdrop 46件 あるのに signal_trades には0件)。
//   このファイルは import に失敗して赤くなる。

import { describe, it, expect } from 'vitest';
import {
  buildSignalPlanInsert, trimRationale, PLAN_RATIONALE_MAX_CHARS, PLAN_RATIONALE_TRUNCATED_MARK,
} from './planLedger.js';
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
      // ★契約の変更: 前後の空白は落とすが **改行は保つ**(旧実装は '方向感が 無い' に潰していた)。
      rationale: '方向感が\n無い',
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

  it('レッグ脱落: 分析用の台帳(proposals.leg_drops_json)と同じ書き方で JSON 配列にする', () => {
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

  // ★契約の変更(2026-08-17): 旧テストは「240文字ちょうどに切られる」ことを固定していた。
  //   根拠文は **シグナルの正しさの一部** なので記録側で削らない方針に変えた(planLedger.ts の注記)。
  //   実測(generator_proposals_kabu.db・12,043件)の最長は 319 文字で、新上限 2000 は事実上効かない。
  it('★rationale は改行を保ったまま記録する(3行構成が保存時に壊れない)', () => {
    const three = '①上昇トレンド継続と判断。\n②直近安値 38,120 の直上を指値。\n LC検算: 38,140 − 38,090 = 50円  ';
    const row = buildSignalPlanInsert({
      t: 5000, system: 'A', result: { ok: true, plan: { direction: 'buy', rationale: three, refPrice: 1 } },
    });
    // 行が3本のまま残る(旧実装は \s+ → ' ' で1行に潰していた)。
    expect(row.rationale!.split('\n')).toEqual([
      '①上昇トレンド継続と判断。',
      '②直近安値 38,120 の直上を指値。',
      ' LC検算: 38,140 − 38,090 = 50円',   // 行末の空白だけ落ちる(行頭の字下げは残す)
    ]);
  });

  it('★意味を壊さない正規化だけ残す(CRLF→LF・行末空白・3行以上の空行の圧縮・前後trim)', () => {
    expect(trimRationale('a\r\nb')).toBe('a\nb');
    expect(trimRationale('a\r b')).toBe('a\n b');
    expect(trimRationale('a\n\n\n\nb')).toBe('a\n\nb');   // 段落の区切り(空行1つ)は残す
    expect(trimRationale('  \n a \n  ')).toBe('a');
    expect(trimRationale('   ')).toBeNull();
    expect(trimRationale(undefined)).toBeNull();
    expect(trimRationale(null)).toBeNull();
  });

  it('★実測の最長(319文字)より長い普通の根拠文は1文字も失われない', () => {
    const long = 'あ'.repeat(400);
    const row = buildSignalPlanInsert({
      t: 5100, system: 'A', result: { ok: true, plan: { direction: 'none', rationale: long, refPrice: 1 } },
    });
    expect(row.rationale).toBe(long);
    expect(row.rationale!.length).toBe(400);
  });

  it('★上限は暴走止めの安全弁: 超えた回だけ切り、切ったことが台帳から読める', () => {
    const runaway = 'あ'.repeat(PLAN_RATIONALE_MAX_CHARS + 500);
    const out = trimRationale(runaway)!;
    expect(out.length).toBe(PLAN_RATIONALE_MAX_CHARS);          // 印を含めて上限に収まる
    expect(out.endsWith(PLAN_RATIONALE_TRUNCATED_MARK)).toBe(true);
    // ちょうど上限の長さなら印は付かない(=切っていない)。
    const exact = 'あ'.repeat(PLAN_RATIONALE_MAX_CHARS);
    expect(trimRationale(exact)).toBe(exact);
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

// ─── ★段5: A/B 分割の測定材料(SplitRecord)が signal_plans の行へ写る ───────────────────
//
//  ★否定対照: この describe の前に足した splitRecord の読み取りブロックを削れば、
//    以下のテストは全て赤になる(旧経路=splitRecord 無しの回は無傷のまま)。
describe('★段5: splitRecord(A/B 分割の測定材料)が行へ写る', () => {
  const OK = { ok: true as const, plan: { direction: 'buy' as const, rationale: 'x', refPrice: 38250 } };

  it('★旧経路(splitRecord 無し)は新列が一切乗らない(既存の挙動を壊さない)', () => {
    const row = buildSignalPlanInsert({ t: 1, system: 'A', result: OK });
    for (const k of [
      'aDirection', 'aWhy', 'bVariant', 'squeezeState', 'squeezeUnavailable',
      'bStrategy', 'aiWhy', 'toolCalls', 'aProvider', 'aProviderModel',
      'bProvider', 'bProviderModel', 'aPromptBuild', 'bPromptBuild',
    ] as const) {
      expect(row[k], `${k} は未指定のはず`).toBeUndefined();
    }
  });

  it('分割 ON で B(buy)まで進んだ回: 8列 + プロバイダ2組 + プロンプト型2つが揃って写る', () => {
    const row = buildSignalPlanInsert({
      t: 2, system: 'A',
      result: {
        ...OK,
        splitRecord: {
          aDirection: 'buy', aWhy: '高値切り上げ', bVariant: 'buy',
          squeezeState: null, bStrategy: '押し目を拾う', toolCalls: 2,
          aProvider: { name: 'gemini', model: 'gemini-flash' },
          bProvider: { name: 'groq', model: 'llama-70b' },
          aPromptBuild: 'pb1:aaaaaaaaaaaaaaaa', bPromptBuild: 'pb1:bbbbbbbbbbbbbbbb',
        },
      },
    });
    expect(row.aDirection).toBe('buy');
    expect(row.aWhy).toBe('高値切り上げ');
    expect(row.bVariant).toBe('buy');
    expect(row.squeezeState).toBeNull();
    expect(row.squeezeUnavailable).toBeUndefined();
    expect(row.bStrategy).toBe('押し目を拾う');
    expect(row.aiWhy).toBeUndefined();
    expect(row.toolCalls).toBe(2);
    // ★これが設計の芯: A と B が別プロバイダで答えても、片方に潰れず両方が残る。
    expect(row.aProvider).toBe('gemini');
    expect(row.aProviderModel).toBe('gemini-flash');
    expect(row.bProvider).toBe('groq');
    expect(row.bProviderModel).toBe('llama-70b');
    expect(row.aPromptBuild).toBe('pb1:aaaaaaaaaaaaaaaa');
    expect(row.bPromptBuild).toBe('pb1:bbbbbbbbbbbbbbbb');
  });

  it("★b_variant='none'(呼ばないと決めた)回は bProvider/bPromptBuild が乗らない(A だけ残る)", () => {
    const row = buildSignalPlanInsert({
      t: 3, system: 'A',
      result: {
        ok: true, plan: { direction: 'none', rationale: 'レンジのため見送り', refPrice: 38250 },
        noneReason: 'rangeDisabled',
        splitRecord: {
          aDirection: 'range', aWhy: 'どちらとも言えない', bVariant: 'none',
          squeezeState: null, aProvider: { name: 'gemini', model: 'gemini-flash' },
          aPromptBuild: 'pb1:aaaaaaaaaaaaaaaa',
        },
      },
    });
    expect(row.aDirection).toBe('range');
    expect(row.bVariant).toBe('none');            // ★NULL ではなく 'none' がそのまま行に乗る
    expect(row.aProvider).toBe('gemini');
    expect(row.bProvider).toBeUndefined();
    expect(row.bPromptBuild).toBeUndefined();
  });

  it('★squeeze_unavailable(測れなかった理由)がある回は squeeze_state と共存して残る', () => {
    const row = buildSignalPlanInsert({
      t: 4, system: 'A',
      result: {
        ...OK,
        splitRecord: {
          bVariant: 'range-fade', squeezeState: null, squeezeUnavailable: 'closed',
        },
      },
    });
    expect(row.squeezeState).toBeNull();
    expect(row.squeezeUnavailable).toBe('closed');
  });

  it('★ai_why(理由つき見送り)は改行を含む自由文もそのまま残る', () => {
    const why = 'あ) 上に置ける節目が無い\nい) 下は本日安値まで遠すぎる';
    const row = buildSignalPlanInsert({
      t: 5, system: 'A',
      result: {
        ok: true, plan: { direction: 'none', rationale: '見送り', refPrice: 38250 }, noneReason: 'ai',
        splitRecord: { bVariant: 'buy', squeezeState: null, aiWhy: why },
      },
    });
    expect(row.aiWhy).toBe(why);
  });

  it('★ok:false(B の呼び出し自体が例外で落ちた)回にも splitRecord は残る(A 側の記録が消えない)', () => {
    const row = buildSignalPlanInsert({
      t: 6, system: 'A',
      result: {
        ok: false, error: 'provider exhausted',
        splitRecord: {
          aDirection: 'sell', aWhy: '戻り売り優勢', bVariant: 'sell',
          squeezeState: null, aProvider: { name: 'gemini', model: 'gemini-flash' },
        },
      },
    });
    expect(row.error).toBe('provider exhausted');
    expect(row.aDirection).toBe('sell');
    expect(row.bVariant).toBe('sell');
    expect(row.aProvider).toBe('gemini');
    expect(row.bProvider).toBeUndefined();
  });
});

// ─── ★段6: B が「判断に必要なデータが足りなかった」と自己申告した自由文(missingData) ─────
describe('★段6: missingData(splitRecord)が ai_why と混ざらずに row へ写る', () => {
  const OK = { ok: true as const, plan: { direction: 'buy' as const, rationale: 'x', refPrice: 38250 } };

  it('★missingData が splitRecord にあれば row.missingData に写る', () => {
    const row = buildSignalPlanInsert({
      t: 1, system: 'A',
      result: {
        ...OK,
        splitRecord: { bVariant: 'buy', squeezeState: null, missingData: 'ATRが算出できませんでした' },
      },
    });
    expect(row.missingData).toBe('ATRが算出できませんでした');
    expect(row.aiWhy).toBeUndefined();   // ★ai_why には混ぜない
  });

  it('★aiWhy(見送り理由)と missingData が同時にあっても別々に残る', () => {
    const row = buildSignalPlanInsert({
      t: 2, system: 'A',
      result: {
        ok: true, plan: { direction: 'none', rationale: '見送り', refPrice: 38250 }, noneReason: 'ai',
        splitRecord: {
          bVariant: 'buy', squeezeState: null,
          aiWhy: 'あ) 上に節目が無い / い) 下は遠い',
          missingData: '基礎データの確定日が古い',
        },
      },
    });
    expect(row.aiWhy).toBe('あ) 上に節目が無い / い) 下は遠い');
    expect(row.missingData).toBe('基礎データの確定日が古い');
  });

  it('★splitRecord が無い(旧経路)回は missingData も未指定のまま(NULL)', () => {
    const row = buildSignalPlanInsert({ t: 3, system: 'A', result: OK });
    expect(row.missingData).toBeUndefined();
  });

  it('★片脚成立(見送りではない)回にも missingData が残る(ai_why の見送り専用フラグと独立)', () => {
    const row = buildSignalPlanInsert({
      t: 4, system: 'A',
      result: {
        ok: true,
        plan: { direction: 'buy', rationale: '押し目買い', refPrice: 38250, limitEntry: 38200, stopLossForLimit: 38145 },
        splitRecord: { bVariant: 'buy', squeezeState: null, missingData: 'い) は判断材料が古い' },
      },
    });
    expect(row.direction).toBe('buy');
    expect(row.missingData).toBe('い) は判断材料が古い');
  });
});

// ─── ★段6続き: split_bypass_reason(分割ON設定なのに、この回だけ旧経路へ落とした理由) ─────
describe('★段6続き: splitBypassReason(result)が row へ写る', () => {
  it('★result.splitBypassReason があれば row.splitBypassReason に写る', () => {
    const row = buildSignalPlanInsert({
      t: 1, system: 'A',
      result: {
        ok: true, plan: { direction: 'buy', rationale: 'x', refPrice: 38250 },
        splitBypassReason: 'heldPosition',
      },
    });
    expect(row.splitBypassReason).toBe('heldPosition');
  });

  it('★複数該当のカンマ区切りもそのまま写る', () => {
    const row = buildSignalPlanInsert({
      t: 2, system: 'A',
      result: {
        ok: true, plan: { direction: 'buy', rationale: 'x', refPrice: 38250 },
        splitBypassReason: 'heldPosition,promptVariant',
      },
    });
    expect(row.splitBypassReason).toBe('heldPosition,promptVariant');
  });

  it('★通常回(該当なし)は未指定のまま(NULL・捏造しない)', () => {
    const row = buildSignalPlanInsert({
      t: 3, system: 'A',
      result: { ok: true, plan: { direction: 'buy', rationale: 'x', refPrice: 38250 } },
    });
    expect(row.splitBypassReason).toBeUndefined();
  });

  it('★ok:false(計画が得られなかった)回にも残る(error 分岐より前に載せているため)', () => {
    const row = buildSignalPlanInsert({
      t: 4, system: 'A',
      result: { ok: false, error: 'LLM未設定', splitBypassReason: 'armedContext' },
    });
    expect(row.error).toBe('LLM未設定');
    expect(row.splitBypassReason).toBe('armedContext');
  });
});
