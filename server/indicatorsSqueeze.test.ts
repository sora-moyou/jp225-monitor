import { describe, it, expect } from 'vitest';
import {
  bandwidthOf, bandwidthExtremes, squeezeStateOf, computeSqueezeSeries, buildSqueezeSnapshot,
} from './indicators.js';
import { SQUEEZE_BB_PERIOD, SQUEEZE_BW_LOOKBACK } from '../core/indicatorSpec.js';

// ─── ★スクイーズ用バンド(20本/2σ)の純関数 ───────────────────────────────────
//
// 定義(仕様 docs/superpowers/specs/2026-08-15-bb-squeeze-bulge-design.md):
//   Bandwidth = (上−下)/中央 ×100
//   BWhigh/low = **現在足を含む**直近125本の最大/最小
//   スクイーズ = BW <= BWlow / バルジ = BW >= BWhigh(= 125本の新記録に達した足)
//
// ★ここで守る核心は「本数が足りない間は判定しない」こと。
//   足りない窓の最大最小は「その時点まで」でしかなく、序盤は数本で最大/最小が決まるので
//   **開始直後に必ずスクイーズかバルジになる**(無意味な発火が毎朝出る)。

describe('bandwidthOf', () => {
  it('(上−下)/中央 ×100', () => {
    expect(bandwidthOf(102, 100, 98)).toBeCloseTo(4, 10);
    expect(bandwidthOf(110, 100, 90)).toBeCloseTo(20, 10);
  });
  it('未算出・中央0以下は null', () => {
    expect(bandwidthOf(null, 100, 98)).toBeNull();
    expect(bandwidthOf(102, null, 98)).toBeNull();
    expect(bandwidthOf(102, 100, null)).toBeNull();
    expect(bandwidthOf(102, 0, 98)).toBeNull();
    expect(bandwidthOf(102, -1, 98)).toBeNull();
  });
  it('幅0(全同値)は 0(null にしない=「収縮しきっている」は観測値)', () => {
    expect(bandwidthOf(100, 100, 100)).toBe(0);
  });
});

describe('bandwidthExtremes', () => {
  it('★現在足を含む直近 lookback 本の最大・最小', () => {
    const r = bandwidthExtremes([5, 1, 3, 9, 2], 3);   // 直近3本 = [3,9,2]
    expect(r.high).toBe(9);
    expect(r.low).toBe(2);
    expect(r.ready).toBe(true);
  });
  it('本数が足りない間は「その時点まで」の最大最小 + ready:false', () => {
    const r = bandwidthExtremes([4, 6], SQUEEZE_BW_LOOKBACK);
    expect(r.high).toBe(6);
    expect(r.low).toBe(4);
    expect(r.ready).toBe(false);
  });
  it('null は無視する(算出できない足で極値が壊れない)', () => {
    const r = bandwidthExtremes([null, 7, null, 3], 4);
    expect(r.high).toBe(7);
    expect(r.low).toBe(3);
  });
  it('全部 null なら null(0 にしない)', () => {
    expect(bandwidthExtremes([null, null], 2)).toEqual({ high: null, low: null, ready: false });
  });
  it('空配列でも壊れない', () => {
    expect(bandwidthExtremes([], 125)).toEqual({ high: null, low: null, ready: false });
  });

  // ★ready は「枠の本数」ではなく「実値の本数」で数える。
  //   BW は先頭 19本(=SQUEEZE_BB_PERIOD−1)が必ず null なので、枠で数えると
  //   中身が 106本しか無いのに「125本の最小」と名乗ってしまう。
  it('★ready は非nullのBW本数で数える(先頭の null を頭数に入れない)', () => {
    const withNulls = [
      ...Array.from({ length: 19 }, () => null),
      ...Array.from({ length: 106 }, (_, i) => 1 + i * 0.01),
    ];
    expect(withNulls).toHaveLength(125);
    expect(bandwidthExtremes(withNulls, 125).ready).toBe(false);   // 枠は125だが実値は106本

    const full = [
      ...Array.from({ length: 19 }, () => null),
      ...Array.from({ length: 125 }, (_, i) => 1 + i * 0.01),
    ];
    expect(bandwidthExtremes(full, 125).ready).toBe(true);         // 実値が125本そろった
  });
});

// ─── ★実数値の固定(この系列が「別のバンド」であることを守る唯一の錨) ─────────────
//
// これまでのテストは全て **相対比較**(not.toBeNull / 大小 / 前後関係)だけで、
//   ・σ を SQUEEZE_BB_SIGMA(2) から既存の BB_SIGMA(0.7) に取り違える
//   ・BW の式を (上−下)/中央 から (上−中央)/中央 に間違える
// のどちらをやっても **全部緑のまま** だった。別系列である理由そのものが守られていない。
// 等差数列なら母集団σが解析的に出るので、期待値を手計算で書ける(=否定対照が赤くなる)。
describe('★実数値(σ と式の取り違えを捕まえる)', () => {
  it('等差数列 [100..119] の BW と %B が手計算と一致する', () => {
    // 窓 = [100,101,...,119](20本 = SQUEEZE_BB_PERIOD)
    //   中央 = (100+119)/2 = 109.5
    //   母集団σ(公差1・n=20) = √((n²−1)/12) = √33.25 = 5.766281297335398
    //   上 = 109.5 + 2σ = 121.03256259467080 / 下 = 109.5 − 2σ = 97.96743740532920
    //   BW = (上−下)/中央 ×100 = 4σ/109.5 ×100 = 21.0640412688051
    //     ※σ=0.7 なら 7.372414444081785 / 式が (上−中央)/中央 なら 10.53202063440255
    //   %B = (119 − 下)/(上 − 下) = 21.0325625946708 / 23.065125189341592 = 0.911877235523957
    //     ※σ=0.7 なら 1.6753635301398772(バンドの外)
    const r = computeSqueezeSeries(Array.from({ length: 20 }, (_, i) => 100 + i));
    expect(r.bw[19]).toBeCloseTo(21.0640412688051, 10);
    expect(r.pctB[19]).toBeCloseTo(0.911877235523957, 12);
  });

  it('bandwidthOf は (上−下)/中央 ×100(中央からの片側幅ではない)', () => {
    // 上−下 = 4 / 上−中央 = 2。片側で割る実装なら 2 が返る。
    expect(bandwidthOf(102, 100, 98)).toBeCloseTo(4, 12);
    expect(bandwidthOf(102, 100, 98)).not.toBeCloseTo(2, 6);
  });
});

// ─── ★前値が「1本前」であることの固定 ─────────────────────────────────────────
//
// prevBw / prevPctB を現在値と同じにする変異も緑のままだった。パネルの色(増加=緑/減少=橙)は
// この差だけで決まるので、同値にすると **色が常に灰** になる=画面が無言で死ぬ。
describe('★prev* は1本前の値である', () => {
  // 20本の同値(=幅0・BW=0・%B は幅0で null)の直後に1本だけ跳ねさせる。
  // 現在足の窓 = 100×19 + 120 → 平均 101 / 母集団σ = √19 = 4.358898943540674
  //   BW = 4σ/101 ×100 = 17.26296611303237
  //   %B = (120 − (101−2σ))/(4σ) = 1.5897247358851685
  const closes = [...Array.from({ length: 20 }, () => 100), 120];

  it('現在値と前値が別の足の値になっている(同値へ潰れていない)', () => {
    const s = buildSqueezeSnapshot(closes);
    expect(s.bw).toBeCloseTo(17.26296611303237, 10);
    expect(s.prevBw).toBe(0);                 // 1本前 = 全同値の窓 → 幅0
    expect(s.pctB).toBeCloseTo(1.5897247358851685, 12);
    expect(s.prevPctB).toBeNull();            // 1本前 = 幅0 → %B は定義できない
  });

  it('系列の [n-2] と厳密に一致する(2本前や現在値ではない)', () => {
    const series = computeSqueezeSeries(closes);
    const s = buildSqueezeSnapshot(closes);
    expect(s.bw).toBe(series.bw[closes.length - 1]);
    expect(s.prevBw).toBe(series.bw[closes.length - 2]);
    expect(s.pctB).toBe(series.pctB[closes.length - 1]);
    expect(s.prevPctB).toBe(series.pctB[closes.length - 2]);
  });
});

describe('squeezeStateOf', () => {
  it('BW <= low はスクイーズ / BW >= high はバルジ', () => {
    expect(squeezeStateOf(1.0, 3.0, 1.0)).toBe('squeeze');
    expect(squeezeStateOf(0.9, 3.0, 1.0)).toBe('squeeze');
    expect(squeezeStateOf(3.0, 3.0, 1.0)).toBe('bulge');
    expect(squeezeStateOf(3.1, 3.0, 1.0)).toBe('bulge');
    expect(squeezeStateOf(2.0, 3.0, 1.0)).toBeNull();
  });
  it('未算出は null', () => {
    expect(squeezeStateOf(null, 3, 1)).toBeNull();
    expect(squeezeStateOf(2, null, 1)).toBeNull();
    expect(squeezeStateOf(2, 3, null)).toBeNull();
  });

  // ★価格フィードが凍ると窓内の BW が全部同じ値になり、high === low になる。
  //   このとき bw <= low が常に成立するので、素直に書くと **永久にスクイーズに張り付く**
  //   (=止まったデータで鳴り続ける)。同値の窓には最大も最小も無いので判定しない。
  it('★high === low(窓内が全部同値=フィード凍結)なら判定しない', () => {
    expect(squeezeStateOf(2, 2, 2)).toBeNull();
    expect(squeezeStateOf(0, 0, 0)).toBeNull();
    expect(squeezeStateOf(1.5, 1.5, 1.5)).toBeNull();
  });
});

describe('computeSqueezeSeries', () => {
  it('本数不足の先頭は null、20本目から値が出る', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + (i % 3));
    const r = computeSqueezeSeries(closes);
    expect(r.bw).toHaveLength(25);
    expect(r.bw[SQUEEZE_BB_PERIOD - 2]).toBeNull();
    expect(r.bw[SQUEEZE_BB_PERIOD - 1]).not.toBeNull();
    expect(r.pctB[SQUEEZE_BB_PERIOD - 1]).not.toBeNull();
  });
  it('全同値なら幅0 → bw=0 / pctB=null(0除算を作らない)', () => {
    const r = computeSqueezeSeries(Array.from({ length: 21 }, () => 100));
    expect(r.bw[20]).toBe(0);
    expect(r.pctB[20]).toBeNull();
  });
});

describe('buildSqueezeSnapshot', () => {
  /** 前半は静か・後半は荒い系列(BW が広がる)。
   *  ★本数は 125 + 19 = 144 本以上が要る: BW の先頭 19本(SQUEEZE_BB_PERIOD−1)は必ず null で、
   *    ready は **実値** 125本で立つため(枠だけ125本あっても中身が足りない)。 */
  const closes = Array.from({ length: 145 }, (_, i) => 100 + Math.sin(i / 2) * (i < 70 ? 0.5 : 6));

  it('★確定足の系列から現在値・前値・極値を出す', () => {
    const s = buildSqueezeSnapshot(closes);
    expect(s.bw).not.toBeNull();
    expect(s.prevBw).not.toBeNull();
    expect(s.pctB).not.toBeNull();
    expect(s.bwHigh! >= s.bw!).toBe(true);
    expect(s.bwLow! <= s.bw!).toBe(true);
    expect(s.ready).toBe(true);
  });

  it('★本数が足りない間は ready:false かつ state は必ず null(毎朝の誤発火を作らない)', () => {
    const s = buildSqueezeSnapshot([100, 101, 102]);
    expect(s.ready).toBe(false);
    expect(s.state).toBeNull();
    const s2 = buildSqueezeSnapshot(Array.from({ length: 30 }, (_, i) => 100 + i % 2));
    expect(s2.ready).toBe(false);       // 125本に満たない
    expect(s2.state).toBeNull();
  });

  it('★実値125本が揃っていれば、最大に達した足でバルジになる', () => {
    // 最後の足で幅が最大になるよう、末尾だけ大きく振らせる。
    const c = Array.from({ length: 145 }, (_, i) => 100 + (i % 2 ? 0.2 : -0.2));
    c[144] = 200;
    const s = buildSqueezeSnapshot(c);
    expect(s.ready).toBe(true);
    expect(s.state).toBe('bulge');
  });

  it('t を渡すと最後の確定足の時刻が入る', () => {
    const times = closes.map((_, i) => 1_700_000_000_000 + i * 300_000);
    const s = buildSqueezeSnapshot(closes, times);
    expect(s.t).toBe(times[times.length - 1]);
  });

  // ★computeIndicators は times.length === closes.length を検証している。
  //   同じファイルの片方だけ検証しないと、呼び出し側から見た契約が非対称になり、
  //   長さがずれたときに **別の足の時刻を無言で貼り付ける**(いつの値か分からなくなる)。
  it('★times の長さが closes と違うときは t を付けない(別の足の時刻を貼らない)', () => {
    const times = closes.map((_, i) => 1_700_000_000_000 + i * 300_000);
    expect(buildSqueezeSnapshot(closes, times.slice(0, 10)).t).toBeUndefined();
    expect(buildSqueezeSnapshot(closes, [...times, 1]).t).toBeUndefined();
    expect(buildSqueezeSnapshot([], []).t).toBeUndefined();
    // 長さが合っていれば従来どおり付く(検証を入れて機能を殺していないこと)。
    expect(buildSqueezeSnapshot(closes, times).t).toBe(times[times.length - 1]);
  });
});
