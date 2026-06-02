import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getRecentAlerts, insertAlert, type AlertRow } from './db/store.js';
import { recordAlert, followupTick, summarize, kindLabel } from './alertHistory.js';
import type { AlertEventPayload } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;  // placeholder so `db.close?.()` in summarize test is a harmless no-op

function payload(over: Partial<any> = {}): AlertEventPayload {
  return { symbol: 'NIY=F', symbolLabel: '日経225先物', changePercent: 0.3, windowSeconds: 60,
    detectionKind: 'slope', direction: 'up', triggeredAt: Date.UTC(2026, 5, 1, 1, 0), change15min: null,
    pa15min: null, range1h: null, zscore: 3.1, ...over };
}

describe('recordAlert', () => {
  it('payload と発火価格から alerts に1行入れ、session を付与', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    recordAlert(db, payload(), 67000);
    const r = getRecentAlerts(db, 1)[0]!;
    expect(r.price).toBe(67000);
    expect(r.direction).toBe('up');
    expect(r.window_seconds).toBe(60);
    expect(r.session).toBe('Day');           // 10:00 JST Monday = Day
    db.close();
  });
});

describe('followupTick', () => {
  it('+5/15/30分の bar close から発火価格比リターン%を埋める', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const t0 = Date.UTC(2026, 5, 1, 1, 0);   // fire time
    insertAlert(db, { symbol: 'NIY=F', triggeredAt: t0, direction: 'up', detectionKind: 'slope',
      windowSeconds: 60, changePercent: 0.3, price: 1000, sessionDate: '2026-06-01', session: 'Day' });
    const bar = (t: number, c: number) => db.prepare(
      'INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', '2026-06-01', 'Day', t, c, c, c, c);
    bar(t0 + 5 * 60_000, 1005);     // +5分 → +0.5%
    bar(t0 + 15 * 60_000, 1010);    // +15分 → +1.0%
    bar(t0 + 30 * 60_000, 990);     // +30分 → -1.0%
    followupTick(db, t0 + 31 * 60_000);
    const r = getRecentAlerts(db, 1)[0]!;
    expect(r.ret5).toBeCloseTo(0.5, 5);
    expect(r.ret15).toBeCloseTo(1.0, 5);
    expect(r.ret30).toBeCloseTo(-1.0, 5);
    db.close();
  });

  it('まだ30分経過していなければ対象外(ret は null のまま)', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const t0 = Date.UTC(2026, 5, 1, 1, 0);
    insertAlert(db, { symbol: 'NIY=F', triggeredAt: t0, direction: 'up', detectionKind: 'slope',
      windowSeconds: 60, changePercent: 0.3, price: 1000, sessionDate: '2026-06-01', session: 'Day' });
    followupTick(db, t0 + 10 * 60_000);
    expect(getRecentAlerts(db, 1)[0]!.ret30).toBeNull();
    db.close();
  });
});

describe('summarize / kindLabel', () => {
  it('種別ラベル(windowSeconds基準)', () => {
    expect(kindLabel(8)).toBe('超短期');
    expect(kindLabel(60)).toBe('短期');
    expect(kindLabel(300)).toBe('長期');
  });
  it('種別ごとの的中率(15分基準, HIT=0.1%)と平均retを集計', () => {
    const rows: AlertRow[] = [
      { id: 1, symbol: 'NIY=F', triggered_at: 1, direction: 'up', detection_kind: 'slope', window_seconds: 60,
        change_percent: 0.3, price: 1000, session_date: null, session: null, ret5: 0.2, ret15: 0.5, ret30: 0.4 },
      { id: 2, symbol: 'NIY=F', triggered_at: 2, direction: 'up', detection_kind: 'slope', window_seconds: 60,
        change_percent: 0.3, price: 1000, session_date: null, session: null, ret5: -0.2, ret15: -0.3, ret30: 0 },
    ];
    const s = summarize(rows);
    const shortStat = s.find(x => x.label === '短期')!;
    expect(shortStat.count).toBe(2);
    expect(shortStat.hitRate).toBeCloseTo(0.5, 5);   // up: ret15>=0.1 が1/2
    db?.close?.();
  });
});
