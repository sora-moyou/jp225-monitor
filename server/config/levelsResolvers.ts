// 主要レベル(意識される水準)の tunable リゾルバ。
// configStore.ts の純粋な切り出し(挙動・既定・境界は一切変えない)。configStore が re-export する。

import { resolveNumeric } from '../configStore.js';

// 主要レベル(意識される水準)のノブをまとめて解決。
// 数値のみ返す(Level 型に依存しない＝levels を import しない＝循環回避)。
export function resolveLevelsConfig(): {
  tol: number;
  showN: number;
  selectWindowYen: number;
  fibConfluenceBonus: number;
  levelTestBonus: number;
  lookbackSessions: number;
  lookbackSessions2: number;
} {
  return {
    tol: resolveNumeric('levelTol'),
    showN: resolveNumeric('levelShowN'),
    selectWindowYen: resolveNumeric('levelSelectWindowYen'),
    fibConfluenceBonus: resolveNumeric('fibConfluenceBonus'),
    levelTestBonus: resolveNumeric('levelTestBonus'),
    lookbackSessions: resolveNumeric('levelLookbackSessions'),
    lookbackSessions2: resolveNumeric('levelLookbackSessions2'),
  };
}
