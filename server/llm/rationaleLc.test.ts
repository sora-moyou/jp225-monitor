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

describe('書式①(幅の申告): 「LC=55円」形', () => {
  it('レッグ見出しごとに申告幅を割り当てる', () => {
    const d = parseLcDeclarations('指値レッグ LC=55円 / ブレイク新規レッグ LC=95円');
    expect(d.limit).toEqual([55]);
    expect(d.stop).toEqual([95]);
    expect(d.unassigned).toEqual([]);
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
