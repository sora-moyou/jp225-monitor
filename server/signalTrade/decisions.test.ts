import { describe, it, expect } from 'vitest';
import { checkStaleLegs, MIN_ENTRY_DISTANCE_YEN } from './decisions.js';

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
