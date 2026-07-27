import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../db/store.js';
import { _reset as resetCooldown } from '../alertCooldown.js';
import {
  createBarDetectState, createLevelDetectState, createDetectorState,
  runBarDetectors, runLevelDetectors, computeLevelAnalytics,
  type LevelAnalytics,
} from './registry.js';
import { INSTRUMENTS } from '../config.js';
import type { AlertEventPayload } from '../types.js';
import type { LevelsResult, Level } from '../levels.js';
import type { Bar } from '../correlation.js';

const NIY = 'NIY=F';
const META = INSTRUMENTS.find(i => i.symbol === NIY)!;

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }
function insertBar(db: DatabaseSync, t: number, h: number, l: number, c: number): void {
  db.prepare('INSERT OR REPLACE INTO bars_1m (symbol, session_date, session, t, o, h, l, c) VALUES (?,?,?,?,?,?,?,?)')
    .run(NIY, '2026-01-15', 'Day', t, c, h, l, c);
}
const lvl = (price: number, tier: 0 | 1 | 2, label: string): Level =>
  ({ price, dist: 0, labels: [label], strong: tier >= 1, score: 2, tier, confluence: false });

// 下抜けブレイク構造(L=100)を作る古い→新しい 5 本: 谷タッチ→山形成→再下落でブレイク。
function downBreakBars(t0: number): { t: number; h: number; l: number }[] {
  return [
    { t: t0 + 0 * 60_000, h: 101, l: 99 },    // トラフ(L 到達)
    { t: t0 + 1 * 60_000, h: 115, l: 105 },   // ピーク(L+reclaim 以上=山形成)
    { t: t0 + 2 * 60_000, h: 112, l: 108 },
    { t: t0 + 3 * 60_000, h: 108, l: 102 },
    { t: t0 + 4 * 60_000, h: 104, l: 96 },    // 直近: 高値≥L, 現値は L 下抜け
  ];
}

describe('createDetectorState — consumer ごとの独立した状態', () => {
  it('bar/level 状態が別インスタンス(相互に共有しない)', () => {
    const a = createDetectorState(), b = createDetectorState();
    expect(a.bar).not.toBe(b.bar);
    expect(a.level).not.toBe(b.level);
    expect(a.bar.lastShockBar).not.toBe(b.bar.lastShockBar);
    expect(a.level.lastEmit).not.toBe(b.level.lastEmit);
  });
});

describe('runBarDetectors — shock を sink に流し、状態は渡した state のみに書く', () => {
  beforeEach(() => resetCooldown());

  function shockBars(t0: number): Bar[] {
    const bars: Bar[] = [];
    let price = 30_000;
    for (let i = 0; i < 68; i++) { price += (i % 2 === 0 ? 1 : -1); bars.push({ t: t0 + i * 60_000, close: price }); }
    bars.push({ t: t0 + 68 * 60_000, close: price + 120 });   // 急騰(完成足になる)
    bars.push({ t: t0 + 69 * 60_000, close: price + 120 });   // 進行中足(slice(0,-1) で除外)
    return bars;
  }

  it('shock を検知して sink に流す(detectionKind=shock)+ per-consumer state に書き込む', () => {
    const t0 = 1_700_000_000_000;
    const bars = shockBars(t0);
    const stateA = createBarDetectState();
    const stateB = createBarDetectState();
    const calls: AlertEventPayload[] = [];
    runBarDetectors(bars, META, t0 + 69 * 60_000, e => calls.push(e), stateA);
    expect(calls.some(e => e.detectionKind === 'shock')).toBe(true);
    // 状態は stateA にのみ書かれ、別 consumer(stateB)は触られない(相互抑制しない根拠)。
    expect(stateA.lastShockBar.size).toBeGreaterThan(0);
    expect(stateB.lastShockBar.size).toBe(0);
  });
});

describe('runLevelDetectors — break を sink に流し、cooldown/dedup は consumer ごとに独立', () => {
  let db: DatabaseSync;
  const t0 = 1_700_000_000_000;
  const now = t0 + 5 * 60_000;

  const analytics = (): LevelAnalytics => ({
    result: { current: 96, up: [], down: [lvl(100, 1, 'テスト水準')], swing: null, reversalSatisfied: false, asOf: now } as LevelsResult,
    latest: { symbol: NIY, t: now, price: 96 },
    sessions: [], cs: null, dailyBandLevels: [], dailyMaLevels: [], dbMs: 0, computeMs: 0,
  });

  beforeEach(() => {
    db = memDb();
    for (const b of downBreakBars(t0)) insertBar(db, b.t, b.h, b.l, b.l);   // close は本検知で未使用(h/l のみ)
  });

  it('tier≥1 水準の下抜けを break として sink に流す', () => {
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, analytics(), now, createLevelDetectState(), e => calls.push(e));
    expect(calls.some(e => e.detectionKind === 'break' && e.direction === 'down')).toBe(true);
  });

  it('★起動直後(未seed)は既存の確定ピボットを「形成」として発火しない(再起動での古い価格の誤発火防止)', () => {
    // downBreakBars は窓内にスイング安値99/高値115の確定ピボットを含む。seed が無いと lastPivotT=0 のため
    // これらが起動時に『形成』誤発火する(実バグ: 現値と乖離した古い価格が文中に出る)。seed で発火しないことを担保。
    const st = createLevelDetectState();
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, analytics(), now, st, e => calls.push(e));
    expect(calls.some(e => e.detectionKind === 'pivot')).toBe(false);   // 既存ピボットは seed 済=発火しない
    expect(st.pivotSeeded).toBe(true);
  });

  it('★seed 後に起動後 新しく確定したピボットは発火する(鮮度内)', () => {
    const st = createLevelDetectState();
    runLevelDetectors(db, analytics(), now, st, () => {});   // ①seed(既存ピボットを既知化)
    // ②起動後: より新しい確定ピボット(安値96→高値120の戻し)を作る足を追加し再実行。
    const t1 = t0 + 5 * 60_000;
    insertBar(db, t1 + 0 * 60_000, 97, 95, 95);     // 新しい安値(95)
    insertBar(db, t1 + 1 * 60_000, 130, 120, 128);  // 大きく戻して安値95を確定(reclaim)
    const now2 = t1 + 2 * 60_000;
    const a2: LevelAnalytics = { ...analytics(), latest: { symbol: NIY, t: now2, price: 128 } };
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, a2, now2, st, e => calls.push(e));
    expect(calls.some(e => e.detectionKind === 'pivot')).toBe(true);   // 起動後の新規ピボットは出る
  });

  it('同一 state を同時刻に再実行 → クールダウンで抑制。別 state は独立に発火(cross-suppress しない)', () => {
    const a = createLevelDetectState();
    const first: AlertEventPayload[] = [];
    runLevelDetectors(db, analytics(), now, a, e => first.push(e));
    const breaks1 = first.filter(e => e.detectionKind === 'break').length;
    expect(breaks1).toBe(1);
    // 同じ state・同じ now → lastEmit クールダウンで break は追加されない。
    const second: AlertEventPayload[] = [];
    runLevelDetectors(db, analytics(), now, a, e => second.push(e));
    expect(second.filter(e => e.detectionKind === 'break').length).toBe(0);
    // 別 consumer の state は first の発火に影響されず独立に発火する(per-consumer 分離)。
    const b = createLevelDetectState();
    const other: AlertEventPayload[] = [];
    runLevelDetectors(db, analytics(), now, b, e => other.push(e));
    expect(other.filter(e => e.detectionKind === 'break').length).toBe(1);
  });

  it('日足バンドの水準抜けを dailyband として sink に流す', () => {
    const calls: AlertEventPayload[] = [];
    const a: LevelAnalytics = {
      ...analytics(),
      result: { current: 96, up: [], down: [], swing: null, reversalSatisfied: false, asOf: now } as LevelsResult,
      dailyBandLevels: [{ price: 100, label: '-2sigma', refKind: 'sigma2' }],
    };
    runLevelDetectors(db, a, now, createLevelDetectState(), e => calls.push(e));
    expect(calls.some(e => e.detectionKind === 'dailyband' && e.direction === 'down')).toBe(true);
  });
});

describe('computeLevelAnalytics — tick が無ければ null', () => {
  it('ticks 空の DB では null(「蓄積中」相当)', () => {
    const db = memDb();
    expect(computeLevelAnalytics(db, Date.now(), createLevelDetectState())).toBeNull();
  });
});
