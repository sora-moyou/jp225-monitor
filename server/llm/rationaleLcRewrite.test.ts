import { describe, it, expect } from 'vitest';
import { rewriteLcWidth, rewriteLcWidthForLeg, kindSpans } from './rationaleLcRewrite.js';

// ═══ 理由欄に書かれた旧LC幅の書き換え(ユーザー指示・2026-08-26) ═══════════════════
//
//   「LCずらしは、シグナル書き換えとともに、理由欄に旧LC幅が記載されていた場合、
//     その幅の値もずらしてください。」
//
// ★守るもの: ①ラベル付きの幅だけを直す ②裸の数値・別語(値幅)は触らない
//             ③式の中は触らない(直すと算術が嘘になる) ④見出しで脚を区別する
//
// ★このファイルは core/pivotNudge.test.ts から移設した(2026-08-26)。
//   移設の理由: 脚の割り当ての権威 headingMarks が server/llm/rationaleLc.ts に在り、
//   core は server を import できないため(core/rationaleDisplay.ts 冒頭の理由と同じ)。
describe('rewriteLcWidth(理由欄の幅の書き換え)', () => {
  it('ラベル付きの幅を直す(表記ゆれ4種)', () => {
    for (const t of ['LC幅60円', 'LC幅は60円', 'LC幅(60)', '損切り幅60円']) {
      const r = rewriteLcWidth(t, 60, 65);
      expect(r.hits).toBe(1);
      expect(r.text).toContain('65');
      expect(r.text).not.toContain('60');
    }
  });

  it('★裸の数値は触らない(ラベルが無ければ幅の申告ではない)', () => {
    expect(rewriteLcWidth('60円ほど下に置く', 60, 65)).toEqual({ text: '60円ほど下に置く', hits: 0 });
  });

  it('★「値幅60円」は触らない(裸の「幅」を語彙に入れていない)', () => {
    // ★この誤読は実在した: rationaleLc の WIDTH_RE が「値幅80円」を LC幅として拾い、
    //   損切りが20円ずれたまま黙って通っていた(v0.9.99 で塞いだ)。同じ穴を開けない。
    const r = rewriteLcWidth('直近の値幅60円を上抜け。LC幅60円。', 60, 65);
    expect(r.hits).toBe(1);
    expect(r.text).toBe('直近の値幅60円を上抜け。LC幅65円。');
  });

  it('★価格を書いた形(LC=65400)から先頭3桁を拾わない', () => {
    expect(rewriteLcWidth('LC=65400', 654, 659).hits).toBe(0);
  });

  it('★式の中の幅は触らない(直すと 65800-65=65740 という嘘になる)', () => {
    const r = rewriteLcWidth('65800-LC幅(60)=65740', 60, 65);
    expect(r).toEqual({ text: '65800-LC幅(60)=65740', hits: 0 });
  });

  it('幅が変わらない/空文字なら何もしない', () => {
    expect(rewriteLcWidth('LC幅60円', 60, 60).hits).toBe(0);
    expect(rewriteLcWidth('', 60, 65).hits).toBe(0);
  });

  it('同じ幅の申告が複数あれば全部直す', () => {
    expect(rewriteLcWidth('LC幅60円。再掲: LC幅60円。', 60, 65).hits).toBe(2);
  });
});

describe('kindSpans / rewriteLcWidthForLeg(脚の割り当て)', () => {
  it('★「逆指値」を「指値」と読まない(長い語から先に照合する)', () => {
    const spans = kindSpans('逆指値買い: A / 指値買い: B');
    expect(spans.map(s => s.kind)).toEqual(['stop', 'limit']);
  });

  it('★見出しで区切った自分の区間だけを直す(隣の脚の幅は残る)', () => {
    const t = '逆指値買い: 高値抜け（LC幅60円）/ 指値買い: 押し（LC幅70円）';
    const r = rewriteLcWidthForLeg(t, 'stop', 60, 65);
    expect(r.text).toBe('逆指値買い: 高値抜け（LC幅65円）/ 指値買い: 押し（LC幅70円）');
    expect(r.hits).toBe(1);
  });

  it('★他の脚の区間にある同じ数値は動かさない', () => {
    const t = '逆指値買い: A（LC幅60円）/ 指値買い: B（LC幅60円）';
    const r = rewriteLcWidthForLeg(t, 'stop', 60, 65);
    expect(r.text).toBe('逆指値買い: A（LC幅65円）/ 指値買い: B（LC幅60円）');
  });

  it('見出しの無い文: 脚が1本だけなら全体を直す / 2本なら触らない', () => {
    const t = '高値抜けに追随。LC幅は60円。';
    expect(rewriteLcWidthForLeg(t, 'stop', 60, 65, { soleLeg: true }).hits).toBe(1);
    expect(rewriteLcWidthForLeg(t, 'stop', 60, 65, { soleLeg: false }).hits).toBe(0);
  });

  it('own(その脚専用の箱)は見出しを見ずに全体を直す', () => {
    // entryWhyForStop のような箱は 1脚ぶんしか入らないので、見出しが無くても曖昧さが無い。
    expect(rewriteLcWidthForLeg('本日高値の上（LC幅60円）', 'stop', 60, 65, { own: true }).hits).toBe(1);
  });

  it('undefined の箱は落ちない', () => {
    expect(rewriteLcWidthForLeg(undefined, 'stop', 60, 65, { own: true })).toEqual({ text: '', hits: 0 });
  });
});

// ═══ ★★否定対照: 自前の /逆指値|指値/ では脚を取り違える(実データ・2026-08-26) ═══════
//
// ■ 実測(signal_plans 2,685件・2026-08-04T03:54Z〜08-25T16:21Z / 2脚の根拠文 1,105件):
//     ・84.8%(937件) は「逆指値」という語を **含まない**
//     ・AI は逆指値レッグを「ブレイク新規」と書く = 81.1%(896件)
//   → 自前の /逆指値|指値/ だけを見る実装では、根拠文 **全体** が指値の区間に入り、
//       指値側の書き換えが2箇所以上に当たった = 596件(53.9%)
//       逆指値側の書き換えが0箇所           = 1,012件(91.6%)
// ■ ★この検査は「移設前の実装(core/pivotNudge.ts の自前 kindSpans)なら落ちる」形にしてある。
//   落ちることは実際に確認済み(報告に出力を貼った)。
describe('★★否定対照: 「ブレイク新規」を逆指値の見出しとして読む', () => {
  const REPRO = '押し目買い指値61600（LC幅60円）。ブレイク新規61700（LC幅60円）';

  it('★指値の書き換えは **1箇所だけ**(旧実装は2箇所に当たった)', () => {
    const r = rewriteLcWidthForLeg(REPRO, 'limit', 60, 65);
    expect(r.hits).toBe(1);                                  // ← 旧実装は 2
    expect(r.text).toBe('押し目買い指値61600（LC幅65円）。ブレイク新規61700（LC幅60円）');
  });

  it('★逆指値の書き換えが **当たる**(旧実装は0箇所=無言で何も直らなかった)', () => {
    const r = rewriteLcWidthForLeg(REPRO, 'stop', 60, 65);
    expect(r.hits).toBe(1);                                  // ← 旧実装は 0
    expect(r.text).toBe('押し目買い指値61600（LC幅60円）。ブレイク新規61700（LC幅65円）');
  });

  it('区間の割り当て: 見出し前=null / 指値 / ブレイク新規=stop', () => {
    expect(kindSpans(REPRO).map(s => s.kind)).toEqual([null, 'limit', 'stop']);
  });
});
