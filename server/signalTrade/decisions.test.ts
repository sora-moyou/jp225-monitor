import { describe, it, expect } from 'vitest';
import { checkStaleLegs, planToArmed, entryRoundedFromPlan, MIN_ENTRY_DISTANCE_YEN } from './decisions.js';

describe('★最低距離(ラグ緩衝): live 価格に近すぎるレッグを落とす', () => {
  // 実測: monitor ARM → trade2 発注決定 の中央値 6.7秒。その間に価格が越えると
  // 指値/逆指値として成立しない。10円は「発注拒否の処理があるなら十分」というユーザー判断による。
  const base = {
    direction: 'buy' as const, at: 1, rationale: 'r',
    limitEntry: 68990, stopLossForLimit: 68930,
    stopEntry: 69100, stopLossForStop: 69040,
  };

  it('現在値から10円未満の指値レッグは落ちる(逆指値は残る)', () => {
    const r = checkStaleLegs({ ...base, limitEntry: 68995 }, 69000);   // 5円 = 近すぎ
    expect(r.armed?.limitEntry).toBeUndefined();
    expect(r.armed?.stopEntry).toBe(69100);
    expect(r.legs.find(l => l.name === 'limit')?.reason).toBe('tooClose');
  });

  it('ちょうど10円は落とさない(境界は含む)', () => {
    const r = checkStaleLegs({ ...base, limitEntry: 68990 }, 69000);   // 10円ちょうど
    expect(r.armed?.limitEntry).toBe(68990);
  });

  it('両レッグとも近すぎれば armed は null(=見送り)', () => {
    const r = checkStaleLegs({ ...base, limitEntry: 68998, stopEntry: 69002 }, 69000);
    expect(r.armed).toBeNull();
  });

  // ★この1件は計画の記述に誤りがあったので訂正済み。引数を変数に束ねて同一参照を見ること
  //   (計画は `toBe(base)` と書いていたが、引数はスプレッドの別オブジェクトなので必ず落ちる)。
  it('live 価格が取れないときは何も落とさない(fail-safe・既存の契約を壊さない)', () => {
    const arg = { ...base, limitEntry: 68998 };
    const r = checkStaleLegs(arg, null);
    expect(r.armed).toBe(arg);       // 同一参照で返る既存契約
    expect(r.legs).toEqual([]);
  });

  it('定数は 10 円', () => {
    expect(MIN_ENTRY_DISTANCE_YEN).toBe(10);
  });
});

describe('★刻み丸め: ARM するエントリー価格は必ず5円刻み', () => {
  it('刻み外の価格は丸めて武装する(買い)', () => {
    const plan = {
      direction: 'buy' as const, rationale: 'x',
      limitEntry: 68993, stopLossForLimit: 68933,
      stopEntry: 69101, stopLossForStop: 69041,
    };
    const armed = planToArmed(plan, 1);
    expect(armed!.limitEntry! % 5).toBe(0);
    expect(armed!.stopEntry! % 5).toBe(0);
    expect(armed!.limitEntry).toBe(68990);   // 買い指値は切り下げ
    expect(armed!.stopEntry).toBe(69105);    // 買い逆指値は切り上げ
  });

  it('刻み外の価格は丸めて武装する(売り)', () => {
    const plan = {
      direction: 'sell' as const, rationale: 'x',
      limitEntry: 69007, stopLossForLimit: 69067,
      stopEntry: 68899, stopLossForStop: 68959,
    };
    const armed = planToArmed(plan, 1);
    expect(armed!.limitEntry).toBe(69010);   // 売り指値は切り上げ
    expect(armed!.stopEntry).toBe(68895);    // 売り逆指値は切り下げ
  });

  // ★★これが最重要のテスト: 丸めても LC 幅が変わらないこと
  it('★丸めても LC 幅が変わらない(SL は丸めた建値から引き直される)', () => {
    const plan = {
      direction: 'buy' as const, rationale: 'x',
      limitEntry: 68993, stopLossForLimit: 68933,   // 元の幅 = 60
      stopEntry: 69101, stopLossForStop: 69041,     // 元の幅 = 60
    };
    const armed = planToArmed(plan, 1);
    expect(armed!.limitEntry! - armed!.stopLossForLimit!).toBe(60);
    expect(armed!.stopEntry! - armed!.stopLossForStop!).toBe(60);
  });

  it('売りでも LC 幅が変わらない(SL は建値の上に同じ幅で引き直される)', () => {
    const plan = {
      direction: 'sell' as const, rationale: 'x',
      limitEntry: 69007, stopLossForLimit: 69067,   // 元の幅 = 60
      stopEntry: 68899, stopLossForStop: 68959,     // 元の幅 = 60
    };
    const armed = planToArmed(plan, 1);
    expect(armed!.stopLossForLimit! - armed!.limitEntry!).toBe(60);
    expect(armed!.stopLossForStop! - armed!.stopEntry!).toBe(60);
  });

  it('既に刻み上なら値も幅も1円も動かない(否定対照)', () => {
    const plan = {
      direction: 'buy' as const, rationale: 'x',
      limitEntry: 68990, stopLossForLimit: 68930,
      stopEntry: 69100, stopLossForStop: 69040,
    };
    const armed = planToArmed(plan, 1);
    expect(armed!.limitEntry).toBe(68990);
    expect(armed!.stopEntry).toBe(69100);
    expect(armed!.stopLossForLimit).toBe(68930);
    expect(armed!.stopLossForStop).toBe(69040);
  });

  // ★安全網(修正2): 検証されるのは「実際に武装される SL」であること。
  //   hasLimit/hasStop が見ているのは丸めで捨てられる元の SL なので、引き直した SL を別途 stopOnCorrectSide に
  //   通している。構成上は必ず満たす(幅>0)ので、その不変条件が全4象限×全剰余で崩れないことを固定する。
  it('★武装される SL は必ず建値の正しい外側(4象限×剰余5通り=20ケース)', () => {
    for (const direction of ['buy', 'sell'] as const) {
      for (const r of [0, 1, 2, 3, 4]) {
        const limitEntry = 69000 + r;
        const stopEntry = 69200 + r;
        const plan = {
          direction, rationale: 'x',
          limitEntry, stopLossForLimit: direction === 'buy' ? limitEntry - 60 : limitEntry + 60,
          stopEntry, stopLossForStop: direction === 'buy' ? stopEntry - 60 : stopEntry + 60,
        };
        const a = planToArmed(plan, 1)!;
        const legs: Array<[number, number]> = [[a.limitEntry!, a.stopLossForLimit!], [a.stopEntry!, a.stopLossForStop!]];
        for (const [e, sl] of legs) {
          expect(e % 5).toBe(0);
          expect(Math.abs(e - sl)).toBe(60);                          // 幅は不変
          expect(direction === 'buy' ? sl < e : sl > e).toBe(true);    // 向きは正しい外側
        }
      }
    }
  });

  it('レンジ脚には丸めを適用しない(今回の範囲外・現在レンジは既定無効)', () => {
    const plan = {
      direction: 'range' as const, rationale: 'x',
      range: {
        upper: { side: 'buy' as const, type: 'stop' as const, entry: 69101, stopLoss: 69041 },
        lower: { side: 'sell' as const, type: 'stop' as const, entry: 68899, stopLoss: 68959 },
      },
    };
    const armed = planToArmed(plan, 1);
    expect(armed!.range!.upper!.entry).toBe(69101);
    expect(armed!.range!.lower!.entry).toBe(68899);
  });
});

describe('★entryRoundedFromPlan: 丸めで武装値が動いた回だけ true(サニティ再検証の適用条件)', () => {
  // 丸めは「約定しにくい側」へしか動かないので幅は広がる方向にしか変わらない。
  // 幅400円ちょうど(=checkSanity の上限)のブラケットは丸め後405円になり上限超に化ける。
  const offTick = {
    direction: 'buy' as const, rationale: 'x',
    limitEntry: 68799, stopLossForLimit: 68739,
    stopEntry: 69199, stopLossForStop: 69139,
  };

  it('丸めで動いた回は true(幅400 → 405 の実例)', () => {
    const a = planToArmed(offTick, 1)!;
    expect(a.limitEntry).toBe(68795);
    expect(a.stopEntry).toBe(69200);
    expect(a.stopEntry! - a.limitEntry!).toBe(405);   // ★プラン段の400から広がっている
    expect(entryRoundedFromPlan(offTick, a)).toBe(true);
  });

  it('既に刻み上なら false(否定対照=再検証を増やさない)', () => {
    const onTick = { ...offTick, limitEntry: 68800, stopLossForLimit: 68740, stopEntry: 69200, stopLossForStop: 69140 };
    const a = planToArmed(onTick, 1)!;
    expect(a.stopEntry! - a.limitEntry!).toBe(400);
    expect(entryRoundedFromPlan(onTick, a)).toBe(false);
  });

  it('落ちたレッグは判定に影響しない(残ったレッグだけを見る)', () => {
    const a = planToArmed(offTick, 1)!;
    const singleLeg = { ...a, stopEntry: undefined, stopLossForStop: undefined };
    expect(entryRoundedFromPlan(offTick, singleLeg)).toBe(true);        // 残った指値が動いている
    const onTickLimit = { ...a, limitEntry: 68799, stopEntry: undefined, stopLossForStop: undefined };
    expect(entryRoundedFromPlan(offTick, onTickLimit)).toBe(false);
  });

  it('レンジは常に false(丸めていない)', () => {
    const plan = {
      direction: 'range' as const, rationale: 'x',
      range: { upper: { side: 'buy' as const, type: 'stop' as const, entry: 69101, stopLoss: 69041 } },
    };
    const a = planToArmed(plan, 1)!;
    expect(entryRoundedFromPlan({}, a)).toBe(false);
  });
});
