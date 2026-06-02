import { isSessionComplete } from './levels.js';
import type { SessionOHLC } from './levels.js';

export interface ADR { adrUp: number; adrDown: number; samples: number; }

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

/** 直近 n の「寄り揃い」完了セッション(指定種別)の up/down レンジの中央値。 */
export function computeADR(sessions: SessionOHLC[], n: number, session: 'Day' | 'Night'): ADR {
  const use = sessions.filter(s => s.session === session && isSessionComplete(s)).slice(0, n);
  const up = use.map(s => s.high - s.open);
  const down = use.map(s => s.open - s.low);
  return { adrUp: median(up), adrDown: median(down), samples: use.length };
}

/** 寄り価格から到達しやすい上値/下値を投影。 */
export function projectTargets(open: number, adr: ADR): { projHigh: number; projLow: number } {
  return { projHigh: open + adr.adrUp, projLow: open - adr.adrDown };
}
