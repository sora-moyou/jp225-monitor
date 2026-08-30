import { describe, it, expect } from 'vitest';
import {
  B_VARIANTS, pickBVariant, parseBFreeText, readLegCandidates, normalizeBText, buildPlanFromBAnswer,
  buildBSystemPrompt, buildBUserPrompt, lcBandPhrase, orderShortJa, tpAskable, effectiveAskTp,
  type BVariant, type SqueezeState, type TrendDirection,
} from './planVariants.js';
import { stopLossFromWidth, stopSideOk } from '../../core/stopGeometry.js';
import { forcedTrendFrom } from '../config/scalpResolvers.js';

// ★段3(v0.9.99)＋★2026-08-25(v0.9.99・応答が JSON → 自由文): B の4種と対応表・読み取り。
//
// 何を守っているか:
//   ① ★版は **コードが選ぶ**(AI は選ばない)。range のときだけスクイーズ判定を見る
//   ② ★side / type は **表が埋める**。AI が何を書いても届かない
//   ③ ★損切りの向きは stopLossFromWidth 一箇所だけが決める(逆側の損切りが作れない)
//   ④ ★片方だけ見送れる(「片方が置けなかった」が「計画ごと見送り」に潰れない)
//   ⑤ ★B(buy) に売り系・B(sell) に買い系の語が1文字も出ない
//   ⑥ ★新しい閾値をプロンプトに書かない(数値は 現在価格 と 設定の帯 だけ)
//   ⑦ ★★自由文の読み取り: **注文タイプの語だけ** で脚を決め、読めない形は落として記録する

const ALL: BVariant[] = ['buy', 'sell', 'range-fade', 'range-breakout'];
const REF = 38250;
/** ★指定文面の帯「55円<=損切幅<160円」を出す設定値(閉区間の上限=159)。 */
const FLOOR = 55;
const CEIL = 159;

describe('① 版はコードが選ぶ(AI は選ばない)', () => {
  it('目線 buy/sell(ブル/ベア)は スクイーズ判定を見ない', () => {
    for (const sq of ['squeeze', 'bulge', null] as SqueezeState[]) {
      expect(pickBVariant('buy', sq)).toBe('buy');
      expect(pickBVariant('sell', sq)).toBe('sell');
    }
  });

  it('★目線 range のとき: スクイーズなら breakout・それ以外は fade', () => {
    expect(pickBVariant('range', 'squeeze')).toBe('range-breakout');
    expect(pickBVariant('range', 'bulge')).toBe('range-fade');
    expect(pickBVariant('range', null)).toBe('range-fade');   // ★測れない回の既定は fade
  });

  it('★選ぶ入力は「目線」と「スクイーズ判定」の2つだけ(AI の自由文は入らない)', () => {
    const dirs: TrendDirection[] = ['buy', 'sell', 'range'];
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

  it('★4版とも「あ」と「い」の注文タイプの組が互いに違う(語だけで脚を判別できる前提)', () => {
    for (const v of ALL) {
      const { a, i } = B_VARIANTS[v].legs;
      expect(`${a.type}/${a.side}`).not.toBe(`${i.type}/${i.side}`);
    }
  });

  it('★AI が side / type / direction を書いても、読み取りに入る場所が無い', () => {
    // ★自由文なので「フィールドが無い」ではなく「読み取りが写す先が無い」。
    const ans = parseBFreeText('direction: sell / side: sell\n逆指値買い38400円（LC幅80円）あ', 'buy')!;
    expect(Object.keys(ans).sort()).toEqual(['aLcWidth', 'aPrice', 'aWhy', 'readIssues'].sort());
    for (const k of ['direction', 'side', 'type', 'stopLoss', 'entry']) {
      expect(Object.prototype.hasOwnProperty.call(ans, k)).toBe(false);
    }
  });

  it('★buy 版に渡せば buy の側が入る(表が勝つ)', () => {
    const ans = parseBFreeText('逆指値買い38400円（LC幅80円）上\n指値買い38100円（LC幅70円）下', 'buy')!;
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

  // ★2026-08-25: 落とした脚は **必ず** LegDrop に残る(黙って消えない)。
  describe('★落とした脚は leg_drops_json に残る(記録専用)', () => {
    it('片脚だけ落ちた回にも 1件だけ残る(名前は limit/stop)', () => {
      const r = buildPlanFromBAnswer('buy', { aPrice: 38400, aLcWidth: 80 }, REF);
      expect(r.legDrops).toEqual([{ name: 'limit', reason: 'missing' }]);
    });

    it('レンジ2版では名前が upper/lower になる', () => {
      const r = buildPlanFromBAnswer('range-fade', { iPrice: 38100, iLcWidth: 70 }, REF);
      expect(r.legDrops).toEqual([{ name: 'upper', reason: 'missing' }]);
    });

    it('★読めた生の値と読み取り失敗の理由も一緒に残る(件数すら数えられない状態を作らない)', () => {
      const r = buildPlanFromBAnswer('buy', {
        aPrice: 38400, readIssues: { a: '「逆指値買い」のLC幅を読めなかった' },
      }, REF);
      expect(r.legDrops[0]).toEqual({
        name: 'stop', reason: 'missing', entry: 38400, parseIssue: '「逆指値買い」のLC幅を読めなかった',
      });
    });

    it('両脚とも立った回は1件も残らない', () => {
      const r = buildPlanFromBAnswer('buy', { aPrice: 38400, aLcWidth: 80, iPrice: 38100, iLcWidth: 70 }, REF);
      expect(r.legDrops).toEqual([]);
    });
  });

  it('strategy は載る欄が残っている(自由文の形式には無いので通常は undefined)', () => {
    const withS = buildPlanFromBAnswer('buy', { strategy: '押し目を節目手前で拾う', aPrice: 38400, aLcWidth: 80 }, REF);
    expect(withS.plan.strategy).toBe('押し目を節目手前で拾う');
    const noS = buildPlanFromBAnswer('buy', { aPrice: 38400, aLcWidth: 80 }, REF);
    expect(Object.prototype.hasOwnProperty.call(noS.plan, 'strategy')).toBe(false);
    // ★strategyWhy は作らない(1フィールドに寄せた)
    expect(Object.prototype.hasOwnProperty.call(withS.plan, 'strategyWhy')).toBe(false);
    // ★自由文の読み取りは strategy を作らない(捏造しない)
    expect(parseBFreeText('逆指値買い38400円（LC幅80円）あ', 'buy')!.strategy).toBeUndefined();
  });
});

describe('⑤⑥ ★プロンプトの検算(2026-08-25・ユーザー指定文面)', () => {
  const full = (v: BVariant): string =>
    buildBSystemPrompt(v, FLOOR, CEIL, '【データ】', false) + buildBUserPrompt(v, REF, FLOOR, CEIL, false);

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
      for (const w of ['スクイーズ', 'バンド幅', '選んでください', '選択', '2択', 'どちらか', '組を混ぜ']) {
        expect(t.split(w).length - 1, `「${w}」が ${v} に出ている`).toBe(0);
      }
    }
  });

  it('⑥ ★規則の数値をプロンプトに書かない(裸の数字を全部数える)', () => {
    // 出てよい数字はこの5種だけ。★どれも **判定のしきい値ではない**:
    //   225   … 銘柄名(日経225先物)
    //   2     … 問いの数(「2つに分けて返してください」)
    //   38250 … 現在価格(データが入る場所)
    //   55/160… 損切幅の帯。★設定から解決した値が埋まる(固定値ではない=下のテストで実証)
    // ★「1行」は書かない(2026-08-22 の実測: 行数/字数の指定で理由が 47% 短くなった)。
    for (const v of ALL) {
      const nums = new Set((full(v).match(/\d+/g) ?? []));
      expect([...nums].sort()).toEqual(['160', '2', '225', '38250', '55'].sort());
    }
  });

  it('★損切幅の帯は **半開区間** で、設定から埋まる(固定値ではない)', () => {
    for (const v of ALL) expect(full(v)).toContain('- 55円<=損切幅<160円とする。');
    const t = buildBSystemPrompt('buy', 40, 199, '', false) + buildBUserPrompt('buy', REF, 40, 199, false);
    expect(t).toContain('40円<=損切幅<200円');
    expect(t).not.toContain('55円');
    expect(t).not.toContain('160円');
  });

  it('★半開表記の上端 = 実際に受理される上限 + 1(印字と受理が一致する)', () => {
    // ★コード側(lcLegExceeds)は `w > ceilingYen` で落とす=ちょうど ceilingYen は許可(閉区間)。
    //   円は整数なので `w <= C` と `w < C+1` は同じ集合。★だから上端は C+1 でなければ嘘になる。
    expect(lcBandPhrase(55, 159)).toBe('55円<=損切幅<160円');
    expect(lcBandPhrase(55, 65)).toBe('55円<=損切幅<66円');
    expect(lcBandPhrase(20, 20)).toBe('20円<=損切幅<21円');
  });

  it('★4版の system が ユーザー指定文面と1行ずつ一致する', () => {
    const head = 'あなたは日経225先物(NIY=F)のスキャルピング/デイトレードを専門とするトレーダーです。';
    const tools = '渡されたデータと、利用可能なデータツール(explain_move / query_alerts / price_history / web_search)'
      + 'を必要に応じて使い、それぞれについて適切な注文価格と損切幅を教えてください。';
    const tail = '- 渡されたデータやテクニカル指標と、それから得られる事柄のみを根拠にする。';
    const expected: Record<BVariant, readonly string[]> = {
      buy: [
        '現在価格より上の価格の逆指値買い注文、下の価格の指値買い注文を同時に出し、先に約定した方でエントリーし他方はキャンセルします。',
        '（上）現在価格より上の買いエントリー価格とその理由。それに対応した損切幅とその理由。',
        '形式は「逆指値買い○○円（LC幅○○円）その後に理由を日本語で自由表記）',
        '（下）現在価格より下の買いエントリー価格とその理由。それに対応した損切幅とその理由。',
        '形式は「指値買い○○円（LC幅○○円）その後に理由を日本語で自由表記）',
      ],
      sell: [
        '現在価格より上の価格の指値売り注文、下の価格の逆指値売り注文を同時に出し、先に約定した方でエントリーし他方はキャンセルします。',
        '（上）現在価格より上の売りエントリー価格とその理由。それに対応した損切幅とその理由。',
        '形式は「指値売り○○円（LC幅○○円）その後に理由を日本語で自由表記）',
        '（下）現在価格より下の売りエントリー価格とその理由。それに対応した損切幅とその理由。',
        '形式は「逆指値売り○○円（LC幅○○円）その後に理由を日本語で自由表記）',
      ],
      'range-breakout': [
        '現在価格より上の価格の逆指値買い注文、下の価格の逆指値売り注文を同時に出し、先に約定した方でエントリーし他方はキャンセルします。',
        '（上）現在価格より上の買いエントリー価格とその理由。それに対応した損切幅とその理由。',
        '形式は「逆指値買い○○円（LC幅○○円）その後に理由を日本語で自由表記）',
        '（下）現在価格より下の売りエントリー価格とその理由。それに対応した損切幅とその理由。',
        '形式は「逆指値売り○○円（LC幅○○円）その後に理由を日本語で自由表記）',
      ],
      'range-fade': [
        '現在価格より上の価格の指値売り注文、下の価格の指値買い注文を同時に出し、先に約定した方でエントリーし他方はキャンセルします。',
        '（上）現在価格より上の売りエントリー価格とその理由。それに対応した損切幅とその理由。',
        '形式は「指値売り○○円（LC幅○○円）その後に理由を日本語で自由表記）',
        '（下）現在価格より下の買いエントリー価格とその理由。それに対応した損切幅とその理由。',
        '形式は「指値買い○○円（LC幅○○円）その後に理由を日本語で自由表記）',
      ],
    };
    for (const v of ALL) {
      const sys = buildBSystemPrompt(v, FLOOR, CEIL, '<<D>>', false);
      expect(sys.split('\n')).toEqual([
        head, expected[v][0]!, tools, '', '制約:', '- 55円<=損切幅<160円とする。', '- 2つに分けて返してください。',
        expected[v][1]!, expected[v][2]!, expected[v][3]!, expected[v][4]!, tail, '', '【データ】', '<<D>>',
      ]);
    }
  });

  it('★JSON の契約を1つも書かない(自由文だけを求める)', () => {
    for (const v of ALL) {
      const t = full(v);
      for (const k of ['JSON', '"aPrice"', '"aLcWidth"', '"strategy"', 'コードフェンス', 'マークダウン']) {
        expect(t.split(k).length - 1, `${v} に「${k}」が出ている`).toBe(0);
      }
    }
  });

  it('★「5円刻み」「丸め」「不等式」など こちらの作業は書かない', () => {
    // ★`5円` 単体では数えない: 帯の `55円<=…` と **部分一致** するため恒偽になる
    //   (A 側の A_FORBIDDEN_TEMPLATE_ONLY で踏んだのと同じ罠。数える場所ではなく語を精密にする)。
    for (const v of ALL) {
      const t = full(v);
      for (const w of ['5円刻み', '刻み', '丸め', '不等式', '検算', 'ティック']) expect(t).not.toContain(w);
    }
  });

  it('★range 2版の system は互いに違う(注文の形が違うので)', () => {
    expect(buildBSystemPrompt('range-fade', FLOOR, CEIL, 'X', false))
      .not.toBe(buildBSystemPrompt('range-breakout', FLOOR, CEIL, 'X', false));
  });

  it('★user プロンプトは現在価格と書き出しの語だけを補う', () => {
    const u = buildBUserPrompt('buy', REF, FLOOR, CEIL, false);
    expect(u).toContain(`現在価格は ${REF} です。`);
    expect(u).toContain('（上）は「逆指値買い」、（下）は「指値買い」で書き始めてください。');
    expect(u).toContain('判断に必要なデータが足りなかったときは、最後に「不足データ: …」と書いてください。');
    for (const w of ['1行', '一行', '短く', '簡潔']) expect(u).not.toContain(w);
  });

  it('★orderShortJa は「注文」を落とすだけ(4版8脚すべて)', () => {
    for (const v of ALL) {
      for (const k of ['a', 'i'] as const) {
        const c = B_VARIANTS[v].legs[k];
        expect(orderShortJa(c)).toBe(c.orderJa.replace('注文', ''));
        expect(orderShortJa(c)).not.toContain('注文');
      }
    }
  });
});

// ═══ ⑦ ★★自由文の読み取り ══════════════════════════════════════════════════
//
// ■ ★この節がこの改訂で **いちばん壊れやすい場所**。実際の応答らしい揺れを並べて殴る。
describe('⑦ ★自由文の読み取り: 実際に来そうな形が全部読める', () => {
  /** ★あ)=逆指値買い / い)=指値買い(版 'buy')。上下の語は識別に使わない。 */
  const READ = (text: string) => parseBFreeText(text, 'buy')!;

  const CASES: ReadonlyArray<readonly [string, string]> = [
    ['①指定どおり(全角括弧)', '逆指値買い65780円（LC幅60円）節目を抜けたら追随するため5円上。'],
    ['②カンマ区切り', '逆指値買い65,780円（LC幅60円）65,775の節目を抜けたら追随するため5円上。'],
    ['③全角数字・全角LC', '逆指値買い６５，７８０円（ＬＣ幅６０円）節目の外側。'],
    ['④半角括弧と空白', '逆指値買い 65780 円 (LC幅 60 円) 節目の外側。'],
    ['⑤行頭に位置の見出し', '（上）逆指値買い65,780円（LC幅60円）節目の外側。'],
    ['⑥太字の飾り', '**（上）**逆指値買い65,780円（LC幅60円）節目の外側。'],
    ['⑦カギ括弧つき', '「逆指値買い65,780円（LC幅60円）節目の外側。'],
    ['⑧「注文」の語つき', '逆指値買い注文 65,780円（LC幅60円）節目の外側。'],
    ['⑨損切幅という表記', '逆指値買い65780円（損切幅60円）節目の外側。'],
    ['⑩コロン区切り', '逆指値買い: 65,780円（LC幅: 60円）節目の外側。'],
    ['⑪箇条書き記号', '- 逆指値買い65,780円（LC幅60円）節目の外側。'],
    ['⑫番号つき', '1. 逆指値買い65,780円（LC幅60円）節目の外側。'],
    ['⑬小数', '逆指値買い65780.0円（LC幅60.0円）節目の外側。'],
    ['⑭全角コロン＋全角スペース', '逆指値買い：　65,780円（ＬＣ幅　60円）節目の外側。'],
  ] as const;

  for (const [name, line] of CASES) {
    it(`${name}: 価格65780 / LC幅60 / 理由が あ) に入る`, () => {
      const r = READ(line);
      expect(r.aPrice, name).toBe(65780);
      expect(r.aLcWidth, name).toBe(60);
      expect(r.aWhy, name).toContain('節目');
      // ★い) は来ていないので価格は入らない(勝手に埋めない)
      expect(r.iPrice).toBeUndefined();
      expect(r.readIssues?.i).toBe('「指値買い」の行が無い');
    });
  }

  it('★両脚そろった標準形(ユーザーが書いた例そのもの)', () => {
    const r = READ([
      '逆指値買い65,780円（LC幅60円）65,775の節目を抜けたら追随するため5円上。幅は直近スイング安値まで。',
      '指値買い65,650円（LC幅55円）押し目の節目手前。',
    ].join('\n'));
    expect(r.aPrice).toBe(65780);
    expect(r.aLcWidth).toBe(60);
    expect(r.aWhy).toBe('65,775の節目を抜けたら追随するため5円上。幅は直近スイング安値まで。');
    expect(r.iPrice).toBe(65650);
    expect(r.iLcWidth).toBe(55);
    expect(r.iWhy).toBe('押し目の節目手前。');
    expect(r.readIssues).toBeUndefined();   // ★1つも問題が無い回は記録も付かない
  });

  it('★理由が次の行に続いても拾う(「1行」を強制していないので起こりうる)', () => {
    const r = READ('逆指値買い65,780円（LC幅60円）節目の外側。\n  直近30分の高値を上抜けたら追随する。');
    expect(r.aWhy).toBe('節目の外側。 直近30分の高値を上抜けたら追随する。');
  });

  it('★理由の中の「値幅が200円」を LC幅として拾わない(近傍だけを見る)', () => {
    const r = READ('逆指値買い65,780円（LC幅60円）30分の値幅が200円なので上抜けに追随。');
    expect(r.aLcWidth).toBe(60);
  });

  it('★LC幅が無い行は 価格だけ読めて 脚は立たない(理由を記録する)', () => {
    const r = READ('逆指値買い65,780円 節目の外側。');
    expect(r.aPrice).toBe(65780);
    expect(r.aLcWidth).toBeUndefined();
    expect(r.readIssues?.a).toBe('「逆指値買い」のLC幅を読めなかった');
    const built = buildPlanFromBAnswer('buy', r, REF);
    expect(built.plan.stopEntry).toBeUndefined();
    expect(built.legDrops).toContainEqual({
      name: 'stop', reason: 'missing', entry: 65780, parseIssue: '「逆指値買い」のLC幅を読めなかった',
    });
  });

  it('★「見送ります」の文中の数字を価格として読まない(句点をまたがない)', () => {
    const r = READ('逆指値買いは見送ります。65,780円は節目から遠いため。');
    expect(r.aPrice).toBeUndefined();
    expect(r.aLcWidth).toBeUndefined();
    // ★2026-08-25: 「置けない」と述べている脚は **表明** として記録する(価格を中途半端に拾わない)。
    expect(r.readIssues?.a).toBe('「逆指値買い」「置けない」と述べている');
    expect(r.aWhy).toContain('見送ります');
  });

  it('★不足データの申告を拾う(あ/い の理由とは別)', () => {
    const r = READ('逆指値買い65,780円（LC幅60円）節目の外側。\n不足データ: ATR が算出できず、節目データも0件でした');
    expect(r.missingData).toBe('ATR が算出できず、節目データも0件でした');
    expect(r.aWhy).toBe('節目の外側。');
  });

  it('★空応答だけが null(それ以外は必ず読み取り結果を返して理由を残す)', () => {
    for (const bad of ['', '   ', '\n\n']) expect(parseBFreeText(bad, 'buy')).toBeNull();
    const r = parseBFreeText('こんにちは。相場は難しいですね。', 'buy')!;
    expect(r.aPrice).toBeUndefined();
    expect(r.readIssues).toEqual({ a: '「逆指値買い」の行が無い', i: '「指値買い」の行が無い' });
  });

  it('★normalizeBText は全角を半角に潰す(この関数だけが揺れを吸収する)', () => {
    expect(normalizeBText('６５，７８０円（ＬＣ幅６０円）')).toBe('65,780円(LC幅60円)');
    expect(normalizeBText('−50')).toBe('-50');
  });
});

// ─── ★★否定対照: 期待した注文タイプでない行は「落ちる」 ───────────────────────
describe('⑦ ★★否定対照: 脚は注文タイプの語だけで決まる(上/下では決めない)', () => {
  it('★buy 版に「指値売り」が来たら、どちらの脚にも入らず記録に残る', () => {
    const r = parseBFreeText('指値売り65,900円（LC幅60円）戻り売り。', 'buy')!;
    expect(r.aPrice).toBeUndefined();
    expect(r.iPrice).toBeUndefined();
    expect(r.readIssues?.unmatched?.[0]).toContain('期待外の注文タイプ(指値売り)');
    expect(r.readIssues?.a).toBe('「逆指値買い」の行が無い');
    expect(r.readIssues?.i).toBe('「指値買い」の行が無い');
    // ★黙って別の脚に入っていない=注文が1本も作られない
    expect(buildPlanFromBAnswer('buy', r, REF).plan.direction).toBe('none');
  });

  it('★sell 版に「逆指値買い」が来たら落ちる(4版すべてで対称に効く)', () => {
    const r = parseBFreeText('逆指値買い65,900円（LC幅60円）上抜け。', 'sell')!;
    expect(r.aPrice).toBeUndefined();
    expect(r.iPrice).toBeUndefined();
    expect(r.readIssues?.unmatched?.[0]).toContain('期待外の注文タイプ(逆指値買い)');
  });

  it('★range-fade に「逆指値」系が来たら落ちる(組を混ぜない)', () => {
    const r = parseBFreeText([
      '逆指値買い65,900円（LC幅60円）上抜け。',
      '逆指値売り65,500円（LC幅60円）下抜け。',
    ].join('\n'), 'range-fade')!;
    expect(r.aPrice).toBeUndefined();
    expect(r.iPrice).toBeUndefined();
    expect(r.readIssues?.unmatched).toHaveLength(2);
  });

  it('★★位置の語が逆でも、注文タイプが正しければ その脚に入る(上/下で判定していない証明)', () => {
    // ★（下）と書いてある行に「逆指値買い」= あ)の注文タイプ。★あ) に入るのが正しい。
    const r = parseBFreeText('（下）逆指値買い65,780円（LC幅60円）節目の外側。', 'buy')!;
    expect(r.aPrice).toBe(65780);
    expect(r.iPrice).toBeUndefined();
  });

  it('★同じ注文タイプが2回来たら、2本目は捨てて記録する(上書きしない)', () => {
    const r = parseBFreeText([
      '逆指値買い65,780円（LC幅60円）1本目。',
      '逆指値買い65,900円（LC幅70円）2本目。',
    ].join('\n'), 'buy')!;
    expect(r.aPrice).toBe(65780);
    expect(r.aLcWidth).toBe(60);
    expect(r.readIssues?.unmatched?.[0]).toContain('重複した見出し(逆指値買い)');
  });

  it('★見送りの理由は 位置の行から **理由としてだけ** 引き取る(価格は絶対に入らない)', () => {
    const r = parseBFreeText([
      '逆指値買い65,780円（LC幅60円）節目の外側。',
      '（下）見送り。押し目の節目が65,000円まで無く、損切幅が帯に収まらない。',
    ].join('\n'), 'buy')!;
    expect(r.iPrice).toBeUndefined();      // ★65,000 を価格として入れない
    expect(r.iLcWidth).toBeUndefined();
    expect(r.iWhy).toContain('損切幅が帯に収まらない');
    expect(r.readIssues?.i).toBe('「指値買い」の行が無い(位置の行の文章を理由として記録)');
  });

  it('★「上昇トレンドなので…」は位置の行に化けない(閉じ記号を必須にしてある)', () => {
    const { positionReasons } = readLegCandidates('上昇トレンドなので買い有利。\n下値は堅い。');
    expect(positionReasons).toEqual({});
  });

  it('★★「修正の逆側」: 旧契約の JSON はもう読めない(=読めないことが記録に残る)', () => {
    // ★旧実装(parseBAnswer)はこれを問題なく読み、両脚を立てていた。
    //   新実装は自由文しか読まないので **落ちる**。★これは意図した非互換で、
    //   黙って落ちるのではなく readIssues → leg_drops_json(parseIssue) に残る。
    const legacy = '{"strategy":"押し目","aPrice":38400,"aLcWidth":80,"iPrice":38100,"iLcWidth":70}';
    const r = parseBFreeText(legacy, 'buy')!;
    expect(r.aPrice).toBeUndefined();
    expect(r.iPrice).toBeUndefined();
    expect(r.readIssues).toEqual({ a: '「逆指値買い」の行が無い', i: '「指値買い」の行が無い' });
    const built = buildPlanFromBAnswer('buy', r, REF);
    expect(built.bothDropped).toBe(true);
    expect(built.legDrops.map(d => d.parseIssue)).toEqual([
      '「逆指値買い」の行が無い', '「指値買い」の行が無い',
    ]);
  });
});

// ─── ★モデルが「形式の行」を復唱したときに本物の行が捨てられない ──────────────
describe('⑦ ★形式行の復唱に本物の脚を殺されない', () => {
  it('★system の形式行をそのまま復唱してから本物を書いても、本物が採られる', () => {
    const r = parseBFreeText([
      '形式は「逆指値買い○○円（LC幅○○円）その後に理由を日本語で自由表記）',
      '逆指値買い65,780円（LC幅60円）節目の外側。',
    ].join('\n'), 'buy')!;
    expect(r.aPrice).toBe(65780);
    expect(r.aLcWidth).toBe(60);
    // ★捨てた行は黙って消さない
    expect(r.readIssues?.unmatched?.[0]).toContain('価格の無い見出しを差し替え');
  });

  it('★逆順(本物が先)なら差し替えは起きず、復唱のほうが捨てられる', () => {
    const r = parseBFreeText([
      '逆指値買い65,780円（LC幅60円）節目の外側。',
      '形式は「逆指値買い○○円（LC幅○○円）その後に理由を日本語で自由表記）',
    ].join('\n'), 'buy')!;
    expect(r.aPrice).toBe(65780);
    expect(r.readIssues?.unmatched?.[0]).toContain('重複した見出し');
  });

  it('★価格つきが2本来たときは先着優先のまま(後から来た値で上書きしない)', () => {
    const r = parseBFreeText([
      '逆指値買い65,780円（LC幅60円）1本目。',
      '逆指値買い65,900円（LC幅70円）2本目。',
    ].join('\n'), 'buy')!;
    expect(r.aPrice).toBe(65780);
    expect(r.readIssues?.unmatched?.[0]).toContain('重複した見出し');
  });
});

// ═══ ★★① LC幅の曖昧な照合(2026-08-25・エバリュエーターが実測で見つけた無言の誤読) ══════
//
// ■ 何が起きていたか
//     `指値買い65,600円 直近の値幅80円を考慮しLC幅は60円とする。`
//   → 実測 lcWidth=80(意図は60) / stopLossForLimit=65520(正しくは65540)。
//   ★80 は帯の中なので下流も通し、readIssues にも legDrops にも残らない=**無言で数値を間違える**。
//   ★原因は WIDTH_RE の選択肢に **裸の `幅`** が入っていて、最左一致が `値幅80` を取ったこと。
//   ★「近傍の語を拾う曖昧な照合」は、この案件で最も高くついた事故(損切りの向きが逆・
//     「外側」の語の衝突)と同じ根。
// ■ 直し方(両方入れた・理由は planVariants.ts のコメント参照)
//   (a) 裸の `幅` を外す(`LC幅|損切幅|損切り幅|ロスカット幅|LC` の明示ラベルだけ)
//   (b) 近傍の候補が **食い違ったら** 脚を立てず readIssues に残す(=残った曖昧さを無言にしない)
describe('★★① LC幅の曖昧な照合: 明示ラベルだけを読み、食い違いは記録に残す', () => {
  const READ = (t: string) => parseBFreeText(t, 'buy')!;

  /** [名前, 本文, 期待する lcWidth(undefined=脚を立てない), 期待する issue の断片] */
  const CASES: ReadonlyArray<readonly [string, string, number | undefined, string | undefined]> = [
    ['①★実測の誤読ケース(値幅80 → LC幅60)',
      '指値買い65,600円 直近の値幅80円を考慮しLC幅は60円とする。', 60, undefined],
    ['②値幅が先・LC幅が後(括弧つき)',
      '指値買い65,600円（値幅80円のためLC幅60円）', 60, undefined],
    ['③理由の中の「30分の値幅が200円」',
      '指値買い65,600円（LC幅60円）30分の値幅が200円なので浅めにする。', 60, undefined],
    ['④A の文面をなぞった理由(値幅200円以内)',
      '指値買い65,600円（LC幅55円）30分間の値幅が200円以内でレンジ気味。', 55, undefined],
    ['⑤「幅」だけで LC を名乗らない形 → 読まない(記録に残す)',
      '指値買い65,600円（幅60円）節目手前。', undefined, 'のLC幅を読めなかった'],
    ['⑥損切幅ラベルは読む',
      '指値買い65,600円（損切幅60円）節目手前。', 60, undefined],
    ['⑦損切り幅ラベルも読む',
      '指値買い65,600円（損切り幅60円）節目手前。', 60, undefined],
    ['⑧ロスカット幅も読む',
      '指値買い65,600円（ロスカット幅60円）節目手前。', 60, undefined],
    ['⑨LC だけ(幅なし)も読む',
      '指値買い65,600円（LC60円）節目手前。', 60, undefined],
    ['⑩★候補が食い違う(LC幅55 と 損切幅60)→ 脚を立てない',
      '指値買い65,600円（LC幅55円 / 損切幅60円）', undefined, 'LC幅の候補が複数'],
    ['⑪★同じ値が2回なら曖昧ではない(採る)',
      '指値買い65,600円（LC幅60円・損切幅60円）', 60, undefined],
    ['⑫全角ラベル＋全角数字',
      '指値買い６５，６００円（ＬＣ幅６０円）節目手前。', 60, undefined],
    ['⑬★非整数は読まない(半開表記が整数前提だから)',
      '指値買い65,600円（LC幅62.5円）節目手前。', undefined, 'LC幅が整数ではない(62.5)'],
    ['⑭★159.5 も読まない(印字「可」・コード「不可」の穴を塞ぐ)',
      '指値買い65,600円（LC幅159.5円）節目手前。', undefined, 'LC幅が整数ではない(159.5)'],
    ['⑮ラベルが窓(20字)の外 → 採らない。★何が在ったかまで記録に残す',
      '指値買い65,600円 直近30分のレンジは狭く上値も重い地合いのためLC幅は60円とする。',
      undefined, 'LC幅が近傍(20字)に無い(窓外に 60円の記述)'],
    ['⑯「値幅」しか書いていない → 読まない(★これが旧実装で 80 を拾っていた形)',
      '指値買い65,600円 直近の値幅80円。', undefined, 'のLC幅を読めなかった'],
  ] as const;

  for (const [name, text, width, issue] of CASES) {
    it(`${name}`, () => {
      const r = READ(text);
      expect(r.iPrice, name).toBe(65600);
      expect(r.iLcWidth, name).toBe(width);
      if (issue === undefined) expect(r.readIssues?.i, name).toBeUndefined();
      else expect(r.readIssues?.i ?? '', name).toContain(issue);
    });
  }

  it('★★否定対照(直す前なら壊れる): 旧の照合(裸の `幅` を含む)は「値幅80」を拾ってしまう', () => {
    // ★直す前の WIDTH_RE を **この場で再現** して、同じ入力で違う答えになることを示す。
    const OLD_WIDTH_RE = /(?:LC幅|損切り幅|損切幅|ロスカット幅|幅|LC)\s*(?:は|[:：=])?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/;
    const line = '指値買い65,600円 直近の値幅80円を考慮しLC幅は60円とする。';
    const after = line.slice('指値買い65,600円'.length);
    expect(after.match(OLD_WIDTH_RE)?.[1]).toBe('80');          // ★旧: 誤って 80
    // 新: 明示ラベルだけなので 60
    expect(parseBFreeText(line, 'buy')!.iLcWidth).toBe(60);
    // ★旧は誤りが記録に残らなかった(帯の中なので下流も通る)。新は正しい値を読み、issue も出ない。
    expect(parseBFreeText(line, 'buy')!.readIssues?.i).toBeUndefined();
  });

  it('★誤読していた値で損切り価格が20円ずれていたことを、正しい値と並べて固定する', () => {
    const r = parseBFreeText('指値買い65,600円 直近の値幅80円を考慮しLC幅は60円とする。', 'buy')!;
    const { plan } = buildPlanFromBAnswer('buy', r, 65700);
    expect(plan.limitEntry).toBe(65600);
    expect(plan.stopLossForLimit).toBe(65540);   // ★60円幅。旧実装は 65520(80円幅)だった
  });
});

// ═══ ★★② 価格の「側」の検査(分割経路にも入れた) ═══════════════════════════
//
// ■ ★直す前の事実(エバリュエーターが実測): entryPositionOk(=entrySideOk)は parseScalpPlan の
//   中にしかなく、★分割経路は parseScalpPlan を通らない。enforcePlanConstraintsReport の本体にも
//   1回も出てこない。→ **買いの逆指値が現在値の下(=即約定)** のまま plan に入り、legDrops も空だった。
// ■ ★新しい判定は書かず、core/entryLabel.ts の entryPositionOk を呼ぶ。
//   落ちた脚は既存の理由の語 'geometry' で記録する(新しい語彙を作らない)。
describe('★★② 価格の側の検査: 現在値の逆側に置かれた脚は落ちて記録に残る', () => {
  const REF2 = 65700;

  it('★実例: 買いの逆指値が現在値の下 → 脚が落ち、legDrops に geometry で残る', () => {
    const a = parseBFreeText('逆指値買い65,600円（LC幅60円）上抜けを狙う', 'buy')!;
    expect(a.aPrice).toBe(65600);        // 読み取り自体は成功している(読めないのとは別)
    const built = buildPlanFromBAnswer('buy', a, REF2);
    expect(built.plan.stopEntry).toBeUndefined();   // ★即約定する注文は作られない
    // ★逆側で落ちた脚は 'geometry'。★もう片方(指値買い)は そもそも来ていないので 'missing'。
    expect(built.legDrops).toContainEqual({
      name: 'stop', reason: 'geometry', entry: 65600, lcWidth: 60,
      parseIssue: `逆指値買いが現在価格(${REF2})の逆側にある`,
    });
    expect(built.legDrops.map(d => `${d.name}:${d.reason}`)).toEqual(['stop:geometry', 'limit:missing']);
  });

  it('★★否定対照(直す前なら通る): 側の検査を外すと、その脚は plan に入ってしまう', () => {
    // ★直す前の実装 = 「価格と幅が揃っていれば立てる」だけ。それをこの場で再現して差を示す。
    const a = parseBFreeText('逆指値買い65,600円（LC幅60円）上抜けを狙う', 'buy')!;
    const oldWouldStand = a.aPrice !== undefined && a.aLcWidth !== undefined && a.aLcWidth > 0;
    expect(oldWouldStand).toBe(true);                       // ★旧: 立ってしまう
    expect(buildPlanFromBAnswer('buy', a, REF2).plan.stopEntry).toBeUndefined();  // ★新: 立たない
  });

  it('★4版8脚すべてで、逆側の価格は落ちる(表の側と一致しない価格を作れない)', () => {
    for (const v of ALL) {
      const spec = B_VARIANTS[v];
      // あ)=上の脚に「現在値より下」/ い)=下の脚に「現在値より上」を与える(必ず逆側)。
      const bad = { aPrice: REF2 - 100, aLcWidth: 60, iPrice: REF2 + 100, iLcWidth: 60 };
      const built = buildPlanFromBAnswer(v, bad, REF2);
      expect(built.plan.direction, v).toBe('none');
      expect(built.legDrops.map(d => d.reason), v).toEqual(['geometry', 'geometry']);
      expect(built.legDrops.map(d => d.name), v)
        .toEqual(spec.shape === 'range' ? ['upper', 'lower'] : [spec.legs.a.type, spec.legs.i.type]);
    }
  });

  it('★正しい側なら1本も落ちない(この検査が恒真でない)', () => {
    for (const v of ALL) {
      const good = { aPrice: REF2 + 100, aLcWidth: 60, iPrice: REF2 - 100, iLcWidth: 60 };
      const built = buildPlanFromBAnswer(v, good, REF2);
      expect(built.legDrops, v).toEqual([]);
      expect(built.bothDropped, v).toBe(false);
    }
  });

  it('★片脚だけ逆側なら、正しいほうは残る(片脚成立の性質を壊さない)', () => {
    const built = buildPlanFromBAnswer('buy', { aPrice: REF2 - 100, aLcWidth: 60, iPrice: REF2 - 50, iLcWidth: 55 }, REF2);
    expect(built.plan.direction).toBe('buy');
    expect(built.plan.stopEntry).toBeUndefined();       // 上の脚(逆指値買い)は逆側で落ちた
    expect(built.plan.limitEntry).toBe(REF2 - 50);      // 下の脚(指値買い)は正しい側なので残る
    expect(built.legDrops.map(d => d.reason)).toEqual(['geometry']);
  });

  it('★refPrice が有限でないときは側の検査をしない(既存の権威 entryPositionOk の性質そのまま)', () => {
    const built = buildPlanFromBAnswer('buy', { aPrice: 100, aLcWidth: 60 }, Number.NaN);
    expect(built.plan.stopEntry).toBe(100);
  });
});

// ═══ ★④ 細かいもの(c)(e)(g) ════════════════════════════════════════════════
describe('★④ 1行2脚 / 装飾記号 / 網羅検査', () => {
  it('(c) ★1行に2脚: 区切り記号の後ろの見出しも拾う(理由も混ざらない)', () => {
    const r = parseBFreeText('逆指値買い65,780円（LC幅60円）、指値買い65,600円（LC幅55円）', 'buy')!;
    expect(r.aPrice).toBe(65780);
    expect(r.aLcWidth).toBe(60);
    expect(r.iPrice).toBe(65600);
    expect(r.iLcWidth).toBe(55);
    expect(r.readIssues).toBeUndefined();
  });

  it('(c) ★文中の「指値」は見出しに化けない(区切り記号の直後だけを見出しにする)', () => {
    const r = parseBFreeText('逆指値買い65,780円（LC幅60円）節目を抜けたら追随する 指値買いは置かない', 'buy')!;
    expect(r.aPrice).toBe(65780);
    expect(r.iPrice).toBeUndefined();          // ★2本目は見出しにならない
    expect(r.aWhy).toContain('指値買いは置かない');
  });

  it('(e) ★装飾記号は理由に残らない(画面と台帳にそのまま出るため)', () => {
    const r = parseBFreeText('**（上）**逆指値買い65,780円（LC幅60円）** 節目抜け。**', 'buy')!;
    expect(r.aWhy).toBe('節目抜け。');
    const r2 = parseBFreeText('逆指値買い65,780円（LC幅60円）> ## __節目抜け。__', 'buy')!;
    expect(r2.aWhy).toBe('節目抜け。');
  });

  it('(g) ★pickBVariant は網羅を型で止める(未知の目線は投げる)', () => {
    expect(pickBVariant('buy', null)).toBe('buy');
    expect(pickBVariant('sell', null)).toBe('sell');
    expect(pickBVariant('range', 'squeeze')).toBe('range-breakout');
    // ★型を外した値を渡すと **黙って range-fade に落ちず** 投げる(以前は落ちていた)。
    expect(() => pickBVariant('bull' as unknown as TrendDirection, null)).toThrow(/未知の目線/);
  });
});

// ═══ ★★①(第2次) 窓を 40 → 20 に戻した(2026-08-25・エバリュエーターの反例) ═══════
//
// ■ ★私が拡大の根拠にした実例は、そもそも拡大を必要としていなかった(検算し直した):
//     `指値買い65,600円 直近の値幅80円を考慮しLC幅は60円とする。`
//   → 価格直後の残り `円 直近の値幅80円を考慮しLC幅は60円とする。` で `LC幅` は **index 14**。
//     ★14 <= 20 = 旧の窓に余裕で収まる。「前置きが入るから広げる」は誤りだった。
// ■ ★そして 40 でだけ **無言で誤読する形** が生まれた(下の否定対照)。
//   窓が広いほど「間違ったほうの候補**だけ**が単独で入る」確率が上がる
//   (候補が2つ揃えば食い違い検出で止まるが、1つだけ入ると止まらない)。
// ■ ★20 に戻したうえで **窓の外のラベルも数える** ようにした=採用はしないが、必ず記録に残す。
//   目的は「窓の最適化」ではなく **無言で採らないこと**。
describe('★★①(第2次) 採用は窓20だけ。窓外のラベルは採らずに記録する', () => {
  /** ★エバリュエーターの反例。窓40 では lc=55(意図は80)を無言採用していた。 */
  const COUNTER = '逆指値買い65,780円 直近高値65,775円の少し上に置く。LC幅55円が制度上の最小値なので、実際にはLC幅80円。';

  it('★窓の位置を算術で固定する(実例=14 / 反例=21 と 43)', () => {
    const idx = (line: string, headLen: number): number[] => {
      const after = line.slice(headLen);
      const priceEnd = after.match(/^(.{0,8}?)([0-9][0-9,]*(?:\.[0-9]+)?)/)![0].length;
      const rest = after.slice(priceEnd);
      const re = /(?:LC幅|損切り幅|損切幅|ロスカット幅|LC)\s*(?:は|[:：=])?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g;
      const out: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(rest)) !== null) out.push(m.index);
      return out;
    };
    // ★1周目の実例: 唯一のラベルが 14 = 窓20 の中(拡大は不要だった)
    expect(idx('指値買い65,600円 直近の値幅80円を考慮しLC幅は60円とする。', '指値買い'.length)).toEqual([14]);
    // ★反例: 21(値55) と 43(値80)。窓40 は 21 だけを拾ってしまう
    expect(idx(COUNTER, '逆指値買い'.length)).toEqual([21, 43]);
  });

  it('★★否定対照: 窓40 なら lc=55 を **無言で** 採っていた(その場で再現する)', () => {
    // ★直す前(2周目)の判定をこの場で再現: 「窓40以内の候補だけを見て、1つなら採る」。
    const after = COUNTER.slice('逆指値買い'.length);
    const priceEnd = after.match(/^(.{0,8}?)([0-9][0-9,]*(?:\.[0-9]+)?)/)![0].length;
    const rest = after.slice(priceEnd);
    const re = /(?:LC幅|損切り幅|損切幅|ロスカット幅|LC)\s*(?:は|[:：=])?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g;
    const within40: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) if (m.index <= 40) within40.push(Number(m[1]));
    expect(within40).toEqual([55]);          // ★窓40: 候補が1つだけ=食い違い検出も効かない → 無言採用

    // ★いま(窓20): どちらも窓外なので採らず、**何が在ったか** を記録に残す。
    const r = parseBFreeText(COUNTER, 'buy')!;
    expect(r.aLcWidth).toBeUndefined();
    expect(r.readIssues?.a).toBe('「逆指値買い」LC幅が近傍(20字)に無い(窓外に 55 / 80円の記述)');
    const built = buildPlanFromBAnswer('buy', r, 65700);
    expect(built.plan.stopEntry).toBeUndefined();            // ★脚は立たない
    expect(built.legDrops).toContainEqual({
      name: 'stop', reason: 'missing', entry: 65780,
      parseIssue: '「逆指値買い」LC幅が近傍(20字)に無い(窓外に 55 / 80円の記述)',
    });
  });

  it('★窓内と窓外が食い違うときも採らない(窓を狭めた副作用を埋める)', () => {
    const r = parseBFreeText('逆指値買い65,780円（LC幅55円）が下限だが、実際にはLC幅80円とする。', 'buy')!;
    expect(r.aLcWidth).toBeUndefined();
    expect(r.readIssues?.a).toBe('「逆指値買い」LC幅の候補が複数(55 / 80円)');
  });

  it('★窓内だけにあれば従来どおり読める(この検査が恒真でない)', () => {
    expect(parseBFreeText('逆指値買い65,780円（LC幅60円）節目抜け。', 'buy')!.aLcWidth).toBe(60);
    expect(parseBFreeText('指値買い65,600円 直近の値幅80円を考慮しLC幅は60円とする。', 'buy')!.iLcWidth).toBe(60);
  });

  it('★窓内に1つ・窓外に同じ値なら食い違いではない(無用な取りこぼしを作らない)', () => {
    const r = parseBFreeText('逆指値買い65,780円（LC幅60円）節目抜け。LC幅60円は直近スイングまで。', 'buy')!;
    expect(r.aLcWidth).toBe(60);
    expect(r.readIssues?.a).toBeUndefined();
  });
});

// ═══ ★形式の見本の書き写しを理由から落とす(2026-08-25 ユーザー指示) ═══════════
//
// ■ ボードに実際に出ていた形:
//     指値: その後に理由を日本語で自由表記 → 65,595の節目手前で拾う
//   の `その後に理由を日本語で自由表記 → ` は、B の system の形式行
//     形式は「指値買い○○円（LC幅○○円）その後に理由を日本語で自由表記）
//   をモデルが理由の頭に写しただけ。★中身は1ビットも無い。
// ■ ★消す場所は **読み取り1箇所**。ここで落とせば 画面・台帳(entry_why_for_*)・
//   AI へ返す履歴 の3つが同時にきれいになる(画面だけで消すと台帳に見本が残る)。
describe('★形式の見本の書き写しは理由に入らない', () => {
  it('★実際に出ていた形: 見本と矢印が落ち、本文だけが残る', () => {
    const r = parseBFreeText([
      '逆指値買い65,780円（LC幅60円）その後に理由を日本語で自由表記 → 65,775の節目を抜けたら追随。',
      '指値買い65,600円（LC幅55円）その後に理由を日本語で自由表記 → 65,595の節目手前で拾う。',
    ].join('\n'), 'buy')!;
    expect(r.aWhy).toBe('65,775の節目を抜けたら追随。');
    expect(r.iWhy).toBe('65,595の節目手前で拾う。');
    // ★価格と幅は当然そのまま(落としたのは見本だけ)。
    expect([r.aPrice, r.aLcWidth, r.iPrice, r.iLcWidth]).toEqual([65780, 60, 65600, 55]);
  });

  it('★書き方の揺れ(括弧つき/矢印なし/末尾)でも落ちる', () => {
    const why = (t: string): string | undefined => parseBFreeText(t, 'buy')!.aWhy;
    expect(why('逆指値買い65,780円（LC幅60円）（その後に理由を日本語で自由表記）節目抜け。')).toBe('節目抜け。');
    expect(why('逆指値買い65,780円（LC幅60円）理由を日本語で自由表記 ⇒ 節目抜け。')).toBe('節目抜け。');
    expect(why('逆指値買い65,780円（LC幅60円）節目抜け。その後に理由を日本語で自由表記')).toBe('節目抜け。');
  });

  it('★見本しか書かなかった回は理由が空になる(見本を理由として名乗らない)', () => {
    const r = parseBFreeText('逆指値買い65,780円（LC幅60円）その後に理由を日本語で自由表記', 'buy')!;
    expect(r.aWhy).toBeUndefined();
    expect(r.aPrice).toBe(65780);     // ★脚は成立する(欠けているのは理由だけ)
  });

  it('★★理由の本文には触らない(この除去が広すぎないことの否定対照)', () => {
    const why = (t: string): string | undefined => parseBFreeText(t, 'buy')!.aWhy;
    expect(why('逆指値買い65,780円（LC幅60円）理由は節目抜け。日本語で書く。'))
      .toBe('理由は節目抜け。日本語で書く。');
    expect(why('逆指値買い65,780円（LC幅60円）自由表記のレンジ上限を抜けたら追随。'))
      .toBe('自由表記のレンジ上限を抜けたら追随。');
  });
});

// ═══ ★2026-08-25(ユーザー指示): 目線の5ルート ═══════════════════════════════
//
// ■ ユーザー確定の5ルート
//   ①AI委任 + レンジON  → A(3択: buy/sell/range) + B
//   ②AI委任 + レンジOFF → A(2択: buy/sell)       + B
//   ③手動 + 買い目線     → **B(buy) のみ**（A を呼ばない）
//   ④手動 + 売り目線     → **B(sell) のみ**
//   ⑤手動 + レンジ目線   → **B(range-*) のみ**。★「目線がAI委任の場合、レンジを許可」に **依存しない**
//
// ■ ★私が一度作った穴(ユーザー訂正で判明)
//   ⑤を①に依存させたため、①OFF のとき手動レンジが **常に見送り** になっていた。
//   ①は「**AI に** range という選択肢を見せるか」の設定で、手動では A を呼ばないので無関係。
//   ★依存させていた箇所は4つ(forcedTrendFrom / UI / rangeDisabled の門 / enforceRangeEnabled)。
describe('★目線の5ルート(forcedTrendFrom と B の版)', () => {
  const V = (mode: 'manual' | 'ai', bias: 'long' | 'short' | 'range' | 'none') =>
    forcedTrendFrom(mode, bias);

  it('①② AI委任は目線を固定しない(=A を呼ぶ)', () => {
    expect(V('ai', 'none')).toBeNull();
    // ★AI委任なら保存値が何であっても固定しない(委任の意味を保つ)。
    for (const b of ['long', 'short', 'range'] as const) expect(V('ai', b)).toBeNull();
  });

  it('③④⑤ 手動は目線を固定する(A の答えの語彙で返す)', () => {
    expect(V('manual', 'long')).toBe('buy');
    expect(V('manual', 'short')).toBe('sell');
    expect(V('manual', 'range')).toBe('range');
  });

  it('★★⑤ 手動レンジは「レンジを許可」に依存しない(引数に持たない=依存しようがない)', () => {
    // ★引数が2つだけ=レンジ設定を受け取る口が無い(構造で保証する)。
    expect(forcedTrendFrom.length).toBe(2);
    expect(V('manual', 'range')).toBe('range');
  });

  it('★レガシーの none(両方向)は目線を固定しない(手動でも A を呼ぶ)', () => {
    expect(V('manual', 'none')).toBeNull();
  });

  it('★固定した目線がそのまま B の版になる(コードが選ぶ・AI は選ばない)', () => {
    expect(pickBVariant(V('manual', 'long')!, null)).toBe('buy');
    expect(pickBVariant(V('manual', 'short')!, null)).toBe('sell');
    expect(pickBVariant(V('manual', 'range')!, null)).toBe('range-fade');
    expect(pickBVariant(V('manual', 'range')!, 'squeeze')).toBe('range-breakout');
  });
});

// ─── ★v0.9.103(RECORD-ONLY): 分割経路でも LC申告の突き合わせを採る ────────────────────
//
// ★なぜ足したか(実測): 複製 signal_plans 3,008行のうち app_version が v0.9.96〜v0.9.102 の行は
//   lc_audit_json が **全行 NULL** だった(v0.9.92 は 124/145 が非NULL)。原因は
//   buildPlanFromBAnswer が lcAudit を一度も設定していなかったこと=分割ONの回は必ず欠測していた。
// ★ここで固定するのは **配線** と **direction を渡していること** だけ。
//   突き合わせの規約(server/llm/rationaleLc.ts)は1バイトも変えていない。
describe('★v0.9.103 分割経路の lcAudit(RECORD-ONLY)', () => {
  it('★申告どおりなら match(status の3値は旧経路と同じ意味)', () => {
    const r = buildPlanFromBAnswer('buy',
      { aPrice: 38400, aLcWidth: 80, iPrice: 38100, iLcWidth: 70 }, REF,
      '逆指値買い: LC幅は80円 / 指値買い: LC幅は70円');
    expect(r.lcAudit?.map(x => [x.leg, x.entry, x.stopLoss, x.actualYen, x.declaredYen, x.status]))
      .toEqual([
        ['stop', 38400, 38320, 80, 80, 'match'],
        ['limit', 38100, 38030, 70, 70, 'match'],
      ]);
  });

  it('★申告と実出力が食い違えば mismatch(落としも直しもしない=採否は不変)', () => {
    const r = buildPlanFromBAnswer('buy',
      { aPrice: 38400, aLcWidth: 5, iPrice: 38100, iLcWidth: 70 }, REF,
      '逆指値買い: LC幅は80円 / 指値買い: LC幅は70円');
    expect(r.lcAudit?.find(x => x.leg === 'stop')).toMatchObject(
      { actualYen: 5, declaredYen: 80, status: 'mismatch' });
    // ★RECORD-ONLY: 食い違っても脚は立ったまま(価格も損切りも AI の値のまま)。
    expect(r.plan.stopEntry).toBe(38400);
    expect(r.plan.stopLossForStop).toBe(38395);
    expect(r.legDrops).toEqual([]);
  });

  it('★★向き(declaredSide)が取れる = direction を渡している(渡さないと sideUnknownDirection)', () => {
    const ok = buildPlanFromBAnswer('buy',
      { aPrice: 38400, aLcWidth: 80 }, REF,
      '逆指値買い: 38400と38320の引き算 → LC幅は80円');
    expect(ok.lcAudit?.[0]).toMatchObject({ leg: 'stop', declaredSide: 'sideOk' });
    // ★買いなのに損切りを建値の **上** と書いた回(根拠文だけが逆・実出力は正しい側)。
    const rev = buildPlanFromBAnswer('buy',
      { aPrice: 38400, aLcWidth: 80 }, REF,
      '逆指値買い: 38400と38480の引き算 → LC幅は80円');
    expect(rev.lcAudit?.[0]).toMatchObject({ leg: 'stop', declaredSide: 'sideReversed' });
    expect(rev.plan.stopLossForStop).toBe(38320);   // ★実出力は従来どおり正しい側(記録だけ)
  });

  it('★落ちた脚も測る(故障は落ちた脚に残る=採用脚だけ見ると存在しないことになる)', () => {
    // ★買いの逆指値を現在値の **下** に置いた回 = 側の違反で落ちる('geometry')。
    const r = buildPlanFromBAnswer('buy',
      { aPrice: REF - 150, aLcWidth: 80, iPrice: REF - 150, iLcWidth: 70 }, REF,
      '逆指値買い: LC幅は80円 / 指値買い: LC幅は70円');
    expect(r.legDrops.map(d => [d.name, d.reason])).toEqual([['stop', 'geometry']]);
    expect(r.lcAudit?.map(x => x.leg)).toEqual(['stop', 'limit']);   // ★落ちた脚も行が在る
  });

  it('★1件も突き合わせられなければ undefined(空配列は載せない)', () => {
    expect(buildPlanFromBAnswer('buy', {}, REF, '価格は置けません').lcAudit).toBeUndefined();
  });

  it('★レンジ2版は upper/lower の語彙で残る(旧経路の脚名と同じ)', () => {
    const r = buildPlanFromBAnswer('range-fade',
      { aPrice: 38400, aLcWidth: 80, iPrice: 38100, iLcWidth: 70 }, REF, '');
    expect(r.lcAudit?.map(x => [x.leg, x.entry, x.stopLoss])).toEqual([
      ['upper', 38400, 38480],   // ★上部=売り → 損切りは上
      ['lower', 38100, 38030],   // ★下部=買い → 損切りは下
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ★2026-08-30(追記): TP(利確幅)を尋ねる版 / 尋ねない版。
//
//   ■ この検査が守るもの
//     ① ★askTp=false のとき、プロンプトも読み取りも **TP 導入前と1バイト同じ**
//        (設定が手動/TP無効のあいだ、AI への質問も台帳も1文字も動かない)
//     ② TP幅は **幅** として読む(価格ではない)。★候補が複数なら採らない(LC と同じ判断)
//     ③ ★TP を読めなくても **脚は落ちない**(TP は無くても計画は成立する)
//     ④ ★TP の記述が理由文へ漏れない(画面・台帳・AI へ返す履歴が機械の文字列で汚れない)
//     ⑤ ★LC の読み取りに影響しない(ラベル集合が交わらない)
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('★TP幅(利確幅)を尋ねる版', () => {
  const REF3 = 65_700;
  const LINE = '逆指値買い65,780円（LC幅60円・TP幅120円）直近高値の上抜けに追随する。';

  it('★① askTp=false は TP 導入前と同じ = TP を1つも読まない(理由に文字列が残る)', () => {
    const r = parseBFreeText(LINE, 'buy', false)!;
    expect(r.aLcWidth).toBe(60);
    expect(r.aTpWidth).toBeUndefined();
    expect(r.aWhy).toContain('TP幅120円');       // ★読まない=消さない(従来の挙動そのもの)
    expect(r.readIssues?.aTp).toBeUndefined();
    // ★引数を省略したときも同じ(既定=尋ねていない)。
    expect(JSON.stringify(parseBFreeText(LINE, 'buy'))).toBe(JSON.stringify(r));
  });

  it('★② askTp=true なら幅として読み、理由からは消える(④)', () => {
    const r = parseBFreeText(LINE, 'buy', true)!;
    expect(r.aLcWidth).toBe(60);
    expect(r.aTpWidth).toBe(120);
    expect(r.aWhy).toBe('直近高値の上抜けに追随する。');
    expect(r.readIssues?.aTp).toBeUndefined();
  });

  it('★TP が LC より前に書かれても、どちらも取り違えずに読む(⑤)', () => {
    const r = parseBFreeText('逆指値買い65,780円（TP幅120円・LC幅60円）節目抜け。', 'buy', true)!;
    expect(r.aLcWidth).toBe(60);
    expect(r.aTpWidth).toBe(120);
  });

  it('★別のラベル(利確幅 / 利食い幅 / TP)でも読む', () => {
    for (const [label, want] of [['利確幅', 120], ['利食い幅', 90], ['TP', 80]] as const) {
      const r = parseBFreeText(`逆指値買い65,780円（LC幅60円・${label}${want}円）節目抜け。`, 'buy', true)!;
      expect(r.aTpWidth).toBe(want);
      expect(r.aLcWidth).toBe(60);
    }
  });

  it('★★候補が複数なら採らない(LC の食い違い検出と同じ判断)・★脚は落ちない(③)', () => {
    const r = parseBFreeText(
      '逆指値買い65,780円（LC幅60円・TP幅120円）ただし伸びれば利確幅200円まで引っ張る。', 'buy', true)!;
    expect(r.aTpWidth).toBeUndefined();
    expect(r.readIssues?.aTp).toContain('TP幅の候補が複数');
    expect(r.readIssues?.a).toBeUndefined();               // ★脚を落とす理由には **ならない**
    const built = buildPlanFromBAnswer('buy', r, REF3);
    expect(built.plan.stopEntry).toBe(65_780);             // ★脚は立っている
    expect(built.plan.tpWidthForStop).toBeUndefined();     // ★TP だけが入らない
    // ★落ちたのは「行そのものが無い」もう一方の脚だけ。TP の曖昧さで落ちた脚は1本も無い。
    expect(built.legDrops.map(d => d.name)).toEqual(['limit']);
    expect(built.legDrops.some(d => (d.parseIssue ?? '').includes('TP'))).toBe(false);
  });

  it('★非整数の TP幅は採らない(LC と同じ規約)', () => {
    const r = parseBFreeText('逆指値買い65,780円（LC幅60円・TP幅120.5円）節目抜け。', 'buy', true)!;
    expect(r.aTpWidth).toBeUndefined();
    expect(r.readIssues?.aTp).toContain('TP幅が整数ではない');
    expect(r.aLcWidth).toBe(60);                            // ★LC は無傷(⑤)
  });

  it('★TP を書かなかった回は「読めなかった」と記録するが、脚は立つ(③)', () => {
    const r = parseBFreeText('逆指値買い65,780円（LC幅60円）節目抜け。', 'buy', true)!;
    expect(r.aTpWidth).toBeUndefined();
    expect(r.readIssues?.aTp).toContain('TP幅を読めなかった');
    expect(buildPlanFromBAnswer('buy', r, REF3).plan.stopEntry).toBe(65_780);
  });

  it('★「置けない」と述べた脚は TP幅も捨てる(価格の無い脚に幅だけ残さない)', () => {
    const r = parseBFreeText('指値買いは置きません（TP幅120円）押し目が来ないため。', 'buy', true)!;
    expect(r.iPrice).toBeUndefined();
    expect(r.iTpWidth).toBeUndefined();
    expect(r.readIssues?.i).toContain('「置けない」と述べている');
  });

  it('★両脚の TP幅がそれぞれの箱へ入る(表が決める=あ/い のどちらが指値かは版ごとに逆)', () => {
    const buy = parseBFreeText([
      '逆指値買い65,780円（LC幅60円・TP幅120円）上抜け。',
      '指値買い65,600円（LC幅55円・TP幅90円）押し目。',
    ].join('\n'), 'buy', true)!;
    const pb = buildPlanFromBAnswer('buy', buy, REF3).plan;
    expect([pb.tpWidthForStop, pb.tpWidthForLimit]).toEqual([120, 90]);
    const sell = parseBFreeText([
      '指値売り65,780円（LC幅60円・TP幅120円）戻り売り。',
      '逆指値売り65,600円（LC幅55円・TP幅90円）下抜け。',
    ].join('\n'), 'sell', true)!;
    const ps = buildPlanFromBAnswer('sell', sell, REF3).plan;
    // ★sell 版は あ)=指値・い)=逆指値。箱の対応が版で入れ替わる。
    expect([ps.tpWidthForLimit, ps.tpWidthForStop]).toEqual([120, 90]);
  });

  it('★TP幅は **幅** のまま入る(価格に変換しない=逆位置の TP が構造的に作れない)', () => {
    const r = parseBFreeText('逆指値買い65,780円（LC幅60円・TP幅120円）上抜け。', 'buy', true)!;
    const plan = buildPlanFromBAnswer('buy', r, REF3).plan;
    expect(plan.tpWidthForStop).toBe(120);
    expect(plan.tpWidthForStop).toBeLessThan(1000);   // ★価格(65,900)ではない
  });

  it('★プロンプト: askTp=false は TP の語を1文字も含まない / true では両脚の形式行に出る', () => {
    for (const v of ALL) {
      const off = buildBSystemPrompt(v, FLOOR, CEIL, 'D', false) + buildBUserPrompt(v, REF, FLOOR, CEIL, false);
      expect(off).not.toContain('TP');
      expect(off).not.toContain('利確');
      const on = buildBSystemPrompt(v, FLOOR, CEIL, 'D', true) + buildBUserPrompt(v, REF, FLOOR, CEIL, true);
      // ★形式行(2本)・（上）（下）の問い(2本)・制約の定義(1本)・user の見送り行(1本)
      // ★ただしレンジ2版は尋ねないので 0本(裁定1)。
      expect(on.match(/TP幅/g)?.length ?? 0).toBe(tpAskable(v) ? 6 : 0);
    }
  });

  // ★★裁定1(2026-08-30): レンジ2版には TP を尋ねない。
  //   理由: TP幅の名前(tpWidthForLimit / tpWidthForStop)は注文タイプでレッグを名指すが、
  //   レンジの脚は upper / lower で range-fade は両方 limitヺerange-breakout は両方 stop。
  //   ★この2名では置き場所が決められない → **尋ねて捨てるのが最悪の形**なので問いごと出さない。
  it('★★レンジ2版は askTp=true でもプロンプトが TP 導入前と1バイト同一', () => {
    for (const v of ['range-fade', 'range-breakout'] as const) {
      expect(tpAskable(v)).toBe(false);
      expect(buildBSystemPrompt(v, FLOOR, CEIL, 'D', true)).toBe(buildBSystemPrompt(v, FLOOR, CEIL, 'D', false));
      expect(buildBUserPrompt(v, REF, FLOOR, CEIL, true)).toBe(buildBUserPrompt(v, REF, FLOOR, CEIL, false));
      expect(effectiveAskTp(v, true)).toBe(false);
    }
    // ★恒真でない対照: directional 2版では askTp=true が必ず文面を変える。
    for (const v of ['buy', 'sell'] as const) {
      expect(tpAskable(v)).toBe(true);
      expect(buildBSystemPrompt(v, FLOOR, CEIL, 'D', true)).not.toBe(buildBSystemPrompt(v, FLOOR, CEIL, 'D', false));
      expect(effectiveAskTp(v, true)).toBe(true);
    }
  });

  it('★★レンジ2版は askTp=true を渡しても TP幅を読まない(尋ねていない数値を台帳に載せない)', () => {
    const txt = ['指値売り65,780円（LC幅60円ヺTP幅120円）戻り売り。',
      '指値買ざ65,600円（LC幅55円ヺTP内90円）押し目。'].join('\n');
    const r = parseBFreeText(txt, 'range-fade', true)!;
    expect(r.aTpWidth).toBeUndefined();
    expect(r.iTpWidth).toBeUndefined();
    expect(r.readIssues?.aTp).toBeUndefined();
    // ★恒真でない対照: 同じ文を directional 版で読めば TP は読める。
    expect(parseBFreeText(
      '指値売り65,780円（LC幅60円ヺTP幅120円）戻り売り。', 'sell', true)!.aTpWidth).toBe(120);
  });

  it('★★プロンプトに TP の **数値** を1つも印字しない(印字した数値はそのまま選ばれるため)', () => {
    const on = buildBSystemPrompt('buy', 55, 65, 'D', true) + buildBUserPrompt('buy', 65_700, 55, 65, true);
    // TP の行に現れてよい数字は無い。★「TP幅○○円」の ○○ は伏せたまま。
    for (const l of on.split('\n')) {
      if (!l.includes('TP')) continue;
      expect(l).not.toMatch(/TP幅[^。\n]{0,6}[0-9]/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ★★2026-08-30(追記): **散文形** の回帰。★実データの書き方でテストする。
//
//   ■ ★なぜ要るか(エバリュエーター実測)
//     AI は指定の括弧形「（LC幅60円）」に **2.6% しか従っていない**。v0.9.102 の実根拠文では
//     45.4%(281/619本)が「…に逆指値買いを設定します。また、損切幅は60円とします。」という
//     **散文形** で、この形だと TP は **文の最後** に来る。
//     ★窓が無いと、そこまで理由文の開始位置を進めてしまい **理由が 226字 → 28字 に消えた**。
//     ★台帳・パネル・**AI へ返す履歴** が同時に壊れる=この案件の「④理由が0字」を作り直す。
//   ■ ★私が最初に書いた TP のテスト14本は **全部 括弧形** だったので、この欠陥を1本も検出しなかった。
//     ★だから「実データに出ている書き方」でのテストをここに足す。
//   ■ 下の文面は **v0.9.102 の実データそのままの書き方**(発明ではない)。
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('★★散文形(実データの 97.4%)で、TP を尋ねても理由文が消えない', () => {
  const REF4 = 66_015;
  /** ★実データの書き方: 価格の直後は理由の本文で、幅の申告は **文の最後** に来る。 */
  const PROSE_TP = '逆指値買い66,070円 現在価格66015円から上昇の可能性が高いと考えられるため、'
    + 'フィボナッチの61.8%ラインである66,070円に逆指値買いを設定します。'
    + 'また、損切幅は60円とし、TP幅は120円とします。';
  const PROSE_NO_TP = '逆指値買い66,070円 現在価格66015円から上昇の可能性が高いと考えられるため、'
    + 'フィボナッチの61.8%ラインである66,070円に逆指値買いを設定します。'
    + 'また、損切幅は60円とします。';

  it('★★理由文が保たれる(修正前は「とします。」だけになっていた)', () => {
    const why = parseBFreeText(PROSE_TP, 'buy', true)!.aWhy!;
    expect(why.length).toBeGreaterThan(50);
    expect(why).toContain('フィボナッチの61.8%ライン');
    expect(why).toContain('現在価格66015円から上昇の可能性');
    expect(why.startsWith('とします')).toBe(false);   // ★修正前の壊れ方そのもの
  });

  it('★askTp=true でも、理由文は askTp=false と **同じ長さ以上**(切り捨てが起きない)', () => {
    const off = parseBFreeText(PROSE_TP, 'buy', false)!.aWhy!;
    const on = parseBFreeText(PROSE_TP, 'buy', true)!.aWhy!;
    expect(on.length).toBeGreaterThanOrEqual(off.length);
    expect(on).toBe(off);   // ★窓の外の TP は理由文を1文字も切らない
  });

  it('★理由文を保ったまま、TP幅は読める(値を捨てていない)', () => {
    expect(parseBFreeText(PROSE_TP, 'buy', true)!.aTpWidth).toBe(120);
  });

  it('★TP を書かない散文形は、askTp の有無で理由文が1バイトも変わらない', () => {
    const off = parseBFreeText(PROSE_NO_TP, 'buy', false)!;
    const on = parseBFreeText(PROSE_NO_TP, 'buy', true)!;
    expect(on.aWhy).toBe(off.aWhy);
    expect(on.aTpWidth).toBeUndefined();
  });

  it('★括弧形(プロンプトが要求した形)では従来どおり: エコーが消えて理由がきれいになる', () => {
    const B = '逆指値買い66,070円（LC幅60円・TP幅120円）フィボナッチの61.8%ラインを上抜けたら追随する。';
    const off = parseBFreeText(B, 'buy', false)!;
    const on = parseBFreeText(B, 'buy', true)!;
    expect(on.aTpWidth).toBe(120);
    expect(on.aWhy).toBe('フィボナッチの61.8%ラインを上抜けたら追随する。');
    expect(off.aWhy).toContain('TP幅120円');           // ★尋ねない側にはエコーが残る(従来どおり)
    expect(on.aWhy!.length).toBeLessThan(off.aWhy!.length);
  });

  // ★窓が効いていることの直接の証拠(恒真でない): 同じ TP の記述を、窓の内と外に置き分ける。
  it('★★窓の内側の TP は理由文を切り、外側の TP は切らない(窓が効いている)', () => {
    const inside = '逆指値買い66,070円（LC幅60円・TP幅120円）上抜けを狙う。';
    const outside = '逆指値買い66,070円（LC幅60円）上抜けを狙う。'
      + '相場が伸びれば利を伸ばしたいので、TP幅は120円とする。';
    const rIn = parseBFreeText(inside, 'buy', true)!;
    const rOut = parseBFreeText(outside, 'buy', true)!;
    expect(rIn.aTpWidth).toBe(120);
    expect(rOut.aTpWidth).toBe(120);                    // ★どちらも値は読める
    expect(rIn.aWhy).toBe('上抜けを狙う。');            // ★窓の内=エコーを切る
    expect(rOut.aWhy).toContain('上抜けを狙う。');      // ★窓の外=AI の文章を切らない
    expect(rOut.aWhy).toContain('利を伸ばしたい');
  });
});
