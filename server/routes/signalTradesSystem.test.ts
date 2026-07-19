import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resolveDbPath, insertSignalTrade } from '../db/store.js';
import { signalTradesHandler, signalTradesClearHandler, parseSystemQuery } from './signalTrades.js';

// ★v0.8.2: GET/POST /api/signal-trades の ?system=A|B ルーティング。既定は A(NULL 行を含む)。
const ORIG_APPDATA = process.env.APPDATA;
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
let dir: string;

function seed(): void {
  const db = openDb(resolveDbPath());
  try {
    const base = { entryPrice: 38000, dir: 'buy' as const, exitPrice: 38050, pnl: 50, qty: 1 };
    insertSignalTrade(db, { ...base, entryT: 1, exitT: 2 });                 // A(NULL)
    insertSignalTrade(db, { ...base, entryT: 3, exitT: 4, system: 'A' });    // 明示 A
    insertSignalTrade(db, { ...base, entryT: 5, exitT: 6, system: 'B' });    // B
  } finally { db.close(); }
}

function mockRes() {
  const out: { code: number; body: unknown } = { code: 200, body: null };
  return {
    out,
    status(c: number) { out.code = c; return this; },
    json(b: unknown) { out.body = b; return this; },
  };
}

describe('signalTrades ?system ルーティング', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-sigroute-'));
    process.env.APPDATA = dir; process.env.HOME = dir; process.env.USERPROFILE = dir;
    seed();
  });
  afterEach(() => {
    if (ORIG_APPDATA !== undefined) process.env.APPDATA = ORIG_APPDATA; else delete process.env.APPDATA;
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it('parseSystemQuery: B のみ B / それ以外は A(既定)', () => {
    expect(parseSystemQuery('B')).toBe('B');
    expect(parseSystemQuery('A')).toBe('A');
    expect(parseSystemQuery(undefined)).toBe('A');
    expect(parseSystemQuery('x')).toBe('A');
  });

  it('GET ?system 省略 → A(NULL含む2件)', () => {
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signalTradesHandler({ query: {} } as any, res as any);
    const body = res.out.body as { ok: boolean; system: string; trades: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.system).toBe('A');
    expect(body.trades).toHaveLength(2);
  });

  it('GET ?system=B → B(1件)', () => {
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signalTradesHandler({ query: { system: 'B' } } as any, res as any);
    const body = res.out.body as { system: string; trades: Array<{ system: string }> };
    expect(body.system).toBe('B');
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0]!.system).toBe('B');
  });

  it('POST clear ?system=B は B のみ消す(A は残る)', () => {
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signalTradesClearHandler({ query: { system: 'B' } } as any, res as any);
    const body = res.out.body as { ok: boolean; system: string; cleared: number };
    expect(body.ok).toBe(true);
    expect(body.system).toBe('B');
    expect(body.cleared).toBe(1);
    // A は残る
    const res2 = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signalTradesHandler({ query: { system: 'A' } } as any, res2 as any);
    expect((res2.out.body as { trades: unknown[] }).trades).toHaveLength(2);
  });
});
