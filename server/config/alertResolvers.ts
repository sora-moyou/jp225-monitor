// アラート系(急変 shock / フラッシュ / グランビルMA / 的中率しきい値)の tunable リゾルバ群。
// configStore.ts の純粋な切り出し(挙動・既定・境界は一切変えない)。configStore が re-export する。

import { DEFAULT_SHOCK_PARAMS, type ShockParams } from '../shockDetector.js';
import { loadConfig, resolveNumeric } from '../configStore.js';

export function resolveShockParams(): ShockParams {
  return {
    ...DEFAULT_SHOCK_PARAMS,   // 固定: avgLen/breakLen/sameDirLen/sameDirNeed
    move1: resolveNumeric('shockMove1Yen'),
    move2: resolveNumeric('shockMove2Yen'),
    shock1: resolveNumeric('shock1Yen'),
    shock2: resolveNumeric('shock2Yen'),
    accelTh: resolveNumeric('shockAccelYen'),
    avgMult: resolveNumeric('shockAvgMult'),
    scoreNeed: resolveNumeric('shockScoreNeed'),
  };
}
export function resolveShockCooldownBars(): number { return resolveNumeric('shockCooldownBars'); }
export function resolveOpenGuardBars(): number { return resolveNumeric('openGuardBars'); }
export function resolveFlashYen(): number { return resolveNumeric('flashYen'); }
export function resolveGranvilleMaMid(): number { return resolveNumeric('granvilleMaMid'); }
export function resolveGranvilleMaLong(): number { return resolveNumeric('granvilleMaLong'); }

// ★検知チューニング(40日ライブ分析)。double反転効かず/break継続0pt/slope+52pt。
// double 形成通知の可否(既定 false=breakout のみ出す)。boolean=採用 / 非boolean/未設定=既定 false。
export function resolveDoubleFormingEnabled(): boolean { return loadConfig().doubleFormingEnabled === true; }
// break 単独スコア(既定 0.9)。minScore=1 未満のため単独 break は emit されず、コンフルエンス時のみ生きる。
export function resolveBreakScore(): number { return resolveNumeric('breakScore'); }
// slope 方向一致ボーナス(既定 0.5)。aggregateSignals に渡し、直近モメンタムと同方向のクラスタへ加点する。
export function resolveSlopeConfluenceBonus(): number { return resolveNumeric('slopeConfluenceBonus'); }

// v0.6.0: 的中率の「成功」判定しきい値(順行% ≥ これ)。シグナル種別ごとに持てる(既定は全種別同値 0.1%)。
// config の hitThresholds 例: { "default": 0.1, "double": 0.2, "level_sr": 0.15 }(リビルド不要で変更可)。
const DEFAULT_HIT_PCT = 0.1;
export function resolveHitThreshold(detectionKind: string | null): number {
  const cfg = loadConfig() as { hitThresholds?: Record<string, number> };
  const m = cfg.hitThresholds;
  if (m) {
    if (detectionKind && typeof m[detectionKind] === 'number') return m[detectionKind];
    if (typeof m.default === 'number') return m.default;
  }
  return DEFAULT_HIT_PCT;
}
