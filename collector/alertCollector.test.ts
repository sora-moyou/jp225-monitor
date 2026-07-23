import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getRecentAlerts, recordTick, upsertDailyClose } from '../server/db/store.js';
import { _reset as resetCooldown } from '../server/alertCooldown.js';
import { _reset as resetFeed } from '../server/feedBars.js';
import { _resetShockCooldown } from '../server/alertEngine.js';
import { AlertCollector } from './alertCollector.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }

describe('AlertCollector', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); resetCooldown(); resetFeed(); _resetShockCooldown(); });

  it('records a shock alert to the DB when a quiet feed jumps', () => {
    const ac = new AlertCollector(db);
    const t0 = 1_700_000_000_000;
    // 68 quiet minutes (one sample per minute) then a sharp jump — comfortably past the 65-bar
    // requirement so bar detection has a full baseline. Detection reads getRealtimeBars only.
    let price = 30000;
    for (let i = 0; i < 68; i++) {
      price += (i % 2 === 0 ? 1 : -1);
      ac.onPrice('NIY=F', price, t0 + i * 60_000);
      ac.onMinute(t0 + i * 60_000);
    }
    const jumpT = t0 + 68 * 60_000;
    ac.onPrice('NIY=F', price + 120, jumpT);   // ~0.4% jump (in-progress bar)
    ac.onMinute(jumpT);
    // Shock evaluates COMPLETED bars only (bars.slice(0,-1)); the jump above lands in the
    // in-progress bar. Feed one more minute so the jump bar CLOSES, then evaluate.
    ac.onPrice('NIY=F', price + 120, jumpT + 60_000);
    ac.onMinute(jumpT + 60_000);
    const rows = getRecentAlerts(db, 10);
    const shock = rows.find(r => r.detection_kind === 'shock');
    expect(shock).toBeDefined();
    expect(shock!.symbol).toBe('NIY=F');
  });

  it('ignores non-NIY symbols for firing', () => {
    const ac = new AlertCollector(db);
    const t0 = 1_700_000_000_000;
    let price = 20000;
    for (let i = 0; i < 72; i++) { price += i === 68 ? 200 : (i % 2 ? -1 : 1); ac.onPrice('NQ=F', price, t0 + i * 60_000); ac.onMinute(t0 + i * 60_000); }
    expect(getRecentAlerts(db, 10).length).toBe(0);
  });

  // STEP 6(意図した挙動変更): collector が従来出していなかった level 検知(break/level_sr/pivot/double/dailyband)を
  // registry 経由で記録するようになったことの回帰。ここでは日足バンド(dailyband)の水準抜けを最小構成で確認する。
  it('records a dailyband alert via the level detectors it previously omitted', () => {
    const ac = new AlertCollector(db);
    // 2026-01-15 12:00 JST(=03:00 UTC)= 日中セッション中盤(寄り3本ガードの外)。
    const now = Date.UTC(2026, 0, 15, 3, 0, 0);
    // 24 本の確定取引日終値(±50 の広いばらつき → MA25≈100)。daily_closes に直接シード。
    for (let i = 0; i < 24; i++) upsertDailyClose(db, 'NIY=F', `2026-01-${String(i + 1).padStart(2, '0')}`, i % 2 === 0 ? 150 : 50, now - (30 - i) * 86_400_000);
    // 直近 1 分足: 谷タッチ(≤105)→山形成(≥110)→再下落で MA25(≈100)を下抜け。現値=96。
    const bars: [number, number, number][] = [
      [now - 4 * 60_000, 101, 99], [now - 3 * 60_000, 115, 105],
      [now - 2 * 60_000, 112, 108], [now - 1 * 60_000, 108, 102], [now, 104, 96],
    ];
    for (const [t, h, l] of bars) {
      db.prepare('INSERT OR REPLACE INTO bars_1m (symbol, session_date, session, t, o, h, l, c) VALUES (?,?,?,?,?,?,?,?)')
        .run('NIY=F', '2026-01-15', 'Day', t, l, h, l, l === 96 ? 96 : (h + l) / 2);
    }
    recordTick(db, 'NIY=F', now, 96, '2026-01-15', 'Day');   // 最新 tick(鮮度 OK・sink の価格解決に使用)
    ac.onMinute(now);
    const rows = getRecentAlerts(db, 20);
    expect(rows.some(r => r.detection_kind === 'dailyband')).toBe(true);
  });
});
