import { describe, it, expect } from 'vitest';
import {
  B_VARIANTS, pickBVariant, parseBAnswer, buildPlanFromBAnswer,
  buildBSystemPrompt, buildBUserPrompt,
  type BVariant, type SqueezeState, type TrendDirection,
} from './planVariants.js';
import { stopLossFromWidth, stopSideOk } from '../../core/stopGeometry.js';

// ★段3(v0.9.99): B の4種と対応表。
//
// 何を守っているか:
//   ① ★版は **コードが選ぶ**(AI は選ばない)。range のときだけスクイーズ判定を見る
//   ② ★side / type は **表が埋める**。AI が返しても届かない(契約に無いキーは parse で落ちる)
//   ③ ★損切りの向きは stopLossFromWidth 一箇所だけが決める(逆側の損切りが作れない)
//   ④ ★片方だけ見送れる(「片方が置けなかった」が「計画ごと見送り」に潰れない)
//   ⑤ ★B(buy) に売り系・B(sell) に買い系の語が1文字も出ない
//   ⑥ ★新しい閾値をプロンプトに書かない(数値は 現在価格 と 設定の帯 だけ)

const ALL: BVariant[] = ['buy', 'sell', 'range-fade', 'range-breakout'];
const REF = 38250;

describe('① 版はコードが選ぶ(AI は選ばない)', () => {
  it('目線 bull/bear は スクイーズ判定を見ない', () => {
    for (const sq of ['squeeze', 'bulge', null] as SqueezeState[]) {
      expect(pickBVariant('bull', sq)).toBe('buy');
      expect(pickBVariant('bear', sq)).toBe('sell');
    }
  });

  it('★目線 range のとき: スクイーズなら breakout・それ以外は fade', () => {
    expect(pickBVariant('range', 'squeeze')).toBe('range-breakout');
    expect(pickBVariant('range', 'bulge')).toBe('range-fade');
    expect(pickBVariant('range', null)).toBe('range-fade');   // ★測れない回の既定は fade
  });

  it('★選ぶ入力は「目線」と「スクイーズ判定」の2つだけ(AI の自由文は入らない)', () => {
    const dirs: TrendDirection[] = ['bull', 'bear', 'range'];
    const got = new Set<string>();
    for (const d of dirs) for (const sq of ['squeeze', 'bulge', null] as SqueezeState[]) got.add(pickBVariant(d, sq));
    expect([...got].sort()).toEqual(ALL.slice().sort());   // 4種すべてに到達し、それ以上は無い
  });
});

describe('② ★side / type は表が埋める(AI には返させない)', () => {
  it('4種の対応表が「あ=上 / い=下」で、side と type が版ごとに決まっている', () => {
    expect(B_VARIANTS.buy.legs).toMatchObject({
      a: { position: 'above', side: 'buy', type: 'stop' },
      i: { position: 'below', side: 'buy', type: 'limit' },
    });
    expect(B_VARIANTS.sell.legs).toMatchObject({
      a: { position: 'above', side: 'sell', type: 'limit' },
      i: { position: 'below', side: 'sell', type: 'stop' },
    });
    expect(B_VARIANTS['range-fade'].legs).toMatchObject({
      a: { position: 'above', side: 'sell', type: 'limit' },
      i: { position: 'below', side: 'buy', type: 'limit' },
    });
    expect(B_VARIANTS['range-breakout'].legs).toMatchObject({
      a: { position: 'above', side: 'buy', type: 'stop' },
      i: { position: 'below', side: 'sell', type: 'stop' },
    });
  });

  it('★「上に売りのブレイク新規」「下に買いのブレイク新規」は表に存在しない(定義上ありえない組)', () => {
    for (const v of ALL) {
      const { a, i } = B_VARIANTS[v].legs;
      if (a.type === 'stop') expect(a.side).toBe('buy');   // 上のブレイク新規は必ず買い
      if (i.type === 'stop') expect(i.side).toBe('sell');  // 下のブレイク新規は必ず売り
    }
  });

  it('★AI が side / type / direction / stopLoss を返しても、parse が拾わない', () => {
    const text = JSON.stringify({
      direction: 'sell', side: 'sell', type: 'stop',
      aPrice: 38400, aLcWidth: 80, aWhy: 'あ', aSide: 'sell', aStopLoss: 99999,
      iPrice: 38100, iLcWidth: 70, iWhy: 'い', entry: 12345,
      strategy: '押し目',
    });
    const ans = parseBAnswer(text)!;
    expect(Object.keys(ans).sort()).toEqual(
      ['aLcWidth', 'aPrice', 'aWhy', 'iLcWidth', 'iPrice', 'iWhy', 'strategy'].sort(),
    );
    // ★契約に無いキーは1つも残らない
    for (const k of ['direction', 'side', 'type', 'aSide', 'aStopLoss', 'entry']) {
      expect(Object.prototype.hasOwnProperty.call(ans, k)).toBe(false);
    }
  });

  it('★AI が sell を主張しても、buy 版に渡せば buy の側が入る(表が勝つ)', () => {
    const ans = parseBAnswer(JSON.stringify({
      direction: 'sell', side: 'sell', aPrice: 38400, aLcWidth: 80, iPrice: 38100, iLcWidth: 70,
    }))!;
    const { plan } = buildPlanFromBAnswer('buy', ans, REF);
    expect(plan.direction).toBe('buy');
    expect(plan.stopEntry).toBe(38400);                      // あ)=上=逆指値買い
    expect(plan.limitEntry).toBe(38100);                     // い)=下=指値買い
    expect(plan.stopLossForStop).toBe(38400 - 80);           // ★買いの損切りは必ず下
    expect(plan.stopLossForLimit).toBe(38100 - 70);
  });
});

describe('③ ★損切りの向きは stopLossFromWidth だけが決める', () => {
  it('4種すべてで、全レッグの損切りが建玉を守る向きになる', () => {
    const ans = { aPrice: REF + 150, aLcWidth: 80, iPrice: REF - 150, iLcWidth: 70 };
    for (const v of ALL) {
      const { plan } = buildPlanFromBAnswer(v, ans, REF);
      const legs: Array<{ side: 'buy' | 'sell'; entry: number; sl: number }> = [];
      if (plan.limitEntry != null) legs.push({ side: B_VARIANTS[v].legs[B_VARIANTS[v].legs.a.type === 'limit' ? 'a' : 'i']!.side, entry: plan.limitEntry, sl: plan.stopLossForLimit! });
      if (plan.stopEntry != null) legs.push({ side: B_VARIANTS[v].legs[B_VARIANTS[v].legs.a.type === 'stop' ? 'a' : 'i']!.side, entry: plan.stopEntry, sl: plan.stopLossForStop! });
      for (const l of Object.values(plan.range ?? {})) legs.push({ side: l.side, entry: l.entry, sl: l.stopLoss });
      expect(legs.length).toBe(2);
      for (const l of legs) expect(stopSideOk(l.side, l.entry, l.sl)).toBe(true);
    }
  });

  it('★幅から作った損切り価格が stopLossFromWidth と1円もずれない', () => {
    const { plan } = buildPlanFromBAnswer('sell', { aPrice: 38400, aLcWidth: 90, iPrice: 38100, iLcWidth: 60 }, REF);
    expect(plan.stopLossForLimit).toBe(stopLossFromWidth('sell', 38400, 90));
    expect(plan.stopLossForStop).toBe(stopLossFromWidth('sell', 38100, 60));
  });

  it('★AI が渡してくる幅が負/0/欠落なら、そのレッグは立たない(壊れた損切りを作らない)', () => {
    for (const bad of [{ aLcWidth: 0 }, { aLcWidth: -50 }, {}]) {
      const { plan } = buildPlanFromBAnswer('buy', { aPrice: 38400, ...bad, iPrice: 38100, iLcWidth: 70 }, REF);
      expect(plan.stopEntry).toBeUndefined();
      expect(plan.limitEntry).toBe(38100);   // もう片方は残る
    }
  });
});

describe('④ ★片方だけ見送れる / 両方なら見送り', () => {
  it('あ) だけ / い) だけ でも計画が成立する', () => {
    const onlyA = buildPlanFromBAnswer('buy', { aPrice: 38400, aLcWidth: 80, iWhy: '下は節目が遠い' }, REF);
    expect(onlyA.plan.direction).toBe('buy');
    expect(onlyA.plan.stopEntry).toBe(38400);
    expect(onlyA.plan.limitEntry).toBeUndefined();
    expect(onlyA.iWhy).toBe('下は節目が遠い');
    expect(onlyA.bothDropped).toBe(false);

    const onlyI = buildPlanFromBAnswer('buy', { iPrice: 38100, iLcWidth: 70, aWhy: '上は空白' }, REF);
    expect(onlyI.plan.limitEntry).toBe(38100);
    expect(onlyI.plan.stopEntry).toBeUndefined();
    expect(onlyI.bothDropped).toBe(false);
  });

  it('★両方置けないときだけ direction:"none" になり、理由の文が残る', () => {
    const r = buildPlanFromBAnswer('sell', { aWhy: '上は空白', iWhy: '下は本日安値まで遠い' }, REF);
    expect(r.plan.direction).toBe('none');
    expect(r.bothDropped).toBe(true);
    expect(r.aWhy).toBe('上は空白');
    expect(r.iWhy).toBe('下は本日安値まで遠い');
  });

  it('★理由も価格も無い(無言)ときは bothDropped だが理由が undefined(呼び出し側が aiSilent にできる)', () => {
    const r = buildPlanFromBAnswer('buy', {}, REF);
    expect(r.bothDropped).toBe(true);
    expect(r.aWhy).toBeUndefined();
    expect(r.iWhy).toBeUndefined();
  });

  it('レンジ2版は range.upper / range.lower に入り、片脚落ちも表現できる', () => {
    const both = buildPlanFromBAnswer('range-fade', { aPrice: 38400, aLcWidth: 80, iPrice: 38100, iLcWidth: 70 }, REF);
    expect(both.plan.direction).toBe('range');
    expect(both.plan.range?.upper).toMatchObject({ side: 'sell', type: 'limit', entry: 38400 });
    expect(both.plan.range?.lower).toMatchObject({ side: 'buy', type: 'limit', entry: 38100 });
    const one = buildPlanFromBAnswer('range-breakout', { aPrice: 38400, aLcWidth: 80 }, REF);
    expect(one.plan.range?.upper).toMatchObject({ side: 'buy', type: 'stop' });
    expect(one.plan.range?.lower).toBeUndefined();
  });

  it('★組を混ぜない(fade は両方 limit・breakout は両方 stop)', () => {
    const fade = buildPlanFromBAnswer('range-fade', { aPrice: 38400, aLcWidth: 80, iPrice: 38100, iLcWidth: 70 }, REF).plan;
    expect([fade.range!.upper!.type, fade.range!.lower!.type]).toEqual(['limit', 'limit']);
    const brk = buildPlanFromBAnswer('range-breakout', { aPrice: 38400, aLcWidth: 80, iPrice: 38100, iLcWidth: 70 }, REF).plan;
    expect([brk.range!.upper!.type, brk.range!.lower!.type]).toEqual(['stop', 'stop']);
  });

  it('strategy は1行としてそのまま載る(欠落なら付かない)', () => {
    const withS = buildPlanFromBAnswer('buy', { strategy: '押し目を節目手前で拾う', aPrice: 38400, aLcWidth: 80 }, REF);
    expect(withS.plan.strategy).toBe('押し目を節目手前で拾う');
    const noS = buildPlanFromBAnswer('buy', { aPrice: 38400, aLcWidth: 80 }, REF);
    expect(Object.prototype.hasOwnProperty.call(noS.plan, 'strategy')).toBe(false);
    // ★strategyWhy は作らない(1フィールドに寄せた)
    expect(Object.prototype.hasOwnProperty.call(withS.plan, 'strategyWhy')).toBe(false);
  });
});

describe('⑤⑥ ★プロンプトの検算', () => {
  const full = (v: BVariant): string => buildBSystemPrompt(v, 55, 160, '【データ】') + buildBUserPrompt(v, REF, 55, 160);

  it('★B(buy) に売り系の語が1文字も無い', () => {
    const t = full('buy');
    for (const w of ['売り', 'sell', 'ベア', '下降']) expect(t.split(w).length - 1).toBe(0);
  });

  it('★B(sell) に買い系の語が1文字も無い', () => {
    const t = full('sell');
    for (const w of ['買い', 'buy', 'ブル', '上昇']) expect(t.split(w).length - 1).toBe(0);
  });

  it('★どの版にも「どちらの組を選べ」という指示が無い(コードが選ぶので説明しない)', () => {
    for (const v of ALL) {
      const t = full(v);
      for (const w of ['スクイーズ', 'バンド幅', '選んでください', '2択', '組を混ぜ']) {
        expect(t.split(w).length - 1).toBe(0);
      }
    }
  });

  it('⑥ ★規則の数値をプロンプトに書かない(裸の数字を全部数える)', () => {
    // 出てよい数字はこの5種だけ。★どれも **判定のしきい値ではない**:
    //   225   … 銘柄名(日経225先物)
    //   2     … 問いの数(「次の2つに答えてください」)
    //   ★「1行」は **外した**(2026-08-22): 字数を指定すると理由が短くなる実測(47%減)があり、
    //      「字数でなく問いで縛る」という設計と矛盾していた。長すぎたら測ってから対処する。
    //   38250 … 現在価格(データが入る場所)
    //   55/160… 損切幅の帯。★設定から解決した値が埋まる(固定値ではない=下のテストで実証)
    for (const v of ALL) {
      const nums = new Set((full(v).match(/\d+/g) ?? []));
      expect([...nums].sort()).toEqual(['160', '2', '225', '38250', '55'].sort());
    }
  });

  it('★損切幅の帯は設定から埋まる(固定値ではない)', () => {
    const t = buildBSystemPrompt('buy', 40, 200, '') + buildBUserPrompt('buy', REF, 40, 200);
    expect(t).toContain('40円以上 200円以下');
    expect(t).toContain('40円以上200円以下');
    expect(t).not.toContain('55');
    expect(t).not.toContain('160');
  });

  it('★あ)=上 / い)=下 と、版ごとの注文名が本文に出る', () => {
    expect(full('buy')).toContain('あ)(現在価格の)上の価格に逆指値買い注文を入れるとしたとき、逆指値価格と損切幅');
    expect(full('buy')).toContain('い)(現在価格の)下の価格に指値買い注文を入れるとしたとき、指値価格と損切幅');
    expect(full('sell')).toContain('あ)(現在価格の)上の価格に指値売り注文を入れるとしたとき、指値価格と損切幅');
    expect(full('sell')).toContain('い)(現在価格の)下の価格に逆指値売り注文を入れるとしたとき、逆指値価格と損切幅');
  });

  it('★strategy に字数の指定が無い(「1行」を書かない)', () => {
    for (const v of ALL) {
      const t = full(v);
      expect(t).toContain('"strategy": string,  // この相場をどう読んで この価格にしたか');
      for (const w of ['1行', '一行', '短く', '簡潔']) expect(t).not.toContain(w);
    }
  });

  it('★出力契約に side / type / direction のフィールドが無い(返す場所が存在しない)', () => {
    for (const v of ALL) {
      const t = full(v);
      for (const k of ['"side"', '"type"', '"direction"', '"stopLoss"', '"entry"']) expect(t).not.toContain(k);
      for (const k of ['"aPrice"', '"aLcWidth"', '"aWhy"', '"iPrice"', '"iLcWidth"', '"iWhy"', '"strategy"']) {
        expect(t).toContain(k);
      }
    }
  });

  it('★range 2版の system は同じ文字列(どちらを渡すかはコードが決めるので説明しない)', () => {
    expect(buildBSystemPrompt('range-fade', 55, 160, 'X'))
      .toBe(buildBSystemPrompt('range-breakout', 55, 160, 'X'));
  });

  it('★壊れた応答は null(捏造しない)', () => {
    for (const bad of ['', 'こんにちは', '{壊れ', 'null']) expect(parseBAnswer(bad)).toBeNull();
    // 前後に説明文やコードフェンスが付いていても拾える
    expect(parseBAnswer('```json\n{"aPrice":1,"aLcWidth":2}\n```')).toEqual({ aPrice: 1, aLcWidth: 2 });
  });
});

// ★段6(2026-08-22): B の user プロンプトに「判断に必要なデータが足りなかったときは、
//   何が足りなかったかも書いてください」を1文足した。新しい数値/語彙は無い(自由文のみ)。
describe('★段6: 「足りなかったデータ」の1文と自由文フィールド', () => {
  const full = (v: BVariant): string => buildBSystemPrompt(v, 55, 160, '【データ】') + buildBUserPrompt(v, REF, 55, 160);

  it('★B の4種すべてに、指定どおりの1文がそのまま入る', () => {
    for (const v of ALL) {
      expect(buildBUserPrompt(v, REF, 55, 160))
        .toContain('判断に必要なデータが足りなかったときは、何が足りなかったかも書いてください。');
    }
  });

  it('★JSON 契約に missingData が入り、選択肢(語彙候補)を作っていない(自由文 string のみ)', () => {
    for (const v of ALL) {
      const t = buildBUserPrompt(v, REF, 55, 160);
      expect(t).toContain('"missingData": string');
      // ★選択肢を作らない = 語彙候補(ATR/節目/BB 等の固有名)をプロンプト本文に書いていない。
      for (const w of ['ATR', 'BB', '節目', 'スイング', 'enum', 'choice']) expect(t).not.toContain(w);
    }
  });

  it('⑥の検算をここでも壊さない(新しい裸の数字を1つも増やしていない)', () => {
    for (const v of ALL) {
      const nums = new Set((full(v).match(/\d+/g) ?? []));
      expect([...nums].sort()).toEqual(['160', '2', '225', '38250', '55'].sort());
    }
  });

  it('★parseBAnswer が missingData を拾う(あ/い の理由 aWhy/iWhy とは別フィールド)', () => {
    const ans = parseBAnswer(JSON.stringify({
      aPrice: 100, aLcWidth: 60, missingData: 'ATR が算出できず、節目データも0件でした',
    }));
    expect(ans?.missingData).toBe('ATR が算出できず、節目データも0件でした');
    expect(ans?.aWhy).toBeUndefined();
  });

  it('★missingData が無い/空文字/空白のみは undefined(捏造しない)', () => {
    expect(parseBAnswer(JSON.stringify({ aPrice: 1, aLcWidth: 2 }))?.missingData).toBeUndefined();
    expect(parseBAnswer(JSON.stringify({ missingData: '' }))?.missingData).toBeUndefined();
    expect(parseBAnswer(JSON.stringify({ missingData: '   ' }))?.missingData).toBeUndefined();
  });

  it('★見送りでない回(片脚成立)にも missingData は書ける(ai_why の見送り専用フラグとは独立)', () => {
    const ans = parseBAnswer(JSON.stringify({
      aPrice: 38400, aLcWidth: 80, aWhy: '節目手前',
      missingData: 'い) は基礎データが古く判断を保留',
    }));
    expect(ans?.aPrice).toBe(38400);
    expect(ans?.missingData).toBe('い) は基礎データが古く判断を保留');
  });
});
