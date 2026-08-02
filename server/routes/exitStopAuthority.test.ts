// ★POST /api/exit-stop が **実質** を返しているかの検査(ロード済みの実装で走らせる)。
//
// ── なぜ別ファイルか ────────────────────────────────────────────────────────
// exitStop.test.ts は「実装が未ロードのとき値を返さない」を確かめるため loadExitImpl() を呼べない
// (呼ぶと 'unloaded' を二度と再現できない)。こちらは逆に **ロードしてから** 実質を見る。
//
// ── なぜ要るか(消すとまた同じ壊れ方をする) ────────────────────────────────
// 元のルート検査は `exitStopResponse(s) === computeExitStop(s)` というトートロジーだった。
// 両辺が同じ関数なので、その関数が **劣化フォールバック(初期LC固定)** であっても緑になる。
// 実測: ロード前は全 peak で initialStop と同値(distinct=1)、ロード後は distinct=5。
// つまり「6サンプル中4つが違う」ほどの差を、この検査は一度も見ていなかった。
//
// ── 何を主張するか ────────────────────────────────────────────────────────
// ★**決済の実数値は一切書かない**。書くのは「性質」だけ:
//   ① 含み益ピークが十分伸びれば、逆指値は initialStop より **有利側** にある(=床が動く)。
//   ② 逆指値は含み益ピークに対して単調(有利側にしか動かない)= ラチェット。
//   ③ 逆指値が initialStop より不利側へ行くことは無い。
//   ④ 段が実在する(取りうる値が2つ以上)。
// 走査の範囲(初期LC幅の倍数)は決済パラメータではない=公開してよい。
//
// ★否定対照も同じファイルに置く: 劣化フォールバックに差し替えるとこの性質は成立せず、
//   さらにルートは 503 になって値そのものを返さない。
import { describe, it, expect } from 'vitest';
import { exitStopHandler } from './exitStop.js';
import {
  loadExitImpl, computeExitStop, computeExitStopSimple, type ExitFn, type ExitState,
} from '../signalTrade/exit/index.js';

const kind = await loadExitImpl();

const ENTRY = 39000;
const LC = 100;                 // 合成の初期LC幅(決済パラメータではない。走査の物差し)。
const STEPS = 60;               // 走査の刻み数。
const SPAN = LC * 20;           // 走査の上限(初期LC幅の倍数=決済パラメータではない)。

function sweep(direction: 'buy' | 'sell', exit: ExitFn): (number | null)[] {
  const initialStop = direction === 'buy' ? ENTRY - LC : ENTRY + LC;
  const out: (number | null)[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const peakProfit = (SPAN * i) / STEPS;
    out.push(exit({ direction, entryPrice: ENTRY, initialStop, peakProfit }));
  }
  return out;
}

/** 有利側の向き(buy=上が有利 / sell=下が有利)で「a は b 以上に有利か」。 */
function atLeastAsFavorable(direction: 'buy' | 'sell', a: number, b: number): boolean {
  return direction === 'buy' ? a >= b : a <= b;
}
function strictlyMoreFavorable(direction: 'buy' | 'sell', a: number, b: number): boolean {
  return direction === 'buy' ? a > b : a < b;
}

/** ①〜④ をまとめて判定する(否定対照でも同じ判定器を使う=判定が甘くなっていない証拠)。 */
function hasRatchetSubstance(direction: 'buy' | 'sell', exit: ExitFn = computeExitStop): {
  movesOffInitial: boolean; monotone: boolean; neverWorse: boolean; distinct: number;
} {
  const initialStop = direction === 'buy' ? ENTRY - LC : ENTRY + LC;
  const stops = sweep(direction, exit).filter((v): v is number => v !== null);
  let monotone = true, neverWorse = true, movesOffInitial = false;
  for (let i = 0; i < stops.length; i++) {
    if (i > 0 && !atLeastAsFavorable(direction, stops[i]!, stops[i - 1]!)) monotone = false;
    if (!atLeastAsFavorable(direction, stops[i]!, initialStop)) neverWorse = false;
    if (strictlyMoreFavorable(direction, stops[i]!, initialStop)) movesOffInitial = true;
  }
  return { movesOffInitial, monotone, neverWorse, distinct: new Set(stops).size };
}

describe.runIf(kind === 'private')('★実質: 権威がロード済みなら床は含み益で動く(数値は書かない)', () => {
  for (const direction of ['buy', 'sell'] as const) {
    it(`${direction}: 十分大きい含み益では initialStop より有利・単調・不利側へ行かない・段が実在する`, () => {
      const r = hasRatchetSubstance(direction);
      expect(r.movesOffInitial, '含み益をいくら伸ばしても初期LCのまま=劣化フォールバックの姿').toBe(true);
      expect(r.monotone, 'ラチェットが単調でない(有利側以外へ動いた)').toBe(true);
      expect(r.neverWorse, '初期LCより不利側へ行った(広げた)').toBe(true);
      expect(r.distinct, '取りうる値が1つ=段が無い(劣化フォールバック)').toBeGreaterThan(1);
    });
  }

  it('ルート(HTTP)経由でも同じ実質が出る=200 で権威の値が返る', () => {
    const res = { code: 200, body: undefined as unknown, status(n: number) { res.code = n; return res; }, json(b: unknown) { res.body = b; return res; } };
    const state: ExitState = { direction: 'buy', entryPrice: ENTRY, initialStop: ENTRY - LC, peakProfit: SPAN };
    exitStopHandler({ body: state, headers: {} } as never, res as never);
    expect(res.code).toBe(200);
    const got = (res.body as { exitStop: number }).exitStop;
    expect(strictlyMoreFavorable('buy', got, ENTRY - LC)).toBe(true);
  });

  // ★否定対照(グローバル状態を触らない): 同じ判定器を **劣化フォールバック** に当てると性質は消える。
  //   = 上の検査が空振り(何にでも緑)ではない証拠。ロード前のルートが返していたのはこちらの値。
  it('★否定対照: 劣化フォールバック(初期LC固定)は同じ判定器で落ちる', () => {
    for (const direction of ['buy', 'sell'] as const) {
      const r = hasRatchetSubstance(direction, computeExitStopSimple);
      expect(r.movesOffInitial, direction).toBe(false);   // 初期LCから一度も動かない。
      expect(r.distinct, direction).toBe(1);              // 段が無い(実測 distinct=1)。
    }
  });
});

// 非公開実装が無いビルド(公開/lite): 権威は成立しない。ルートは値を返さないことだけを主張する。
describe.runIf(kind !== 'private')('公開フォールバックのビルドでは権威として応答しない', () => {
  it('503(劣化した値を権威の顔で返さない)', () => {
    const res = { code: 200, body: undefined as unknown, status(n: number) { res.code = n; return res; }, json(b: unknown) { res.body = b; return res; } };
    exitStopHandler({ body: { direction: 'buy', entryPrice: ENTRY, initialStop: ENTRY - LC, peakProfit: SPAN }, headers: {} } as never, res as never);
    expect(res.code).toBe(503);
  });
});
