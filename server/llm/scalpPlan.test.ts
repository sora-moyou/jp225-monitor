import { describe, it, expect, vi } from 'vitest';
import {
  parseScalpPlan, parseRangeLeg, runScalpPlan, buildScalpPlan, isLLMEnabled,
  SCALP_QUESTION, SCALP_SYSTEM_PROMPT,
  buildScalpQuestion, buildScalpSystemPrompt, resolveLcRange, scalpJsonInstruction,
  enforcePlanConstraints, enforcePlanConstraintsReport,
  parseAiRegime, parseAiConfidence, stopSideOk, entrySideOk,
  lcLegExceeds, buildDelegationNote, buildStrategySpec, buildLegNote,
  DEFAULT_LC_FLOOR_YEN, DEFAULT_LC_CEILING_YEN,
  type ToolHandlers, type AiPlan, type KnobModes,
} from './openai.js';

// LLM 応答テキスト→AiPlan の検証(refPrice は必ず monitor 側の値で上書きされる)。
const REF = 38250;

const goodPlan: AiPlan = {
  direction: 'buy',
  limitEntry: 38200,
  stopEntry: 38350,
  stopLossForLimit: 38150,
  stopLossForStop: 38300,
  rationale: '押し目買い。直近安値38200が支持。',
  refPrice: 12345,   // LLM 自己申告(無視される想定)
};

describe('parseScalpPlan', () => {
  it('素の JSON を検証して AiPlan を返す(refPrice は引数で上書き)', () => {
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForLimit).toBe(38150);
      expect(r.plan.stopLossForStop).toBe(38300);
      expect(r.plan.rationale).toContain('押し目');
      expect(r.plan.refPrice).toBe(REF);   // 自己申告12345ではなく monitor 値
    }
  });

  it('コードフェンス+前後説明が混じっても最初の JSON を拾う', () => {
    const raw = 'これが計画です:\n```json\n' + JSON.stringify(goodPlan) + '\n```\n以上。';
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
  });

  it('direction 不正→ok:false', () => {
    const bad = { ...goodPlan, direction: 'hold' };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('direction');
  });

  it('価格が数値でない→ok:false', () => {
    const bad = { ...goodPlan, limitEntry: 'x' };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(false);
  });

  it('rationale 欠落→ok:false', () => {
    const { rationale, ...rest } = goodPlan;
    void rationale;
    const r = parseScalpPlan(JSON.stringify(rest), REF);
    expect(r.ok).toBe(false);
  });

  it('JSON でない→ok:false', () => {
    const r = parseScalpPlan('普通の文章です', REF);
    expect(r.ok).toBe(false);
  });

  it('空文字→ok:false', () => {
    const r = parseScalpPlan('', REF);
    expect(r.ok).toBe(false);
  });

  it('direction:"none"(見送り)は ok:true・価格欠落は不正としない', () => {
    // rationale + refPrice のみ(価格フィールドなし)でも見送りとして正当。
    const r = parseScalpPlan(JSON.stringify({ direction: 'none', rationale: '良い場面なし。様子見。' }), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.plan.rationale).toContain('様子見');
      expect(r.plan.refPrice).toBe(REF);   // refPrice は monitor 値で上書き
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopEntry).toBeUndefined();
    }
  });

  it('direction:"none" は rationale 欠落なら ok:false(見送り理由は必須)', () => {
    const r = parseScalpPlan(JSON.stringify({ direction: 'none' }), REF);
    expect(r.ok).toBe(false);
  });

  it('指値レッグの片側だけ(limitEntry 欠落・stopLossForLimit 残)→ok:false(対の不整合)', () => {
    // レッグは対で出す規約: 片方だけは不正。
    const { limitEntry, ...noLimit } = goodPlan;
    void limitEntry;
    const r = parseScalpPlan(JSON.stringify(noLimit), REF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('limit leg');
  });

  it('逆指値レッグの片側だけ(stopEntry 欠落・stopLossForStop 残)→ok:false(対の不整合)', () => {
    const { stopEntry, ...noStop } = goodPlan;
    void stopEntry;
    const r = parseScalpPlan(JSON.stringify(noStop), REF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('stop leg');
  });

  it('指値のみプラン(逆指値レッグ欠落)→ok:true・plan に limit だけ入る', () => {
    // stopEntry / stopLossForStop を省いた「指値のみ」。逆指値レッグの LC が95円超の時の回避策。
    const { stopEntry, stopLossForStop, ...limitOnly } = goodPlan;
    void stopEntry; void stopLossForStop;
    const r = parseScalpPlan(JSON.stringify(limitOnly), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopLossForLimit).toBe(38150);
      expect(r.plan.stopEntry).toBeUndefined();
      expect(r.plan.stopLossForStop).toBeUndefined();
      expect(r.plan.refPrice).toBe(REF);
    }
  });

  it('逆指値のみプラン(指値レッグ欠落)→ok:true・plan に stop だけ入る', () => {
    const { limitEntry, stopLossForLimit, ...stopOnly } = goodPlan;
    void limitEntry; void stopLossForLimit;
    const r = parseScalpPlan(JSON.stringify(stopOnly), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForStop).toBe(38300);
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopLossForLimit).toBeUndefined();
      expect(r.plan.refPrice).toBe(REF);
    }
  });

  it('両レッグありは従来どおり ok:true(全価格が入る)', () => {
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForLimit).toBe(38150);
      expect(r.plan.stopLossForStop).toBe(38300);
    }
  });

  it('buy で両レッグとも欠落(価格皆無)→ok:false', () => {
    // direction≠none なのに価格が1つも無いのは不正。
    const r = parseScalpPlan(JSON.stringify({ direction: 'buy', rationale: '理由' }), REF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('at least one leg');
  });
});

// ─── 表示整合: buildLegNote(採用レッグの機械生成注記・純関数) ───
describe('buildLegNote(採用レッグ注記・純関数)', () => {
  it('両レッグ→「指値+逆指値」', () => {
    expect(buildLegNote({ hasLimit: true, hasStop: true })).toBe('（実際の注文: 指値+逆指値）');
  });
  it('指値のみ→「指値のみ・逆指値レッグなし」', () => {
    expect(buildLegNote({ hasLimit: true, hasStop: false })).toBe('（実際の注文: 指値のみ・逆指値レッグなし）');
  });
  it('逆指値のみ→「逆指値のみ・指値レッグなし」', () => {
    expect(buildLegNote({ hasLimit: false, hasStop: true })).toBe('（実際の注文: 逆指値のみ・指値レッグなし）');
  });
  it('レッグ皆無→空文字(追記しない)', () => {
    expect(buildLegNote({ hasLimit: false, hasStop: false })).toBe('');
  });
  it('AI が出した逆指値レッグが落とされた→不採用タグを付す', () => {
    const s = buildLegNote({ hasLimit: true, hasStop: false, stopDropped: true });
    expect(s).toBe('（実際の注文: 指値のみ・逆指値レッグなし）（逆指値レッグは条件を満たさず不採用）');
  });
  it('AI が出した指値レッグが落とされた→不採用タグを付す', () => {
    const s = buildLegNote({ hasLimit: false, hasStop: true, limitDropped: true });
    expect(s).toBe('（実際の注文: 逆指値のみ・指値レッグなし）（指値レッグは条件を満たさず不採用）');
  });
});

// ─── 表示整合: parseScalpPlan が rationale 末尾にレッグ注記を追記する ───
describe('parseScalpPlan レッグ注記(表示整合)', () => {
  it('指値のみプラン(AI が逆指値を出さない)→ rationale 末尾が「指値のみ・逆指値レッグなし」・元テキストは前置で保持', () => {
    const { stopEntry, stopLossForStop, ...limitOnly } = goodPlan;
    void stopEntry; void stopLossForStop;
    const r = parseScalpPlan(JSON.stringify(limitOnly), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.rationale.startsWith('押し目買い。直近安値38200が支持。')).toBe(true);
      expect(r.plan.rationale.endsWith('（実際の注文: 指値のみ・逆指値レッグなし）')).toBe(true);
      // AI は逆指値を出していないので不採用タグは付かない。
      expect(r.plan.rationale).not.toContain('不採用');
    }
  });

  it('AI が逆指値レッグを出したが entrySideOk 違反で落ちた→指値レッグ維持+「逆指値レッグ…不採用」注記', () => {
    // buy: 指値は正。逆指値 entry 38200(現在値38250より下=buy には不正)→ 逆指値レッグを落とす。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目・逆指値も置いたつもり', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,   // 正
      stopEntry: 38200, stopLossForStop: 38150,     // entry が現在値より下=buy の逆指値として不正
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBeUndefined();
      expect(r.plan.rationale).toContain('（実際の注文: 指値のみ・逆指値レッグなし）');
      expect(r.plan.rationale).toContain('（逆指値レッグは条件を満たさず不採用）');
    }
  });

  it('正しい両レッグ→注記は「指値+逆指値」', () => {
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.rationale).toContain('（実際の注文: 指値+逆指値）');
      expect(r.plan.rationale).not.toContain('不採用');
    }
  });

  it('none の rationale は注記を付けない(不変)', () => {
    const r = parseScalpPlan(JSON.stringify({ direction: 'none', rationale: '様子見。' }), REF);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.rationale).toBe('様子見。');
  });

  it('range の rationale は注記を付けない(不変)', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ・両面。', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('range');
      expect(r.plan.rationale).toBe('レンジ・両面。');
    }
  });
});

// ─── 損切りの向き検証(orientation): 不正プラン発生源を断つ ───
describe('stopSideOk(損切りの向き・純関数)', () => {
  it('買い(long)は損切りが entry の下だけ true(上/等値は false)', () => {
    expect(stopSideOk('buy', 100, 90)).toBe(true);
    expect(stopSideOk('buy', 100, 110)).toBe(false);   // 上=逆側
    expect(stopSideOk('buy', 100, 100)).toBe(false);   // 境界(幅0)=不正
  });
  it('売り(short)は損切りが entry の上だけ true(下/等値は false)', () => {
    expect(stopSideOk('sell', 100, 110)).toBe(true);
    expect(stopSideOk('sell', 100, 90)).toBe(false);   // 下=逆側
    expect(stopSideOk('sell', 100, 100)).toBe(false);  // 境界(幅0)=不正
  });
});

// エントリー位置の向き検証(refPrice=現在値 に対する 指値/逆指値 の幾何)。
describe('entrySideOk(エントリー位置の向き・純関数)', () => {
  const REF_P = 100;
  it('買い: 指値=現在値より下だけ true / 上は false', () => {
    expect(entrySideOk('buy', 'limit', 90, REF_P)).toBe(true);
    expect(entrySideOk('buy', 'limit', 110, REF_P)).toBe(false);
  });
  it('買い: 逆指値=現在値より上だけ true / 下は false', () => {
    expect(entrySideOk('buy', 'stop', 110, REF_P)).toBe(true);
    expect(entrySideOk('buy', 'stop', 90, REF_P)).toBe(false);
  });
  it('売り: 指値=現在値より上だけ true / 下は false', () => {
    expect(entrySideOk('sell', 'limit', 110, REF_P)).toBe(true);
    expect(entrySideOk('sell', 'limit', 90, REF_P)).toBe(false);
  });
  it('売り: 逆指値=現在値より下だけ true / 上は false', () => {
    expect(entrySideOk('sell', 'stop', 90, REF_P)).toBe(true);
    expect(entrySideOk('sell', 'stop', 110, REF_P)).toBe(false);
  });
  it('境界(entry===refPrice=距離0)は不正(false)', () => {
    expect(entrySideOk('buy', 'limit', 100, REF_P)).toBe(false);
    expect(entrySideOk('sell', 'stop', 100, REF_P)).toBe(false);
  });
  it('refPrice 非有限は検証しない(true=従来通り通す)', () => {
    expect(entrySideOk('buy', 'limit', 110, NaN)).toBe(true);
    expect(entrySideOk('sell', 'stop', 110, Infinity)).toBe(true);
  });
});

// エントリー位置の向き検証(parse・directional): 反転プランを見送り化/レッグ落とし。
describe('parseScalpPlan エントリー位置の向き検証(directional)', () => {
  // REF=38250。
  it('反転 SELL(指値=現在値より下・逆指値=現在値より上)→ 両レッグ不正で見送り(none)', () => {
    // sell なのに 指値38200<REF(下=不正)・逆指値38300>REF(上=不正)。SL 向きは各レッグ正しくしておく。
    const raw = JSON.stringify({
      direction: 'sell', rationale: '反転プラン', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38260,   // SL は entry の上=sell として正
      stopEntry: 38300, stopLossForStop: 38360,     // SL は entry の上=sell として正
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopEntry).toBeUndefined();
      expect(r.plan.refPrice).toBe(REF);
    }
  });

  it('正しい SELL(指値=現在値より上・逆指値=現在値より下)→ 両レッグ維持', () => {
    // sell: 指値38300>REF(戻り売り)・逆指値38200<REF(下抜け追随)。SL 向きも各レッグ正。
    const raw = JSON.stringify({
      direction: 'sell', rationale: '戻り売り+下抜け', refPrice: 1,
      limitEntry: 38300, stopLossForLimit: 38360,   // 上=正
      stopEntry: 38200, stopLossForStop: 38260,     // 上=正
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('sell');
      expect(r.plan.limitEntry).toBe(38300);
      expect(r.plan.stopLossForLimit).toBe(38360);
      expect(r.plan.stopEntry).toBe(38200);
      expect(r.plan.stopLossForStop).toBe(38260);
    }
  });

  it('正しい BUY(指値=現在値より下・逆指値=現在値より上)→ 両レッグ維持(goodPlan)', () => {
    // goodPlan: buy・指値38200<REF・逆指値38350>REF・SL 向きも正。
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBe(38350);
    }
  });

  it('反転 BUY レッグ(指値=現在値より上)→ その指値レッグを落とす(正しい逆指値は残す)', () => {
    // buy なのに 指値38300>REF(上=不正)→落とす。逆指値38350>REF(上=正)・SL 向きも正→残す。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '指値だけ反転', refPrice: 1,
      limitEntry: 38300, stopLossForLimit: 38250,   // SL は entry の下=buy として正(entry 位置だけ不正)
      stopEntry: 38350, stopLossForStop: 38300,     // 逆指値は完全に正
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBeUndefined();     // entry 位置が現在値の上=落とす
      expect(r.plan.stopLossForLimit).toBeUndefined();
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForStop).toBe(38300);
    }
  });
});

describe('parseScalpPlan 損切りの向き検証(directional)', () => {
  it('buy で指値レッグの SL がエントリーより上(逆側)→ 指値レッグを落とす(逆指値が正しければ残す)', () => {
    // 指値: entry 38200 / SL 38260(上=逆側・不正)→ 落とす。逆指値: entry 38350 / SL 38300(下=正)→ 残す。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38260,
      stopEntry: 38350, stopLossForStop: 38300,
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBeUndefined();       // 向き違反で落ちる
      expect(r.plan.stopLossForLimit).toBeUndefined();
      expect(r.plan.stopEntry).toBe(38350);            // 正しい向きは残る
      expect(r.plan.stopLossForStop).toBe(38300);
    }
  });

  it('sell で SL がエントリーより下(逆側)→ そのレッグを落とす', () => {
    // sell 指値: entry 38300 / SL 38250(下=逆側・不正)→ 落とす。逆指値: entry 38150 / SL 38200(上=正)→ 残す。
    const raw = JSON.stringify({
      direction: 'sell', rationale: '戻り', refPrice: 1,
      limitEntry: 38300, stopLossForLimit: 38250,
      stopEntry: 38150, stopLossForStop: 38200,
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('sell');
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopEntry).toBe(38150);
      expect(r.plan.stopLossForStop).toBe(38200);
    }
  });

  it('両レッグとも向き違反 → 見送り(none)を ok:true で返す', () => {
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目のつもり', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38260,   // 上=逆側
      stopEntry: 38350, stopLossForStop: 38400,     // 上=逆側
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopEntry).toBeUndefined();
      expect(r.plan.rationale).toContain('押し目');   // rationale は維持
      expect(r.plan.refPrice).toBe(REF);
    }
  });

  it('境界(SL==entry=幅0)は向き不正として落とす', () => {
    // 指値: entry 38200 / SL 38200(幅0=不正)→ 落とす。逆指値は正しい→残る。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38200,
      stopEntry: 38350, stopLossForStop: 38300,
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopEntry).toBe(38350);
    }
  });

  it('正しい向きのプランは不変(向き検証で壊れない)', () => {
    // goodPlan: buy・指値SL38150<38200・逆指値SL38300<38350(いずれも下=正)。
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForLimit).toBe(38150);
      expect(r.plan.stopLossForStop).toBe(38300);
    }
  });

  it('★スモーキングガン: {buy, limitEntry:64565, stopLossForLimit:64610, stopEntry:64665, stopLossForStop:64610} → 指値レッグ落ち・逆指値のみ buy', () => {
    // 実データ由来。買いなのに指値の損切り64610が entry 64565 の上(逆側)=不正 → 指値レッグを落とす。
    // 逆指値レッグは stopLossForStop 64610 < stopEntry 64665(下=正)なので残る → stop-only の buy になる。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '実データ再現', refPrice: 1,
      limitEntry: 64565, stopLossForLimit: 64610,
      stopEntry: 64665, stopLossForStop: 64610,
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBeUndefined();        // 逆側の損切り→落とす
      expect(r.plan.stopLossForLimit).toBeUndefined();
      expect(r.plan.stopEntry).toBe(64665);             // 正しい向きの逆指値のみ残る
      expect(r.plan.stopLossForStop).toBe(64610);
    }
  });

  it('★スモーキングガン変種: 逆指値の損切りも逆側 → 両レッグ落ちて none', () => {
    // stopLossForStop 64700 > stopEntry 64665(上=逆側・buy には不正)→ 逆指値も落ち、両レッグ落ちで none。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '実データ再現・両逆側', refPrice: 1,
      limitEntry: 64565, stopLossForLimit: 64610,
      stopEntry: 64665, stopLossForStop: 64700,
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.direction).toBe('none');
  });
});

describe('parseScalpPlan 損切りの向き検証(range)', () => {
  it('range buy レッグの SL が entry より上 → そのレッグを落とす', () => {
    // lower は buy(entry 38100)。SL 38150 は上=逆側(buy は下でなければ不正)→ 落とす。upper(sell)は正しい→残る。
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },   // sell 上=正
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38150 },     // buy だが上=逆側
      },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('range');
      expect(r.plan.range?.lower).toBeUndefined();     // 向き違反で落ちる
      expect(r.plan.range?.upper?.side).toBe('sell');
    }
  });

  it('range sell レッグの SL が entry より下 → そのレッグを落とす', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38350 },   // sell だが下=逆側
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },     // buy 下=正
      },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.range?.upper).toBeUndefined();
      expect(r.plan.range?.lower?.side).toBe('buy');
    }
  });

  it('range 両レッグとも向き違反 → 見送り(none)', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジのつもり', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38350 },   // 下=逆側
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38150 },     // 上=逆側
      },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.direction).toBe('none');
  });

  it('正しい向きの range は不変', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.range?.upper).toEqual({ side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 });
      expect(r.plan.range?.lower).toEqual({ side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 });
    }
  });
});

describe('enforcePlanConstraints 向きの二重防御(冪等・正常プラン不変)', () => {
  it('directional: 向き違反レッグを enforce でも落とす(万一 parse をすり抜けても)', () => {
    // 手組みで向き違反を作る(buy・指値SL上=逆側)。enforce が指値レッグを落とし逆指値のみ残す。
    const p: AiPlan = {
      direction: 'buy', rationale: '押し目', refPrice: REF,
      limitEntry: 38200, stopLossForLimit: 38260,   // 上=逆側
      stopEntry: 38350, stopLossForStop: 38300,     // 下=正
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBeUndefined();
    expect(r.stopEntry).toBe(38350);
  });

  it('directional: 両レッグ向き違反 → none', () => {
    const p: AiPlan = {
      direction: 'buy', rationale: '押し目', refPrice: REF,
      limitEntry: 38200, stopLossForLimit: 38260,
      stopEntry: 38350, stopLossForStop: 38400,
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('none');
  });

  it('range: 向き違反レッグを enforce でも落とす', () => {
    const p: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38350 },   // 下=逆側
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },     // 正
      },
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();
    expect(r.range?.lower?.side).toBe('buy');
  });

  it('向き違反由来の drop は vetoFired を立てない(veto の効き目だけ計測)', () => {
    const p: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38350 },   // 向き違反で落ちる
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    };
    const r = enforcePlanConstraintsReport(p, { ceilingYen: 65, bias: 'none' });
    expect(r.vetoFired).toBe(false);
  });
});

// runScalpPlan: create を注入して tool ループ+parse+再要求を検証(実 API 非依存)。
function fakeCreate(seq: any[]) {
  let i = 0;
  return vi.fn(async () => seq[i++]);
}
const NO_TOOLS: unknown[] = [];
const NO_HANDLERS: ToolHandlers = {};

describe('runScalpPlan (create 注入)', () => {
  it('一発で有効 JSON→AiPlan を返す', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: JSON.stringify(goodPlan) }, finish_reason: 'stop' }] },
    ]);
    const plan = await runScalpPlan(create as any, 'sys', 'user', NO_TOOLS, NO_HANDLERS, REF);
    expect(plan.direction).toBe('buy');
    expect(plan.refPrice).toBe(REF);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('1回目が不正→厳格に1回だけ再要求して復帰', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: 'すみません、JSONではない回答' }, finish_reason: 'stop' }] },
      { choices: [{ message: { content: JSON.stringify(goodPlan) }, finish_reason: 'stop' }] },
    ]);
    const plan = await runScalpPlan(create as any, 'sys', 'user', NO_TOOLS, NO_HANDLERS, REF);
    expect(plan.direction).toBe('buy');
    expect(create).toHaveBeenCalledTimes(2);   // 初回 + 再要求1回
  });

  it('再要求しても不正→例外(再要求は1回まで)', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] },
      { choices: [{ message: { content: 'まだ not json' }, finish_reason: 'stop' }] },
    ]);
    await expect(runScalpPlan(create as any, 'sys', 'user', NO_TOOLS, NO_HANDLERS, REF))
      .rejects.toThrow(/parse failed after retry/);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('データツールを名前で振り分けてから JSON を返す', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'query_alerts', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: JSON.stringify(goodPlan) }, finish_reason: 'stop' }] },
    ]);
    const data = vi.fn(async () => 'ALERTS');
    const plan = await runScalpPlan(create as any, 'sys', 'user', [{}], { query_alerts: data }, REF);
    expect(plan.direction).toBe('buy');
    expect(data).toHaveBeenCalledTimes(1);
  });
});

describe('scalp プロンプト文言(レッグ独立・指値のみ回避・LC 幅パラメータ)', () => {
  it('SCALP_QUESTION(既定)にレッグ独立の LC 上限と指値のみ回避が含まれる', () => {
    expect(SCALP_QUESTION).toContain('それぞれ独立');
    expect(SCALP_QUESTION).toContain('指値のみ');
    // ★新既定: 上限65・下限45(旧75/95 は撤去)。
    expect(SCALP_QUESTION).toContain('65');
    expect(SCALP_QUESTION).toContain('45');
    expect(SCALP_QUESTION).not.toContain('95');
    expect(SCALP_QUESTION).not.toContain('75');
  });
  it('SCALP_SYSTEM_PROMPT(既定)にレッグ独立の LC 上限とレッグ省略の指針が含まれる', () => {
    expect(SCALP_SYSTEM_PROMPT).toContain('それぞれ独立');
    expect(SCALP_SYSTEM_PROMPT).toContain('指値のみ');
    expect(SCALP_SYSTEM_PROMPT).toContain('逆指値のみ');
    // ★新既定: 上限65(旧95 は撤去)。
    expect(SCALP_SYSTEM_PROMPT).toContain('65');
    expect(SCALP_SYSTEM_PROMPT).not.toContain('95');
    expect(SCALP_SYSTEM_PROMPT).not.toContain('75');
  });
  it('SCALP_SYSTEM_PROMPT にギャップ戦略の検証済み知見(優位性ゼロ・提案しない)が含まれる(v0.7.38 回帰)', () => {
    // 9年バックテストでギャップ起点戦略(フィル/反転/継続)は全否定。AIが寄りでギャップ狙いを提案しないためのガードレール。
    expect(SCALP_SYSTEM_PROMPT).toContain('ギャップ');
    expect(SCALP_SYSTEM_PROMPT).toContain('検証済みの知見');
    expect(SCALP_SYSTEM_PROMPT).toContain('提案しない');
  });

  it('既定(引数なし)は floor=45/ceiling=65 を使う', () => {
    expect(DEFAULT_LC_FLOOR_YEN).toBe(45);
    expect(DEFAULT_LC_CEILING_YEN).toBe(65);
    expect(buildScalpQuestion()).toBe(SCALP_QUESTION);
    expect(buildScalpSystemPrompt()).toBe(SCALP_SYSTEM_PROMPT);
  });

  it('lcCeilingYen=65 でプロンプトに 65 が入り 95 が入らない(明示指定)', () => {
    const q = buildScalpQuestion(45, 65);
    const s = buildScalpSystemPrompt(45, 65);
    expect(q).toContain('65');
    expect(q).not.toContain('95');
    expect(s).toContain('65');
    expect(s).not.toContain('95');
  });

  it('3つの常時注入ビルダーに現在値ベースの位置ルール(買い=指値下/逆指値上・売り=指値上/逆指値下)が入る', () => {
    const spec = buildStrategySpec({
      floor: { mode: 'manual', value: 45 },
      ceiling: { mode: 'manual', value: 65 },
      trendVeto: { mode: 'manual', value: 100 },
      cooldown: { mode: 'manual', value: 90 },
      bias: { mode: 'manual', value: 'none' },
      range: { mode: 'manual', value: false },
      hardMax: { enabled: true, value: 150 },
      exitDesc: '【決済ロジック】…',
    });
    for (const t of [buildScalpQuestion(), buildScalpSystemPrompt(), spec]) {
      expect(t).toContain('指値=現在値より上');   // 売りの指値=現在値より上
      expect(t).toContain('指値=現在値より下');   // 買いの指値=現在値より下
    }
  });

  it('3つの常時注入ビルダーに指値/逆指値の距離ルール(両方=間・片方だけ=200円以内)が入る', () => {
    const spec = buildStrategySpec({
      floor: { mode: 'manual', value: 45 },
      ceiling: { mode: 'manual', value: 65 },
      trendVeto: { mode: 'manual', value: 100 },
      cooldown: { mode: 'manual', value: 90 },
      bias: { mode: 'manual', value: 'none' },
      range: { mode: 'manual', value: false },
      hardMax: { enabled: true, value: 150 },
      exitDesc: '【決済ロジック】…',
    });
    for (const t of [buildScalpQuestion(), buildScalpSystemPrompt(), spec]) {
      expect(t).toContain('200円以内');           // 片レッグの距離上限
      expect(t).toContain('片方だけ');            // 片レッグの条件文
      expect(t).toContain('間');                  // 両方=現在値が2価格の間
      expect(t).toContain('400円以内');           // 両レッグの指値↔逆指値の幅上限
    }
  });

  it('3つの常時注入ビルダーのレンジ記述に距離ルール(上下2本=幅400円以内・片面=200円以内)が入る', () => {
    // レンジ(両面ストラドル)にも directional と同じ思想の距離ルールを伝える。
    const spec = buildStrategySpec({
      floor: { mode: 'manual', value: 45 },
      ceiling: { mode: 'manual', value: 65 },
      trendVeto: { mode: 'manual', value: 100 },
      cooldown: { mode: 'manual', value: 90 },
      bias: { mode: 'manual', value: 'none' },
      range: { mode: 'manual', value: true },
      hardMax: { enabled: true, value: 150 },
      exitDesc: '【決済ロジック】…',
    });
    // range を有効にした3ビルダー(question/system は rangeEnabled 既定 true)。
    for (const t of [buildScalpQuestion(), buildScalpSystemPrompt(), spec]) {
      expect(t).toContain('レンジの距離');
      expect(t).toContain('400円以内');   // 上下2本の幅上限
      expect(t).toContain('200円以内');   // 片面レンジの距離上限
    }
  });

  it('3つの常時注入ビルダーに「実際に出力したレッグだけ説明」の指示が入る(表示整合・v0.7.41)', () => {
    const spec = buildStrategySpec({
      floor: { mode: 'manual', value: 45 },
      ceiling: { mode: 'manual', value: 65 },
      trendVeto: { mode: 'manual', value: 100 },
      cooldown: { mode: 'manual', value: 90 },
      bias: { mode: 'manual', value: 'none' },
      range: { mode: 'manual', value: false },
      hardMax: { enabled: true, value: 150 },
      exitDesc: '【決済ロジック】…',
    });
    for (const t of [buildScalpQuestion(), buildScalpSystemPrompt(), spec]) {
      expect(t).toContain('実際に出力したレッグだけ説明');
    }
  });

  it('lcFloorYen/lcCeilingYen をプロンプトに反映(例: 50〜120)', () => {
    const q = buildScalpQuestion(50, 120);
    const s = buildScalpSystemPrompt(50, 120);
    expect(q).toContain('50');
    expect(q).toContain('120');
    expect(q).toContain(`50〜120円`);
    expect(s).toContain(`50〜120円`);
    // v0.7.37 のレッグ独立・指値のみ/逆指値のみ回避は上限が変わっても保持。
    expect(q).toContain('それぞれ独立');
    expect(q).toContain('指値のみ');
    expect(s).toContain('逆指値のみ');
    // v0.7.38 のギャップ知見も保持。
    expect(s).toContain('ギャップ');
    expect(s).toContain('検証済みの知見');
  });
});

describe('resolveLcRange(サニタイズ/クランプ)', () => {
  it('未指定は既定 45/65', () => {
    expect(resolveLcRange()).toEqual({ floorYen: 45, ceilingYen: 65 });
    expect(resolveLcRange(undefined, undefined)).toEqual({ floorYen: 45, ceilingYen: 65 });
  });
  it('正常値はそのまま', () => {
    expect(resolveLcRange(50, 120)).toEqual({ floorYen: 50, ceilingYen: 120 });
  });
  it('非有限/非数値は既定へフォールバック', () => {
    expect(resolveLcRange(NaN, 80)).toEqual({ floorYen: 45, ceilingYen: 80 });
    expect(resolveLcRange(Infinity, 80)).toEqual({ floorYen: 45, ceilingYen: 80 });
    // @ts-expect-error 実行時の不正入力を想定
    expect(resolveLcRange('x', 'y')).toEqual({ floorYen: 45, ceilingYen: 65 });
  });
  it('範囲外(<20 / >300)は該当側を既定へ', () => {
    expect(resolveLcRange(10, 80)).toEqual({ floorYen: 45, ceilingYen: 80 });
    expect(resolveLcRange(50, 999)).toEqual({ floorYen: 50, ceilingYen: 65 });
  });
  it('floor>ceiling は floor を ceiling まで下げる(締めた上限を尊重・既定へ戻さない)', () => {
    expect(resolveLcRange(120, 50)).toEqual({ floorYen: 50, ceilingYen: 50 });
    // ★フットガン: 呼び出し側 floor 未指定(=既定45)で ceiling を 20〜44 に締めても、上限が黙って緩まない。
    expect(resolveLcRange(undefined, 30)).toEqual({ floorYen: 30, ceilingYen: 30 });
  });
});

describe('scalpJsonInstruction フィールド注記の LC 反映', () => {
  it('既定(引数なし)の JSON 注記に LC幅45〜65 が入り 95/75 が入らない', () => {
    const j = scalpJsonInstruction(38250);
    expect(j).toContain('LC幅45〜65円');
    expect(j).toContain('65円超は出さない');
    expect(j).not.toContain('95');
    expect(j).not.toContain('75');
    // refPrice は反映される。
    expect(j).toContain('38250');
  });
  it('明示 ceiling(120)を JSON 注記に反映', () => {
    const j = scalpJsonInstruction(38250, 50, 120);
    expect(j).toContain('LC幅50〜120円');
    expect(j).toContain('120円超は出さない');
    expect(j).not.toContain('95');
  });
});

describe('enforcePlanConstraints(LC上限・バイアスのハード適用)', () => {
  // buy: 指値LC=|38200-38150|=50 / 逆指値LC=|38350-38300|=50。
  const base: AiPlan = {
    direction: 'buy',
    limitEntry: 38200, stopLossForLimit: 38150,
    stopEntry: 38350, stopLossForStop: 38300,
    rationale: '押し目買い', refPrice: REF,
  };

  it('両レッグとも上限以内(50≤65)→素通し', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBe(38350);
  });

  it('境界(ちょうど上限=50)は許可', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 50, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBe(38350);
  });

  it('上限超のレッグだけ落とす(逆指値LC=50が上限49超→逆指値のみ落ち、指値も同50なので両落ち→none)', () => {
    // ceiling=49 だと両レッグ(各50)が超える→両落ち→none。
    const r = enforcePlanConstraints(base, { ceilingYen: 49, bias: 'none' });
    expect(r.direction).toBe('none');
    expect(r.limitEntry).toBeUndefined();
    expect(r.stopEntry).toBeUndefined();
  });

  it('片レッグだけ上限超→そのレッグを落とし他レッグは残る', () => {
    // 逆指値LC=|38400-38300|=100(上限65超)→逆指値落ち。指値LC=50は残る。
    const p: AiPlan = { ...base, stopEntry: 38400, stopLossForStop: 38300 };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopLossForLimit).toBe(38150);
    expect(r.stopEntry).toBeUndefined();
    expect(r.stopLossForStop).toBeUndefined();
  });

  it('両レッグとも上限超→direction:none(価格なし)', () => {
    const p: AiPlan = {
      direction: 'sell',
      limitEntry: 38300, stopLossForLimit: 38400,   // LC=100
      stopEntry: 38200, stopLossForStop: 38320,     // LC=120
      rationale: '戻り売り', refPrice: REF,
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('none');
    expect(r.limitEntry).toBeUndefined();
    expect(r.stopEntry).toBeUndefined();
    expect(r.rationale).toBe('戻り売り');
    expect(r.refPrice).toBe(REF);
  });

  it("bias='long' かつ sell → none(素通し前に方向veto)", () => {
    const sell: AiPlan = {
      direction: 'sell',
      limitEntry: 38300, stopLossForLimit: 38340,   // LC=40(上限内)
      rationale: '戻り売り', refPrice: REF,
    };
    const r = enforcePlanConstraints(sell, { ceilingYen: 65, bias: 'long' });
    expect(r.direction).toBe('none');
    expect(r.limitEntry).toBeUndefined();
  });

  it("bias='short' かつ buy → none", () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'short' });
    expect(r.direction).toBe('none');
  });

  // ★向きの正しい sell(損切りは各エントリーの上)。base を単に direction 反転すると buy 向きの損切りになり
  //   向き検証で落ちるため、sell の pass-through 検証には向きの正しい fixture を使う。
  const validSell: AiPlan = {
    direction: 'sell',
    limitEntry: 38200, stopLossForLimit: 38250,   // 上=正(LC=50)
    stopEntry: 38050, stopLossForStop: 38100,     // 上=正(LC=50)
    rationale: '戻り売り', refPrice: REF,
  };

  it("bias='long' かつ buy は素通し / bias='short' かつ sell は素通し", () => {
    const rLong = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'long' });
    expect(rLong.direction).toBe('buy');
    const rShort = enforcePlanConstraints(validSell, { ceilingYen: 65, bias: 'short' });
    expect(rShort.direction).toBe('sell');
  });

  it("bias='none' は方向を素通し(buy/sell とも)", () => {
    expect(enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none' }).direction).toBe('buy');
    expect(enforcePlanConstraints(validSell, { ceilingYen: 65, bias: 'none' }).direction).toBe('sell');
  });

  it('direction:none は何もしない(素通し)', () => {
    const none: AiPlan = { direction: 'none', rationale: '見送り', refPrice: REF };
    const r = enforcePlanConstraints(none, { ceilingYen: 65, bias: 'long' });
    expect(r).toEqual(none);
  });

  it('LC上限で片レッグ残存後にバイアス違反なら none(LC→bias の順で最終none)', () => {
    // sell・逆指値LC=100(落ち)・指値LC=40(残る)だが bias=long でvetoされ none。
    const p: AiPlan = {
      direction: 'sell',
      limitEntry: 38300, stopLossForLimit: 38340,  // LC=40 残る
      stopEntry: 38200, stopLossForStop: 38320,    // LC=120 落ち
      rationale: '戻り売り', refPrice: REF,
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'long' });
    expect(r.direction).toBe('none');
    expect(r.limitEntry).toBeUndefined();
  });
});

// ─── レンジ脚 drop 理由の rationale 明記(表示専用テキスト) ───
describe('enforcePlanConstraints range 脚 drop 理由を rationale に明記', () => {
  // REF=38250。upper=売り指値(上)/lower=買い指値(下)。
  const upper = { side: 'sell' as const, type: 'limit' as const, entry: 38400, stopLoss: 38450 };  // LC=50
  const lower = { side: 'buy' as const, type: 'limit' as const, entry: 38100, stopLoss: 38050 };    // LC=50
  const basePlan: AiPlan = {
    direction: 'range', rationale: '上部に売り指値、下部に買い指値を設定', refPrice: REF,
    range: { upper: { ...upper }, lower: { ...lower } },
  };

  it("bias='short' で下部(買い指値)が落ちる→上部だけ残り rationale にバイアス除外を明記", () => {
    const r = enforcePlanConstraints(basePlan, { ceilingYen: 65, bias: 'short' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper?.side).toBe('sell');   // 上部(売り)残存
    expect(r.range?.lower).toBeUndefined();       // 下部(買い)脱落
    // rationale は元文 + 下部(買い指値)+バイアス を含む注記
    expect(r.rationale).toContain('上部に売り指値、下部に買い指値を設定');
    expect(r.rationale).toContain('下部');
    expect(r.rationale).toContain('買い指値');
    expect(r.rationale).toContain('バイアス');
    expect(r.rationale).toContain('売り優先');    // short=売り優先
    // 残った上部については注記しない
    expect(r.rationale).not.toContain('上部(売り指値)');
  });

  it('LC上限超で上部(売り指値)が落ちる→rationale に LC上限 を明記', () => {
    // upper=売り(SLはentry上=正)だが LC=|38400-38550|=150(上限65超)→上部落ち。lower.LC=50 残る。
    const p: AiPlan = {
      ...basePlan,
      range: { upper: { ...upper, entry: 38400, stopLoss: 38550 }, lower: { ...lower } },
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();       // 上部脱落
    expect(r.range?.lower?.side).toBe('buy');      // 下部残存
    expect(r.rationale).toContain('上部');
    expect(r.rationale).toContain('売り指値');
    expect(r.rationale).toContain('LC上限');
  });

  it('脚が落ちない正常 range は rationale を改変しない', () => {
    const r = enforcePlanConstraints(basePlan, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('range');
    expect(r.rationale).toBe('上部に売り指値、下部に買い指値を設定');
  });
});

// ─── レンジ両面ストラドル(range): parse ───
describe('parseScalpPlan range(レンジ両面ストラドル)', () => {
  // REF=38250。upper.entry は現在値超・lower.entry は現在値未満。
  const upper = { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 };  // 上=売り指値 LC=50
  const lower = { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 };    // 下=買い指値 LC=50
  const rangePlan = { direction: 'range', rationale: 'レンジ・上下に反応帯', range: { upper, lower }, refPrice: 1 };

  it('有効な両レッグ range→ok:true・range.upper/lower が入る(refPrice は上書き)', () => {
    const r = parseScalpPlan(JSON.stringify(rangePlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('range');
      expect(r.plan.refPrice).toBe(REF);
      expect(r.plan.range?.upper).toEqual({ side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 });
      expect(r.plan.range?.lower).toEqual({ side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 });
    }
  });

  it('抜け追随(逆指値)形も通る: 上=買い逆指値 / 下=売り逆指値', () => {
    const p = { direction: 'range', rationale: 'ブレイク追随', refPrice: 1, range: {
      upper: { side: 'buy', type: 'stop', entry: 38400, stopLoss: 38350 },
      lower: { side: 'sell', type: 'stop', entry: 38100, stopLoss: 38150 },
    } };
    const r = parseScalpPlan(JSON.stringify(p), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.range?.upper?.type).toBe('stop');
      expect(r.plan.range?.lower?.side).toBe('sell');
    }
  });

  it('片レッグが幾何違反(upper.entry が現在値未満)→そのレッグを落とし片面 range で通す', () => {
    const bad = { ...rangePlan, range: { upper: { ...upper, entry: 38200 }, lower } };  // upper.entry<REF
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('range');
      expect(r.plan.range?.upper).toBeUndefined();   // 幾何違反で落ちる
      expect(r.plan.range?.lower).toBeDefined();
    }
  });

  it('片レッグが壊れている(side 不正)→そのレッグを落とし片面 range', () => {
    const bad = { ...rangePlan, range: { upper: { ...upper, side: 'hold' }, lower } };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.range?.upper).toBeUndefined();
      expect(r.plan.range?.lower?.side).toBe('buy');
    }
  });

  it('両レッグとも無効(幾何違反)→ok:true の見送り(none)', () => {
    const bad = { ...rangePlan, range: {
      upper: { ...upper, entry: 38000 },   // 現在値未満=違反
      lower: { ...lower, entry: 38500 },   // 現在値超=違反
    } };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.plan.range).toBeUndefined();
      expect(r.plan.rationale).toContain('レンジ');
    }
  });

  it('range フィールド欠落→none(見送り)', () => {
    const r = parseScalpPlan(JSON.stringify({ direction: 'range', rationale: '理由' }), REF);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.direction).toBe('none');
  });

  it('既存の buy/sell/none パースは不変(range 追加で壊れない)', () => {
    expect(parseScalpPlan(JSON.stringify(goodPlan), REF).ok).toBe(true);
    expect(parseScalpPlan(JSON.stringify({ direction: 'none', rationale: '様子見' }), REF).ok).toBe(true);
  });
});

describe('parseRangeLeg', () => {
  it('正常レッグを返す', () => {
    expect(parseRangeLeg({ side: 'buy', type: 'stop', entry: 100, stopLoss: 90 }))
      .toEqual({ side: 'buy', type: 'stop', entry: 100, stopLoss: 90 });
  });
  it('side/type enum 違反・非有限・非オブジェクトは null', () => {
    expect(parseRangeLeg({ side: 'x', type: 'limit', entry: 1, stopLoss: 2 })).toBeNull();
    expect(parseRangeLeg({ side: 'buy', type: 'y', entry: 1, stopLoss: 2 })).toBeNull();
    expect(parseRangeLeg({ side: 'buy', type: 'limit', entry: 'a', stopLoss: 2 })).toBeNull();
    expect(parseRangeLeg({ side: 'buy', type: 'limit', entry: 1 })).toBeNull();   // stopLoss 欠落
    expect(parseRangeLeg(null)).toBeNull();
    expect(parseRangeLeg('nope')).toBeNull();
  });
});

// ─── レンジ両面ストラドル(range): enforce ───
describe('enforcePlanConstraints range(LC上限/バイアス per レッグ)', () => {
  const base: AiPlan = {
    direction: 'range', rationale: 'レンジ', refPrice: REF,
    range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },  // LC=50
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },    // LC=50
    },
  };

  it('両レッグ上限以内(50≤65)→素通し(両レッグ残る)', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeDefined();
    expect(r.range?.lower).toBeDefined();
  });

  it('片レッグだけ LC 上限超→そのレッグを落とし片面 range', () => {
    const p: AiPlan = { ...base, range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38520 },   // LC=120 超
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },     // LC=50 残る
    } };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();
    expect(r.range?.lower).toBeDefined();
  });

  it('両レッグとも LC 上限超→none', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 49, bias: 'none' });  // 各50>49
    expect(r.direction).toBe('none');
    expect(r.range).toBeUndefined();
    expect(r.rationale).toBe('レンジ');
  });

  it("bias='long' は sell レッグを落とす(upper=sell を drop・lower=buy 残る)", () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'long' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();   // sell 落ち
    expect(r.range?.lower?.side).toBe('buy');
  });

  it("bias='short' は buy レッグを落とす(lower=buy を drop・upper=sell 残る)", () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'short' });
    expect(r.direction).toBe('range');
    expect(r.range?.lower).toBeUndefined();
    expect(r.range?.upper?.side).toBe('sell');
  });

  it("bias が両レッグを落とすと none(long で両レッグ sell)", () => {
    const p: AiPlan = { ...base, range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'sell', type: 'stop', entry: 38100, stopLoss: 38150 },
    } };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'long' });
    expect(r.direction).toBe('none');
  });
});

// ─── トレンド veto(生きた強トレンドに逆行するフェード新規を落とす) ───
describe('enforcePlanConstraints トレンド veto(directional)', () => {
  const buyPlan: AiPlan = {
    direction: 'buy',
    limitEntry: 38200, stopLossForLimit: 38150,   // LC=50
    stopEntry: 38350, stopLossForStop: 38300,     // LC=50
    rationale: '押し目買い', refPrice: REF,
  };
  const sellPlan: AiPlan = {
    direction: 'sell',
    limitEntry: 38300, stopLossForLimit: 38340,   // LC=40
    stopEntry: 38150, stopLossForStop: 38190,     // LC=40
    rationale: '戻り売り', refPrice: REF,
  };

  it('強上昇 + directional sell → none(逆行=見送り)', () => {
    const r = enforcePlanConstraints(sellPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('none');
    expect(r.rationale).toBe('戻り売り');
    expect(r.refPrice).toBe(REF);
  });

  it('強上昇 + directional buy は維持(順行)', () => {
    const r = enforcePlanConstraints(buyPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBe(38350);
  });

  it('強下降 + directional buy → none(逆行)', () => {
    const r = enforcePlanConstraints(buyPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'down', strong: true } });
    expect(r.direction).toBe('none');
  });

  it('強下降 + directional sell は維持(順行)', () => {
    const r = enforcePlanConstraints(sellPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'down', strong: true } });
    expect(r.direction).toBe('sell');
  });

  it('trend.strong=false(flat)は現行と完全一致(素通し)', () => {
    const withFlat = enforcePlanConstraints(sellPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'flat', strong: false } });
    const noTrend = enforcePlanConstraints(sellPlan, { ceilingYen: 65, bias: 'none' });
    expect(withFlat).toEqual(noTrend);
    expect(withFlat.direction).toBe('sell');
  });

  it('trend 未指定は現行と完全一致(素通し)', () => {
    const r = enforcePlanConstraints(sellPlan, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('sell');
    expect(r.limitEntry).toBe(38300);
  });

  it('合成順: 順行 buy は トレンド veto を通過し、その後 LC 上限で片レッグ落ちる', () => {
    // 強上昇 + buy(順行)。逆指値LC=|38450-38300|=150 は上限65超で落ち、指値LC=50 は残る。
    const p: AiPlan = { ...buyPlan, stopEntry: 38450, stopLossForStop: 38300 };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBeUndefined();
  });
});

describe('enforcePlanConstraints トレンド veto(range 片面化)', () => {
  const base: AiPlan = {
    direction: 'range', rationale: 'レンジ', refPrice: REF,
    range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },  // LC=50
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },    // LC=50
    },
  };

  it('強上昇 → 上=売り指値を落とし 下=買いが残る(片面 range)', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();
    expect(r.range?.lower?.side).toBe('buy');
  });

  it('強下降 → 下=買いを落とし 上=売りが残る(片面 range)', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none', trend: { dir: 'down', strong: true } });
    expect(r.direction).toBe('range');
    expect(r.range?.lower).toBeUndefined();
    expect(r.range?.upper?.side).toBe('sell');
  });

  it('両レッグとも逆行 side → none(強上昇で両レッグ sell)', () => {
    const p: AiPlan = { ...base, range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'sell', type: 'stop', entry: 38100, stopLoss: 38150 },
    } };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('none');
  });

  it('flat(strong=false)は range を現行どおり素通し(両レッグ残る)', () => {
    const withFlat = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none', trend: { dir: 'flat', strong: false } });
    const noTrend = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none' });
    expect(withFlat).toEqual(noTrend);
    expect(withFlat.range?.upper).toBeDefined();
    expect(withFlat.range?.lower).toBeDefined();
  });

  it('合成: 強上昇 + トレンドで上落ち → 残る下(buy)を LC 上限で更に落とすと none', () => {
    // 上=sell(トレンドで落ち)・下=buy だが LC=|38100-37980|=120 上限65超 → 下も落ち → none。
    const p: AiPlan = { ...base, range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 37980 },
    } };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('none');
  });
});

// ─── AI 自己レジーム/確信度(v0.7.54・記録のみ・寛容パース) ───
describe('parseAiRegime / parseAiConfidence(寛容)', () => {
  it('regime は enum のみ受理・それ以外は undefined', () => {
    expect(parseAiRegime('trend_up')).toBe('trend_up');
    expect(parseAiRegime('range')).toBe('range');
    expect(parseAiRegime('unclear')).toBe('unclear');
    expect(parseAiRegime('bogus')).toBeUndefined();
    expect(parseAiRegime(123)).toBeUndefined();
    expect(parseAiRegime(undefined)).toBeUndefined();
  });
  it('confidence は有限数を 0-100 にクランプ・非数値は undefined', () => {
    expect(parseAiConfidence(70)).toBe(70);
    expect(parseAiConfidence(0)).toBe(0);
    expect(parseAiConfidence(120)).toBe(100);
    expect(parseAiConfidence(-5)).toBe(0);
    expect(parseAiConfidence(NaN)).toBeUndefined();
    expect(parseAiConfidence('80')).toBeUndefined();
    expect(parseAiConfidence(undefined)).toBeUndefined();
  });
});

describe('parseScalpPlan regime/confidence 寛容パース(後方互換)', () => {
  it('directional plan に regime/confidence を載せる', () => {
    const raw = JSON.stringify({ ...goodPlan, regime: 'trend_up', confidence: 72 });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.regime).toBe('trend_up');
      expect(r.plan.confidence).toBe(72);
    }
  });
  it('none plan にも regime/confidence を載せる', () => {
    const raw = JSON.stringify({ direction: 'none', rationale: '見送り', regime: 'range', confidence: 40 });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.plan.regime).toBe('range');
      expect(r.plan.confidence).toBe(40);
    }
  });
  it('欠落/不正な regime・confidence は undefined(既存挙動は不変)', () => {
    const raw = JSON.stringify({ ...goodPlan, regime: 'bogus', confidence: 'high' });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.regime).toBeUndefined();
      expect(r.plan.confidence).toBeUndefined();
      // 他フィールドは従来どおり。
      expect(r.plan.limitEntry).toBe(38200);
    }
  });
  it('regime/confidence が無い応答も従来どおり成立(後方互換)', () => {
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.regime).toBeUndefined();
      expect(r.plan.confidence).toBeUndefined();
    }
  });
});

// ─── enforcePlanConstraintsReport vetoFired surface(挙動は不変・発火だけ計測) ───
describe('enforcePlanConstraintsReport vetoFired(挙動不変で発火を surface)', () => {
  const buyPlan: AiPlan = {
    direction: 'buy',
    limitEntry: 38200, stopLossForLimit: 38150,
    stopEntry: 38350, stopLossForStop: 38300,
    rationale: '押し目買い', refPrice: REF,
  };
  const sellPlan: AiPlan = {
    direction: 'sell',
    limitEntry: 38300, stopLossForLimit: 38340,
    stopEntry: 38150, stopLossForStop: 38190,
    rationale: '戻り売り', refPrice: REF,
  };

  it('返る plan は enforcePlanConstraints と完全一致(byte 不変)', () => {
    const opts = { ceilingYen: 65, bias: 'none' as const, trend: { dir: 'up' as const, strong: true } };
    expect(enforcePlanConstraintsReport(sellPlan, opts).plan).toEqual(enforcePlanConstraints(sellPlan, opts));
    const opts2 = { ceilingYen: 49, bias: 'none' as const };
    expect(enforcePlanConstraintsReport(buyPlan, opts2).plan).toEqual(enforcePlanConstraints(buyPlan, opts2));
  });

  it('directional 逆行(強上昇 sell)→ none 化 & vetoFired=true', () => {
    const r = enforcePlanConstraintsReport(sellPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.plan.direction).toBe('none');
    expect(r.vetoFired).toBe(true);
  });

  it('directional 順行(強上昇 buy)→ 維持 & vetoFired=false', () => {
    const r = enforcePlanConstraintsReport(buyPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.plan.direction).toBe('buy');
    expect(r.vetoFired).toBe(false);
  });

  it('trend 未指定/flat は vetoFired=false(veto 無効)', () => {
    expect(enforcePlanConstraintsReport(sellPlan, { ceilingYen: 65, bias: 'none' }).vetoFired).toBe(false);
    expect(enforcePlanConstraintsReport(sellPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'flat', strong: false } }).vetoFired).toBe(false);
  });

  it('LC 上限や bias 由来の none 化は vetoFired=false(veto の効き目だけ計測)', () => {
    // bias veto で none 化するが、これはトレンド veto ではない。
    const r = enforcePlanConstraintsReport(sellPlan, { ceilingYen: 65, bias: 'long' });
    expect(r.plan.direction).toBe('none');
    expect(r.vetoFired).toBe(false);
  });

  it('range 片面化(強上昇で上=売り脚を落とす)→ vetoFired=true・下は残る', () => {
    const base: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    };
    const r = enforcePlanConstraintsReport(base, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.plan.direction).toBe('range');
    expect(r.plan.range?.upper).toBeUndefined();
    expect(r.plan.range?.lower?.side).toBe('buy');
    expect(r.vetoFired).toBe(true);
  });
});

describe('scalpJsonInstruction / SYSTEM に regime/confidence 指示', () => {
  it('JSON スキーマに regime と confidence フィールドが入る', () => {
    const j = scalpJsonInstruction(38250);
    expect(j).toContain('"regime"');
    expect(j).toContain('"confidence"');
    expect(j).toContain('trend_up');
  });
  it('system prompt が「まず regime/confidence を出す」旨を含む', () => {
    expect(SCALP_SYSTEM_PROMPT).toContain('regime');
    expect(SCALP_SYSTEM_PROMPT).toContain('confidence');
  });
});

describe('scalp プロンプト trendVeto 文言', () => {
  it('既定(veto=100)で SCALP_QUESTION/SYSTEM に勢い/レンジの指針が入る', () => {
    expect(SCALP_QUESTION).toContain('直近の勢い');
    expect(SCALP_QUESTION).toContain('横ばい');
    expect(SCALP_SYSTEM_PROMPT).toContain('直近の勢い');
    // 既定は 100(旧LC上限の 95/75 とは無関係=回帰保護)。
    expect(SCALP_QUESTION).toContain('100');
  });

  it('trendVetoYen を渡すと閾値がプロンプトに反映される', () => {
    expect(buildScalpQuestion(45, 65, true, 150)).toContain('±150円未満');
    expect(buildScalpSystemPrompt(45, 65, true, 150)).toContain('±150円未満');
  });

  it('trendVetoYen=0(無効)は勢い/レンジ指針を注入しない', () => {
    const q = buildScalpQuestion(45, 65, true, 0);
    const s = buildScalpSystemPrompt(45, 65, true, 0);
    expect(q).not.toContain('直近の勢い');
    expect(s).not.toContain('直近の勢い');
  });
});

describe('scalp プロンプト range トグル(rangeEnabled)', () => {
  it('rangeEnabled=true(既定)でプロンプト/JSON に range 指示が入る', () => {
    expect(buildScalpQuestion()).toContain('range');
    expect(buildScalpSystemPrompt()).toContain('range');
    expect(scalpJsonInstruction(38250)).toContain('range');
    // 既定は range ON=SCALP_QUESTION/SCALP_SYSTEM_PROMPT にも range 文言。
    expect(SCALP_QUESTION).toContain('range');
    expect(SCALP_SYSTEM_PROMPT).toContain('range');
  });
  it('rangeEnabled=false で range を明示禁止(「range は出さない」)', () => {
    expect(buildScalpQuestion(45, 65, false)).toContain('range');   // 「range は出さない」を含む
    expect(buildScalpQuestion(45, 65, false)).toContain('出さない');
    expect(buildScalpSystemPrompt(45, 65, false)).toContain('出さない');
    // JSON スキーマの direction enum に range が入らない(regime 値の "range" とは別物なので、
    // direction enum 語順と range 両面オブジェクトの不在で判定する。v0.7.54 で regime 値に "range" が入るため)。
    expect(scalpJsonInstruction(38250, 45, 65, false)).not.toContain('"none" | "range"');
    expect(scalpJsonInstruction(38250, 45, 65, false)).not.toContain('"range": {');
  });
});

// ─── v0.7.56: 項目別 手動/AI 委任 + LC安全上限 ───
describe('lcLegExceeds(LC上限 mode 分岐 + 安全網)', () => {
  it('既定(mode/hardMax 省略)は w>ceiling のみ=従来と一致', () => {
    expect(lcLegExceeds(50, { ceilingYen: 65 })).toBe(false);
    expect(lcLegExceeds(66, { ceilingYen: 65 })).toBe(true);
    expect(lcLegExceeds(65, { ceilingYen: 65 })).toBe(false);   // 境界=許可
  });
  it('ceilingMode=ai は ceiling では落とさない', () => {
    expect(lcLegExceeds(200, { ceilingYen: 65, ceilingMode: 'ai' })).toBe(false);
  });
  it('lcHardMax 有効時は mode 無関係に value 超を落とす(ai でも)', () => {
    expect(lcLegExceeds(200, { ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: true, value: 150 } })).toBe(true);
    expect(lcLegExceeds(120, { ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: true, value: 150 } })).toBe(false);
  });
  it('lcHardMax 無効時はハード上限なし(ai 完全自由)', () => {
    expect(lcLegExceeds(500, { ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: false, value: 150 } })).toBe(false);
  });
  it('★既定 hardMax(enabled150)+manual65 は 65 超のみ=ceiling が支配(回帰なし)', () => {
    // 150 有効でも 65<150 なので、ceiling で既に落ちる=hardMax は追加ドロップしない=従来挙動と一致。
    expect(lcLegExceeds(66, { ceilingYen: 65, ceilingMode: 'manual', lcHardMax: { enabled: true, value: 150 } })).toBe(true);
    expect(lcLegExceeds(50, { ceilingYen: 65, ceilingMode: 'manual', lcHardMax: { enabled: true, value: 150 } })).toBe(false);
  });
});

describe('enforcePlanConstraints ceilingMode/lcHardMax 分岐', () => {
  // buy: 指値LC=|38200-38150|=50 / 逆指値LC=|38500-38300|=200(=上限65超・150超)。
  const wide: AiPlan = {
    direction: 'buy',
    limitEntry: 38200, stopLossForLimit: 38150,   // LC=50
    stopEntry: 38500, stopLossForStop: 38300,     // LC=200
    rationale: '押し目買い', refPrice: 38250,
  };

  it('manual(既定): LC200 の逆指値は落ち・指値のみ残る(従来)', () => {
    const r = enforcePlanConstraints(wide, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBeUndefined();
  });
  it('ai-ceiling + hardMax 無効: LC200 でも両レッグ残る(上限で落とさない)', () => {
    const r = enforcePlanConstraints(wide, { ceilingYen: 65, bias: 'none', ceilingMode: 'ai', lcHardMax: { enabled: false, value: 150 } });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBe(38500);   // ai=ceilingで落とさない
  });
  it('ai-ceiling + hardMax 有効(150): LC200 は安全網で落ちる・LC50 は残る', () => {
    const r = enforcePlanConstraints(wide, { ceilingYen: 65, bias: 'none', ceilingMode: 'ai', lcHardMax: { enabled: true, value: 150 } });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBeUndefined();   // 200>150 安全網で落ちる
  });
  it('ai-ceiling range: hardMax 有効で上限超レッグだけ落とす', () => {
    const rng: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: 38250,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38650 },   // LC=250>150
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },      // LC=50
      },
    };
    const r = enforcePlanConstraints(rng, { ceilingYen: 65, bias: 'none', ceilingMode: 'ai', lcHardMax: { enabled: true, value: 150 } });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();   // 安全網
    expect(r.range?.lower?.side).toBe('buy');
  });
  it('★回帰: manual + 既定 hardMax(150) は ceilingMode/hardMax 省略と同一結果', () => {
    const withDefaults = enforcePlanConstraints(wide, { ceilingYen: 65, bias: 'none', ceilingMode: 'manual', lcHardMax: { enabled: true, value: 150 } });
    const legacy = enforcePlanConstraints(wide, { ceilingYen: 65, bias: 'none' });
    expect(withDefaults).toEqual(legacy);
  });
});

describe('buildDelegationNote(委任ノート)', () => {
  const allManual: KnobModes = { lcFloor: 'manual', lcCeiling: 'manual', trendVeto: 'manual', cooldown: 'manual', bias: 'manual', range: 'manual' };
  const ctx = { floorYen: 45, ceilingYen: 65, hardMax: { enabled: true, value: 150 } };

  it('全 knob 手動 → 空文字(プロンプト不変=回帰なし)', () => {
    expect(buildDelegationNote(allManual, ctx)).toBe('');
  });
  it('lcCeiling=ai → LC をAIに委任する旨 + ロジック(コツコツドカン回避) + 安全上限を明記', () => {
    const n = buildDelegationNote({ ...allManual, lcCeiling: 'ai' }, ctx);
    expect(n).toContain('最大初期LC');
    expect(n).toContain('あなたが決める');
    expect(n).toContain('コツコツドカン');   // ★ロジックが転写されている
    expect(n).toContain('安全上限 150円');
  });
  it('trendVeto=ai → 判断ロジックと根拠(勢いデータ・フェードは負ける)を転写', () => {
    const n = buildDelegationNote({ ...allManual, trendVeto: 'ai' }, ctx);
    expect(n).toContain('直近の勢い');          // 使うべきデータを明示
    expect(n).toContain('フェード');            // 逆張りの基準
    expect(n).toContain('regime');             // 自己レジームを下す
  });
  it('lcCeiling=ai + hardMax 無効 → 安全上限の文言なし', () => {
    const n = buildDelegationNote({ ...allManual, lcCeiling: 'ai' }, { ...ctx, hardMax: { enabled: false, value: 150 } });
    expect(n).toContain('最大初期LC');
    expect(n).not.toContain('安全上限');
  });
  it('trendVeto/bias/range=ai → 各委任行が入る', () => {
    const n = buildDelegationNote({ ...allManual, trendVeto: 'ai', bias: 'ai', range: 'ai' }, ctx);
    expect(n).toContain('トレンド');
    expect(n).toContain('方向');
    expect(n).toContain('レンジ両面');
  });
  it('range=ai → 連敗時にレンジ両面へ切替を検討する指示が入る', () => {
    const n = buildDelegationNote({ ...allManual, range: 'ai' }, ctx);
    expect(n).toContain('連敗');
    expect(n).toContain('range(両面)へ切り替え');
  });
});

describe('buildStrategySpec(戦略仕様・完全版=全定数+委任状態+決済ロジック)', () => {
  const base = {
    floor: { mode: 'manual' as const, value: 45 },
    ceiling: { mode: 'manual' as const, value: 65 },
    trendVeto: { mode: 'manual' as const, value: 100 },
    cooldown: { mode: 'manual' as const, value: 90 },
    bias: { mode: 'manual' as const, value: 'none' as const },
    range: { mode: 'manual' as const, value: false },
    hardMax: { enabled: true, value: 150 },
    exitDesc: '【決済ロジック(phase-exit)】…利益ロックのラチェット床…',
  };
  it('エントリー全定数と決済説明を1ブロックに含む', () => {
    const s = buildStrategySpec(base);
    expect(s).toContain('下限45円');
    expect(s).toContain('上限65円');
    expect(s).toContain('±100円');            // トレンド閾値(定数)
    expect(s).toContain('90秒');               // クールダウン(定数)
    expect(s).toContain('+5円');               // ストップ緩衝
    expect(s).toContain('50円');               // 最低距離
    expect(s).toContain('安全上限 150円');
    expect(s).toContain('ラチェット');          // 決済ロジックが注入される
  });
  it('委任状態を各項目に明示(AI=あなたが決める / 手動=固定・厳守)', () => {
    const s = buildStrategySpec({ ...base, trendVeto: { mode: 'ai', value: 100 } });
    expect(s).toContain('【AI委任=あなたが決めてよい】');   // trendVeto=ai
    expect(s).toContain('【手動=固定・厳守】');             // 他は手動
  });
  it('LC安全上限 無効なら「安全上限 無効」', () => {
    const s = buildStrategySpec({ ...base, hardMax: { enabled: false, value: 150 } });
    expect(s).toContain('安全上限 無効');
  });
  it('節目への置き方(指値=5〜10円内側 / 逆指値=0〜5円外側)を含む', () => {
    const s = buildStrategySpec(base);
    expect(s).toContain('節目への置き方');
    expect(s).toContain('5〜10円');
    expect(s).toContain('0〜5円');
    expect(s).toContain('内側');
    expect(s).toContain('外側');
  });
});

describe('節目への指値/逆指値プレースメント規則(約定重視)', () => {
  it('system prompt と question にも同じ規則(節目オフセット)を注入する', () => {
    for (const t of [buildScalpSystemPrompt(), buildScalpQuestion()]) {
      expect(t).toContain('節目');
      expect(t).toContain('5〜10円');    // 指値=内側オフセット
      expect(t).toContain('0〜5円');     // 逆指値=外側オフセット
      expect(t).toContain('内側');
      expect(t).toContain('外側');
    }
  });
});

describe('buildScalpPlan (no-key path)', () => {
  it('LLM キー未設定→{ ok:false, error:"LLM未設定" }', async () => {
    // テスト環境では API キー未設定を前提(isLLMEnabled=false)。念のため確認してから検証する。
    if (isLLMEnabled()) {
      // キーが設定されている環境ではこのケースは検証対象外。
      return;
    }
    const r = await buildScalpPlan({ symbol: 'NIY=F' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('LLM未設定');
  });
});

// ─── ★AIテクニカル: system prompt のテクニカル許可行(エントリーのタイミング判断のみ) ───

describe('buildScalpSystemPrompt テクニカル許可行(aiTechnicalEnabled)', () => {
  it('既定(false)は従来の system prompt と byte 一致=テクニカル行なし', () => {
    const off = buildScalpSystemPrompt(45, 65, true, 100);
    expect(off).toBe(buildScalpSystemPrompt(45, 65, true, 100, false));
    expect(off).not.toContain('テクニカル指標(RSI/BB)の活用');
  });
  it('true でテクニカル許可行を末尾に追記(エントリーの"タイミング"判断のみ・決済は既定ロジック)', () => {
    const on = buildScalpSystemPrompt(45, 65, true, 100, true);
    expect(on.startsWith(buildScalpSystemPrompt(45, 65, true, 100, false))).toBe(true);   // 既存部分は不変
    expect(on).toContain('テクニカル指標(RSI/BB)の活用');
    expect(on).toContain('生きたトレンドはフェードしない');   // テクニカル単独の逆張りを戒める文言
    // ★決済(手仕舞い)は AI に委ねない=強制決済の指示は入れない。
    expect(on).toContain('決済(手仕舞い)は既定のロジックが担当する');
    expect(on).not.toContain('heldAction');
  });
});
