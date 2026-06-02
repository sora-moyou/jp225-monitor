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

const JST_OFFSET = 9 * 3600_000;

export interface SeasBar { t: number; o: number; h: number; l: number; c: number; }
export interface SlotStat { slot: string; avgReturn: number; upRate: number; avgRange: number; samples: number; }

/** epoch を JST の slotMin 分スロット 'HH:MM' に。 */
export function slotKey(epochMs: number, slotMin: number): string {
  const j = new Date(epochMs + JST_OFFSET);
  const minutes = j.getUTCHours() * 60 + j.getUTCMinutes();
  const slot = Math.floor(minutes / slotMin) * slotMin;
  return `${String(Math.floor(slot / 60)).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')}`;
}
function dayKey(epochMs: number): string {
  return new Date(epochMs + JST_OFFSET).toISOString().slice(0, 10);
}

/** 時間帯シーズナリティ: 日×スロットで return/range を出し、スロット横断で平均/上昇率を集計。 */
export function computeSeasonality(bars: SeasBar[], slotMin: number): SlotStat[] {
  const groups = new Map<string, SeasBar[]>();   // 'day|slot' → bars
  for (const b of bars) {
    const k = `${dayKey(b.t)}|${slotKey(b.t, slotMin)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(b);
  }
  const bySlot = new Map<string, { ret: number; range: number }[]>();
  for (const [k, bs] of groups) {
    bs.sort((a, b) => a.t - b.t);
    const slot = k.split('|')[1]!;
    const open = bs[0]!.o;
    if (open <= 0) continue;
    const close = bs[bs.length - 1]!.c;
    const hi = Math.max(...bs.map(x => x.h));
    const lo = Math.min(...bs.map(x => x.l));
    const ret = ((close - open) / open) * 100;
    const range = ((hi - lo) / open) * 100;
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot)!.push({ ret, range });
  }
  const out: SlotStat[] = [];
  for (const [slot, arr] of bySlot) {
    const n = arr.length;
    out.push({
      slot,
      avgReturn: arr.reduce((a, b) => a + b.ret, 0) / n,
      upRate: arr.filter(x => x.ret > 0).length / n,
      avgRange: arr.reduce((a, b) => a + b.range, 0) / n,
      samples: n,
    });
  }
  out.sort((a, b) => a.slot.localeCompare(b.slot));
  return out;
}

/** 現在の asOf が属するスロットと次スロットの統計を返す(無ければ null)。 */
export function currentAndNextSlot(stats: SlotStat[], asOf: number, slotMin: number): { now: SlotStat | null; next: SlotStat | null } {
  const nowKey = slotKey(asOf, slotMin);
  const j = new Date(asOf + JST_OFFSET);
  const minutes = j.getUTCHours() * 60 + j.getUTCMinutes();
  const nextMin = (Math.floor(minutes / slotMin) * slotMin + slotMin) % 1440;
  const nextKey = `${String(Math.floor(nextMin / 60)).padStart(2, '0')}:${String(nextMin % 60).padStart(2, '0')}`;
  return {
    now: stats.find(s => s.slot === nowKey) ?? null,
    next: stats.find(s => s.slot === nextKey) ?? null,
  };
}
