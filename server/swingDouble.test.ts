import { describe, it, expect } from 'vitest';
import {
  detectSwingDouble, DEFAULT_SWING_DOUBLE, passesDoubleBandConditions,
  DOUBLE_BW_PEAK_RATIO, DOUBLE_BAND_RULES_ALL,
  type DoubleBandStats, type DoubleBandLookup,
} from './swingDouble.js';
import type { SwingPivot } from './swingPivots.js';

const M = 60_000;
const lo = (i: number, price: number): SwingPivot => ({ kind: 'low', price, t: i * M });
const hi = (i: number, price: number): SwingPivot => ({ kind: 'high', price, t: i * M });

// ★'unchecked' = 帯条件(第6章)を評価しない明示の指定。**幾何の回帰テスト**はここを使う
//   (幾何と帯を混ぜると、どちらが落としたのか分からないテストになる)。帯条件は下の describe で固定する。
const NO_BANDS = 'unchecked' as const;

describe('detectSwingDouble', () => {
  // ユーザー実例: 谷 66950 → ネック 67770 → 谷 66930、現値 67790(ネック上抜け)
  const example: SwingPivot[] = [hi(0, 68085), lo(1, 66950), hi(2, 67770), lo(3, 66930)];

  it('ダブルボトム成立: ネック上抜けで breakout(谷差が小さくてもOK)', () => {
    const s = detectSwingDouble(example, 67790, NO_BANDS);
    expect(s?.kind).toBe('bottom');
    expect(s?.stage).toBe('breakout');
    expect(s?.neck).toBe(67770);
    expect(s?.legs).toEqual([66950, 66930]);
    expect(s?.target).toBe(67770 + (67770 - 66950));   // 浅い方(66950)基準 = 68590
  });

  it('ダブルボトム形成中: 現値がネック未満なら forming', () => {
    expect(detectSwingDouble(example, 67500, NO_BANDS)?.stage).toBe('forming');
  });

  // ダブルは2つの脚が「ほぼ同じ高さ」でなければ人間の認識と乖離する(谷64,455→63,755=差700の
  // 切り下げを「ダブルボトム」と誤検知していた)。谷差は突出(ネックの高さ)に対する比率で判定する。
  it('谷差が突出に対して大きすぎる(切り下げ/切り上げ)なら null', () => {
    // 谷1=64455, 谷2=63755(差700・切り下げ)。ネック65090、浅い方=64455、突出=635。
    // 比率 700/635=1.10 > 0.4 → 非ダブル(ユーザー実例)。
    const piv: SwingPivot[] = [hi(0, 65800), lo(1, 64455), hi(2, 65090), lo(3, 63755)];
    expect(detectSwingDouble(piv, 64365, NO_BANDS)).toBeNull();
  });
  it('谷がほぼ同じ高さ(突出比 ≤ lowTolRatio=0.08)なら成立', () => {
    // 谷1=66000, 谷2=66050(差50)。ネック67000、浅い方=66050、突出=950。比率50/950=0.053 ≤ 0.08 → OK。
    const piv: SwingPivot[] = [hi(0, 68000), lo(1, 66000), hi(2, 67000), lo(3, 66050)];
    expect(detectSwingDouble(piv, 66800, NO_BANDS)?.stage).toBe('forming');
  });
  it('谷差が突出の8%を超えれば null(やや不揃いでも厳格に弾く)', () => {
    // 谷1=66000, 谷2=66150(差150)。突出=850。比率150/850=0.176 > 0.08 → null。
    const piv: SwingPivot[] = [hi(0, 68000), lo(1, 66000), hi(2, 67000), lo(3, 66150)];
    expect(detectSwingDouble(piv, 66800, NO_BANDS)).toBeNull();
  });

  it('ネックの突出が minProminence 未満なら null(浅いW=ノイズ)', () => {
    const flat: SwingPivot[] = [hi(0, 67100), lo(1, 67000), hi(2, 67050), lo(3, 67000)];  // 突出50<150
    expect(detectSwingDouble(flat, 67060, NO_BANDS)).toBeNull();
  });

  it('現値が谷を割ったら(パターン破壊)null', () => {
    expect(detectSwingDouble(example, 66800, NO_BANDS)).toBeNull();   // 66800 < min(66950,66930)
  });

  it('ダブルトップ成立: ネック下抜けで breakout', () => {
    const top: SwingPivot[] = [lo(0, 66000), hi(1, 67800), lo(2, 67000), hi(3, 67820)];
    const s = detectSwingDouble(top, 66990, NO_BANDS);
    expect(s?.kind).toBe('top');
    expect(s?.stage).toBe('breakout');
    expect(s?.neck).toBe(67000);
    expect(s?.target).toBe(67000 - (67800 - 67000));   // 浅い方の山(67800)基準
  });

  it('最後のピボットが山(=ボトム形成中でない)ならボトムは出ない', () => {
    const piv: SwingPivot[] = [lo(0, 66950), hi(1, 67770), lo(2, 66930), hi(3, 67900)];
    expect(detectSwingDouble(piv, 67950, NO_BANDS)?.kind).not.toBe('bottom');
  });

  it('ガード: ピボット3本未満 / 現値<=0 は null', () => {
    expect(detectSwingDouble([lo(0, 1), hi(1, 2)], 3, NO_BANDS)).toBeNull();
    expect(detectSwingDouble(example, 0, NO_BANDS)).toBeNull();
  });

  // 決着済みガード: ネックを大きく抜けて測定移動の目標に到達したら、もう「認識できる」
  // setup ではない(古いブレイクの再発火)。actionable=ネック近傍だけ通知する。
  describe('決着済みガード(目標到達で打ち切り)', () => {
    // example: neck 67770, 浅い谷 66950, 突出 820, target 68590
    it('ダブルボトム: 目標(68590)以上では null', () => {
      expect(detectSwingDouble(example, 68590, NO_BANDS)).toBeNull();
      expect(detectSwingDouble(example, 68700, NO_BANDS)).toBeNull();
    });
    it('ダブルボトム: 目標手前のブレイクは breakout のまま', () => {
      expect(detectSwingDouble(example, 68500, NO_BANDS)?.stage).toBe('breakout');
      expect(detectSwingDouble(example, 67790, NO_BANDS)?.stage).toBe('breakout');
    });
    it('ダブルトップ: 目標(66200)以下では null', () => {
      // neck 67000, 浅い山 67800, 突出 800, target 66200
      const top: SwingPivot[] = [lo(0, 66000), hi(1, 67800), lo(2, 67000), hi(3, 67820)];
      expect(detectSwingDouble(top, 66200, NO_BANDS)).toBeNull();
      expect(detectSwingDouble(top, 66000, NO_BANDS)).toBeNull();
      expect(detectSwingDouble(top, 66300, NO_BANDS)?.stage).toBe('breakout');
    });
    it('breakoutExtensionRatio を狭めると、より早く打ち切る', () => {
      // ratio 0.5 → 目標の半分(neck+410=68180)以上で null
      expect(detectSwingDouble(example, 68200, NO_BANDS, { ...DEFAULT_SWING_DOUBLE, breakoutExtensionRatio: 0.5 })).toBeNull();
      expect(detectSwingDouble(example, 68000, NO_BANDS, { ...DEFAULT_SWING_DOUBLE, breakoutExtensionRatio: 0.5 })?.stage).toBe('breakout');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  ★第6章の帯条件(2026-08-16)— 表で固定する
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ボトム: ①右谷の %B > 0 ②左谷の %B < 右谷の %B ③左谷の BW ≥ BWhigh × 0.5
// トップ: ①右山の %B < 1 ②左山の %B > 右山の %B ③同上
//   ※③の比率は DOUBLE_BW_PEAK_RATIO(2026-08-16 に 0.9 → 0.5)。**この見出しに数値を手書きしている**ので、
//     定数を動かしたら必ずここも直すこと(直し忘れると、次に読む人はこの行を仕様と読む)。
//
// 境界値を必ず含める: %B が **ちょうど 0 / ちょうど 1**、左右の %B が **同値**、
// BW が BWhigh の **ちょうど 50%**。ここは「>」か「≥」かで挙動が反転する場所なので、
// 文章ではなく表で固定しないと後から静かに変わる。

const st = (pctB: number | null, bw: number | null, bwHigh: number | null, bwReady = true): DoubleBandStats =>
  ({ pctB, bw, bwHigh, bwReady });

// ③を満たす左脚(BW 9.0 / BWhigh 10.0 = BWhigh比 90% ≥ 閾値 50%)。①②の検査で③を巻き込まないための土台。
// ★90% は閾値ではなくこのフィクスチャの実値。閾値を上げても③を満たし続けるよう余裕を持たせてある。
const wideLeft = (pctB: number | null): DoubleBandStats => st(pctB, 9.0, 10.0);

describe('passesDoubleBandConditions(第6章の帯条件)', () => {
  describe('①右脚がバンドの内側', () => {
    it('ボトム: 右谷の %B > 0 なら通る', () => {
      expect(passesDoubleBandConditions('bottom', wideLeft(-0.10), st(0.05, 5, 10))).toBe(true);
    });
    it('ボトム境界: 右谷の %B が **ちょうど 0**(=下限バンドそのもの)は通さない', () => {
      expect(passesDoubleBandConditions('bottom', wideLeft(-0.10), st(0, 5, 10))).toBe(false);
    });
    it('ボトム: 右谷がバンドの外(%B < 0)なら通さない', () => {
      expect(passesDoubleBandConditions('bottom', wideLeft(-0.30), st(-0.05, 5, 10))).toBe(false);
    });
    it('トップ: 右山の %B < 1 なら通る / **ちょうど 1** は通さない', () => {
      expect(passesDoubleBandConditions('top', wideLeft(1.10), st(0.95, 5, 10))).toBe(true);
      expect(passesDoubleBandConditions('top', wideLeft(1.10), st(1, 5, 10))).toBe(false);
      expect(passesDoubleBandConditions('top', wideLeft(1.30), st(1.05, 5, 10))).toBe(false);
    });
  });

  describe('②左脚のほうが外側', () => {
    it('ボトム: 左 %B < 右 %B なら通る', () => {
      expect(passesDoubleBandConditions('bottom', wideLeft(0.02), st(0.20, 5, 10))).toBe(true);
    });
    it('ボトム境界: 左右の %B が **同値** なら通さない(厳密な <)', () => {
      expect(passesDoubleBandConditions('bottom', wideLeft(0.20), st(0.20, 5, 10))).toBe(false);
    });
    it('ボトム: 左のほうが内側(左 > 右)なら通さない', () => {
      expect(passesDoubleBandConditions('bottom', wideLeft(0.40), st(0.20, 5, 10))).toBe(false);
    });
    it('トップ: 左 %B > 右 %B なら通る / 同値・逆は通さない', () => {
      expect(passesDoubleBandConditions('top', wideLeft(0.98), st(0.80, 5, 10))).toBe(true);
      expect(passesDoubleBandConditions('top', wideLeft(0.80), st(0.80, 5, 10))).toBe(false);
      expect(passesDoubleBandConditions('top', wideLeft(0.60), st(0.80, 5, 10))).toBe(false);
    });
  });

  // ★2026-08-16 に既定を 0.9 → 0.5 へ緩めた(境界の数値もそれに合わせて書き換えている)。
  //   理由は swingDouble.ts の DOUBLE_BW_PEAK_RATIO の注記を参照(売買を落としアラート専用に確定したため)。
  describe('③左脚の BW がピーク付近(BWhigh の 50%以上)', () => {
    it('境界: BW が BWhigh の **ちょうど 50%** は通る(≥)', () => {
      expect(passesDoubleBandConditions('bottom', st(-0.1, 5.0, 10.0), st(0.2, 5, 10))).toBe(true);
    });
    it('50% をわずかに下回れば通さない', () => {
      expect(passesDoubleBandConditions('bottom', st(-0.1, 4.999, 10.0), st(0.2, 5, 10))).toBe(false);
    });
    it('BW が BWhigh を超えている(=そのものがピーク)なら通る', () => {
      expect(passesDoubleBandConditions('bottom', st(-0.1, 10.0, 10.0), st(0.2, 5, 10))).toBe(true);
    });
    // ★旧値 0.9 を引数で渡す形にしてある = 既定値が式に焼き込まれていたら、この2行のどちらかが落ちる。
    it('比率は引数で動く(0.9 を渡せば BWhigh の 50% では通らない)', () => {
      expect(passesDoubleBandConditions('bottom', st(-0.1, 9.0, 10.0), st(0.2, 5, 10), 0.9)).toBe(true);
      expect(passesDoubleBandConditions('bottom', st(-0.1, 5.0, 10.0), st(0.2, 5, 10), 0.9)).toBe(false);
    });
    it('既定の比率は 0.5', () => { expect(DOUBLE_BW_PEAK_RATIO).toBe(0.5); });
  });

  describe('欠測は不成立(確かめられないものを通さない)', () => {
    it('帯が引けない足(null)は false', () => {
      expect(passesDoubleBandConditions('bottom', null, st(0.2, 5, 10))).toBe(false);
      expect(passesDoubleBandConditions('bottom', wideLeft(-0.1), null)).toBe(false);
    });
    it('%B が null(バンド幅0/本数不足)なら false', () => {
      expect(passesDoubleBandConditions('bottom', wideLeft(null), st(0.2, 5, 10))).toBe(false);
      expect(passesDoubleBandConditions('bottom', wideLeft(-0.1), st(null, 5, 10))).toBe(false);
    });
    it('BWhigh の参照本数が足りない(bwReady=false)なら false', () => {
      // ★ここを通すと「数本しか無い窓の最大」を BWhigh と名乗ることになり、③はほぼ常に成立する。
      expect(passesDoubleBandConditions('bottom', st(-0.1, 9.0, 10.0, false), st(0.2, 5, 10))).toBe(false);
    });
    it('BW / BWhigh が null・BWhigh が 0 以下なら false', () => {
      expect(passesDoubleBandConditions('bottom', st(-0.1, null, 10.0), st(0.2, 5, 10))).toBe(false);
      expect(passesDoubleBandConditions('bottom', st(-0.1, 9.0, null), st(0.2, 5, 10))).toBe(false);
      expect(passesDoubleBandConditions('bottom', st(-0.1, 0, 0), st(0.2, 5, 10))).toBe(false);
    });
  });

  describe('否定対照の器(bandRules)', () => {
    it('既定は3条件とも有効', () => {
      expect(DOUBLE_BAND_RULES_ALL).toEqual({ insideBand: true, outerLeft: true, bwPeak: true });
    });
    it('①を外すと、右谷が %B=0 でも通る(条件が効いていることの裏返し)', () => {
      const left = wideLeft(-0.1), right = st(0, 5, 10);
      expect(passesDoubleBandConditions('bottom', left, right)).toBe(false);
      expect(passesDoubleBandConditions('bottom', left, right, DOUBLE_BW_PEAK_RATIO,
        { ...DOUBLE_BAND_RULES_ALL, insideBand: false })).toBe(true);
    });
    it('②を外すと、左右の %B が同値でも通る', () => {
      const left = wideLeft(0.2), right = st(0.2, 5, 10);
      expect(passesDoubleBandConditions('bottom', left, right)).toBe(false);
      expect(passesDoubleBandConditions('bottom', left, right, DOUBLE_BW_PEAK_RATIO,
        { ...DOUBLE_BAND_RULES_ALL, outerLeft: false })).toBe(true);
    });
    it('③を外すと、左谷の BW がピークから遠くても通る', () => {
      const left = st(-0.1, 1.0, 10.0), right = st(0.2, 5, 10);
      expect(passesDoubleBandConditions('bottom', left, right)).toBe(false);
      expect(passesDoubleBandConditions('bottom', left, right, DOUBLE_BW_PEAK_RATIO,
        { ...DOUBLE_BAND_RULES_ALL, bwPeak: false })).toBe(true);
    });
  });
});

describe('detectSwingDouble × 帯条件(結線)', () => {
  // 幾何は成立する実例(neck 67770 / 谷 66950・66930 / 現値 67790 = breakout)
  const example: SwingPivot[] = [hi(0, 68085), lo(1, 66950), hi(2, 67770), lo(3, 66930)];
  const bandsOf = (map: Record<number, DoubleBandStats>): DoubleBandLookup => p => map[p.t] ?? null;

  it('帯条件を満たせば従来どおり breakout が出る', () => {
    const bands = bandsOf({ [1 * M]: st(-0.05, 9.5, 10.0), [3 * M]: st(0.30, 4.0, 10.0) });
    expect(detectSwingDouble(example, 67790, bands)?.stage).toBe('breakout');
  });
  it('右谷がバンドの外(%B ≤ 0)なら、幾何が成立していても出さない', () => {
    const bands = bandsOf({ [1 * M]: st(-0.20, 9.5, 10.0), [3 * M]: st(-0.01, 4.0, 10.0) });
    expect(detectSwingDouble(example, 67790, bands)).toBeNull();
  });
  it('左谷のほうが内側(左 %B ≥ 右 %B)なら出さない', () => {
    const bands = bandsOf({ [1 * M]: st(0.40, 9.5, 10.0), [3 * M]: st(0.30, 4.0, 10.0) });
    expect(detectSwingDouble(example, 67790, bands)).toBeNull();
  });
  it('左谷の BW がピーク付近でなければ出さない', () => {
    const bands = bandsOf({ [1 * M]: st(-0.05, 2.0, 10.0), [3 * M]: st(0.30, 4.0, 10.0) });
    expect(detectSwingDouble(example, 67790, bands)).toBeNull();
  });
  it('脚の足が帯の列に無い(引けない)なら出さない', () => {
    expect(detectSwingDouble(example, 67790, bandsOf({}))).toBeNull();
  });
  it('帯は **脚**(第1・第3ピボット)で引く。ネックの足では引かない', () => {
    const seen: number[] = [];
    detectSwingDouble(example, 67790, p => { seen.push(p.t); return st(0.1, 9.5, 10.0); });
    expect(seen).toEqual([1 * M, 3 * M]);   // ネック(2*M)は含まれない
  });
  it('ダブルトップも上下対称に効く', () => {
    const top: SwingPivot[] = [lo(0, 66000), hi(1, 67800), lo(2, 67000), hi(3, 67820)];
    const ok = bandsOf({ [1 * M]: st(1.05, 9.5, 10.0), [3 * M]: st(0.70, 4.0, 10.0) });
    const ng = bandsOf({ [1 * M]: st(1.05, 9.5, 10.0), [3 * M]: st(1.00, 4.0, 10.0) });  // 右山 %B=1 ちょうど
    expect(detectSwingDouble(top, 66990, ok)?.stage).toBe('breakout');
    expect(detectSwingDouble(top, 66990, ng)).toBeNull();
  });
});
