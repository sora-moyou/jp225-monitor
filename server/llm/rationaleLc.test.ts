// 根拠文の「申告 LC幅」と実出力の突き合わせ(記録専用)の単体テスト。
//
// ■ 何を守っているか(実測 2026-08-07)
//   AI は根拠文に正しい幅(55円)を書きながら、損切りには建値の隣(+5円)を入れることがある。
//   その食い違いは **落ちたレッグ側にしか残らない**(実台帳: 落ちたレッグ 41.7% / 採用レッグ 2.0%)。
//   だから抽出が壊れると「故障が消えた」ように見えてしまう。ここで守るのは主に3点:
//     ① 2つの書式(「LC=55円」と「65540 + 55 = 65595」)の両方が読めること
//     ② 「一致(match)」と「読み取れなかった(undeclared)」を **決して混ぜない** こと
//     ③ 「LC=65400」のような **価格** の書き方から先頭3桁(654)を幅として拾わないこと(偽陽性の主犯)
//
// ■ ★否定対照(この実装前のコード)
//   git show HEAD:server/llm/scalpPlan.ts には申告幅を読む処理が存在しない(rationale は文字列として
//   表示・台帳へ写されるだけ)。よって ./rationaleLc.js の import 自体が解決できず、このファイルは全部赤になる。

import { describe, it, expect } from 'vitest';
import { parseLcDeclarations, declaredWidthFor, auditLcDeclarations } from './rationaleLc.js';
// ★プロンプト側の書式 SSOT。テストは「合成した文字列」ではなく **プロンプトが使う生成関数** を呼ぶ。
import { lcWidthDeclarationExample, lcFloorRule, scalpJsonInstruction } from './scalpPlan.js';

describe('書式①(幅の申告): 「LC=55円」形', () => {
  it('レッグ見出しごとに申告幅を割り当てる', () => {
    const d = parseLcDeclarations('指値レッグ LC=55円 / ブレイク新規レッグ LC=95円');
    expect(d.limit).toEqual([55]);
    expect(d.stop).toEqual([95]);
    expect(d.unassigned).toEqual([]);
  });

  // ★v0.9.70: 損切りの契約が「価格(stopLossFor…)」→「幅(lcWidthFor…)」に変わった。新しい名前で
  //   書かれた根拠文でも申告幅が同じレッグへ割り当たること(足し忘れると無言で undeclared に落ちる)。
  it('★新しいフィールド名で幅を申告する形(lcWidthForLimit は 55円)も読む', () => {
    const d = parseLcDeclarations('lcWidthForLimit は 55円 / lcWidthForStop は 95円');
    expect(d.limit).toEqual([55]);
    expect(d.stop).toEqual([95]);
    expect(d.unassigned).toEqual([]);
  });

  it('range 脚の lcWidth 申告(lcWidth: 60)も幅として読む', () => {
    expect(parseLcDeclarations('上部の lcWidth: 60').unassigned).toEqual([60]);
  });

  it('「逆指値」の中の「指値」を拾わない(長い語から照合する)', () => {
    const d = parseLcDeclarations('逆指値レッグは LC=95円 とした');
    expect(d.stop).toEqual([95]);
    expect(d.limit).toEqual([]);
  });

  it('「LC幅(55)」「LC幅は55円」「損切り幅は55円」も同じ申告として読む', () => {
    expect(parseLcDeclarations('指値 LC幅(55)').limit).toEqual([55]);
    expect(parseLcDeclarations('指値 LC幅は55円').limit).toEqual([55]);
    expect(parseLcDeclarations('指値 損切り幅は55円').limit).toEqual([55]);
  });

  it('★偽陽性ガード: 「LC=65400」(幅でなく価格)から 654 を拾わない', () => {
    const d = parseLcDeclarations('指値レッグ LC=65400');
    expect(d.limit).toEqual([]);
    expect(d.unassigned).toEqual([]);
  });

  // ─── ★2026-08-17 に塞いだ2つの穴(ユーザー判断で着手) ───
  it('★穴①: 幅を括弧で囲んだ「LC幅は(55)円」も読む(従来は undeclared に落ちていた)', () => {
    expect(parseLcDeclarations('指値レッグ LC幅は(55)円').limit).toEqual([55]);
    expect(parseLcDeclarations('指値レッグ (68870)と(68625)の引き算 → LC幅は(55)円。').limit).toEqual([55]);
    // 助詞なしの従来形は今までどおり(回帰なし)。
    expect(parseLcDeclarations('指値 LC幅(55)').limit).toEqual([55]);
  });

  it('★穴①の偽陽性ガードは括弧の中でも生きている: 「LC幅は(65400)円」から 654 を拾わない', () => {
    const d = parseLcDeclarations('指値レッグ LC幅は(65400)円');
    expect(d.limit).toEqual([]);
    expect(d.unassigned).toEqual([]);
  });

  it('★穴②: 全角「ＬＣ＝５５円」/「ＬＣ幅は６０円」も読む', () => {
    expect(parseLcDeclarations('指値レッグ ＬＣ＝５５円').limit).toEqual([55]);
    expect(parseLcDeclarations('ブレイク新規レッグ ＬＣ幅は６０円').stop).toEqual([60]);
  });

  it('★全角でも偽陽性ガードは効く(「ＬＣ＝６５４００」から 654 を拾わない)', () => {
    expect(parseLcDeclarations('指値レッグ ＬＣ＝６５４００').limit).toEqual([]);
  });

  it('★全角を半角へ写しても見出しの割り当てはずれない(写しは長さ不変)', () => {
    // 全角が見出しより前に在っても、その後ろの申告は正しいレッグへ付く。
    const d = parseLcDeclarations('ＬＣ＝１０円 を基準に、指値レッグ LC=55円、ブレイク新規レッグ LC=95円。');
    expect(d.unassigned).toEqual([10]);
    expect(d.limit).toEqual([55]);
    expect(d.stop).toEqual([95]);
  });

  it('「LC幅55円」(助詞なし・括弧なし)は従来どおり読まない=件数を動かさない', () => {
    expect(parseLcDeclarations('指値レッグ LC幅55円').limit).toEqual([]);
  });

  it('見出しより前に出た申告はどのレッグにも割り当てない(unassigned)', () => {
    const d = parseLcDeclarations('LC=55円 を基本として、指値レッグを置く');
    expect(d.unassigned).toEqual([55]);
    expect(d.limit).toEqual([]);
  });
});

describe('書式②(代入の式): 「65540 + 55 = 65595」形', () => {
  it('左辺・幅・右辺を読み、AI 自身の算術が閉じているかも見る', () => {
    const d = parseLcDeclarations('ブレイク新規レッグ 65540 + 55 = 65595');
    expect(d.equations).toEqual([
      { a: 65540, op: '+', w: 55, b: 65595, selfConsistent: true, leg: 'stop' },
    ]);
  });

  it('「65015+LC幅(55)=65070」形も読む', () => {
    const d = parseLcDeclarations('指値レッグ 65015+LC幅(55)=65070');
    expect(d.equations[0]).toMatchObject({ a: 65015, op: '+', w: 55, b: 65070, leg: 'limit' });
  });

  it('AI の算術が合っていない式は selfConsistent=false で残す(捨てない)', () => {
    const d = parseLcDeclarations('指値レッグ 65015 − 55 ＝ 64900');
    expect(d.equations[0]).toMatchObject({ op: '-', w: 55, b: 64900, selfConsistent: false });
  });

  it('式しか無いレッグは式の幅を代表値にする(source=equation)', () => {
    const d = parseLcDeclarations('ブレイク新規レッグ 65540 + 55 = 65595');
    expect(declaredWidthFor(d, 'stop')).toEqual({ yen: 55, source: 'equation' });
    expect(declaredWidthFor(d, 'limit')).toBeNull();
  });
});

describe('突き合わせ(auditLcDeclarations)', () => {
  it('★実データの故障そのもの: 申告55円・実際5円 → mismatch(値も両方残す)', () => {
    // 実台帳 [08-07 05:56] 売り: 「ブレイク新規は65540に設定し、損切りは65545(LC幅=5円)」
    const rows = auditLcDeclarations(
      '売り。指値レッグ LC=55円。ブレイク新規レッグ LC=55円 で65540に設定した。',
      [{ leg: 'stop', entry: 65540, stopLoss: 65545 }],
    );
    expect(rows).toEqual([{
      leg: 'stop', entry: 65540, stopLoss: 65545,
      actualYen: 5, declaredYen: 55, status: 'mismatch', source: 'width',
    }]);
  });

  it('申告どおりに代入できていれば match', () => {
    const rows = auditLcDeclarations('ブレイク新規レッグ LC=55円', [{ leg: 'stop', entry: 65540, stopLoss: 65595 }]);
    expect(rows[0]).toMatchObject({ declaredYen: 55, actualYen: 55, status: 'match' });
  });

  it('★「未申告」と「一致」を混ぜない: 申告が無いレッグは undeclared / declaredYen=null', () => {
    const rows = auditLcDeclarations('サポートの外側に損切りを置いた。', [{ leg: 'stop', entry: 65540, stopLoss: 65595 }]);
    expect(rows[0]).toEqual({ leg: 'stop', entry: 65540, stopLoss: 65595, actualYen: 55, declaredYen: null, status: 'undeclared' });
    expect(rows[0]!.status).not.toBe('match');
  });

  it('2レッグを別々に突き合わせる(片方 match・片方 mismatch)', () => {
    const rows = auditLcDeclarations(
      '指値レッグ LC=55円、ブレイク新規レッグ LC=95円。',
      [{ leg: 'limit', entry: 65600, stopLoss: 65545 }, { leg: 'stop', entry: 65540, stopLoss: 65545 }],
    );
    expect(rows.map(r => [r.leg, r.declaredYen, r.actualYen, r.status])).toEqual([
      ['limit', 55, 55, 'match'],
      ['stop', 95, 5, 'mismatch'],
    ]);
  });

  it('式の右辺(申告した損切り価格)も残す=実出力と直接比べられる', () => {
    const rows = auditLcDeclarations('ブレイク新規レッグ 65540 + 55 = 65595', [{ leg: 'stop', entry: 65540, stopLoss: 65545 }]);
    expect(rows[0]).toMatchObject({ declaredYen: 55, declaredStopLoss: 65595, equationSelfConsistent: true, status: 'mismatch' });
  });

  it('価格が揃っていないレッグ(AI が出していない)は行を作らない', () => {
    expect(auditLcDeclarations('指値レッグ LC=55円', [{ leg: 'stop', entry: null, stopLoss: null }])).toEqual([]);
  });

  it('根拠文が空/未定義でも例外を投げず、全レッグ undeclared になる', () => {
    expect(auditLcDeclarations(null, [{ leg: 'limit', entry: 100, stopLoss: 55 }])[0]).toMatchObject({ status: 'undeclared' });
    expect(auditLcDeclarations(undefined, [{ leg: 'limit', entry: 100, stopLoss: 55 }])[0]!.declaredYen).toBeNull();
  });

  it('★病的な入力でも例外を投げず現実的な時間で返る(記録が取引の判断を止めない前提)', () => {
    const junk = '指値レッグ ' + '65540 + 55 = '.repeat(20000) + 'LC=' + '9'.repeat(50000);
    const t0 = Date.now();
    const rows = auditLcDeclarations(junk, [{ leg: 'limit', entry: 65540, stopLoss: 65595 }]);
    expect(rows).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('レンジ脚(upper/lower)は見出しで区別できない: 申告が文中に1つだけなら使い、曖昧なら undeclared', () => {
    const sole = auditLcDeclarations('両面に置く。LC=60円 を各脚に適用。', [{ leg: 'upper', entry: 65600, stopLoss: 65660 }]);
    expect(sole[0]).toMatchObject({ declaredYen: 60, status: 'match', source: 'sole' });
    const ambiguous = auditLcDeclarations('指値レッグ LC=55円、ブレイク新規レッグ LC=95円。', [{ leg: 'lower', entry: 65600, stopLoss: 65545 }]);
    expect(ambiguous[0]).toMatchObject({ declaredYen: null, status: 'undeclared' });
  });
});

// ─── ★v0.9.83: 「幅は正しく符号だけ逆」を見逃さない(向きの突き合わせ・RECORD-ONLY) ─────────
//
//  ■ なぜ要るか(実測 2026-08-17・generator_proposals 複製)
//    従来 auditLcDeclarations は **幅しか** 比べていなかったので、根拠文が損切りを建値の逆側に書いていても
//    幅さえ合っていれば status:'match' と記録していた。式が読めた4,450レッグ中 右辺が逆側=1,654(37.2%)、
//    うち幅は正しく符号だけ逆=1,211(27.2%)。★実際に執行される計画が逆側だったのは 0件(壊れているのは根拠文だけ)。
//  ■ 設計(混ぜない)
//    status(match/mismatch/undeclared)の意味は1バイトも変えない。向きは declaredSide に **別立て** で置く。
//    値の語彙も status と重ならない語(sideOk/sideReversed/sideUnknownDirection)にして、
//    台帳の LIKE 検索が衝突しないようにしてある。
describe('向きの突き合わせ(declaredSide)', () => {
  // ★実データそのもの(pid=17372, buy)。実際の計画は stopEntry=68780 / stopLoss=68720(建値の下=正しい)。
  //   根拠文は 68840(建値の上=逆側)。従来の記録は {actualYen:60, declaredYen:60, status:'match'} で、
  //   根拠文が逆を向いていることが台帳から読めなかった。
  it('★実データ(pid=17372): 幅は一致(match)のまま、向きだけ sideReversed が立つ', () => {
    const rows = auditLcDeclarations(
      'ブレイク新規レッグ (68780)と(68840)の引き算 → LC幅は60円。',
      [{ leg: 'stop', entry: 68780, stopLoss: 68720, side: 'buy' }],
    );
    expect(rows[0]).toMatchObject({
      actualYen: 60, declaredYen: 60, status: 'match',            // ← 幅の判定は不変
      declaredSide: 'sideReversed', declaredSideEntry: 68780, declaredSideStop: 68840,
      declaredSideFrom: 'subtraction',
    });
  });

  it('向きが合っていれば sideOk(買い=損切りは下・売り=上)', () => {
    const buy = auditLcDeclarations('指値レッグ 68725と68665の引き算 → LC幅は60円。',
      [{ leg: 'limit', entry: 68725, stopLoss: 68665, side: 'buy' }]);
    expect(buy[0]).toMatchObject({ status: 'match', declaredSide: 'sideOk' });
    const sell = auditLcDeclarations('指値レッグ 68725と68785の引き算 → LC幅は60円。',
      [{ leg: 'limit', entry: 68725, stopLoss: 68785, side: 'sell' }]);
    expect(sell[0]).toMatchObject({ status: 'match', declaredSide: 'sideOk' });
  });

  it('書式②(式)からも向きを読む', () => {
    const rows = auditLcDeclarations('ブレイク新規レッグ 65540 + 55 = 65595',
      [{ leg: 'stop', entry: 65540, stopLoss: 65485, side: 'buy' }]);
    expect(rows[0]).toMatchObject({ declaredSide: 'sideReversed', declaredSideFrom: 'equation', declaredSideStop: 65595 });
  });

  it('★書式①(幅だけの申告)からは向きを判定しない=キー自体を置かない(「読めない」を「一致」にしない)', () => {
    const rows = auditLcDeclarations('ブレイク新規レッグ LC=55円', [{ leg: 'stop', entry: 65540, stopLoss: 65595, side: 'sell' }]);
    expect(rows[0]).toMatchObject({ status: 'match' });
    expect(rows[0]).not.toHaveProperty('declaredSide');
  });

  it('★direction が渡らなければ推測しない: sideUnknownDirection と明示して残す', () => {
    const rows = auditLcDeclarations('指値レッグ 68725と68665の引き算 → LC幅は60円。',
      [{ leg: 'limit', entry: 68725, stopLoss: 68665 }]);
    expect(rows[0]).toMatchObject({ declaredSide: 'sideUnknownDirection', declaredSideEntry: 68725, declaredSideStop: 68665 });
  });

  it('★レンジ脚(upper/lower)は見出しで区別できないので向きは判定しない', () => {
    const rows = auditLcDeclarations('両面に置く。65600と65540の引き算 → LC幅は60円。',
      [{ leg: 'upper', entry: 65600, stopLoss: 65660, side: 'sell' }]);
    expect(rows[0]).not.toHaveProperty('declaredSide');
  });

  it('★向きは status を1バイトも動かさない(逆側でも幅が違えば mismatch のまま)', () => {
    const rows = auditLcDeclarations('ブレイク新規レッグ (68780)と(68840)の引き算 → LC幅は60円。',
      [{ leg: 'stop', entry: 68780, stopLoss: 68775, side: 'buy' }]);
    expect(rows[0]).toMatchObject({ status: 'mismatch', declaredYen: 60, actualYen: 5, declaredSide: 'sideReversed' });
  });
});

// ─── ★v0.9.70: プロンプトの例文が、このパーサで **実際に読める** ことの実証 ─────────────
//
//  ★これが無かったために起きたこと(この版の初版・未出荷):
//   プロンプトの例文を「(エントリー価格)と(損切りの位置)の距離=(幅)」にしたが、WIDTH_RE はその形を
//   1件も読めなかった。つまり **モデルがプロンプトの例に忠実に従うほど lcAudit が undeclared に落ち**、
//   v0.9.61〜v0.9.64 で積み上げた「申告 vs 実出力」の計測が丸ごと死ぬ、という無言の失敗になっていた。
//
//  ★合成した文字列でテストしない。**プロンプトが使うのと同じ関数(lcWidthDeclarationExample)** に
//   実数値を入れて生成した文字列を食わせる。例文の書式を変えた人は必ずここで落ちる。
describe('★プロンプトの例文がパーサで読めること(書式の SSOT が噛み合っているか)', () => {
  it('lcWidthDeclarationExample で作った申告は match になる(指値/ブレイク新規とも)', () => {
    const limitDecl = lcWidthDeclarationExample('指値レッグ', '66210', '66145', '65');
    const stopDecl = lcWidthDeclarationExample('ブレイク新規レッグ', '66330', '66390', '60');
    const rows = auditLcDeclarations(`${limitDecl}。${stopDecl}。`, [
      { leg: 'limit', entry: 66210, stopLoss: 66145 },
      { leg: 'stop', entry: 66330, stopLoss: 66390 },
    ]);
    expect(rows.map(r => [r.leg, r.declaredYen, r.status])).toEqual([
      ['limit', 65, 'match'],
      ['stop', 60, 'match'],
    ]);
  });

  it('★否定対照: 旧版の例文の書式(…の距離=N円)は1件も読めない(undeclared)', () => {
    // これがこの版で直した事故そのもの。プロンプトの例文をこの形に戻したら、下の期待値が現実になる。
    const rows = auditLcDeclarations('指値レッグ 66210と66145の距離=65円', [
      { leg: 'limit', entry: 66210, stopLoss: 66145 },
    ]);
    expect(rows.map(r => [r.declaredYen, r.status])).toEqual([[null, 'undeclared']]);
  });

  it('例文は実際にプロンプト(lcFloorRule / scalpJsonInstruction)へ入っている', () => {
    const placeholder = lcWidthDeclarationExample('指値レッグ', '(エントリー価格)', '(損切りの位置)', '(幅)');
    expect(lcFloorRule(55)).toContain(placeholder);
    expect(scalpJsonInstruction(38250, 55, 65, false)).toContain(placeholder);
  });
});
