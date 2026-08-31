import { describe, it, expect } from 'vitest';
import { planToArmed, armedToCurrentSignal, toSignalTradeState, reverseToDoten, type EngineState } from './decisions.js';
import type { AiPlan } from '../llm/openai.js';

// ★v0.9.86: AI の「相場の読み」(strategy / strategyWhy)を **画面まで** 運ぶ配線の実証。
//   v0.9.85 は台帳(signal_plans)にだけ記録し、SSE には1バイトも載せていなかった=画面に出しようがなかった。
//   経路: AiPlan → planToArmed(ArmedBracket) → armedToCurrentSignal(CurrentSignal) → toSignalTradeState(SSE payload)。
//   ★記録専用の持ち回り: 採否・価格・脚落ちには一切影響しない(下の「否定対照」で価格が同一であることを固定する)。

const BUY_PLAN = {
  direction: 'buy' as const,
  limitEntry: 68725, stopLossForLimit: 68665,
  stopEntry: 68780, stopLossForStop: 68720,
  rationale: '押し目買い',
};
const STRATEGY = 'トレンド押し目・戻り';
const WHY = '上昇トレンド中、S1まで引きつけて反発を取る';

describe('planToArmed: 相場の読みを armed へ運ぶ', () => {
  it('directional: strategy / strategyWhy がそのまま載る', () => {
    const a = planToArmed({ ...BUY_PLAN, strategy: STRATEGY, strategyWhy: WHY }, 1000);
    expect(a?.strategy).toBe(STRATEGY);
    expect(a?.strategyWhy).toBe(WHY);
  });

  it('range: 両面ストラドルでも載る', () => {
    const a = planToArmed({
      direction: 'range', rationale: 'レンジ',
      range: {
        upper: { side: 'sell', type: 'limit', entry: 68900, stopLoss: 68960 },
        lower: { side: 'buy', type: 'limit', entry: 68700, stopLoss: 68640 },
      },
      strategy: 'レンジ内', strategyWhy: '上下端が効いている',
    }, 1000);
    expect(a?.mode).toBe('range');
    expect(a?.strategy).toBe('レンジ内');
    expect(a?.strategyWhy).toBe('上下端が効いている');
  });

  it('★一覧外のラベルも丸めない(台帳と同じ規約)', () => {
    expect(planToArmed({ ...BUY_PLAN, strategy: '寄り天狙い' }, 1000)?.strategy).toBe('寄り天狙い');
  });

  it('★否定対照: 欠落した計画から作る armed は従来と byte 一致(価格も1円も動かない)', () => {
    const bare = planToArmed(BUY_PLAN, 1000);
    const withS = planToArmed({ ...BUY_PLAN, strategy: STRATEGY, strategyWhy: WHY }, 1000);
    expect('strategy' in (bare as object)).toBe(false);
    expect('strategyWhy' in (bare as object)).toBe(false);
    // 採否・価格・脚は完全に同一(記録専用=判断に使っていない)。
    expect({ ...withS, strategy: undefined, strategyWhy: undefined })
      .toEqual({ ...bare, strategy: undefined, strategyWhy: undefined });
    expect(withS?.limitEntry).toBe(bare?.limitEntry);
    expect(withS?.stopEntry).toBe(bare?.stopEntry);
    expect(withS?.stopLossForLimit).toBe(bare?.stopLossForLimit);
    expect(withS?.stopLossForStop).toBe(bare?.stopLossForStop);
  });
});

describe('armedToCurrentSignal: 相場の読みを現在シグナルへ運ぶ', () => {
  it('在れば引き継ぎ、無ければフィールドごと付けない', () => {
    const a = planToArmed({ ...BUY_PLAN, strategy: STRATEGY, strategyWhy: WHY }, 1000)!;
    const s = armedToCurrentSignal(a, 7);
    expect(s.strategy).toBe(STRATEGY);
    expect(s.strategyWhy).toBe(WHY);
    const bare = armedToCurrentSignal(planToArmed(BUY_PLAN, 1000)!, 7);
    expect('strategy' in bare).toBe(false);
    expect('strategyWhy' in bare).toBe(false);
  });
});

describe('toSignalTradeState: SSE payload に載る(★これが無いと画面に出しようがない)', () => {
  const armedState = (strategy?: string, why?: string): EngineState => ({
    phase: 'armed',
    armed: planToArmed({ ...BUY_PLAN, ...(strategy ? { strategy } : {}), ...(why ? { strategyWhy: why } : {}) }, 1000)!,
  });

  it('signal / entry の両方に載る(パネルはどちらの経路でも描ける)', () => {
    const st = armedState(STRATEGY, WHY);
    const sig = armedToCurrentSignal(st.armed!, 7);
    const s = toSignalTradeState(st, 68750, 2000, sig);
    expect(s.signal?.strategy).toBe(STRATEGY);
    expect(s.signal?.strategyWhy).toBe(WHY);
    expect(s.entry?.strategy).toBe(STRATEGY);
    expect(s.entry?.strategyWhy).toBe(WHY);
    // ★実際に SSE へ流れるのは JSON。文字列化しても消えないことを見る。
    const json = JSON.parse(JSON.stringify(s));
    expect(json.signal.strategy).toBe(STRATEGY);
    expect(json.signal.strategyWhy).toBe(WHY);
  });

  it('保有中(filled)でも現在シグナルの読みは載り続ける', () => {
    const sig = armedToCurrentSignal(armedState(STRATEGY, WHY).armed!, 7);
    const filled: EngineState = {
      phase: 'filled',
      position: { direction: 'buy', entryPrice: 68725, qty: 1, initialStop: 68665, peakProfit: 0, rationale: '押し目買い', at: 1500 },
    };
    const s = toSignalTradeState(filled, 68750, 2000, sig);
    expect(s.signal?.strategy).toBe(STRATEGY);
    expect(s.signal?.strategyWhy).toBe(WHY);
  });

  it('★否定対照: 欠落なら SSE の JSON は従来と byte 一致(dedupe / 旧クライアント互換)', () => {
    const st = armedState();
    const sig = armedToCurrentSignal(st.armed!, 7);
    const json = JSON.stringify(toSignalTradeState(st, 68750, 2000, sig));
    expect(json.includes('strategy')).toBe(false);
    // 参照実装: strategy を持たない armed から作った state(=従来の形)と完全一致。
    expect(json).toBe(JSON.stringify(toSignalTradeState(
      { phase: 'armed', armed: planToArmed(BUY_PLAN, 1000)! }, 68750, 2000,
      armedToCurrentSignal(planToArmed(BUY_PLAN, 1000)!, 7),
    )));
  });

  it('ドテン(反転)経路でも読みが運ばれる', () => {
    const held: EngineState = {
      phase: 'filled',
      position: { direction: 'sell', entryPrice: 68900, qty: 1, initialStop: 68960, peakProfit: 0, rationale: '戻り売り', at: 500 },
    };
    const plan: AiPlan = { ...BUY_PLAN, refPrice: 68750, strategy: 'ドテン', strategyWhy: '上昇転換で保有の売りを畳む' };
    const rev = reverseToDoten(held, plan, 68750, 2000);
    expect(rev?.armed.strategy).toBe('ドテン');
    const s = toSignalTradeState(rev!.next, 68750, 2000, armedToCurrentSignal(rev!.armed, 8));
    expect(s.signal?.strategy).toBe('ドテン');
    expect(s.signal?.strategyWhy).toBe('上昇転換で保有の売りを畳む');
    expect(s.signal?.doten).toBe(true);
  });
});

// ─── ★v0.9.87: 「その価格の根拠にした節目」(limitLevel / stopLevel)を画面まで運ぶ配線 ────
//   経路は strategy と同一: AiPlan → planToArmed → armedToCurrentSignal → toSignalTradeState → signalPanel。
//   ★内側/外側と距離は画面側の純関数が計算する(ここで運ぶのは節目の生値だけ)。
//   ★記録+表示専用: 採否・価格・脚落ちには1バイトも影響しない(下の否定対照で価格の同一性を固定)。
const LIMIT_LEVEL = 68700;
const STOP_LEVEL = 68775;

describe('★節目(limitLevel / stopLevel)を画面まで運ぶ', () => {
  it('planToArmed → armedToCurrentSignal → SSE の全段で残る', () => {
    const a = planToArmed({ ...BUY_PLAN, limitLevel: LIMIT_LEVEL, stopLevel: STOP_LEVEL }, 1000)!;
    expect(a.limitLevel).toBe(LIMIT_LEVEL);
    expect(a.stopLevel).toBe(STOP_LEVEL);
    const sig = armedToCurrentSignal(a, 7);
    expect(sig.limitLevel).toBe(LIMIT_LEVEL);
    expect(sig.stopLevel).toBe(STOP_LEVEL);
    const json = JSON.parse(JSON.stringify(toSignalTradeState({ phase: 'armed', armed: a }, 68750, 2000, sig)));
    expect(json.signal.limitLevel).toBe(LIMIT_LEVEL);
    expect(json.signal.stopLevel).toBe(STOP_LEVEL);
    // entry 経路(signal を持たない後方互換の描画)でも落ちない。
    expect(json.entry.limitLevel).toBe(LIMIT_LEVEL);
    expect(json.entry.stopLevel).toBe(STOP_LEVEL);
  });

  it('片方だけの申告も片方だけ運ぶ(欠けた側はフィールドごと付けない)', () => {
    const a = planToArmed({ ...BUY_PLAN, limitLevel: LIMIT_LEVEL }, 1000)!;
    expect(a.limitLevel).toBe(LIMIT_LEVEL);
    expect('stopLevel' in a).toBe(false);
    expect('stopLevel' in armedToCurrentSignal(a, 7)).toBe(false);
  });

  it('★壊れた値(NaN/Infinity)は運ばない(画面に嘘の距離を出させない)', () => {
    const a = planToArmed({ ...BUY_PLAN, limitLevel: NaN, stopLevel: Infinity }, 1000)!;
    expect('limitLevel' in a).toBe(false);
    expect('stopLevel' in a).toBe(false);
  });

  it('★否定対照: 申告が無ければ armed も SSE JSON も従来と byte 一致(価格も1円も動かない)', () => {
    const bare = planToArmed(BUY_PLAN, 1000)!;
    const withL = planToArmed({ ...BUY_PLAN, limitLevel: LIMIT_LEVEL, stopLevel: STOP_LEVEL }, 1000)!;
    expect('limitLevel' in bare).toBe(false);
    expect('stopLevel' in bare).toBe(false);
    expect(withL.limitEntry).toBe(bare.limitEntry);
    expect(withL.stopEntry).toBe(bare.stopEntry);
    expect(withL.stopLossForLimit).toBe(bare.stopLossForLimit);
    expect(withL.stopLossForStop).toBe(bare.stopLossForStop);
    const json = JSON.stringify(toSignalTradeState(
      { phase: 'armed', armed: bare }, 68750, 2000, armedToCurrentSignal(bare, 7),
    ));
    expect(json.includes('Level')).toBe(false);
  });

  it('ドテン(反転)経路でも節目が運ばれる', () => {
    const held: EngineState = {
      phase: 'filled',
      position: { direction: 'sell', entryPrice: 68900, qty: 1, initialStop: 68960, peakProfit: 0, rationale: '戻り売り', at: 500 },
    };
    const plan: AiPlan = { ...BUY_PLAN, refPrice: 68750, limitLevel: LIMIT_LEVEL, stopLevel: STOP_LEVEL };
    const rev = reverseToDoten(held, plan, 68750, 2000)!;
    expect(rev.armed.limitLevel).toBe(LIMIT_LEVEL);
    const s = toSignalTradeState(rev.next, 68750, 2000, armedToCurrentSignal(rev.armed, 8));
    expect(s.signal?.stopLevel).toBe(STOP_LEVEL);
  });
});

// ─── ★TP(利確)を **待機中のシグナル** まで運ぶ配線の実証 ────────────────────────────
//   ■ 何が欠けていたか: TP は 計画 → armed → **建玉** までしか運ばれておらず、
//     待機中(armed)のシグナルには TP の材料が1バイトも無かった=ボードは描きようがなかった。
//   ■ ★直し方(2周目の裁定): **発火価格を server が計算して載せる**。画面は描くだけ。
//     ・幅(tpWidthFor*)……… 記録/分析用に運ぶ(画面は使わない)
//     ・価格(tpTriggerFor*)… ★**毎 broadcast いまの設定(TpDirective)から** 引き直す。
//       ★ARM 時のスナップショット(signal.settings)は使わない=設定を変えれば値が変わる=SSE が再送される。
//   ■ ★式は増やしていない: resolveTpWidth → takeProfitTrigger(決済が通るのと同じ2つ)だけで作る。
const TP_LIMIT = 70;
const TP_STOP = 90;
const TP_PLAN = { ...BUY_PLAN, tpWidthForLimit: TP_LIMIT, tpWidthForStop: TP_STOP };
/** engine が毎tick 解決して渡すもの(= tpDirective() の戻り値と同じ形)。 */
const AI_ON = { enabled: true, manualYen: null };
const OFF = { enabled: false, manualYen: null };
const MANUAL40 = { enabled: true, manualYen: 40 };
const sse = (plan: typeof BUY_PLAN & { tpWidthForLimit?: number; tpWidthForStop?: number },
             tp: { enabled: boolean; manualYen: number | null } | null) => {
  const a = planToArmed(plan, 1000)!;
  return toSignalTradeState({ phase: 'armed', armed: a }, 68750, 2000, armedToCurrentSignal(a, 7),
    undefined, undefined, undefined, undefined, tp);
};

describe('★TP を待機中のシグナルへ(幅=記録用 / 価格=画面用)', () => {
  it('幅は armedToCurrentSignal → SSE へそのまま運ばれる(記録/分析用)', () => {
    const a = planToArmed(TP_PLAN, 1000)!;
    expect(a.tpWidthForLimit).toBe(TP_LIMIT);
    const s = armedToCurrentSignal(a, 7);
    expect(s.tpWidthForLimit).toBe(TP_LIMIT);
    expect(s.tpWidthForStop).toBe(TP_STOP);
    expect(sse(TP_PLAN, AI_ON).signal?.tpWidthForStop).toBe(TP_STOP);
  });

  it('★AI委任: 価格 = エントリー ± AI の幅(買い=+)', () => {
    const st = sse(TP_PLAN, AI_ON);
    expect(st.signal?.tpTriggerForLimit).toBe(68725 + TP_LIMIT);   // 指値 68,725
    expect(st.signal?.tpTriggerForStop).toBe(68780 + TP_STOP);     // 逆指値 68,780
  });

  it('★手動: 設定の現在値が勝つ(AI の幅が載っていても)=決済側 resolveTpWidth と同じ優先順位', () => {
    const st = sse(TP_PLAN, MANUAL40);
    expect(st.signal?.tpTriggerForLimit).toBe(68725 + 40);
    expect(st.signal?.tpTriggerForStop).toBe(68780 + 40);
  });

  it('★TP を切っていれば **TP の欄ごと作らない**(幅も価格も)=切れば1バイトも増えない', () => {
    const st = sse(TP_PLAN, OFF);
    for (const k of ['tpTriggerForLimit', 'tpTriggerForStop', 'tpWidthForLimit', 'tpWidthForStop']) {
      expect(k in (st.signal as object)).toBe(false);
    }
    // ★幅だけを無条件に載せていた版は、TP=OFF でも SSE JSON が TP 導入前と一致しなかった
    //   (不変の実証で2ケース赤になって気づいた)。advance の「無効なら幅を焼かない」と同じ判断に揃える。
    //   ★「切っていた期間」は台帳 signal_plans(tp_width_for_* / settings_json)で数える=SSE で数えない。
    expect(JSON.stringify(st.signal)).not.toContain('tp');
  });

  it('★同じ armed でも、設定を変えれば **SSE の JSON が変わる**(dedupe で古い表示が残らない)', () => {
    const a = planToArmed(TP_PLAN, 1000)!;
    const sig = armedToCurrentSignal(a, 7);
    const json = (tp: { enabled: boolean; manualYen: number | null }) => JSON.stringify(
      toSignalTradeState({ phase: 'armed', armed: a }, 68750, 2000, sig, undefined, undefined, undefined, undefined, tp));
    const on = json(AI_ON), off = json(OFF), man = json(MANUAL40);
    expect(on).not.toBe(off);
    expect(on).not.toBe(man);
    expect(off).not.toBe(man);
  });

  it('★幅が無い/不正な脚には価格を載せない(0・負・NaN は「幅なし」= 決済側と同じ規約)', () => {
    for (const w of [0, -70, NaN]) {
      const st = sse({ ...BUY_PLAN, tpWidthForLimit: w, tpWidthForStop: TP_STOP }, AI_ON);
      expect('tpTriggerForLimit' in (st.signal as object)).toBe(false);
      expect(st.signal?.tpTriggerForStop).toBe(68780 + TP_STOP);
    }
  });

  it('★レンジ両面には載せない(TP を尋ねていない)', () => {
    const a = planToArmed({
      direction: 'range', rationale: 'レンジ',
      range: {
        upper: { side: 'sell', type: 'limit', entry: 68900, stopLoss: 68960 },
        lower: { side: 'buy', type: 'limit', entry: 68700, stopLoss: 68640 },
      },
    }, 1000)!;
    const st = toSignalTradeState({ phase: 'armed', armed: a }, 68750, 2000, armedToCurrentSignal(a, 8),
      undefined, undefined, undefined, undefined, MANUAL40);
    expect(JSON.stringify(st.signal)).not.toContain('tpTrigger');
  });

  it('★否定対照: TP が効かない回は SSE JSON に TP の語が1つも出ない(既存 JSON と byte 一致)', () => {
    const bare = planToArmed(BUY_PLAN, 1000)!;
    const sBare = armedToCurrentSignal(bare, 7);
    expect('tpWidthForLimit' in sBare).toBe(false);
    const withTp = armedToCurrentSignal(planToArmed(TP_PLAN, 1000)!, 7);
    // 価格・脚は完全に同一(表示専用=判断に使っていない)。
    expect(withTp.limitEntry).toBe(sBare.limitEntry);
    expect(withTp.stopEntry).toBe(sBare.stopEntry);
    expect(withTp.stopLossForLimit).toBe(sBare.stopLossForLimit);
    expect(withTp.stopLossForStop).toBe(sBare.stopLossForStop);
    // ★AI委任で幅が無い回 / TP を切っている回 は TP の語が1つも出ない。
    //   ★手動(MANUAL40)は別: 幅が設定に在るので **AI が幅を書かなくても** TP は効く(=価格が載るのが正しい)。
    for (const tp of [AI_ON, OFF]) {
      const json = JSON.stringify(toSignalTradeState({ phase: 'armed', armed: bare }, 68750, 2000, sBare,
        undefined, undefined, undefined, undefined, tp));
      expect(json.includes('tpWidth')).toBe(false);
      expect(json.includes('tpTrigger')).toBe(false);
    }
    // ★対照(恒真でないことの確認): 手動なら同じ armed でも価格が載る。
    expect(toSignalTradeState({ phase: 'armed', armed: bare }, 68750, 2000, sBare,
      undefined, undefined, undefined, undefined, MANUAL40).signal?.tpTriggerForLimit).toBe(68725 + 40);
  });

  it('★エバリュエーターが再現した3経路(ARM 時の設定に依存しない)', () => {
    const a = planToArmed(TP_PLAN, 1000)!;   // ★どの経路も同じ armed(=ARM 時の設定を焼いていない)
    const sig = armedToCurrentSignal(a, 7);
    const st = (tp: { enabled: boolean; manualYen: number | null }) =>
      toSignalTradeState({ phase: 'armed', armed: a }, 68750, 2000, sig, undefined, undefined, undefined, undefined, tp);
    // ① ARM時 ON → 待機中に OFF: 価格が消える(嘘の行が出ない)
    expect(st(AI_ON).signal?.tpTriggerForLimit).toBe(68795);
    expect('tpTriggerForLimit' in (st(OFF).signal as object)).toBe(false);
    // ② ARM時 OFF → 待機中に ON+手動40: 価格が出る
    expect(st(MANUAL40).signal?.tpTriggerForLimit).toBe(68725 + 40);
  });
});
