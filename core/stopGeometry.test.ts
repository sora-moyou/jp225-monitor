import { describe, it, expect } from 'vitest';
import { stopLossFromWidth, stopSideOk } from './stopGeometry.js';

// ─── ★このテストの目的(2026-08-17 の集約) ────────────────────────────────────
//
// 損切りの向きの規約は monitor 内で **5箇所に手書きで複製** されていた:
//   ① server/llm/scalpPlan.ts  stopSideOk
//   ② server/llm/scalpPlan.ts  stopLossFromWidth
//   ③ server/signalTrade/decisions.ts  stopOnCorrectSide
//   ④ server/signalTrade/decisions.ts  stopLossAtEntry
//   ⑤ server/llm/rationaleLc.ts  declaredSideOk
// 5箇所とも式は **文字どおり同一** であることを確認したうえで、core/stopGeometry.ts へ集約した
// (=規約の変更ではなく純粋な集約。挙動は1バイトも変えていない)。
//
// ★だからこのテストは「望ましい仕様」ではなく **旧実装が返していた値そのもの** を固定する。
//   下の oldStopSideOk / oldStopLossFromWidth は、集約前の5箇所の本体を **そのまま写した** もので、
//   4象限(buy/sell × 正しい側/逆側)と境界(幅0)で新実装と一致することを確かめる。
//   ここが落ちたら「集約で挙動が変わった」の意味であり、期待値を緩めてはならない。
//
// ★jp225-trade2(src/ai/sanity.ts)にも同じ規約の写しがあるが、別リポなので今回の集約の対象外。

/** 集約前の実装の写し(scalpPlan.stopSideOk / decisions.stopOnCorrectSide / rationaleLc.declaredSideOk と同一の本体)。 */
function oldStopSideOk(side: 'buy' | 'sell', entry: number, stopLoss: number): boolean {
  return side === 'buy' ? stopLoss < entry : stopLoss > entry;
}

/** 集約前の実装の写し(scalpPlan.stopLossFromWidth / decisions.stopLossAtEntry と同一の本体)。 */
function oldStopLossFromWidth(side: 'buy' | 'sell', entry: number, widthYen: number): number {
  return side === 'buy' ? entry - widthYen : entry + widthYen;
}

describe('stopLossFromWidth(幅→損切り価格・符号が決まる唯一の場所)', () => {
  it('買いは建値の下・売りは建値の上に置く', () => {
    expect(stopLossFromWidth('buy', 40000, 50)).toBe(39950);
    expect(stopLossFromWidth('sell', 40000, 50)).toBe(40050);
  });

  it('幅0は建値そのもの(=向きの検査で落ちる。ここでは符号だけを決める)', () => {
    expect(stopLossFromWidth('buy', 40000, 0)).toBe(40000);
    expect(stopLossFromWidth('sell', 40000, 0)).toBe(40000);
    expect(stopSideOk('buy', 40000, stopLossFromWidth('buy', 40000, 0))).toBe(false);
    expect(stopSideOk('sell', 40000, stopLossFromWidth('sell', 40000, 0))).toBe(false);
  });

  it('正の幅を通せば、導いた価格は必ず向きの検査を満たす(逆位置が表現不能であることの確認)', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const w of [5, 10, 45, 55, 100, 400]) {
        expect(stopSideOk(side, 40000, stopLossFromWidth(side, 40000, w))).toBe(true);
      }
    }
  });

  it('★桁落ち: 幅が正でも導いた価格が建値と一致することが実在する(呼び出し側が落とす前提の事実を固定)', () => {
    expect(stopLossFromWidth('buy', 1e20, 1e-12)).toBe(1e20);
    expect(stopSideOk('buy', 1e20, stopLossFromWidth('buy', 1e20, 1e-12))).toBe(false);
  });
});

describe('stopSideOk(損切りの向き・4象限と境界)', () => {
  it('買い: 下=正 / 上=逆 / 同値=不正', () => {
    expect(stopSideOk('buy', 100, 90)).toBe(true);
    expect(stopSideOk('buy', 100, 110)).toBe(false);
    expect(stopSideOk('buy', 100, 100)).toBe(false);
  });

  it('売り: 上=正 / 下=逆 / 同値=不正', () => {
    expect(stopSideOk('sell', 100, 110)).toBe(true);
    expect(stopSideOk('sell', 100, 90)).toBe(false);
    expect(stopSideOk('sell', 100, 100)).toBe(false);
  });
});

describe('★集約前後で挙動が同一(旧実装の写しと突き合わせる)', () => {
  const entries = [0, 100, 39_995, 40_000, 65_660, 1e20, -100];
  const widths = [0, 1e-12, 5, 45, 50, 55, 400, 1e6];

  it('stopLossFromWidth: 4象限 × 境界で旧実装と同じ値を返す', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const e of entries) {
        for (const w of widths) {
          expect(stopLossFromWidth(side, e, w)).toBe(oldStopLossFromWidth(side, e, w));
        }
      }
    }
  });

  it('stopSideOk: 4象限(buy/sell × 上/下)と境界(同値)で旧実装と同じ真偽を返す', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const e of entries) {
        for (const d of [-1e6, -400, -55, -5, -1e-12, 0, 1e-12, 5, 55, 400, 1e6]) {
          const sl = e + d;
          expect(stopSideOk(side, e, sl)).toBe(oldStopSideOk(side, e, sl));
        }
      }
    }
  });

  it('非有限も旧実装と同じ扱い(NaN は常に false・Infinity も式のまま)', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const v of [NaN, Infinity, -Infinity]) {
        expect(stopSideOk(side, 40_000, v)).toBe(oldStopSideOk(side, 40_000, v));
        expect(stopSideOk(side, v, 40_000)).toBe(oldStopSideOk(side, v, 40_000));
        expect(stopLossFromWidth(side, 40_000, v)).toEqual(oldStopLossFromWidth(side, 40_000, v));
      }
    }
    expect(stopSideOk('buy', 40_000, NaN)).toBe(false);
    expect(stopSideOk('sell', 40_000, NaN)).toBe(false);
  });
});
