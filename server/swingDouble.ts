// 長周期スイング・ダブルボトム/トップ検知(純粋関数)。
//
// 複数セッションをまたぐ大きな W/M 反転を捉える(旧 90分窓 micro ダブルは v0.6.0 で廃止)。
// 確定スイングピボット(extractSwingPivots を大きな reclaim で計算=主要スイングのみ)の列から、
// 直近の [谷→ネック(山)→谷](トップは [山→ネック(谷)→山])を探す。
//
// ユーザー指定: 「2つの谷の価格差は大きくてかまわない」。よって equal-lows(谷の高さ一致)は要求せず、
// 本物の W かどうかは **ネックの突出度**(ネック − 浅い方の谷 ≥ minProminence)だけで判定する。
//
// ★2026-08-16(仕様 第6章): 上の幾何条件は**そのまま残し**、スクイーズ用バンド(5分足20本±2σ)による
//   3条件を重ねた(下の passesDoubleBandConditions)。種別名は `double` のまま=画面と履歴は変えない。
//   定義が変わるので、これ以前の的中率記録とは**不連続**になる(仕様 第9章・ユーザー了承済み)。
//
// 2段で通知する:
//   forming  = 谷2を付け、現値がまだネック未満(上抜け待ち)
//   breakout = 現値がネックを breakTol 超で上抜け(=ダブルボトム成立)
// 連発抑制は呼び出し側の per-neck クールダウンで行う。

import type { SwingPivot } from './swingPivots.js';
import type { BarBandStats } from './indicators.js';

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  ★ダブルの帯条件(2026-08-16・仕様 第6章)— 純関数(SSOT)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// 幾何(ネックの突出・脚の高さが近い・突破マージン・決着済みガード)は従来のまま残し、
// その上に **スクイーズ用バンド(5分足20本±2σ)** による3条件を重ねる。
//
//  ボトム: ①右谷の安値がバンドの内側(%B > 0)
//          ②左谷の %B < 右谷の %B(=左のほうが外に出ている=売られ過ぎの度合いが弱まっている)
//          ③左谷の足の BW が、その足までの BWhigh の bwPeakRatio 以上(=拡大のピーク付近で1つ目を付けた)
//  トップ: 上下対称(①右山の高値が %B < 1・②左山の %B > 右山の %B・③は同じ)
//
// ★%B は「谷の安値 / 山の高値」で計算する(終値ではない)。仕様の文言が「安値がバンドの内側」だから。
// ★帯の値は必ず **その足の時点まで** で計算したものを渡すこと(未来を見ない)。この関数は渡された値を
//   そのまま信じるので、時点の担保は呼び出し側(buildBarBandLookup)の責任。
// ★欠測(null / 参照本数不足)は **不成立**として扱う。「値が出せない=条件を確かめられない」ので
//   通してしまうと、定義を変えた意味が無くなる(無言で旧定義に戻る)。

/** 帯の3条件の有効/無効。**既定は全部 true**(= 本番)。
 *  false にできるのは「条件を1つずつ外して発火数が増えるか」を実データで確かめる否定対照のためだけ。 */
export interface DoubleBandRules {
  /** ①右脚がバンドの内側 */ insideBand: boolean;
  /** ②左脚のほうが外側   */ outerLeft: boolean;
  /** ③左脚の BW がピーク付近 */ bwPeak: boolean;
}
export const DOUBLE_BAND_RULES_ALL: DoubleBandRules = { insideBand: true, outerLeft: true, bwPeak: true };

/** ③の閾値: 左脚の BW ≥ BWhigh × これ。仕様 第6章の 0.9。
 *
 *  ★実データ(NIY=F 1分足 181,577本 / 5分足 36,300本 / 2025-12-29〜2026-07-30 = 207日)での効き:
 *
 *  | 定義 | breakout の発火 | 相異なるW | bottom / top |
 *  |---|---|---|---|
 *  | 旧(帯なし) | 182件(0.88/日) | 38 | 129 / 53 |
 *  | **新(3条件)** | **18件(0.087/日)** | **2** | **18 / 0** |
 *  | 否定対照 ①なし | 28件 | 3 | 18 / 10 |
 *  | 否定対照 ②なし | 19件 | 3 | 18 / 1 |
 *  | 否定対照 ③なし | 51件 | 8 | 40 / 11 |
 *
 *  ★比率を緩めても本数はほとんど戻らない(0.9→18件/W2・0.7→19件/W3・0.5→25件/W6)。
 *    絞っているのは主に ①と③ の**同時成立**であって、この閾値そのものではない。
 *  ★条件ごとの単独通過率(幾何が成立した局面のうち): bottom ①42.8% ②43.7% ③15.2% /
 *    top ①22.4% ②63.9% ③40.7%。トップの①が特に低いのは、脚の**高値**で %B を測る以上
 *    スイング高値の足は上限バンドの外に出やすいため(仕様どおりの挙動)。 */
export const DOUBLE_BW_PEAK_RATIO = 0.9;

/** 脚(谷/山)の足で読んだ帯の値。indicators.buildBarBandLookup の戻り値をそのまま使う。 */
export type DoubleBandStats = BarBandStats;

/** ピボット → その足の帯の値。列に無い足(=判定できない)は null。 */
export type DoubleBandLookup = (pivot: SwingPivot) => DoubleBandStats | null;

/** 帯条件の入力。**'unchecked' は「帯条件を評価しない」ことを明示する指定**で、5分足のバンドを
 *  用意できない過去研究スクリプト専用。本番経路(detect/registry・alert-audit)では使わない。 */
export type DoubleBands = DoubleBandLookup | 'unchecked';

/** 第6章の3条件。左右いずれかの帯が引けない/欠測なら false(=出さない)。 */
export function passesDoubleBandConditions(
  kind: 'bottom' | 'top',
  left: DoubleBandStats | null, right: DoubleBandStats | null,
  bwPeakRatio: number = DOUBLE_BW_PEAK_RATIO,
  rules: DoubleBandRules = DOUBLE_BAND_RULES_ALL,
): boolean {
  const needPctB = rules.insideBand || rules.outerLeft;
  if (needPctB && (!left || !right)) return false;
  if (rules.bwPeak && !left) return false;
  const lp = left?.pctB ?? null, rp = right?.pctB ?? null;
  if (rules.insideBand) {
    if (rp == null) return false;
    if (kind === 'bottom' ? !(rp > 0) : !(rp < 1)) return false;
  }
  if (rules.outerLeft) {
    if (lp == null || rp == null) return false;
    if (kind === 'bottom' ? !(lp < rp) : !(lp > rp)) return false;
  }
  if (rules.bwPeak) {
    if (!left!.bwReady) return false;                       // 参照本数が足りない=BWhigh を名乗れない
    const bw = left!.bw, high = left!.bwHigh;
    if (bw == null || high == null || !(high > 0)) return false;
    if (!(bw >= high * bwPeakRatio)) return false;
  }
  return true;
}

export interface SwingDoubleParams {
  minProminence: number;  // ネック − max(谷1,谷2)(=浅い方の谷)がこれ以上で「本物のW」とみなす
  lowTolRatio: number;    // |谷1 − 谷2| ≤ lowTolRatio × 突出(ネック高さ)。2つの脚が「同じ高さ」と認識できる近さを担保
  breakTol: number;       // ネック突破マージン(円)
  breakoutExtensionRatio: number;  // 現値がネックから「突出 × この比率」を超えて離れたら決着済み→出さない(1.0=測定移動の目標)
  bwPeakRatio: number;    // 左脚の BW が「その足までの BWhigh × この比率」以上なら“ピーク付近”(第6章③)
  bandRules: DoubleBandRules;  // 帯の3条件の有効/無効(既定は全部 true。否定対照の実験だけが動かす)
}
// lowTolRatio: 旧 lowTol(固定2000円)は緩すぎ、谷64,455→63,755(差700=切り下げ)のような
// 「ダブルでない下降の底」を誤検知していた(人間の認識と乖離)。ダブルは2つの脚が「ほぼ同じ高さ」で
// なければならない。それを**突出(ネックの高さ)に対する比率**で判定(スケール不変)。0.08=谷差は突出の
// 8%まで(ユーザー指定・厳格)。実データ二極化: 良品=比率0.04 / 不良=0.45以上(実例=1.10)。
// 突出635円の例なら許容谷差 ≈ 51円。
// breakoutExtensionRatio: 強トレンドで0.8%押しが入らないと古い [谷山谷] が末尾に残り続け、価格が
// ネックを大きく抜けて決着した後も「成立」を延々再発火する(チャート上では現値近傍にダブルが無く
// 「認識できない」)。測定移動の目標(ネック±突出)に到達したら setup 終了とみなし打ち切る。
export const DEFAULT_SWING_DOUBLE: SwingDoubleParams = {
  minProminence: 150, lowTolRatio: 0.08, breakTol: 5, breakoutExtensionRatio: 1.0,
  bwPeakRatio: DOUBLE_BW_PEAK_RATIO, bandRules: DOUBLE_BAND_RULES_ALL,
};

export interface SwingDoubleSignal {
  kind: 'bottom' | 'top';
  stage: 'forming' | 'breakout';
  neck: number;
  legs: [number, number];   // [谷1, 谷2](bottom) / [山1, 山2](top)
  target: number;           // 測定移動: ネック ±(ネック − 浅い方の脚)
}

/**
 * 確定スイングピボット列(古い→新しい)と現値から、直近の大スイング・ダブルを判定。該当なしは null。
 * 直近3ピボットが [low, high, low](=ダブルボトム形成中)/ [high, low, high](=ダブルトップ形成中)の時だけ
 * 評価する(=2つ目の脚を付けて現在ネックへ向かっている、最も actionable な局面)。
 *
 * ★bands は **必須の第3引数**(既定値を置かない)。既定を 'unchecked' にすると、呼び出し側が
 *   渡し忘れたときに **無言で旧定義に戻る**。帯を渡すか「評価しない」と明示するかを型で選ばせる。
 *   (このために p と順番を入れ替えた。p は従来どおり省略可。)
 */
export function detectSwingDouble(
  pivots: SwingPivot[], current: number, bands: DoubleBands,
  p: SwingDoubleParams = DEFAULT_SWING_DOUBLE,
): SwingDoubleSignal | null {
  if (!(current > 0) || pivots.length < 3) return null;
  const n = pivots.length;
  const a = pivots[n - 3]!, neckP = pivots[n - 2]!, b = pivots[n - 1]!;
  // 帯の3条件(第6章)。'unchecked' のときだけ素通し。左=1つ目の脚(a)・右=2つ目の脚(b)。
  const bandsOk = (kind: 'bottom' | 'top'): boolean =>
    bands === 'unchecked' || passesDoubleBandConditions(kind, bands(a), bands(b), p.bwPeakRatio, p.bandRules);

  // ダブルボトム: 谷 → 山(ネック) → 谷、最後のピボットが谷(=現在は谷2からの上昇レグ)
  if (a.kind === 'low' && neckP.kind === 'high' && b.kind === 'low') {
    const neck = neckP.price, L1 = a.price, L2 = b.price;
    const shallow = Math.max(L1, L2);                 // 浅い方の谷(高い方)
    const prom = neck - shallow;
    if (prom >= p.minProminence && Math.abs(L1 - L2) <= prom * p.lowTolRatio && current > Math.min(L1, L2)) {
      // 決着済み: 価格がネック+突出×ratio(=測定移動の目標)以上に伸びたら古いブレイク→出さない。
      if (current >= neck + prom * p.breakoutExtensionRatio) return null;
      if (!bandsOk('bottom')) return null;               // ★第6章の帯条件(欠測は不成立)
      const stage: SwingDoubleSignal['stage'] = current > neck + p.breakTol ? 'breakout' : 'forming';
      return { kind: 'bottom', stage, neck, legs: [L1, L2], target: neck + prom };
    }
  }
  // ダブルトップ: 山 → 谷(ネック) → 山、最後のピボットが山(=現在は山2からの下落レグ)
  if (a.kind === 'high' && neckP.kind === 'low' && b.kind === 'high') {
    const neck = neckP.price, H1 = a.price, H2 = b.price;
    const shallow = Math.min(H1, H2);                 // 浅い方の山(低い方)
    const prom = shallow - neck;
    if (prom >= p.minProminence && Math.abs(H1 - H2) <= prom * p.lowTolRatio && current < Math.max(H1, H2)) {
      // 決着済み: 価格がネック−突出×ratio(=測定移動の目標)以下に伸びたら古いブレイク→出さない。
      if (current <= neck - prom * p.breakoutExtensionRatio) return null;
      if (!bandsOk('top')) return null;                  // ★第6章の帯条件(欠測は不成立)
      const stage: SwingDoubleSignal['stage'] = current < neck - p.breakTol ? 'breakout' : 'forming';
      return { kind: 'top', stage, neck, legs: [H1, H2], target: neck - prom };
    }
  }
  return null;
}
