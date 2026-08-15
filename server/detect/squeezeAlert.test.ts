import { describe, it, expect } from 'vitest';
import { squeezeEdge, squeezeFire, describeSqueeze, createLevelDetectState } from './registry.js';
import { buildSqueezeSnapshot, type SqueezeSnapshot } from '../indicators.js';
import { SQUEEZE_BB_PERIOD, SQUEEZE_BW_LOOKBACK } from '../../core/indicatorSpec.js';

// スクイーズ/バルジ アラートの発火規則(仕様 第3章・第4章)。
//
// 状態の定義(BW <= BWlow = スクイーズ / BW >= BWhigh = バルジ)は server/indicators.ts が SSOT で、
// そちらは server/indicatorsSqueeze.test.ts が固定している。ここが固定するのは **いつ鳴らすか**:
//   ①状態に **入った足** で1回だけ(同じ状態が続く間は鳴らさない/抜けたことは通知しない)
//   ②同種別は 30分 再発火しない(実測 193日/参照72本: 状態に入る足は 5.9回/日、最長19本=95分 張り付く)
//   ③ready:false(参照本数 SQUEEZE_BW_LOOKBACK 本が未充足)の間は **絶対に** 鳴らさない

const T0 = 1_770_000_000_000;   // 5分境界に乗った適当な基準時刻
const MIN = 60_000;

/** 手で組んだスナップショット(既定 = 参照本数の最小に触れた確定足)。 */
function snap(over: Partial<SqueezeSnapshot> = {}): SqueezeSnapshot {
  return {
    pctB: 0.31, prevPctB: 0.44, bw: 0.14, prevBw: 0.19,
    bwHigh: 0.82, bwLow: 0.14, ready: true, state: 'squeeze', t: T0,
    ...over,
  };
}

describe('squeezeEdge — 状態に入った足だけ', () => {
  it('null → squeeze で発火', () => { expect(squeezeEdge(null, 'squeeze')).toBe('squeeze'); });
  it('squeeze → squeeze は発火しない(連続で板を埋めない)', () => { expect(squeezeEdge('squeeze', 'squeeze')).toBeNull(); });
  it('squeeze → bulge は発火する', () => { expect(squeezeEdge('squeeze', 'bulge')).toBe('bulge'); });
  it('squeeze → null は発火しない(抜けたことは通知しない)', () => { expect(squeezeEdge('squeeze', null)).toBeNull(); });
  it('null → null / bulge → bulge も発火しない', () => {
    expect(squeezeEdge(null, null)).toBeNull();
    expect(squeezeEdge('bulge', 'bulge')).toBeNull();
  });
  it('bulge → squeeze は発火する(逆向きの遷移も対称)', () => { expect(squeezeEdge('bulge', 'squeeze')).toBe('squeeze'); });
});

describe('squeezeFire — 確定足ごとの発火', () => {
  it('新しい確定足でだけ評価する(同じ足を二度評価しても二度鳴らない)', () => {
    const st = createLevelDetectState();
    expect(squeezeFire(st, snap({ t: T0 }), T0)).toBe('squeeze');
    // 同じ t の再評価(7日窓の読み直しが同じ足に当たった場合)は無発火。
    expect(squeezeFire(st, snap({ t: T0 }), T0 + 8_000)).toBeNull();
    // 過去の足(足が巻き戻る=データ補正)も無発火。
    expect(squeezeFire(st, snap({ t: T0 - 5 * MIN }), T0 + 16_000)).toBeNull();
  });

  it('同じ状態が続く足では鳴らない / 別の状態に入った足で鳴る', () => {
    const st = createLevelDetectState();
    expect(squeezeFire(st, snap({ t: T0 }), T0)).toBe('squeeze');
    expect(squeezeFire(st, snap({ t: T0 + 5 * MIN }), T0 + 5 * MIN)).toBeNull();          // squeeze 継続
    expect(squeezeFire(st, snap({ t: T0 + 10 * MIN, state: null }), T0 + 10 * MIN)).toBeNull();   // 抜けた
    // 抜けた直後に反対側(bulge)へ入る: 種別が違うのでクールダウンに掛からず鳴る。
    expect(squeezeFire(st, snap({ t: T0 + 15 * MIN, state: 'bulge' }), T0 + 15 * MIN)).toBe('bulge');
  });

  it('★同種別は30分クールダウン(同じ収縮局面で出入りしても鳴り続けない)', () => {
    const st = createLevelDetectState();
    expect(squeezeFire(st, snap({ t: T0 }), T0)).toBe('squeeze');
    // 抜けて → 20分後に入り直す: 遷移(edge)は成立しているがクールダウン内なので出さない。
    expect(squeezeFire(st, snap({ t: T0 + 10 * MIN, state: null }), T0 + 10 * MIN)).toBeNull();
    expect(squeezeFire(st, snap({ t: T0 + 20 * MIN }), T0 + 20 * MIN)).toBeNull();
    // ちょうど30分でもまだ出さない(境界は「30分を超えたら」)。
    expect(squeezeFire(st, snap({ t: T0 + 25 * MIN, state: null }), T0 + 25 * MIN)).toBeNull();
    expect(squeezeFire(st, snap({ t: T0 + 30 * MIN }), T0 + 30 * MIN)).toBeNull();
    // 30分を超えた入り直しは鳴る。
    expect(squeezeFire(st, snap({ t: T0 + 35 * MIN, state: null }), T0 + 35 * MIN)).toBeNull();
    expect(squeezeFire(st, snap({ t: T0 + 40 * MIN }), T0 + 40 * MIN)).toBe('squeeze');
  });

  it('クールダウンは種別ごと(スクイーズを抑えている間もバルジは鳴る)', () => {
    const st = createLevelDetectState();
    expect(squeezeFire(st, snap({ t: T0 }), T0)).toBe('squeeze');
    expect(squeezeFire(st, snap({ t: T0 + 5 * MIN, state: 'bulge' }), T0 + 5 * MIN)).toBe('bulge');
    expect(squeezeFire(st, snap({ t: T0 + 10 * MIN, state: 'squeeze' }), T0 + 10 * MIN)).toBeNull();   // squeeze はまだ30分内
  });

  it('★ready:false の間は絶対に鳴らない(state が入っていても捨てる)', () => {
    const st = createLevelDetectState();
    // 本数不足の窓は最大/最小が数本で決まるので、素通しすると毎朝かならずどちらかで鳴る。
    expect(squeezeFire(st, snap({ t: T0, ready: false, state: 'squeeze' }), T0)).toBeNull();
    expect(squeezeFire(st, snap({ t: T0 + 5 * MIN, ready: false, state: 'bulge' }), T0 + 5 * MIN)).toBeNull();
    // ready になった最初の足では(直前が null 扱いなので)ちゃんと鳴る。
    expect(squeezeFire(st, snap({ t: T0 + 10 * MIN, ready: true, state: 'squeeze' }), T0 + 10 * MIN)).toBe('squeeze');
  });

  it('t を持たないスナップショット(足0本)では鳴らない', () => {
    const st = createLevelDetectState();
    expect(squeezeFire(st, buildSqueezeSnapshot([], []), T0)).toBeNull();
  });

  it('クールダウンで抑えた回も「状態は移った」として記録する(復帰直後に二重で鳴らない)', () => {
    const st = createLevelDetectState();
    expect(squeezeFire(st, snap({ t: T0 }), T0)).toBe('squeeze');
    expect(squeezeFire(st, snap({ t: T0 + 5 * MIN, state: null }), T0 + 5 * MIN)).toBeNull();
    expect(squeezeFire(st, snap({ t: T0 + 10 * MIN }), T0 + 10 * MIN)).toBeNull();       // 抑制(prev='squeeze' へ)
    // 40分後も同じ状態が続いているだけ=遷移が無いので、クールダウンが明けても鳴らない。
    expect(squeezeFire(st, snap({ t: T0 + 40 * MIN }), T0 + 40 * MIN)).toBeNull();
  });
});

describe('describeSqueeze — アラート文', () => {
  it('スクイーズは「最小」、値は小数2桁、価格は3桁区切り', () => {
    const s = snap({ bw: 0.14, bwHigh: 0.82, bwLow: 0.14 });
    expect(describeSqueeze('squeeze', s, 69_120))
      .toBe(`スクイーズ — BB幅が${SQUEEZE_BW_LOOKBACK}本の最小(BW 0.14 / 高安 0.82/0.14) 69,120円`);
  });
  it('バルジは「最大」', () => {
    const s = snap({ bw: 0.82, bwHigh: 0.82, bwLow: 0.14, state: 'bulge' });
    expect(describeSqueeze('bulge', s, 69_310))
      .toBe(`バルジ — BB幅が${SQUEEZE_BW_LOOKBACK}本の最大(BW 0.82 / 高安 0.82/0.14) 69,310円`);
  });
});

// ─── 実系列(手で組んだスナップショットではない)での通し ───────────────────────────
// buildSqueezeSnapshot に確定足の close 列を1本ずつ足していく = 本番の detector と同じ入力の作り方。
describe('通し: 実際の close 列を1本ずつ流す', () => {
  /** 振れ幅が縮んでいく系列。序盤(ready:false)から終盤(ready:true)までを1本ずつ評価する。 */
  function run(closes: number[], cooldownMs?: number): {
    fires: { t: number; at: number; kind: string; ready: boolean }[]; readyFrom: number;
  } {
    const st = createLevelDetectState();
    const fires: { t: number; at: number; kind: string; ready: boolean }[] = [];
    let readyFrom = -1;
    for (let i = 1; i <= closes.length; i++) {
      const prefix = closes.slice(0, i);
      const times = prefix.map((_, j) => T0 + j * 5 * MIN);
      const s = buildSqueezeSnapshot(prefix, times);
      if (s.ready && readyFrom < 0) readyFrom = i;
      const now = times[times.length - 1]!;
      const fired = cooldownMs === undefined ? squeezeFire(st, s, now) : squeezeFire(st, s, now, cooldownMs);
      if (fired) fires.push({ t: i, at: now, kind: fired, ready: s.ready });
    }
    return { fires, readyFrom };
  }

  /** 振幅が縮みつつ揺れる系列(= 状態に入ったり抜けたりする)。 */
  const CLOSES = Array.from({ length: 260 }, (_, i) => 40_000 + Math.sin(i / 2) * Math.max(2, 300 - i));

  it('★ready になる前(=本数不足の間)は1回も鳴らない', () => {
    // ready 前の窓では「その時点までの最小」に毎回触れるので、ready を見ずに素通しすると序盤から鳴る。
    const { fires, readyFrom } = run(CLOSES);
    expect(readyFrom).toBe(SQUEEZE_BW_LOOKBACK + SQUEEZE_BB_PERIOD - 1);   // 参照本数 + BW先頭の欠測19本 から ready
    expect(fires.length).toBeGreaterThan(0);                                // 鳴らないテストではない
    expect(fires.every(f => f.ready)).toBe(true);
    expect(fires.every(f => f.t >= readyFrom)).toBe(true);
  });

  it('★同種別の発火間隔は必ず30分超(クールダウンが実系列でも効く)', () => {
    const { fires } = run(CLOSES);
    const lastByKind = new Map<string, number>();
    for (const f of fires) {
      const prev = lastByKind.get(f.kind);
      if (prev !== undefined) expect(f.at - prev).toBeGreaterThan(30 * MIN);
      lastByKind.set(f.kind, f.at);
    }
  });

  it('★否定対照: クールダウンを0にすると同じ系列で発火数が増える', () => {
    const withCd = run(CLOSES).fires.length;
    const noCd = run(CLOSES, 0).fires.length;
    expect(noCd).toBeGreaterThan(withCd);
  });
});
