import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, insertAlert, getRecentAlerts, type AlertInsert } from './store.js';

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}

function alert(over: Partial<AlertInsert> = {}): AlertInsert {
  return {
    symbol: 'NIY=F', triggeredAt: 1_700_000_000_000, direction: 'down',
    detectionKind: 'break', windowSeconds: 60, changePercent: 0, price: 67455,
    sessionDate: '2026-06-05', session: 'Day', referenceKind: null, referencePrice: null,
    ...over,
  };
}

describe('alerts 二重書き込み防止(UNIQUE 同一性インデックス)', () => {
  it('完全一致のアラートを2回 insert しても1行(INSERT OR IGNORE)', () => {
    const db = memDb();
    insertAlert(db, alert());
    insertAlert(db, alert());
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('reference_price=NULL の完全一致も1行(COALESCE で NULL を正規化)', () => {
    const db = memDb();
    insertAlert(db, alert({ referenceKind: null, referencePrice: null }));
    insertAlert(db, alert({ referenceKind: null, referencePrice: null }));
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('同時刻・同種別でも reference_price が違えば別アラートとして2行残る', () => {
    const db = memDb();
    insertAlert(db, alert({ referenceKind: 'level', referencePrice: 67400 }));
    insertAlert(db, alert({ referenceKind: 'level', referencePrice: 67500 }));
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });

  it('同時刻でも detection_kind / direction が違えば別アラート', () => {
    const db = memDb();
    insertAlert(db, alert({ detectionKind: 'break', direction: 'down' }));
    insertAlert(db, alert({ detectionKind: 'break', direction: 'up' }));
    insertAlert(db, alert({ detectionKind: 'shock', direction: 'down' }));
    expect(getRecentAlerts(db, 10).length).toBe(3);
  });

  it('triggered_at が違えば別アラート(近接重複は時間窓ガードの担当)', () => {
    const db = memDb();
    insertAlert(db, alert({ triggeredAt: 1_700_000_000_000 }));
    insertAlert(db, alert({ triggeredAt: 1_700_000_060_000 }));
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });

  it('UNIQUE 索引 idx_alerts_identity が作られている', () => {
    const db = memDb();
    const idx = db.prepare('PRAGMA index_list(alerts)').all() as Array<{ name: string; unique: number }>;
    expect(idx.some(i => i.name === 'idx_alerts_identity' && i.unique === 1)).toBe(true);
  });
});

describe('既存DBの自己修復マイグレーション', () => {
  it('UNIQUE 索引が無い旧DBに重複があっても initSchema で除去され索引が張られる', () => {
    const db = new DatabaseSync(':memory:');
    // 旧スキーマ(索引なし)を再現して、素の INSERT で完全一致重複を作る
    db.exec(`CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, triggered_at INTEGER NOT NULL,
      direction TEXT, detection_kind TEXT, window_seconds INTEGER, change_percent REAL, price REAL,
      session_date TEXT, session TEXT, ret5 REAL, ret15 REAL, ret30 REAL,
      reference_kind TEXT, reference_price REAL)`);
    const raw = db.prepare(`INSERT INTO alerts (symbol, triggered_at, direction, detection_kind, window_seconds, change_percent, price, session_date, session, reference_kind, reference_price)
      VALUES ('NIY=F', 1700000000000, 'down', 'break', 60, 0, 67455, '2026-06-05', 'Day', NULL, NULL)`);
    raw.run(); raw.run(); raw.run();   // 3 件の完全一致重複
    // 別水準(残るべき)
    db.prepare(`INSERT INTO alerts (symbol, triggered_at, direction, detection_kind, window_seconds, change_percent, price, session_date, session, reference_kind, reference_price)
      VALUES ('NIY=F', 1700000000000, 'down', 'break', 60, 0, 67455, '2026-06-05', 'Day', 'level', 67500)`).run();
    expect(getRecentAlerts(db, 10).length).toBe(4);   // 重複3 + 別1

    initSchema(db);   // 自己修復: 重複除去 + UNIQUE 索引

    const rows = getRecentAlerts(db, 10);
    expect(rows.length).toBe(2);   // 完全一致は1本化、別水準は保持
    const idx = db.prepare('PRAGMA index_list(alerts)').all() as Array<{ name: string; unique: number }>;
    expect(idx.some(i => i.name === 'idx_alerts_identity' && i.unique === 1)).toBe(true);
  });
});
