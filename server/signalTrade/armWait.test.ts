import { describe, it, expect } from 'vitest';
import {
  ARM_WAIT_K, ARM_WAIT_MAX_MS, ARM_WAIT_MIN_MS,
  computeArmWait, describeArmWait, entryLegsOf, nearestEntryDistance, sigma1mFromBars,
} from './armWait.js';
import { armedWaitMsOf, ARMED_TIMEOUT_MS, advance, type EngineState } from './decisions.js';

const bar = (t: number, c: number) => ({ t, o: c, h: c, l: c, c });

describe('sigma1mFromBars(直近1分足終値変化の標準偏差)', () => {
  it('本数が足りなければ null(=待ちは下限へ落ちる fail-safe)', () => {
    expect(sigma1mFromBars([])).toBeNull();
    expect(sigma1mFromBars(null)).toBeNull();
    // 差分4本(足5本)は最低5本に満たない。
    expect(sigma1mFromBars([1, 2, 3, 4, 5].map((i) => bar(i * 60_000, 64000 + i)))).toBeNull();
  });

  it('一定幅で上下する系列の σ を返す(平均からの偏差=0 なら null)', () => {
    // 終値が +10,-10,+10,... の交互 → 差分は ±20 の交互 → 平均0・σ=20。
    const cs = [64000, 64010, 64000, 64010, 64000, 64010, 64000];
    const bars = cs.map((c, i) => bar(i * 60_000, c));
    expect(sigma1mFromBars(bars)).toBeCloseTo(10, 6);
    // 完全な水平線(全部同値)は σ=0 → null(0除算を作らない)。
    expect(sigma1mFromBars(new Array(20).fill(0).map((_, i) => bar(i * 60_000, 64000)))).toBeNull();
  });

  it('窓 n で直近だけを見る(古い暴れは σ に混ぜない)', () => {
    const old = [64000, 64500, 64000, 64500, 64000, 64500];   // 暴れている過去
    const recent = new Array(20).fill(0).map((_, i) => 64000 + (i % 2));   // 静かな直近
    const bars = [...old, ...recent].map((c, i) => bar(i * 60_000, c));
    const s = sigma1mFromBars(bars, 15);
    expect(s).not.toBeNull();
    expect(s as number).toBeLessThan(5);
  });
});

describe('nearestEntryDistance / entryLegsOf', () => {
  it('最も近いレッグまでの距離(=最初に約定し得るレッグ)を返す', () => {
    expect(nearestEntryDistance(64000, [63900, 64200])).toBe(100);
    expect(nearestEntryDistance(64000, [64200, 63900])).toBe(100);
  });
  it('レッグ無し/価格非有限は null', () => {
    expect(nearestEntryDistance(64000, [])).toBeNull();
    expect(nearestEntryDistance(64000, [null, undefined, NaN])).toBeNull();
    expect(nearestEntryDistance(NaN, [64000])).toBeNull();
    expect(nearestEntryDistance(null, [64000])).toBeNull();
  });
  it('directional は limit/stop、range は upper/lower を拾う', () => {
    expect(entryLegsOf({ limitEntry: 63900, stopEntry: 64100 })).toEqual([63900, 64100]);
    expect(entryLegsOf({ range: { upper: { entry: 64200 }, lower: { entry: 63800 } } })).toEqual([64200, 63800]);
    expect(entryLegsOf(null)).toEqual([]);
  });
});

describe('computeArmWait(距離とボラから待ち時間を決める)', () => {
  it('材料が欠けたら必ず下限=現行の15分(新しい仕組みで挙動を悪化させない)', () => {
    for (const [d, s] of [[null, 40], [100, null], [100, 0], [NaN, 40], [100, NaN]] as const) {
      const w = computeArmWait(d as number | null, s as number | null);
      expect(w.waitMs).toBe(ARM_WAIT_MIN_MS);
      expect(w.reason).toBe('no-data');
    }
  });

  it('近距離/高ボラは 15分のまま(=71%の武装は挙動不変)', () => {
    // (30/40)²=0.56分 ×3 = 1.7分 → 下限
    const w = computeArmWait(30, 40);
    expect(w.waitMs).toBe(ARM_WAIT_MIN_MS);
    expect(w.reason).toBe('floor');
    expect(w.estMin).toBeCloseTo(0.5625, 4);
  });

  it('遠距離/低ボラは上限30分でクランプ(古い前提を抱え続けない)', () => {
    // (150/20)²=56.25分 ×3 = 169分 → 上限
    const w = computeArmWait(150, 20);
    expect(w.waitMs).toBe(ARM_WAIT_MAX_MS);
    expect(w.reason).toBe('cap');
  });

  it('中間はランダムウォークの到達推定 (距離/σ)² × K に比例する', () => {
    // (100/30)²=11.11分 ×3 = 33.3分 → 上限30分
    expect(computeArmWait(100, 30).reason).toBe('cap');
    // (70/28)²=6.25分 ×3 = 18.75分 → そのまま採用
    const w = computeArmWait(70, 28);
    expect(w.reason).toBe('scaled');
    expect(w.waitMs).toBe(Math.round(3 * 6.25 * 60_000));
    expect(Math.round(w.waitMs / 60_000)).toBe(19);
  });

  it('★実データ由来の3例(近距離/中距離/遠距離)で実際に何分になるか', () => {
    const min = (d: number, s: number) => Math.round(computeArmWait(d, s).waitMs / 60_000);
    // ① 近距離・普通のボラ(実データの中央値付近: 距離50円 σ40円/分) → 15分(現行と同じ)
    expect(min(50, 40)).toBe(15);
    // ② 中距離・低ボラ(実失効例: 距離70円 σ18.7円/分・15分後さらに15分で到達した回) → 30分で救える
    expect(min(70, 18.7)).toBe(30);
    // ③ 遠距離・低ボラ(実失効例: 距離160円 σ16.7円/分) → 30分(上限)
    expect(min(160, 16.7)).toBe(30);
    // ④ 遠距離でも高ボラなら伸ばさない(距離120円 σ60円/分 → (2)²=4分×3=12分 → 下限15分)
    expect(min(120, 60)).toBe(15);
  });

  it('単調性: 同じσなら距離が遠いほど待ちは短くならない', () => {
    let prev = 0;
    for (const d of [10, 30, 50, 70, 90, 120, 150, 200]) {
      const w = computeArmWait(d, 30).waitMs;
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it('下限を割らない/上限を超えない(短すぎ・長すぎを構造的に防ぐ)', () => {
    for (let d = 0; d <= 400; d += 7) {
      for (const s of [5, 15, 30, 60, 120]) {
        const w = computeArmWait(d, s).waitMs;
        expect(w).toBeGreaterThanOrEqual(ARM_WAIT_MIN_MS);
        expect(w).toBeLessThanOrEqual(ARM_WAIT_MAX_MS);
      }
    }
  });

  it('describeArmWait は「なぜこの時間か」の材料を全部含む', () => {
    const s = describeArmWait(computeArmWait(150, 20));
    expect(s).toContain('距離=150円');
    expect(s).toContain('σ=20.0円/分');
    expect(s).toContain(`×K${ARM_WAIT_K}`);
    expect(s).toContain('cap');
    expect(describeArmWait(computeArmWait(null, null))).toContain('材料不足');
  });
});

describe('armedWaitMsOf / advance が使う待ち時間', () => {
  it('waitMs 未設定は従来の一律15分(据えない呼び出し元は byte 一致)', () => {
    expect(armedWaitMsOf(undefined)).toBe(ARMED_TIMEOUT_MS);
    expect(armedWaitMsOf({})).toBe(ARMED_TIMEOUT_MS);
    expect(armedWaitMsOf({ waitMs: 0 })).toBe(ARMED_TIMEOUT_MS);
    expect(armedWaitMsOf({ waitMs: NaN })).toBe(ARMED_TIMEOUT_MS);
    expect(armedWaitMsOf({ waitMs: 25 * 60_000 })).toBe(25 * 60_000);
  });

  it('★advance: waitMs=25分のブラケットは 15分では失効せず 25分で失効する', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: {
        direction: 'buy', limitEntry: 63800, stopLossForLimit: 63750,
        rationale: 'x', at: 0, waitMs: 25 * 60_000,
      },
    };
    // 15分では armed のまま(従来なら失効していた)。
    const a = advance(st, 64000, 15 * 60_000);
    expect(a.armedTimedOut).toBeUndefined();
    expect(a.next.phase).toBe('armed');
    // 24分59秒でもまだ armed。
    expect(advance(st, 64000, 25 * 60_000 - 1).next.phase).toBe('armed');
    // 25分で失効。
    const b = advance(st, 64000, 25 * 60_000);
    expect(b.armedTimedOut).toBe(true);
    expect(b.next.phase).toBe('flat');
  });
});
