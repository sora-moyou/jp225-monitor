import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema } from '../db/store.js';
import { resetConfigCache } from '../configStore.js';
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

  // ★config 隔離(resolveBreakScore 等は ~/.jp225-monitor/config.json を読む)。実ユーザー設定を読まないよう HOME を差し替える。
  let cfgDir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  const writeConfig = (obj: Record<string, unknown>): void => {
    mkdirSync(join(cfgDir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(cfgDir, '.jp225-monitor', 'config.json'), JSON.stringify(obj), 'utf-8');
    resetConfigCache();
  };

  const analytics = (): LevelAnalytics => ({
    result: { current: 96, up: [], down: [lvl(100, 1, 'テスト水準')], swing: null, reversalSatisfied: false, asOf: now } as LevelsResult,
    latest: { symbol: NIY, t: now, price: 96 },
    sessions: [], cs: null, dailyBandLevels: [], dailyMaLevels: [], dbMs: 0, computeMs: 0,
  });

  beforeEach(() => {
    db = memDb();
    for (const b of downBreakBars(t0)) insertBar(db, b.t, b.h, b.l, b.l);   // close は本検知で未使用(h/l のみ)
    cfgDir = mkdtempSync(join(tmpdir(), 'jp225-reg-'));
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE;
    process.env.HOME = cfgDir; process.env.USERPROFILE = cfgDir;
    // 既定は breakScore=1.2(単独 break を出す)にして、以下のプラミング検証(sink/クールダウン独立)を成立させる。
    writeConfig({ breakScore: 1.2 });
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    resetConfigCache();
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it('tier≥1 水準の下抜けを break として sink に流す', () => {
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, analytics(), now, createLevelDetectState(), e => calls.push(e));
    expect(calls.some(e => e.detectionKind === 'break' && e.direction === 'down')).toBe(true);
  });

  it('★40日ライブ: 単独 break は既定 0.9<minScore1 で除外(コンフルエンス無しは出さない)', () => {
    writeConfig({});   // breakScore 未設定=既定 0.9。momentum も無い(recent は5分のみ)ので slope 加点も付かない。
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, analytics(), now, createLevelDetectState(), e => calls.push(e));
    expect(calls.some(e => e.detectionKind === 'break')).toBe(false);
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

describe('runLevelDetectors — double(スイングW)の形成抑制 / breakout 発火(40日ライブ)', () => {
  // ★double は反転が効かない → 既定は breakout のみ・forming は doubleFormingEnabled=true 時のみ。
  //   スイングバーは 90分の recent 窓の外(=break/pivot/level_sr のノイズを避ける)に置き、4日窓の double だけを評価させる。
  let db: DatabaseSync;
  let cfgDir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  const t0 = 1_700_000_000_000;
  const B = 300_000;                       // 5分足
  const now = t0 + 200 * 60_000;           // 最終バー(t0+25分)より十分後 → recent(90分)窓は空。

  const writeConfig = (obj: Record<string, unknown>): void => {
    mkdirSync(join(cfgDir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(cfgDir, '.jp225-monitor', 'config.json'), JSON.stringify(obj), 'utf-8');
    resetConfigCache();
  };

  // ダブルボトム W: 谷64,000 → ネック(山)65,200 → 谷64,050。finalHigh で forming/breakout を切替。
  //   breakout: finalHigh=65,300(現値>ネック+5) / forming: finalHigh=64,650(谷2確定に足りる戻りだが現値≤ネック+5)。
  function swingBars(finalHigh: number): { t: number; h: number; l: number }[] {
    return [
      { t: t0 + 0 * B, h: 64100, l: 64000 },   // 谷1(64,000)
      { t: t0 + 1 * B, h: 64720, l: 64200 },   // 戻り→谷1確定(reclaim≈522)
      { t: t0 + 2 * B, h: 65200, l: 64800 },   // ネック(山65,200)
      { t: t0 + 3 * B, h: 64900, l: 64600 },   // 押し→ネック確定
      { t: t0 + 4 * B, h: 64300, l: 64050 },   // 谷2(64,050)
      { t: t0 + 5 * B, h: finalHigh, l: 64200 },   // 戻り→谷2確定 + 現値
    ];
  }
  const analyticsFor = (price: number): LevelAnalytics => ({
    result: { current: price, up: [], down: [], swing: null, reversalSatisfied: false, asOf: now } as LevelsResult,
    latest: { symbol: NIY, t: now, price },
    sessions: [], cs: null, dailyBandLevels: [], dailyMaLevels: [], dbMs: 0, computeMs: 0,
  });
  const seed = (bars: { t: number; h: number; l: number }[]): void => {
    db = memDb();
    for (const b of bars) insertBar(db, b.t, b.h, b.l, Math.round((b.h + b.l) / 2));
  };

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'jp225-reg2-'));
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE;
    process.env.HOME = cfgDir; process.env.USERPROFILE = cfgDir;
    writeConfig({});   // 既定(doubleFormingEnabled 未設定=false / breakScore 0.9)。
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    resetConfigCache();
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it('breakout(成立)は既定で double として発火し score=1.0', () => {
    seed(swingBars(65300));
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, analyticsFor(65300), now, createLevelDetectState(), e => calls.push(e));
    const d = calls.find(e => e.detectionKind === 'double');
    expect(d).toBeTruthy();
    expect(d!.direction).toBe('up');   // ダブルボトム → 上
  });

  it('forming(形成)は既定OFF=double を発火しない', () => {
    seed(swingBars(64650));
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, analyticsFor(64650), now, createLevelDetectState(), e => calls.push(e));
    expect(calls.some(e => e.detectionKind === 'double')).toBe(false);
  });

  it('doubleFormingEnabled=true なら forming も double として発火', () => {
    writeConfig({ doubleFormingEnabled: true });
    seed(swingBars(64650));
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, analyticsFor(64650), now, createLevelDetectState(), e => calls.push(e));
    expect(calls.some(e => e.detectionKind === 'double')).toBe(true);
  });
});

describe('runLevelDetectors — N波動(nwave)アラートの発火/未発火/クールダウン', () => {
  // ★nwave は analytics で算出済みの N 波(a.nwave)を使って emit する(節目と同一の波=乖離しない)。
  //   ここでは emit/クールダウン配線を検証(値幅計算そのものは nwave.test.ts で網羅)。
  let db: DatabaseSync;
  const t0 = 1_700_000_000_000;
  const now = t0 + 5 * 60_000;

  beforeEach(() => { db = memDb(); });

  // 上昇N波(確認済み): A66,100 → B66,800 → C66,300、V値=67,300。
  const nwUp = { direction: 'up' as const, a: 66100, b: 66800, c: 66300, bT: t0 + 2 * 60_000,
    targets: { N: 67000, V: 67300, E: 67500 } };
  const base = (nwave: unknown): LevelAnalytics => ({
    result: { current: 66900, up: [], down: [], swing: null, reversalSatisfied: false, asOf: now } as LevelsResult,
    latest: { symbol: NIY, t: now, price: 66900 },
    sessions: [], cs: null, dailyBandLevels: [], dailyMaLevels: [],
    nwave: nwave as LevelAnalytics['nwave'], dbMs: 0, computeMs: 0,
  });

  it('確認済み上昇N波で nwave を発火し、目標V値(67,300)を文言に含む', () => {
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, base(nwUp), now, createLevelDetectState(), e => calls.push(e));
    const ev = calls.find(e => e.detectionKind === 'nwave');
    expect(ev).toBeTruthy();
    expect(ev!.direction).toBe('up');
    expect(ev!.note).toContain('上昇N波');
    expect(ev!.note).toContain('67,300');   // V値
    expect(ev!.referencePrice).toBe(67300);
  });

  it('N波が無い(未確認)なら nwave を発火しない', () => {
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, base(null), now, createLevelDetectState(), e => calls.push(e));
    expect(calls.some(e => e.detectionKind === 'nwave')).toBe(false);
  });

  it('同一B(同じ波)はクールダウンで再発火しない', () => {
    const st = createLevelDetectState();
    const first: AlertEventPayload[] = [];
    runLevelDetectors(db, base(nwUp), now, st, e => first.push(e));
    expect(first.filter(e => e.detectionKind === 'nwave').length).toBe(1);
    const second: AlertEventPayload[] = [];
    runLevelDetectors(db, base(nwUp), now + 60_000, st, e => second.push(e));
    expect(second.filter(e => e.detectionKind === 'nwave').length).toBe(0);
  });

  it('別のB(新しい波)はクールダウン内でも再発火する', () => {
    const st = createLevelDetectState();
    runLevelDetectors(db, base(nwUp), now, st, () => {});
    const nwUp2 = { ...nwUp, b: 66900, targets: { N: 67100, V: 67500, E: 67700 } };   // 別のB
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, base(nwUp2), now + 60_000, st, e => calls.push(e));
    expect(calls.some(e => e.detectionKind === 'nwave')).toBe(true);
  });
});

describe('computeLevelAnalytics — tick が無ければ null', () => {
  it('ticks 空の DB では null(「蓄積中」相当)', () => {
    const db = memDb();
    expect(computeLevelAnalytics(db, Date.now(), createLevelDetectState())).toBeNull();
  });
});
