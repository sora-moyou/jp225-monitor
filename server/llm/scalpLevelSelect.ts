// AI(scalp-plan)のプロンプトへ渡す「主要節目」の選抜。純関数(IO/時計なし=テスト可能)。
//
// なぜ切り出したか: 従来は scalpContext.ts の中で `up と down を混ぜて距離順に8本」だけ だった。
// 実データ計測(2026-08・NIY=F 1分足 60日・15分刻み 3,338断面)で分かったこと:
//   ・片側が 0本/1本 に枯れる断面は 0.0%(computeLevels が既に上下それぞれで選抜しているため)。
//     ただし片側 2本 は 2.0% あり、最小保証は無い。
//   ・強度は選抜に一切効いていなかった。★★(tier>=2)の脱落率は距離で二極:
//     ±300円以内 0.0% / ±600円以内 5.1% / ±1000円以内 48.7% / それ以上 97.3%。
//   ・「最寄りが弱い(tier<2)のに、その先の★★が上位8から落ちている」断面は
//     半径300円 0.0% / 500円 0.7% / 800円 7.3%。
// つまり実害は「中距離(±600〜1000円)の強い節目が見えない」ことに集中している。そこだけを直す:
//   (1) 上下それぞれに最低本数を保証する(片側偏りの構造的な予防)
//   (2) tier>=2 は距離の枠外でも別枠で数本入れる(強度を選抜に効かせる)
//   (3) 総数は増やしすぎない(トークン。既定 8〜12本)
// 表示フォーマット/並び順(現在値からの距離順)は呼び出し側の責務。ここは「どれを渡すか」だけを決める。

import type { Level, LevelsResult } from '../levels.js';

/** プロンプトへ出す1本。kind は元の up/down 配列の所属(価格の符号ではない=従来と同じ判定)。 */
export interface PromptLevel {
  level: Level;
  kind: 'レジ' | 'サポ';
  /** 現在値からの距離(円・符号つき)。 */
  dist: number;
}

export interface PromptLevelSelectOptions {
  /** 上下それぞれに保証する最低本数(在庫が足りなければあるだけ)。 */
  perSideMin?: number;
  /** 距離だけで埋める合計本数の下限(従来の 8本 と同じ幅を保つ)。 */
  baseTotal?: number;
  /** 総数の上限(トークン抑制)。 */
  maxTotal?: number;
  /** 距離の枠外でも入れる「強い節目」の 片側あたり本数。 */
  strongPerSide?: number;
  /** 「強い節目」とみなす tier の下限。 */
  strongTier?: number;
}

/** 既定値(実運用の値)。テストと計測はこの定数を参照する。 */
export const DEFAULT_PROMPT_LEVEL_SELECT = {
  perSideMin: 4,
  baseTotal: 8,
  maxTotal: 12,
  strongPerSide: 2,
  strongTier: 2,
} as const;

interface Ann extends PromptLevel { ad: number; i: number }

/**
 * プロンプトへ渡す節目を選ぶ。返り値は「現在値からの距離が近い順」(同距離は up→down の元順)。
 *
 * 手順:
 *   A. 上下それぞれ 近い順に perSideMin 本(在庫が足りなければあるだけ)
 *   B. 未選抜の tier>=strongTier を 近い順に 片側 strongPerSide 本まで(距離の枠外でも入れる)
 *   C. まだ baseTotal に満たなければ、残りを距離が近い順に補充(片側しか無い退化ケースでも従来の本数を保つ)
 * 総数は maxTotal を超えない。levels が null / 両側空なら空配列。
 */
export function selectPromptLevels(
  levels: LevelsResult | null | undefined,
  currentPrice: number,
  opts: PromptLevelSelectOptions = {},
): PromptLevel[] {
  const o = { ...DEFAULT_PROMPT_LEVEL_SELECT, ...opts };
  const maxTotal = Math.max(0, o.maxTotal);
  if (!levels || maxTotal === 0) return [];

  const valid = (l: Level | null | undefined): l is Level =>
    !!l && typeof l.price === 'number' && Number.isFinite(l.price);
  const ann: Ann[] = [];
  const push = (arr: readonly Level[] | undefined, kind: 'レジ' | 'サポ'): void => {
    for (const l of Array.isArray(arr) ? arr : []) {
      if (!valid(l)) continue;
      const dist = l.price - currentPrice;
      ann.push({ level: l, kind, dist, ad: Math.abs(dist), i: ann.length });
    }
  };
  push(levels.up, 'レジ');
  push(levels.down, 'サポ');
  if (ann.length === 0) return [];

  const byNear = (a: Ann, b: Ann): number => (a.ad - b.ad) || (a.i - b.i);
  const up = ann.filter(x => x.kind === 'レジ').sort(byNear);
  const down = ann.filter(x => x.kind === 'サポ').sort(byNear);

  const chosen = new Set<Ann>();
  const take = (x: Ann | undefined): boolean => {
    if (!x || chosen.has(x) || chosen.size >= maxTotal) return false;
    chosen.add(x);
    return true;
  };

  // A. 上下それぞれの最低本数(距離が近い順)。
  for (const side of [up, down]) {
    for (const x of side.slice(0, Math.max(0, o.perSideMin))) take(x);
  }
  // B. 強い節目(tier>=strongTier)は距離の枠外でも片側 strongPerSide 本まで。近い順。
  const tierOf = (x: Ann): number => typeof x.level.tier === 'number' ? x.level.tier : 0;
  for (const side of [up, down]) {
    let added = 0;
    for (const x of side) {
      if (added >= Math.max(0, o.strongPerSide)) break;
      if (chosen.has(x) || tierOf(x) < o.strongTier) continue;
      if (take(x)) added++;
    }
  }
  // C. baseTotal に満たなければ 距離順で補充(片側しか無い/在庫が偏る退化ケース用)。
  if (chosen.size < Math.min(o.baseTotal, maxTotal)) {
    for (const x of [...ann].sort(byNear)) {
      if (chosen.size >= Math.min(o.baseTotal, maxTotal)) break;
      take(x);
    }
  }

  return [...chosen].sort(byNear).map(({ level, kind, dist }) => ({ level, kind, dist }));
}
