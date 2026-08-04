// 未約定ブラケットの「待ち時間(armed-timeout までの猶予)」を決める純関数。
//
// ─── なぜ可変にするのか(実測 2026-08-05) ─────────────────────────────
// 従来は一律 ARMED_TIMEOUT_MS=15分だった。「指値/逆指値まで遠いなら15分では短すぎる」という
// 指摘を、実データ(prices_kabu.db の signal_trades 306件 + serverlog の armed-timeout 69件)で検証した。
//
//  (1) 約定した組の「ARM 時点の現在値→エントリー価格の距離」: 中央値 50円 / p90 110円 / 最大 205円。
//      約定所要は 中央値 2.1分 / p90 9.7分 / **最大 14.6分**(=15分で右側打ち切られた標本)。
//  (2) 失効した組の距離: 中央値 70円 / p90 125円 / 最大 300円。約定組より明確に遠い。
//  (3) 失効した組の ARM 時の値動きの速さ(直近15分の1分足レンジ平均)は 中央値 37円/分。
//      約定した組は 60円/分。**失効は「遠い」だけでなく「動きが遅い」ときに起きている**。
//
// → 距離だけでは足りず、距離を「その時間帯の値動きの速さ」で正規化する必要がある。
//
// ─── なぜ 距離÷速さ ではなく (距離÷σ)² なのか ────────────────────────
// 素朴な「距離 ÷ 速さ = 到達に要する推定時間」は **実測を大幅に過小評価** した
// (推定 中央値 0.8分 に対し実所要 中央値 2.1分。est<2分 のバケットで 実/推定 の中央値が 2.28倍)。
// 価格は一方向に「歩く」のではなくランダムウォークするので、距離 D を初めて跨ぐまでの時間は
// D に比例せず **D² に比例** する(first passage time ∝ (D/σ)²)。
//
// 実際、σ=直近15分の1分足終値変化の標準偏差[円/分] としたとき (距離/σ)² は
// 「15分以内に約定できた確率」の単調な予測子になった(約定306件+失効69件=375件):
//
//     (距離/σ)²  |  約定 |  失効 | 15分以内約定率
//        0 - 1   |  132 |    3 |  98%
//        1 - 3   |   77 |   13 |  86%
//        3 - 8   |   52 |   25 |  68%
//        8 - 15  |   27 |   16 |  63%
//       15 - 30  |    9 |    8 |  53%
//
// 生の距離だけでは単調にならない(40-60円=75% なのに 60-80円=85%)ため、σ による正規化が要る。
//
// ─── 係数と上下限の根拠 ───────────────────────────────────────────
// 失効69件について「あと何分待てば実際にレッグへ到達したか」を bars_1m で数えた:
//     +5分=9% / +15分=19% / +30分=28% / +60分=33%。追加所要の中央値は **61分**。
// つまり失効の多くは「もう少しで約定するところだった」のではなく、単に逆行している。
// → 待ち時間を大きく伸ばしても割に合わない。伸ばすのは **見込みのある一部だけ** に限る。
//
// K(係数)と上限の掃引(失効69件の救済 / 全武装375件が受ける平均待ち):
//     K=2 cap=30 → 救済  3件( 4%) / 平均待ち 17.0分
//     K=3 cap=30 → 救済  7件(10%) / 平均待ち 18.1分   ★採用
//     K=3 cap=40 → 救済 10件(14%) / 平均待ち 19.4分
//     K=5 cap=40 → 救済 12件(17%) / 平均待ち 22.0分
// K=3 / 上限30分 を採用: 武装の 71% は 15分のまま(=現行と同じ)、延長されるのは 29% だけ。
// 上限を 40分以上に伸ばしても救済の伸びは鈍く(追加所要の中央値が61分なので届かない)、
// 「古い前提のブラケットを持ち続ける」コストだけが増える。
//
// 下限を 15分に据え置くのは、既存の約定306件のうち **1件も** 15分未満で切られないため
// (=この変更で取れていた約定を失わない)。上限30分は「AI の計画サイクル(既定3分)を10回まわす」
// 程度で、それ以上は (d) の「失効後に同じ計画を出し直す」経路で新しい判断に更新するほうが健全。

import type { OHLCBar } from '../indicators.js';

/** 待ち時間の下限[ms]。現行の一律値と同じ=近距離では挙動が変わらない。 */
export const ARM_WAIT_MIN_MS = 15 * 60_000;
/** 待ち時間の上限[ms]。これ以上は伸ばさない(古い前提のブラケットを抱え続けない)。 */
export const ARM_WAIT_MAX_MS = 30 * 60_000;
/** (距離/σ)² [分] に掛ける係数。根拠は冒頭の掃引表。 */
export const ARM_WAIT_K = 3;
/** σ を測る窓(直近何本の1分足か)。 */
export const ARM_WAIT_SIGMA_BARS = 15;
/** σ の算出に必要な最低本数。これ未満は σ=null(=下限の15分に落とす)。 */
export const ARM_WAIT_SIGMA_MIN_BARS = 5;

/** 待ち時間の決定内訳。**なぜこの時間になったか** をログ/DB から辿るための全材料を持つ。 */
export interface ArmWaitDecision {
  /** 採用した待ち時間[ms]。 */
  waitMs: number;
  /** ARM 時価格から最も近いエントリー価格までの距離[円]。測れなければ null。 */
  distanceYen: number | null;
  /** 直近1分足終値変化の標準偏差[円/分]。測れなければ null。 */
  sigma1m: number | null;
  /** ランダムウォークの到達推定 (距離/σ)² [分]。測れなければ null。 */
  estMin: number | null;
  /** どの枝で決まったか。no-data=材料が無く下限へ / floor=下限クランプ / scaled=素の計算値 / cap=上限クランプ。 */
  reason: 'no-data' | 'floor' | 'scaled' | 'cap';
}

/** 直近 n 本の1分足終値変化の標準偏差[円/分](= ランダムウォークの σ)。
 *  bars は t 昇順を前提。差分が ARM_WAIT_SIGMA_MIN_BARS 本未満、または非有限値が混ざる場合は null。 */
export function sigma1mFromBars(bars: OHLCBar[] | null | undefined, n: number = ARM_WAIT_SIGMA_BARS): number | null {
  if (!bars || bars.length < 2) return null;
  const seg = bars.slice(Math.max(0, bars.length - (n + 1)));
  const d: number[] = [];
  for (let i = 1; i < seg.length; i++) {
    const a = seg[i - 1]?.c, b = seg[i]?.c;
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    d.push(b - a);
  }
  if (d.length < ARM_WAIT_SIGMA_MIN_BARS) return null;
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  const v = d.reduce((s, x) => s + (x - mean) ** 2, 0) / d.length;
  const sd = Math.sqrt(v);
  return sd > 0 && Number.isFinite(sd) ? sd : null;
}

/** ARM 時価格から「最も近いエントリー価格」までの距離[円]。
 *  最初に約定するのは必ず最も近いレッグなので、待ち時間の判断もそのレッグを基準にする。
 *  レッグが1本も無い/価格が非有限なら null。 */
export function nearestEntryDistance(
  armedPrice: number | null | undefined,
  legs: Array<number | null | undefined>,
): number | null {
  if (armedPrice == null || !Number.isFinite(armedPrice)) return null;
  const ds = legs
    .filter((v): v is number => v != null && Number.isFinite(v))
    .map(v => Math.abs(v - armedPrice));
  return ds.length ? Math.min(...ds) : null;
}

/** ArmedBracket 形のオブジェクトから全エントリー価格(directional の limit/stop・range の upper/lower)を取り出す。 */
export function entryLegsOf(a: {
  limitEntry?: number; stopEntry?: number;
  range?: { upper?: { entry: number }; lower?: { entry: number } };
} | null | undefined): number[] {
  if (!a) return [];
  const out: number[] = [];
  if (a.limitEntry != null) out.push(a.limitEntry);
  if (a.stopEntry != null) out.push(a.stopEntry);
  if (a.range?.upper) out.push(a.range.upper.entry);
  if (a.range?.lower) out.push(a.range.lower.entry);
  return out.filter(v => Number.isFinite(v));
}

/**
 * 待ち時間を決める本体(純関数)。
 *   estMin = (距離 / σ)²    … ランダムウォークで距離を初めて跨ぐまでの推定分数
 *   waitMs = clamp(K × estMin, ARM_WAIT_MIN_MS, ARM_WAIT_MAX_MS)
 * 距離 or σ が測れない(フィード断・起動直後で足が足りない 等)ときは **必ず下限=現行の15分** に落とす
 * (材料が無いときに待ちを伸ばさない=新しい仕組みで挙動を悪化させない fail-safe)。
 */
export function computeArmWait(
  distanceYen: number | null | undefined,
  sigma1m: number | null | undefined,
  opts?: { k?: number; minMs?: number; maxMs?: number },
): ArmWaitDecision {
  const k = opts?.k ?? ARM_WAIT_K;
  const minMs = opts?.minMs ?? ARM_WAIT_MIN_MS;
  const maxMs = opts?.maxMs ?? ARM_WAIT_MAX_MS;
  const d = distanceYen != null && Number.isFinite(distanceYen) && distanceYen >= 0 ? distanceYen : null;
  const s = sigma1m != null && Number.isFinite(sigma1m) && sigma1m > 0 ? sigma1m : null;
  if (d === null || s === null) {
    return { waitMs: minMs, distanceYen: d, sigma1m: s, estMin: null, reason: 'no-data' };
  }
  const estMin = (d / s) ** 2;
  const rawMs = k * estMin * 60_000;
  if (rawMs <= minMs) return { waitMs: minMs, distanceYen: d, sigma1m: s, estMin, reason: 'floor' };
  if (rawMs >= maxMs) return { waitMs: maxMs, distanceYen: d, sigma1m: s, estMin, reason: 'cap' };
  return { waitMs: Math.round(rawMs), distanceYen: d, sigma1m: s, estMin, reason: 'scaled' };
}

/** ログ1行用の説明。「なぜこの時間になったか」を数値込みで残す(後から読めない実装にしない)。 */
export function describeArmWait(w: ArmWaitDecision): string {
  const min = (ms: number): string => `${Math.round(ms / 60_000)}分`;
  if (w.reason === 'no-data') {
    return `wait=${min(w.waitMs)} (材料不足: 距離=${w.distanceYen ?? '-'} σ=${w.sigma1m ?? '-'} → 下限)`;
  }
  return `wait=${min(w.waitMs)} (距離=${Math.round(w.distanceYen as number)}円 `
    + `σ=${(w.sigma1m as number).toFixed(1)}円/分 (距離/σ)²=${(w.estMin as number).toFixed(1)}分 `
    + `×K${ARM_WAIT_K} → ${w.reason})`;
}
