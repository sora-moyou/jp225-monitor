import { describe, it, expect } from 'vitest';
import { detectContextPresence } from './contextPresence.js';
import { buildScalpMarketData } from './scalpContext.js';
import { buildBasedataContext } from './basedataContext.js';

// ★段5続き: 「文脈のどのブロックが実際に入ったか」の検出(純関数)。
//
// ■ ★否定対照
//   detectContextPresence の各 includes() 判定を消せば、対応するテストが赤になる。
// ■ ★実装非依存の確認
//   ここでは scalpContext.ts/basedataContext.ts を **実際に呼んで** 出力を作り、
//   その本物の出力に対して判定する(マーカー文字列を手で捏造しない)。

const NOW = Date.UTC(2026, 7, 22, 2, 0, 0);
const REF = 38250;

function bar(t: number, o: number, h: number, l: number, c: number) {
  return { t, o, h, l, c };
}

describe('detectContextPresence(実際の buildScalpMarketData/buildBasedataContext の出力に対して)', () => {
  it('★十分な足・節目・アラートがある回は全部 true(news 以外)', () => {
    // computeIndicators は 5分足の確定closeが15本以上要る → 1分足を多めに用意。
    // ★スイング確定には reclaim(現在値の0.3%≒115円)を超える上下動が要るので、そのぶんの
    //   ジグザグ(±300円)を1分足に混ぜる(平坦な足だけでは pivot が1本も確定しない)。
    const manyBars = Array.from({ length: 120 }, (_, i) => {
      const wave = Math.sin(i / 6) * 300;
      const c = REF + wave;
      return bar(NOW - (120 - i) * 60_000, c, c + 20, c - 20, c);
    });
    const levels = {
      current: REF, swing: null, reversalSatisfied: false, asOf: NOW,
      up: [{ price: REF + 100, dist: 100, labels: ['節目'], strong: false, score: 2, tier: 1 as const, confluence: false }],
      down: [{ price: REF - 100, dist: -100, labels: ['節目'], strong: false, score: 2, tier: 1 as const, confluence: false }],
    } as import('../levels.js').LevelsResult;
    const alerts = [{
      id: 1, triggered_at: NOW - 60_000, direction: 'up', detection_kind: 'break', window_seconds: null,
      change_percent: null, price: REF, session_date: null, session: null, ret5: 0.1, ret15: 0.2, ret30: 0.3,
    }] as unknown as import('../db/store.js').AlertRow[];
    const session = {
      sessionDate: '2026-08-22', session: 'Day' as const, open: REF - 200, high: REF + 300, low: REF - 300,
      close: REF, highT: NOW, lowT: NOW, openT: NOW,
    };

    const marketData = buildScalpMarketData({
      bars: manyBars, levels, alerts, now: NOW, currentPrice: REF + 99, session, indicatorsEnabled: true,
    });
    const basedata = buildBasedataContext({
      dailyCloses: Array.from({ length: 80 }, (_, i) => REF - 1000 + i * 10),
      dailyBars: Array.from({ length: 80 }, (_, i) => ({
        sessionDate: `2026-0${1 + Math.floor(i / 28)}-${(1 + (i % 28)).toString().padStart(2, '0')}`,
        open: REF - 1000 + i * 10, high: REF - 990 + i * 10, low: REF - 1010 + i * 10, close: REF - 1000 + i * 10,
      })),
      currentPrice: REF + 99,
    });
    const rich = [marketData, basedata].filter(Boolean).join('\n\n');
    const p = detectContextPresence(rich, 3);

    expect(p).toEqual({
      atr: true, sessionHighLow: true, levels: true, bb: true, swing: true,
      longHorizon: true, alerts: true, dailyBand: true, basedata: true, news: true,
    });
  });

  it('★足0本・節目0件・アラート0件なら該当ブロックは全部 false', () => {
    const marketData = buildScalpMarketData({
      bars: [], levels: null, alerts: [], now: NOW, currentPrice: REF, indicatorsEnabled: true,
    });
    const basedata = buildBasedataContext({ dailyCloses: [], dailyBars: [], currentPrice: REF });
    const rich = [marketData, basedata].filter(Boolean).join('\n\n');
    const p = detectContextPresence(rich, 0);
    expect(p).toEqual({
      atr: false, sessionHighLow: false, levels: false, bb: false, swing: false,
      longHorizon: false, alerts: false, dailyBand: false, basedata: false, news: false,
    });
  });

  it('★基礎データが「本数不足」の回は dailyBand=false・basedata=true(全欠測ではない)を区別する', () => {
    // 終値が25本未満(日足バンドの計算に不足)だが、MA5等は出せる本数はある想定。
    const basedata = buildBasedataContext({
      dailyCloses: Array.from({ length: 10 }, (_, i) => REF - 100 + i),
      dailyBars: Array.from({ length: 10 }, (_, i) => ({
        sessionDate: `2026-08-${(1 + i).toString().padStart(2, '0')}`,
        open: REF - 100 + i, high: REF - 90 + i, low: REF - 110 + i, close: REF - 100 + i,
      })),
      currentPrice: REF,
    });
    expect(basedata).toContain('本数不足');   // ★前提: このケースは本当に不足を踏んでいる
    const p = detectContextPresence(basedata, 0);
    expect(p.dailyBand).toBe(false);
    expect(p.basedata).toBe(true);   // ブロックそのものは出ている(全欠測ではない)
  });

  it('★ATR とは独立に本日高安だけ消える回がある(session 無し・bars だけでは高安が出ない構成は稀だが、判定は独立)', () => {
    // ATR は bars があれば出るが、本日高安は session か bars の高安が要る。
    // ここでは「ATR14(」だけが出て「本日高安 」は出ない状況を、実装どおりの入力で作れないため、
    // 独立性は仕様(コード分岐)として明記し、ここでは両方 true になる通常ケースのみ固定する。
    const bars = Array.from({ length: 20 }, (_, i) => bar(NOW - (20 - i) * 60_000, REF, REF + 5, REF - 5, REF));
    const marketData = buildScalpMarketData({ bars, levels: null, alerts: [], now: NOW, currentPrice: REF, indicatorsEnabled: false });
    const p = detectContextPresence(marketData, 0);
    expect(p.atr).toBe(true);
    expect(p.sessionHighLow).toBe(true);   // bars から高安を出せる
  });

  it('news は文字列を見ない(件数だけで決まる)', () => {
    expect(detectContextPresence('何でもいい文字列', 0).news).toBe(false);
    expect(detectContextPresence('', 5).news).toBe(true);
  });

  it('richText が空文字/不正値でも例外にならず全部 false', () => {
    expect(detectContextPresence('', 0)).toEqual({
      atr: false, sessionHighLow: false, levels: false, bb: false, swing: false,
      longHorizon: false, alerts: false, dailyBand: false, basedata: false, news: false,
    });
    // @ts-expect-error 実行時の型崩れ(外部入力想定)にも耐える
    expect(() => detectContextPresence(undefined, 0)).not.toThrow();
  });
});
