import { describe, it, expect } from 'vitest';
import { computeLevels, type SessionOHLC } from './levels.js';

function mk(date: string, ses: 'Day'|'Night', o: number, h: number, l: number, c: number): SessionOHLC {
  // openT を寄りに合わせて isSessionComplete=true にする(寄り時刻=その日の8:45/17:00 UTC換算)
  const [y,m,d] = date.split('-').map(Number);
  const min = ses === 'Day' ? 8*60+45 : 17*60;
  const openT = Date.UTC(y!, m!-1, d!, Math.floor(min/60), min%60) - 9*3600_000;
  return { sessionDate: date, session: ses, open: o, high: h, low: l, close: c, highT: openT+3600_000, lowT: openT+1800_000, openT };
}

describe('computeLevels scoring', () => {
  it('numeric score+tier; heavy cluster at a meaningful round price outranks an isolated level; representative = real member price', () => {
    // 散らばった20セッション。高値の多くを 67500(=最大高=round500=longHL)に寄せ、
    // 安値・始値は散らす(病的な全同一系列にしない)。現値は 67000。
    const sessions: SessionOHLC[] = [];
    const highs = [67500, 67500, 67500, 67480, 67320, 67500, 67210, 67500, 67390, 67500,
                   67260, 67500, 67180, 67450, 67500, 67340, 67500, 67220, 67410, 67500];
    const lows  = [66480, 66510, 66200, 66620, 66380, 66540, 66700, 66260, 66590, 66440,
                   66660, 66300, 66720, 66520, 66360, 66600, 66280, 66640, 66460, 66340];
    for (let i = 0; i < 20; i++) {
      const dd = String(2 + i).padStart(2, '0');
      sessions.push(mk(`2026-05-${dd}`, i % 2 ? 'Day' : 'Night', 67000, highs[i]!, lows[i]!, 67000 + (i % 5) * 20));
    }
    const r = computeLevels(sessions, 67000, Date.now(), null, []);
    const all = [...r.up, ...r.down];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every(l => typeof l.score === 'number' && (l.tier === 0 || l.tier === 1 || l.tier === 2))).toBe(true);
    // 67500: 最大高(longHL)+多数のsessHL+round500 が集中 → 高スコア・tier>=1
    const conf = all.find(l => Math.abs(l.price - 67500) <= 12);
    expect(conf).toBeDefined();
    expect(conf!.tier).toBeGreaterThanOrEqual(1);
    // 代表価格は中央値の平均値ではなく、意味のある実価格(67500=最大高/round500)であること
    expect(conf!.price).toBe(67500);
    // 67500 のスコアは、孤立した節目(例 67000近傍の grid)より高い
    const isolated = all.filter(l => l !== conf).map(l => l.score);
    expect(Math.max(...isolated)).toBeLessThan(conf!.score);
  });
});
