import { describe, it, expect } from 'vitest';
import {
  bandwalkDirOf, buildBandwalkSamples, evaluateBandwalk, describeBandwalk,
  createBandwalkFireState, shouldFireBandwalk, bandwalkBiasAllows, DEFAULT_BANDWALK,
  type BandwalkSample, type BandwalkParams,
} from './bandwalk.js';
import { DEFAULT_SHOCK_PARAMS } from './shockDetector.js';

// バンドウォーク判定(占有率 + 窓の純粋性 + 逆方向の急変で打ち切り + 目線一致)の純関数テスト。
// 「非成立側の挙動」を固定するのが主目的(バンドウォークでないときに何も起きないこと)。

const MIN = 60_000;
const T0 = 1_800_000_000_000;   // 5分境界に乗る適当な基準時刻
const P: BandwalkParams = { windowBars: 6, minRatio: 0.7, minBars: 4, cooldownMs: 30 * MIN };

/** 観測列を「向きの文字列」から作る簡易ヘルパ。u=up 成立 / d=down 成立 / '-'=非成立。 */
function samples(pattern: string, opts: { shockUpAt?: number[]; shockDownAt?: number[] } = {}): BandwalkSample[] {
  return [...pattern].map((ch, i) => ({
    t: T0 + i * 5 * MIN,
    close: 40_000 + i,
    rsi: ch === 'u' ? 60 : ch === 'd' ? 40 : 50,
    upper: 40_100, lower: 39_900,
    dir: ch === 'u' ? 'up' : ch === 'd' ? 'down' : null,
    shockUp: (opts.shockUpAt ?? []).includes(i),
    shockDown: (opts.shockDownAt ?? []).includes(i),
  } as BandwalkSample));
}

describe('bandwalkDirOf(1本ぶんの条件)', () => {
  it('RSI≥50 かつ 終値≥上限 → up / RSI≤50 かつ 終値≤下限 → down', () => {
    expect(bandwalkDirOf(101, 55, 100, 90)).toBe('up');
    expect(bandwalkDirOf(89, 45, 100, 90)).toBe('down');
  });
  it('境界(ちょうど50 / ちょうどバンド上)は成立側に含める', () => {
    expect(bandwalkDirOf(100, 50, 100, 90)).toBe('up');    // RSI=50 ちょうど + 上限ちょうど
    expect(bandwalkDirOf(90, 50, 100, 90)).toBe('down');   // RSI=50 ちょうど + 下限ちょうど
  });
  it('バンド内 / 指標未算出は null', () => {
    expect(bandwalkDirOf(95, 60, 100, 90)).toBeNull();
    expect(bandwalkDirOf(101, null, 100, 90)).toBeNull();
    expect(bandwalkDirOf(101, 60, null, 90)).toBeNull();
  });
});

describe('evaluateBandwalk', () => {
  // ★目線(scalpBias)の3値分岐(ユーザー確定仕様)。ここが今回いちばん取り違えやすい所なので、
  //   3値 × 上下 の6通りを全部固定する。
  it("目線='long'(買い目線)は上のバンドウォークだけ成立し、下は成立しない", () => {
    expect(evaluateBandwalk(samples('uuuuuu'), 'long', P)?.direction).toBe('up');
    expect(evaluateBandwalk(samples('dddddd'), 'long', P)).toBeNull();
  });

  it("目線='short'(売り目線)は下のバンドウォークだけ成立し、上は成立しない", () => {
    expect(evaluateBandwalk(samples('dddddd'), 'short', P)?.direction).toBe('down');
    expect(evaluateBandwalk(samples('uuuuuu'), 'short', P)).toBeNull();
  });

  it("★目線='none'(未設定/AI委任)は方向一致を問わない=上下どちらも成立する", () => {
    expect(evaluateBandwalk(samples('uuuuuu'), 'none', P)?.direction).toBe('up');
    expect(evaluateBandwalk(samples('dddddd'), 'none', P)?.direction).toBe('down');
  });

  it('bandwalkBiasAllows: 3値 × 上下 の6通り', () => {
    expect(bandwalkBiasAllows('long', 'up')).toBe(true);
    expect(bandwalkBiasAllows('long', 'down')).toBe(false);
    expect(bandwalkBiasAllows('short', 'up')).toBe(false);
    expect(bandwalkBiasAllows('short', 'down')).toBe(true);
    expect(bandwalkBiasAllows('none', 'up')).toBe(true);
    expect(bandwalkBiasAllows('none', 'down')).toBe(true);
  });

  it("目線='none' でも「上下が同時に成立」することは無い(純粋性が排他を保証する)", () => {
    // 上下が混在する窓はどちらの向きでも純粋性で落ちる=曖昧な二重成立が起きない。
    expect(evaluateBandwalk(samples('uuuddd'), 'none', P)).toBeNull();
  });

  it('占有率が閾値未満なら不成立', () => {
    // 6本中4本=0.67 < 0.7
    expect(evaluateBandwalk(samples('u-u-uu'), 'long', P)).toBeNull();
    // 6本中5本=0.83 ≥ 0.7
    const bw = evaluateBandwalk(samples('u-uuuu'), 'long', P);
    expect(bw?.ratio).toBeCloseTo(5 / 6);
    expect(bw?.bars).toBe(6);
  });

  it('★窓に逆向きが1本でも混じれば不成立(純粋性・ユーザー確定仕様)', () => {
    // 占有率だけなら 5/6=0.83 で成立するが、下の成立が1本あるので落とす。
    expect(evaluateBandwalk(samples('uuuuud'), 'long', P)).toBeNull();
    expect(evaluateBandwalk(samples('duuuuu'), 'long', P)).toBeNull();
  });

  it('★逆方向の急変で窓を打ち切る(急変=判断の打ち切り)。残りが minBars 未満なら不成立', () => {
    // index2 に下向きの急変 → 以降(index3..5)の3本しか数えられず minBars=4 に足りない。
    expect(evaluateBandwalk(samples('uuuuuu', { shockDownAt: [2] }), 'long', P)).toBeNull();
    // index1 の急変なら残り4本 → 成立(占有率 4/4)。
    const bw = evaluateBandwalk(samples('uuuuuu', { shockDownAt: [1] }), 'long', P);
    expect(bw?.bars).toBe(4);
    expect(bw?.ratio).toBe(1);
  });

  it('順方向の急変では打ち切らない(バンドウォークを壊す動きではない)', () => {
    const bw = evaluateBandwalk(samples('uuuuuu', { shockUpAt: [2] }), 'long', P);
    expect(bw?.bars).toBe(6);
  });

  it('足が連続していない(セッション跨ぎ/欠測)ところで窓を打ち切る', () => {
    const s = samples('uuuuuu');
    s[2]!.t -= 60 * MIN;   // 3本目より前に大きな穴 → 窓は末尾3本だけ → minBars 未満
    expect(evaluateBandwalk(s, 'long', P)).toBeNull();
  });

  it('本数が minBars 未満なら不成立', () => {
    expect(evaluateBandwalk(samples('uuu'), 'long', P)).toBeNull();
  });

  it('最新足の指標が未算出なら不成立', () => {
    const s = samples('uuuuuu');
    s[s.length - 1]!.rsi = null;
    expect(evaluateBandwalk(s, 'long', P)).toBeNull();
  });

  it('空配列でも落ちない', () => {
    expect(evaluateBandwalk([], 'long', P)).toBeNull();
  });
});

describe('shouldFireBandwalk(発火の抑制)', () => {
  it('非成立→成立 で1回だけ鳴り、継続中は鳴らない', () => {
    const st = createBandwalkFireState();
    const bw = evaluateBandwalk(samples('uuuuuu'), 'long', P)!;
    expect(shouldFireBandwalk(st, bw, P)).toBe(true);
    expect(shouldFireBandwalk(st, { ...bw, t: bw.t + 5 * MIN }, P)).toBe(false);
  });

  it('クールダウン内の同方向の再成立は鳴らない / 超えたら鳴る', () => {
    const st = createBandwalkFireState();
    const bw = evaluateBandwalk(samples('uuuuuu'), 'long', P)!;
    expect(shouldFireBandwalk(st, bw, P)).toBe(true);
    shouldFireBandwalk(st, null, P);                                    // いったん解除
    expect(shouldFireBandwalk(st, { ...bw, t: bw.t + 10 * MIN }, P)).toBe(false);
    shouldFireBandwalk(st, null, P);
    expect(shouldFireBandwalk(st, { ...bw, t: bw.t + 31 * MIN }, P)).toBe(true);
  });

  it('非成立(null)では鳴らず、状態も解除される', () => {
    const st = createBandwalkFireState();
    expect(shouldFireBandwalk(st, null, P)).toBe(false);
    expect(st.active).toBeNull();
  });
});

describe('buildBandwalkSamples(1分足 → 確定5分足の観測列)', () => {
  /** 一定の傾きで上がる1分足。n 本。 */
  function rising(n: number, step = 6): { t: number; o: number; h: number; l: number; c: number }[] {
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = 40_000 + i * step;
      out.push({ t: T0 + i * MIN, o: c, h: c + 1, l: c - 1, c });
    }
    return out;
  }
  it('形成中の最後の5分足は落とす(確定足だけを返す)', () => {
    const s = buildBandwalkSamples(rising(100), 5, DEFAULT_SHOCK_PARAMS);
    expect(s.length).toBe(5);
    // 100本=20本の5分足 → 確定19本。末尾の確定足は index18(=T0+90分)。
    expect(s[s.length - 1]!.t).toBe(T0 + 18 * 5 * MIN);
  });
  it('単調上昇では上のバンドウォークが成立する(本番の算出経路で end-to-end)', () => {
    const s = buildBandwalkSamples(rising(200), DEFAULT_BANDWALK.windowBars, DEFAULT_SHOCK_PARAMS);
    const bw = evaluateBandwalk(s, 'long', DEFAULT_BANDWALK);
    expect(bw?.direction).toBe('up');
    expect(describeBandwalk(bw!)).toContain('上昇バンドウォーク継続中');
    // ★売り目線では同じデータでも成立しない / 目線なしでは成立する。
    expect(evaluateBandwalk(s, 'short', DEFAULT_BANDWALK)).toBeNull();
    expect(evaluateBandwalk(s, 'none', DEFAULT_BANDWALK)?.direction).toBe('up');
  });
  it('足が無ければ空配列(落ちない)', () => {
    expect(buildBandwalkSamples([], 12)).toEqual([]);
  });
});
