import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getRecentAlerts } from '../server/db/store.js';
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
});
