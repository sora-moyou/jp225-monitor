import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from './db/store.js';
import { writeHeartbeat, isCollectorAlive, HEARTBEAT_FRESH_MS } from './collectorHeartbeat.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }

describe('collectorHeartbeat', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); });

  it('reports dead when no heartbeat written', () => {
    expect(isCollectorAlive(db, 1_000_000)).toBe(false);
  });

  it('reports alive within the freshness window', () => {
    writeHeartbeat(db, 1_000_000);
    expect(isCollectorAlive(db, 1_000_000 + HEARTBEAT_FRESH_MS - 1)).toBe(true);
  });

  it('reports dead once the heartbeat is stale', () => {
    writeHeartbeat(db, 1_000_000);
    expect(isCollectorAlive(db, 1_000_000 + HEARTBEAT_FRESH_MS + 1)).toBe(false);
  });
});
