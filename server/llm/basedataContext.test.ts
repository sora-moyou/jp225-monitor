import { describe, it, expect } from 'vitest';
import { buildBasedataContext, BASEDATA_RECENT_DAYS, type DailyBar } from './basedataContext.js';
import { computeDailyBands, computeDailyMAs, dailyCloseSeries, DAILY_CLOSES_KEEP } from '../dailyBand.js';

// ★段2(v0.9.98): 基礎データ(日足)を AI 文脈に渡す純関数。
//
// 何を守っているか:
//   ① ★アラートが使う数値と **同じ値** を書く(SSOT。画面/アラート/AI で MA25 が食い違わない)
//   ② ★「渡せなかった」が **黙って消えない**(欠落は行として書く)
//   ③ ★古い値が残らない(この関数は状態を持たない=同じ入力なら同じ出力・入力が減れば出力も減る)
//   ④ ★確定日を必ず見出しに書く(collector が止まった系列が「新しい顔」で渡らない)
//   ⑤ ★向きは不等式で書く(「上/下」の語の衝突で符号を取り違えた過去の事故を避ける)
//   ⑥ ★新しい閾値を書かない(印字される数値は データそのもの か 既存の期間ラベルだけ)

/** i 日目の終値が base + i*step になる終値列(古い→新しい)。 */
const closes = (n: number, base = 39000, step = 10): number[] =>
  Array.from({ length: n }, (_, i) => base + i * step);

const bars = (n: number, base = 39000): DailyBar[] =>
  Array.from({ length: n }, (_, i) => ({
    sessionDate: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: base + i * 10, high: base + i * 10 + 50, low: base + i * 10 - 50, close: base + i * 10 + 5,
  }));

describe('基礎データ(日足)ブロック', () => {
  it('① ★アラートが使うのと同じ数値になる(SSOT・値を作り直していない)', () => {
    const c = closes(80);
    const price = 39500;
    const text = buildBasedataContext({ dailyCloses: c, dailyBars: bars(80), currentPrice: price });
    // アラート経路(detect/registry.ts)と同じ呼び方で作った値
    const mas = computeDailyMAs(dailyCloseSeries(c, price, 75));
    const bands = computeDailyBands(dailyCloseSeries(c, price));
    expect(mas.length).toBeGreaterThan(0);
    expect(bands.length).toBe(5);
    for (const m of mas) expect(text).toContain(`${m.label}(${Math.round(m.price).toLocaleString('en-US')})`);
    for (const b of bands) expect(text).toContain(`${b.label}=${Math.round(b.price).toLocaleString('en-US')}`);
  });

  it('② ★日足が1本も無いとき、ブロックが消えずに「取得できず」と書く', () => {
    const text = buildBasedataContext({ dailyCloses: [], dailyBars: [], currentPrice: 39500 });
    expect(text).not.toBe('');
    expect(text).toContain('取得できず');
    expect(text).toContain('基礎データ');
    // ★数値を1つも書かない(無いものを書かない)
    expect(text).not.toMatch(/MA\d+\(/);
  });

  it('② ★本数が足りない線は黙って消さず「本数不足」と本数を書く', () => {
    const text = buildBasedataContext({ dailyCloses: closes(10), dailyBars: bars(3), currentPrice: 39500 });
    expect(text).toContain('MA20/MA50/MA75=本数不足(終値11本)');   // 10本 + 現在値
    expect(text).toContain('日足バンド=本数不足(終値11本)');
    expect(text).toContain('MA5(');                                 // 作れる線は出る
  });

  it('② ★終値はあるが日足OHLCが無いとき、長期高安と日足OHLCだけが「取得できず」になる', () => {
    const text = buildBasedataContext({ dailyCloses: closes(80), dailyBars: [], currentPrice: 39500 });
    expect(text).toContain('長期高安=取得できず(取引日足0本)');
    expect(text).toContain('日足OHLC=取得できず');
    expect(text).toContain('日足バンド: ');    // 終値から作れるものは出る
  });

  it('③ ★状態を持たない: 同じ入力なら同じ出力・入力が減れば前回の値は残らない', () => {
    const full = { dailyCloses: closes(80), dailyBars: bars(80), currentPrice: 39500 };
    const a = buildBasedataContext(full);
    const b = buildBasedataContext(full);
    expect(b).toBe(a);                                   // 決定的
    const empty = buildBasedataContext({ dailyCloses: [], dailyBars: [], currentPrice: 39500 });
    // ★直前に満杯の入力で呼んでいても、空入力の出力に前回の数値が1つも残らない
    expect(empty).not.toContain('MA25');
    expect(empty).not.toContain('長期高安(');
    expect(buildBasedataContext(full)).toBe(a);          // 空呼び出しの後でも元に戻る
  });

  it('④ ★確定日を見出しに書く(古い系列が「新しい顔」で渡らない)', () => {
    const old = bars(80);
    old[old.length - 1]!.sessionDate = '2026-05-01';     // 系列が止まっている状況
    const text = buildBasedataContext({ dailyCloses: closes(80), dailyBars: old, currentPrice: 39500 });
    expect(text).toContain('確定 2026-05-01 まで');
    // 日付が取れないときは「不明」と書く(捏造しない)
    const noDate = buildBasedataContext({ dailyCloses: closes(80), dailyBars: [], currentPrice: 39500 });
    expect(noDate).toContain('確定 不明 まで');
  });

  it('⑤ ★向きは不等式で書く(「上」「下」の語を使わない)', () => {
    const text = buildBasedataContext({ dailyCloses: closes(80), dailyBars: bars(80), currentPrice: 39500 });
    const maLine = text.split('\n').find(l => l.startsWith('日足MA:'))!;
    expect(maLine).toMatch(/現在値[<>=]MA5\(/);
    // ★方向の語を1文字も入れない(過去に「外側」の語の衝突で符号を取り違えた)
    for (const w of ['より上', 'より下', '上抜け', '下抜け', '上回', '下回']) expect(maLine).not.toContain(w);
  });

  it('⑤ ★現在値の位置も不等式(バンドの2本の間)', () => {
    const text = buildBasedataContext({ dailyCloses: closes(80), dailyBars: bars(80), currentPrice: 39500 });
    const pos = text.split('\n').find(l => l.startsWith('現在値の位置:'));
    expect(pos).toBeDefined();
    expect(pos!).toMatch(/(< 現在値 <|現在値 <|< 現在値)/);
  });

  it('★長期高安は 節目の longHL(24セッション) ではなく、渡した取引日足の全体から取る', () => {
    const b = bars(80);
    b[3]!.high = 99999;    // ★24セッションより外側(古い側)にある極値
    b[5]!.low = 1;
    const text = buildBasedataContext({ dailyCloses: closes(80), dailyBars: b, currentPrice: 39500 });
    expect(text).toContain('高=99,999');
    expect(text).toContain('安=1(');
    expect(text).toContain('長期高安(取引日足80本)');
  });

  it(`★日足OHLC は直近${BASEDATA_RECENT_DAYS}本まで(印字の本数であって閾値ではない)`, () => {
    const text = buildBasedataContext({ dailyCloses: closes(80), dailyBars: bars(80), currentPrice: 39500 });
    const line = text.split('\n').find(l => l.startsWith('日足OHLC 直近'))!;
    expect(line).toContain(`直近${BASEDATA_RECENT_DAYS}本`);
    expect(line.split(' | ').length).toBe(BASEDATA_RECENT_DAYS);
    // 本数が足りなければ、あるだけ出して本数もその値になる(嘘を書かない)
    const few = buildBasedataContext({ dailyCloses: closes(80), dailyBars: bars(3), currentPrice: 39500 });
    expect(few).toContain('日足OHLC 直近3本');
  });

  it('⑥ ★規則の数値を書かない(印字される数字はデータか既存の期間ラベルだけ)', () => {
    const text = buildBasedataContext({ dailyCloses: closes(80), dailyBars: bars(80), currentPrice: 39500 });
    // 期間ラベル(MA5/20/25/50/75・±1/2sigma・80営業日・直近10本)以外に、
    // 「〜円以上」「〜%」のような **規則を作る数値** が入っていないこと。
    for (const w of ['円以上', '円以下', '%', '以内', '以上に', '倍']) expect(text).not.toContain(w);
    expect(text).toContain(`最大${DAILY_CLOSES_KEEP}営業日`);
  });

  it('★現在値が壊れていれば何も書かない(壊れた数値でブロックを作らない)', () => {
    for (const p of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildBasedataContext({ dailyCloses: closes(80), dailyBars: bars(80), currentPrice: p })).toBe('');
    }
  });

  it('★壊れた行は捨てるが、残りは書く(1本の異常で全体を落とさない)', () => {
    const b = bars(10);
    b[0] = { sessionDate: 'x', open: Number.NaN, high: Number.NaN, low: Number.NaN, close: Number.NaN };
    const text = buildBasedataContext({
      dailyCloses: [...closes(79), Number.NaN], dailyBars: b, currentPrice: 39500,
    });
    expect(text).toContain('長期高安(取引日足9本)');
    expect(text).toContain('日足MA: ');
  });
});
