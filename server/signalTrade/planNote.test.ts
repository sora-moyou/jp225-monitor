// ★v0.9.97: 「目線はあって、その目線のもとでシグナルを見送った」回に、AI の目線と理由を
//   画面まで運ぶ経路の実証。
//
// ■ このファイルが守るもの
//   ① buildPlanNote(純関数)の **出所の優先順位**。目線は A の答え(splitRecord.aDirection)から
//      **しか** 取らない。旧経路は目線が取れないので **ラベルを出さない**。
//      ★rationale の本文に「目線はレンジ」と書いてあっても復元しない(推測で断定しない)。
//   ② SignalEngine を実際に1サイクル走らせ、getState() の lastNone に届くこと(=配線の実証)。
//      ARM した回は消えること・武装中の JSON には載らないこと。
//
// ■ ★否定対照
//   ・planNote.ts の aDirection ブロックを消すと §目線は A の答えからしか取らない が赤くなる。
//   ・engine.ts の `this.lastPlanNote = …` の行を消すと §engine → SSE state が赤くなる。
//
// ■ ★実 LLM は呼ばない(runScalpPlanWithChart をモック)。実 DB も触らない(APPDATA を隔離)。

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScalpPlanResult } from '../llm/scalpPlan.js';

let canned: ScalpPlanResult = { ok: false, error: 'unset' };

vi.mock('../llm/scalpPlanRunner.js', () => ({
  runScalpPlanWithChart: vi.fn(async () => canned),
}));
vi.mock('../sse/broker.js', () => ({ broadcast: () => { /* noop */ } }));

import { buildPlanNote, PLAN_GATES, type PlanGate } from './planNote.js';
import { SignalEngine } from './engine.js';
import { openDb, resolveDbPath, getSignalPlans } from '../db/store.js';

const NOW = Date.UTC(2026, 7, 3, 1, 0, 0);   // 取引時間内(2026-08-03 月曜 10:00 JST)
const REF = 38250;
const AT = 1_700_000_000_000;
const A_CFG = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };

// ★ユーザーの実DBを絶対に触らない(planLedgerAbSplit.test.ts と同じ隔離作法)。
const ROOT = mkdtempSync(join(tmpdir(), 'jp225-plannote-'));
const QUARANTINE = join(ROOT, 'quarantine');
mkdirSync(QUARANTINE, { recursive: true });
const ORIG_APPDATA = process.env.APPDATA;
process.env.APPDATA = QUARANTINE;

let dir: string;
let seq = 0;

beforeEach(() => {
  dir = join(ROOT, `case-${++seq}`);
  mkdirSync(dir, { recursive: true });
  process.env.APPDATA = dir;
  vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
  vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
});
afterEach(() => {
  process.env.APPDATA = QUARANTINE;
  vi.restoreAllMocks();
});
afterAll(() => {
  if (ORIG_APPDATA !== undefined) process.env.APPDATA = ORIG_APPDATA; else delete process.env.APPDATA;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

function plans(): number {
  const db = openDb(resolveDbPath());
  try { return getSignalPlans(db).length; } finally { db.close(); }
}

async function runCycle(result: ScalpPlanResult): Promise<SignalEngine> {
  canned = result;
  const eng = new SignalEngine(A_CFG);
  await eng.start();
  eng.feed(REF, NOW);
  await vi.waitFor(() => expect(plans()).toBe(1), { timeout: 3000 });
  return eng;
}

// ── 実データ(2026-08-24 の分割21件)と同じ形の標本 ──────────────────────────
//   ★prices_kabu.db の複製から書き写したもの(a_why は実物の1件をそのまま使う)。
const REAL_A_WHY = '現値がフィボナッチの50%戻しを下回っており、直近の動きが横ばい。RSIも50付近で上昇・下降の明確な勢いが見られない。';
const REAL_RATIONALE = `目線はレンジ(${REAL_A_WHY})。レンジの取引は設定で無効なため見送り。`;

const rangeDisabledResult: ScalpPlanResult = {
  ok: true,
  plan: { direction: 'none', rationale: REAL_RATIONALE, refPrice: REF },
  noneReason: 'rangeDisabled',
  splitRecord: { aDirection: 'range', aWhy: REAL_A_WHY, bVariant: 'none', squeezeState: null },
};

describe('§目線は A の答えからしか取らない(推測で復元しない)', () => {
  it('分割の回(rangeDisabled・実データと同じ形): 目線・理由・見送りの語がそろう', () => {
    const n = buildPlanNote(rangeDisabledResult, AT);
    expect(n).toEqual({
      at: AT, bias: 'range', why: REAL_A_WHY,
      reason: 'rangeDisabled', reasonText: 'レンジ設定が無効',
    });
  });

  it('★理由は A の自由文(a_why)を使い、合成文の rationale は使わない', () => {
    const n = buildPlanNote(rangeDisabledResult, AT);
    // 合成文には「目線はレンジ(…)。…見送り。」が入る=画面の3行と3重になる。
    expect(n?.why).not.toContain('目線はレンジ');
    expect(n?.why).not.toContain('見送り');
  });

  it('★旧経路(splitRecord 無し)は、rationale が「目線はレンジ」と書いていても bias を付けない', () => {
    const n = buildPlanNote({
      ok: true,
      plan: { direction: 'none', rationale: REAL_RATIONALE, refPrice: REF },
      noneReason: 'ai',
    }, AT);
    expect(n?.bias).toBeUndefined();
    // 理由は出す(rationale しか無いのでそれを使う)。見送りの語も出す。
    expect(n?.why).toBe(REAL_RATIONALE);
    expect(n?.reasonText).toBe('AIが提案せず');
  });

  it('旧経路で directionWhy が在れば rationale より優先する', () => {
    const n = buildPlanNote({
      ok: true,
      plan: { direction: 'none', rationale: 'LC幅は60円', refPrice: REF, directionWhy: '直近安値を切り上げている' },
      noneReason: 'ai',
    }, AT);
    expect(n?.why).toBe('直近安値を切り上げている');
    expect(n?.bias).toBeUndefined();
  });

  it('bull/bear/range を画面の語彙(buy/sell/range)へ写す', () => {
    const of = (aDirection: 'bull' | 'bear' | 'range'): string | undefined => buildPlanNote({
      ok: true, plan: { direction: 'none', rationale: 'x', refPrice: REF }, noneReason: 'ai',
      splitRecord: { aDirection, aWhy: 'w', bVariant: 'none', squeezeState: null },
    }, AT)?.bias;
    expect(of('bull')).toBe('buy');
    expect(of('bear')).toBe('sell');
    expect(of('range')).toBe('range');
  });

  it('A は答えたが B の呼び出しで落ちた回(ok:false)でも、目線と理由だけは残る', () => {
    const n = buildPlanNote({
      ok: false, error: 'B timeout',
      splitRecord: { aDirection: 'bull', aWhy: '高値切り上げが続く', bVariant: 'buy', squeezeState: null },
    }, AT);
    expect(n?.bias).toBe('buy');
    expect(n?.why).toBe('高値切り上げが続く');
    // ★見送りの語は名乗らない(ok:false は noneReason を持たない=嘘の理由を作らない)。
    expect(n?.reason).toBeUndefined();
    expect(n?.reasonText).toBeUndefined();
  });

  it('★材料が1つも無い回は null(空の括弧や「不明」を作らない)', () => {
    expect(buildPlanNote({ ok: false, error: '画像が撮れない' }, AT)).toBeNull();
    expect(buildPlanNote({ ok: true, plan: { direction: 'none', rationale: '   ', refPrice: REF } }, AT)).toBeNull();
  });
});

describe('§engine → SSE state(配線の実証)', () => {
  it('見送りサイクルの後、getState().lastNone に目線と理由が載る', async () => {
    const eng = await runCycle(rangeDisabledResult);
    const s = eng.getState(NOW);
    console.info(`[実測/配線] phase=${s.phase} bias=${s.lastNone?.bias} reason=${s.lastNone?.reason} why=${(s.lastNone?.why ?? '').slice(0, 20)}…`);
    expect(s.phase).toBe('flat');
    expect(s.lastNone?.bias).toBe('range');
    expect(s.lastNone?.reasonText).toBe('レンジ設定が無効');
    expect(s.lastNone?.why).toBe(REAL_A_WHY);
    eng.stop();
  });

  it('★ARM した回は lastNone を付けない(古い見送りの理由を残さない)', async () => {
    const eng = await runCycle({
      ok: true,
      plan: {
        direction: 'buy', rationale: '押し目買い', refPrice: REF,
        limitEntry: REF - 50, stopLossForLimit: REF - 100,
      },
      splitRecord: { aDirection: 'bull', aWhy: '高値切り上げ', bVariant: 'buy', squeezeState: null },
    });
    const s = eng.getState(NOW);
    expect(s.phase).toBe('armed');
    expect(s.lastNone).toBeUndefined();
    eng.stop();
  });

  it('★1度も計画していない起動直後は lastNone を付けない=既存 SSE JSON と同一', async () => {
    canned = rangeDisabledResult;
    const eng = new SignalEngine(A_CFG);
    await eng.start();
    expect(eng.getState(NOW).lastNone).toBeUndefined();
    eng.stop();
  });
});

// ★2026-08-24(リーダー裁定①): 「AI は目線を出したが、こちらの検証で止めた」回にも目線を出す。
//
// ■ 実測(prices_kabu.db の複製・8/19 00:00 JST 以降)
//   ARM しなかった行は 127件。うち direction='none' が120件、**残る7件は direction='sell' のまま**
//   こちらのゲートで止まっていた(全件サニティ不通過・単レッグが現在値から200円超)。
//   ★この7件の目線は **AI が答えた値そのもの**(plan.direction)であって推測ではない。
describe('§コードが抑止した回(direction が buy/sell のまま ARM しなかった)', () => {
  const suppressedPlan = {
    ok: true as const,
    plan: {
      direction: 'sell' as const, refPrice: 66065,
      rationale: '現在の下降トレンドを考慮し、強いサポートを下抜けることで下落が期待できるため計画した。',
      stopEntry: 65815, stopLossForStop: 65875,
    },
  };

  it('★目線は plan.direction から取る(sell → 売り目線の語彙)', () => {
    const n = buildPlanNote(suppressedPlan, AT, 'sanity');
    expect(n?.bias).toBe('sell');
    expect(n?.suppressed).toBe(true);
    expect(n?.reason).toBe('sanity');
  });

  it('★サニティ/refドリフト/再検証は 2026-08-24 に足した新しい語彙(既存語が無かった)', () => {
    // ★2026-08-24 以前はここが undefined で、画面は「不採用」の1語に縮退していた。
    //   リーダー裁定で3語を足した(足りなかった根拠は planNote.ts の GATE_TEXT コメントに実測で残す)。
    expect(buildPlanNote(suppressedPlan, AT, 'sanity')?.reasonText).toBe('エントリーが現在値から遠い');
    expect(buildPlanNote(suppressedPlan, AT, 'refDrift')?.reasonText).toBe('価格が動いた');
    expect(buildPlanNote(suppressedPlan, AT, 'recheck')?.reasonText).toBe('再検証で落ちた');
  });

  it('既存語彙が在るゲートはその日本語を載せる(SSOT と待機表示から流用)', () => {
    expect(buildPlanNote(suppressedPlan, AT, 'stale')?.reasonText).toBe('現在値が既にエントリーを通過');
    expect(buildPlanNote(suppressedPlan, AT, 'armBlocked')?.reasonText).toBe('連続失効');
  });

  it('★gate は noneReason より優先する(止めたのはゲートだから)', () => {
    const n = buildPlanNote({ ...suppressedPlan, noneReason: 'ai' } as never, AT, 'sanity');
    expect(n?.reason).toBe('sanity');
    expect(n?.suppressed).toBe(true);
  });

  it("★direction='none' の回は plan からも目線を作らない(推測しない)", () => {
    const n = buildPlanNote({
      ok: true, plan: { direction: 'none', rationale: '良い場面が無い', refPrice: 66065 }, noneReason: 'ai',
    }, AT);
    expect(n?.bias).toBeUndefined();
  });

  it('★A の答え(aDirection)は plan.direction より優先する', () => {
    const n = buildPlanNote({
      ok: true, plan: { direction: 'sell', rationale: 'x', refPrice: 1 },
      splitRecord: { aDirection: 'bear', aWhy: 'w', bVariant: 'sell', squeezeState: null },
    }, AT, 'sanity');
    expect(n?.bias).toBe('sell');
    expect(n?.why).toBe('w');
  });
});

describe('§engine → SSE state: コードが抑止した回', () => {
  it('★サニティ不通過(実測7件と同じ形: 単レッグが現在値から200円超)で目線が state に載る', async () => {
    // ref から 250円離れた単レッグ = MAX_ENTRY_DISTANCE_YEN(200) 超 → サニティ不通過。
    const eng = await runCycle({
      ok: true,
      plan: {
        direction: 'sell', refPrice: REF,
        rationale: '強いサポートを下抜けることで下落が期待できる',
        stopEntry: REF - 250, stopLossForStop: REF - 190,
      },
    });
    const s = eng.getState(NOW);
    console.info(`[実測/抑止] phase=${s.phase} bias=${s.lastNone?.bias} reason=${s.lastNone?.reason} suppressed=${s.lastNone?.suppressed}`);
    expect(s.phase).toBe('flat');
    expect(s.lastNone?.bias).toBe('sell');
    expect(s.lastNone?.suppressed).toBe(true);
    expect(s.lastNone?.reason).toBe('sanity');
    expect(s.lastNone?.reasonText).toBe('エントリーが現在値から遠い');
    eng.stop();
  });
});

// ★2026-08-24(リーダー裁定): ゲートの表。**新しいゲートを足したら必ずここが落ちる。**
//
// ■ なぜ要るか
//   ゲートを1つ足して文言を書き忘れると、画面は「不採用」の1語に縮退する=
//   「何が起きたか分からない表示」になり、この案件の目的(なぜそうなったかの理由の表示)を外す。
//   ★tsc も Record<PlanGate,string> で守るが、**テストでも落ちる**ようにする(この案件の流儀)。
//
// ■ ★恒真でないことの実証(このファイルの外で実施・報告に記載)
//   PLAN_GATES に 6つめ('foo')を足すと、下の3本のうち少なくとも1本が実際に赤くなることを確認済み。
describe('§ゲートの表(新しいゲートを足したら落ちる)', () => {
  it('★ゲートは5つ。増減したらここで気づく', () => {
    expect([...PLAN_GATES]).toEqual(['sanity', 'refDrift', 'stale', 'recheck', 'armBlocked']);
    expect(PLAN_GATES.length).toBe(5);
  });

  it('★すべてのゲートに日本語がある(1つでも欠けたら赤)', () => {
    const dummy = { ok: true as const, plan: { direction: 'sell' as const, rationale: 'x', refPrice: 1 } };
    const missing = PLAN_GATES.filter(g => {
      const t = buildPlanNote(dummy, AT, g)?.reasonText;
      return typeof t !== 'string' || t.trim().length === 0;
    });
    expect(missing).toEqual([]);
  });

  it('★文言に数値を入れない(閾値が変わったら嘘になる)', () => {
    const dummy = { ok: true as const, plan: { direction: 'sell' as const, rationale: 'x', refPrice: 1 } };
    for (const g of PLAN_GATES) {
      const t = buildPlanNote(dummy, AT, g)?.reasonText ?? '';
      expect(t, `${g} の文言に数字が入っている: ${t}`).not.toMatch(/[0-9０-９]/);
    }
  });

  it('★裁定どおりの文言であること(リリースノートと画面が食い違わない)', () => {
    const dummy = { ok: true as const, plan: { direction: 'sell' as const, rationale: 'x', refPrice: 1 } };
    const text = (g: PlanGate): string | undefined => buildPlanNote(dummy, AT, g)?.reasonText;
    expect(text('sanity')).toBe('エントリーが現在値から遠い');
    expect(text('refDrift')).toBe('価格が動いた');
    expect(text('recheck')).toBe('再検証で落ちた');
    expect(text('stale')).toBe('現在値が既にエントリーを通過');       // ★既存 SSOT からの引き
    expect(text('armBlocked')).toBe('連続失効');                      // ★既存の待機表示の語
  });
});

// ★2026-08-24(第2版・エバリュエーター指摘②): **A が目線だけ返した回**(理由なし)に、
//   合成文が理由の行へ落ちていた。parseTrendAnswer は理由なしを明示的に許しているので、
//   この回は実際に起こりうる(実測41件では a_why 41/41 記入済みで発生率0だったが、経路は開いていた)。
//   ★直す前の出力(再現済み):
//       レンジ目線 ／ 目線はレンジ。レンジの取引は設定で無効なため見送り。
//       見送り: レンジ設定が無効
describe('§分割の回は合成文へ落ちない(A が理由を返さなかった回)', () => {
  // scalpPlanSplit.ts の レンジ不許可 分岐が、A の why 無しで作る実際の形。
  const noAWhy = {
    ok: true as const,
    plan: { direction: 'none' as const, rationale: '目線はレンジ。レンジの取引は設定で無効なため見送り。', refPrice: 65000 },
    noneReason: 'rangeDisabled' as const,
    splitRecord: { aDirection: 'range' as const, bVariant: 'none' as const, squeezeState: null },
  };

  it('★a_why が無い分割の回: 目線は出るが、理由は **付けない**(合成文を名乗らない)', () => {
    const n = buildPlanNote(noAWhy, AT);
    expect(n?.bias).toBe('range');
    expect(n?.why).toBeUndefined();
    expect(n?.reasonText).toBe('レンジ設定が無効');
  });

  it('★A 失敗 / B 無言 の合成文も同じく落ちない', () => {
    for (const [rationale, reason] of [
      ['目線の判断が得られませんでした(呼び出し失敗)。', 'aFailed'],
      ['AI が規定の形で答えませんでした。', 'aiSilent'],
    ] as const) {
      const n = buildPlanNote({
        ok: true, plan: { direction: 'none', rationale, refPrice: 65000 }, noneReason: reason,
        splitRecord: { aDirection: 'range', bVariant: 'none', squeezeState: null },
      }, AT);
      expect(n?.why, `${reason} で合成文が理由になっている`).toBeUndefined();
    }
  });

  it('★分割の回でも directionWhy が在れば使う(A の why と同じ文字列が入る経路)', () => {
    const n = buildPlanNote({
      ok: true,
      plan: { direction: 'none', rationale: '合成文', refPrice: 65000, directionWhy: '高値切り上げが続く' },
      noneReason: 'ai',
      splitRecord: { aDirection: 'bull', bVariant: 'buy', squeezeState: null },
    }, AT);
    expect(n?.why).toBe('高値切り上げが続く');
  });

  it('★旧経路(splitRecord 無し)は従来どおり rationale まで落ちる(1バイトも変えていない)', () => {
    const n = buildPlanNote({
      ok: true, plan: { direction: 'none', rationale: '良い場面が無いため見送り。', refPrice: 65000 }, noneReason: 'ai',
    }, AT);
    expect(n?.why).toBe('良い場面が無いため見送り。');
  });
});

// ★2026-08-24(第3版・エバリュエーター指摘①): 第2版の直し方(分割の回は rationale を一切見ない)は
//   **行き過ぎ** で、A が目線だけ返し B が本物の理由を返した回に B の理由を捨てていた。
//   合成文が入るのは scalpPlanSplit.ts の3経路だけで、その3経路は noneReason が
//   aFailed / rangeDisabled / aiSilent に確定する=正規表現なしで見分けられる。
describe('§分割の回の理由: 合成文だけを避け、B の本物の理由は捨てない', () => {
  /** A は目線だけ(why 無し)・B が本物の理由を返して両脚落ち(noneReason='ai')。 */
  const bRealReason = {
    ok: true as const,
    plan: { direction: 'none' as const, rationale: '節目が近すぎて置けないため見送り。', refPrice: 65000 },
    noneReason: 'ai' as const,
    splitRecord: { aDirection: 'bull' as const, bVariant: 'buy' as const, squeezeState: null },
  };

  it('★退行の再発防止: A に why 無し × B に本物の理由 → **理由が出る**', () => {
    const n = buildPlanNote(bRealReason, AT);
    expect(n?.bias).toBe('buy');
    expect(n?.why).toBe('節目が近すぎて置けないため見送り。');   // ★第2版はここが undefined だった
  });

  it('合成文の3経路(aFailed / rangeDisabled / aiSilent)は従来どおり理由にしない', () => {
    for (const [rationale, reason] of [
      ['目線はレンジ。レンジの取引は設定で無効なため見送り。', 'rangeDisabled'],
      ['目線の判断が得られませんでした(呼び出し失敗)。', 'aFailed'],
      ['AI が規定の形で答えませんでした。', 'aiSilent'],
    ] as const) {
      const n = buildPlanNote({
        ok: true, plan: { direction: 'none', rationale, refPrice: 65000 }, noneReason: reason,
        splitRecord: { aDirection: 'range', bVariant: 'none', squeezeState: null },
      }, AT);
      expect(n?.why, `${reason} で合成文が理由になっている`).toBeUndefined();
    }
  });

  it('優先順位は aWhy → directionWhy → rationale', () => {
    const base = {
      ok: true as const, noneReason: 'ai' as const,
      plan: { direction: 'none' as const, rationale: 'R', refPrice: 65000, directionWhy: 'D' },
      splitRecord: { aDirection: 'bull' as const, aWhy: 'A', bVariant: 'buy' as const, squeezeState: null },
    };
    expect(buildPlanNote(base, AT)?.why).toBe('A');
    expect(buildPlanNote({ ...base, splitRecord: { ...base.splitRecord, aWhy: undefined } }, AT)?.why).toBe('D');
    expect(buildPlanNote({
      ...base, plan: { ...base.plan, directionWhy: undefined },
      splitRecord: { ...base.splitRecord, aWhy: undefined },
    }, AT)?.why).toBe('R');
  });
});

// ★★「修正の逆側」(2026-08-24 から定型に追加): この直しで **逆に出なくなる入力** が無いか。
//   ★見つけた1件: 'rangeDisabled' は **旧経路(scalpPlan.ts)でも付く** ので、合成文の除外を
//     splitRecord の有無に紐づけずに広げると、旧経路の AI 自身の文が消える。
describe('§逆側: 合成文の除外を旧経路へ広げていない', () => {
  it("★旧経路の 'rangeDisabled' は AI 自身の文を理由として出す(消えない)", () => {
    const n = buildPlanNote({
      ok: true,
      plan: { direction: 'none', rationale: 'レンジ相場と判断したため今回は入らない。', refPrice: 65000 },
      noneReason: 'rangeDisabled',
    }, AT);
    expect(n?.why).toBe('レンジ相場と判断したため今回は入らない。');
    expect(n?.bias).toBeUndefined();   // 旧経路は目線ラベルを出さない(従来どおり)
  });

  it("★旧経路の 'aiSilent' / 'aFailed' も同じ(旧経路の rationale は合成文ではない)", () => {
    for (const reason of ['aiSilent', 'aFailed'] as const) {
      const n = buildPlanNote({
        ok: true, plan: { direction: 'none', rationale: 'AI の本文', refPrice: 65000 }, noneReason: reason,
      }, AT);
      expect(n?.why, `旧経路 ${reason} で理由が消えている`).toBe('AI の本文');
    }
  });
});
