import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { sessionKey, levelSignature, getLevelsSnapshot, persistAndResolveDailyCloses } from './levelsLoop.js';
import { initSchema, getDailyCloses } from '../db/store.js';
import { computeDailyBands, dailyCloseSeries } from '../dailyBand.js';
import type { LevelsResult } from '../levels.js';

describe('sessionKey', () => {
  it('classifySession の結果を安定キー文字列にする', () => {
    expect(sessionKey({ sessionDate: '2026-06-01', session: 'Night' })).toBe('2026-06-01/Night');
    expect(sessionKey(null)).toBe('none');
  });
});

describe('getLevelsSnapshot', () => {
  it('最後に計算した水準(last)を返す。起動直後は空スナップショット', () => {
    // tick() を回さない状態では初期値(空)。stream.ts が接続時に安全に扱える形であることを確認。
    const snap = getLevelsSnapshot();
    expect(snap).toHaveProperty('up');
    expect(snap).toHaveProperty('down');
    expect(Array.isArray(snap.up)).toBe(true);
    expect(Array.isArray(snap.down)).toBe(true);
  });
});

describe('levelSignature — 現値凍結でも水準が同じなら署名は不変(de-dupe が正しく働く根拠)', () => {
  it('current(現値)を署名に含めない: 現値だけ動いても署名は変わらない', () => {
    const base = (current: number): LevelsResult => ({
      current,
      up: [{ price: 67200, dist: 200, labels: ['上値'], strong: true, score: 3, tier: 1, confluence: false }],
      down: [{ price: 66800, dist: -200, labels: ['下値'], strong: false, score: 1, tier: 0, confluence: false }],
      swing: null, reversalSatisfied: false, asOf: 1,
    });
    // 現値が動いても(66900→67100)署名は同じ → 定常時は再 broadcast しない。
    expect(levelSignature(base(66900))).toBe(levelSignature(base(67100)));
  });
});

describe('persistAndResolveDailyCloses — 空 daily_closes(アップグレード後)でもバンドが痩せない', () => {
  const SYMBOL = 'NIY=F';
  const mkConfirmed = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ sessionDate: `d${String(i).padStart(3, '0')}`, close: 38000 + i, openT: i * 1000 }));

  it('★空DB + confirmed100件で1cycle → 十分本数を確保し MA25バンドが非空になる(実害バグ回帰)', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    expect(getDailyCloses(db, SYMBOL, 80)).toHaveLength(0);   // 前提: daily_closes は空
    const confirmed = mkConfirmed(100);
    const series = persistAndResolveDailyCloses(db, SYMBOL, confirmed, 80);
    expect(series.length).toBeGreaterThanOrEqual(24);          // バンド(>=24)を満たす
    expect(series.length).toBe(80);                            // keep=80 に切り詰め
    // 実際にバンドが5水準出る(空 [] にならない)ことを確認
    const bands = computeDailyBands(dailyCloseSeries(series, 38100));
    expect(bands).toHaveLength(5);
    db.close();
  });

  it('daily_closes が完全化した後は durable を採用し従来(getSessionOHLC Day終値)とバイト等価の窓', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const confirmed = mkConfirmed(100);
    persistAndResolveDailyCloses(db, SYMBOL, confirmed, 80);            // 1回目: upsert で完全化
    const series2 = persistAndResolveDailyCloses(db, SYMBOL, confirmed, 80);   // 2回目: durable≥fallback
    // 2回目の系列 = confirmed の直近80本の close(=getSessionOHLC 由来 fallback と同一窓)
    expect(series2).toEqual(confirmed.slice(-80).map(s => s.close));
  });

  it('durable が fetch窓より豊富(daily_closes に履歴蓄積)なら durable を採用しバンドが痩せない', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    // daily_closes に80本の履歴を蓄積済み
    persistAndResolveDailyCloses(db, SYMBOL, mkConfirmed(80), 80);
    // その後 getSessionOHLC の窓が縮んで confirmed が30本しか返らない状況を模す(末尾30本)
    const shrunkWindow = mkConfirmed(80).slice(-30);
    const series = persistAndResolveDailyCloses(db, SYMBOL, shrunkWindow, 80);
    expect(series.length).toBe(80);          // durable(80) ≥ fallback(30) → 豊富な durable を採用
    expect(series.length).toBeGreaterThanOrEqual(24);   // バンド維持
    db.close();
  });
});
