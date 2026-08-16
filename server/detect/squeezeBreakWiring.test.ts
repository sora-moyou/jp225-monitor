import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema } from '../db/store.js';
import { resetConfigCache } from '../configStore.js';
import { createLevelDetectState, runLevelDetectors, type LevelAnalytics, type LevelDetectState } from './registry.js';
import { aggregate5m } from '../indicators.js';
import { SQUEEZE_BB_PERIOD, SQUEEZE_BW_LOOKBACK } from '../../core/indicatorSpec.js';
import type { AlertEventPayload } from '../types.js';
import type { LevelsResult } from '../levels.js';

// ★本番配線(runLevelDetectors)を **実際に通す** 通しテスト。
//
// server/detect/squeezeBreakAlert.test.ts は純関数(squeezeBreakFire 等)と「見張りを手で置いた状態」を
// 固定しているが、**親(スクイーズ/バルジ)の発火から見張りを張る唯一の本番経路**
//   registry.ts:  state.squeeze.watch = makeSqueezeBreakWatch(fired, lastClosed, now);
// を通るテストが1本も無かった(この行を無効化しても全テストが緑になった=機能が本番で死んでも気づけない)。
// ここが固定するのは、DB の1分足だけを入力にした通しで:
//   ①親が鳴った直後、state.squeeze.watch が **張られている**(null ではない)
//   ②その見張りの高安は **確定5分足** の h/l と一致し、**形成中の足** の h/l とは一致しない
//   ③続けて 高値+5 を超える現値を流すと squeeze_break が up で sink に出る
//   ④バルジ側は 安値−5 割れで bulge_break が down で出る(下抜けも対称)
//
// ★逃げ道を作らない: 「見張りが無ければ何も検査しない」形にすると穴がそのまま残るので、
//   watch は必ず not.toBeNull() で明示的に主張し、件数も toBe(1) で固定する。

const SYMBOL = 'NIY=F';
const MIN = 60_000;
const TF5 = 5 * MIN;
const T0 = 1_770_000_000_000;        // 5分境界に乗った基準時刻(1_770_000_000_000 / 300_000 = 5,900,000)

// 判定に必要な確定5分足の本数。BW は先頭 (SQUEEZE_BB_PERIOD−1) 本が欠測なので、
// 参照本数 SQUEEZE_BW_LOOKBACK を満たす最小 = 72 + 19 = 91本(= ready ちょうど)。
const CLOSED_5M_BARS = SQUEEZE_BW_LOOKBACK + SQUEEZE_BB_PERIOD - 1;
const FORMING_IDX = CLOSED_5M_BARS;   // 最後の1本(形成中)= 91
const BASE = 62_000;

// 1分足の高安の付け方。確定足と形成中の足で **明確に違う** 幅にして、取り違えたら赤くなるようにする。
const BAR_UP = 30, BAR_DOWN = 40;             // 確定足: close+30 / close−40
const FORMING_UP = 400, FORMING_DOWN = 400;   // 形成中の足: close±400(確定足の高安とは桁違い)

/** 5分足 i 本目の終値。squeeze = 最後の20本だけ平坦(BW が窓の最小)/ bulge = 最後の20本だけ暴れる(最大)。 */
function closeOf(kind: 'squeeze' | 'bulge', i: number): number {
  const sign = i % 2 === 0 ? 1 : -1;
  const calm = BASE + sign;                    // ほぼ平坦(BW ≒ 0)
  const wild = BASE + sign * (i - 70) * 60;    // 振幅がどんどん伸びる(BW が最大へ)
  const swing = BASE + sign * 300;             // 一定の大きな振れ(比較対象の BW)
  if (kind === 'squeeze') return i <= 70 ? swing : calm;
  return i <= 70 ? calm : wild;
}

interface SeedResult { closedHigh: number; closedLow: number; formingHigh: number; formingLow: number }

/** 親を鳴らすティックの現値。確定足のレンジ **内側** に置く(親と同じティックで子が鳴ってしまわないように)。 */
const insidePrice = (s: SeedResult): number => (s.closedHigh + s.closedLow) / 2;

/** DB の bars_1m に「確定91本 + 形成中1本」ぶんの1分足を書く(本番と同じ入力の作り方)。 */
function seedBars(db: DatabaseSync, kind: 'squeeze' | 'bulge'): SeedResult {
  const ins = db.prepare(
    'INSERT OR REPLACE INTO bars_1m (symbol, session_date, session, t, o, h, l, c) VALUES (?,?,?,?,?,?,?,?)',
  );
  for (let i = 0; i < CLOSED_5M_BARS; i++) {
    const c = closeOf(kind, i);
    for (let j = 0; j < 5; j++) ins.run(SYMBOL, '2026-02-02', 'Day', T0 + i * TF5 + j * MIN, c, c + BAR_UP, c - BAR_DOWN, c);
  }
  // 形成中の足(now を含む枠)。3本だけ載っている = まだ閉じていない。
  for (let j = 0; j < 3; j++) {
    ins.run(SYMBOL, '2026-02-02', 'Day', T0 + FORMING_IDX * TF5 + j * MIN, BASE, BASE + FORMING_UP, BASE - FORMING_DOWN, BASE);
  }
  const lastClosedC = closeOf(kind, CLOSED_5M_BARS - 1);
  return {
    closedHigh: lastClosedC + BAR_UP, closedLow: lastClosedC - BAR_DOWN,
    formingHigh: BASE + FORMING_UP, formingLow: BASE - FORMING_DOWN,
  };
}

describe('★本番配線: runLevelDetectors が確定5分足から見張りを張る(親→子の唯一の経路)', () => {
  let db: DatabaseSync;
  // 形成中の枠の3分目。now−SETTLE(20秒)も同じ5分枠に入るので、この枠が「今の slot」。
  const now = T0 + FORMING_IDX * TF5 + 3 * MIN;

  // ★config 隔離(周辺の検知が ~/.jp225-monitor/config.json を読む)。実ユーザー設定を読ませない。
  let cfgDir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  const analytics = (price: number, at: number): LevelAnalytics => ({
    result: { current: price, up: [], down: [], swing: null, reversalSatisfied: false, asOf: at } as LevelsResult,
    latest: { symbol: SYMBOL, t: at, price },
    sessions: [], cs: null, dailyBandLevels: [], dailyMaLevels: [], dbMs: 0, computeMs: 0,
  });

  /** 本番の配線を1回まわす(state は呼び出し側が持ち回る = 実走と同じ)。 */
  function tick(st: LevelDetectState, price: number, at: number): AlertEventPayload[] {
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, analytics(price, at), at, st, e => calls.push(e));
    return calls;
  }

  beforeEach(() => {
    db = new DatabaseSync(':memory:'); initSchema(db);
    cfgDir = mkdtempSync(join(tmpdir(), 'jp225-sqwire-'));
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE;
    process.env.HOME = cfgDir; process.env.USERPROFILE = cfgDir;
    mkdirSync(join(cfgDir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(cfgDir, '.jp225-monitor', 'config.json'), JSON.stringify({}), 'utf-8');
    resetConfigCache();
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    resetConfigCache();
    rmSync(cfgDir, { recursive: true, force: true });
    db.close();
  });

  it('前提: 仕込んだ足は「確定91本 + 形成中1本」で、確定足と形成中の足の高安は別物', () => {
    const seed = seedBars(db, 'squeeze');
    const bars5 = aggregate5m(
      db.prepare('SELECT t, o, h, l, c FROM bars_1m WHERE symbol = ? ORDER BY t ASC').all(SYMBOL) as unknown as
        { t: number; o: number; h: number; l: number; c: number }[],
    );
    expect(bars5.length).toBe(CLOSED_5M_BARS + 1);            // 確定91 + 形成中1
    expect(bars5[bars5.length - 1]!.t).toBe(T0 + FORMING_IDX * TF5);
    const lastClosed = bars5[bars5.length - 2]!;
    expect(lastClosed.h).toBe(seed.closedHigh);
    expect(lastClosed.l).toBe(seed.closedLow);
    expect(bars5[bars5.length - 1]!.h).toBe(seed.formingHigh);
    expect(bars5[bars5.length - 1]!.l).toBe(seed.formingLow);
    // 取り違えたら必ず差が出る幅にしてある(= ②の検査が意味を持つ前提)。
    expect(seed.closedHigh).not.toBe(seed.formingHigh);
    expect(seed.closedLow).not.toBe(seed.formingLow);
  });

  it('①スクイーズが鳴った直後、state.squeeze.watch が張られている(本番の配線を通っている)', () => {
    const seed = seedBars(db, 'squeeze');
    const st = createLevelDetectState();
    expect(st.squeeze.watch).toBeNull();                       // 出発点(親がまだ鳴っていない)
    const out = tick(st, insidePrice(seed), now);
    // 親が実際に鳴っている(鳴っていないテストではない)。
    expect(out.filter(e => e.detectionKind === 'squeeze').length).toBe(1);
    // ★逃げ道を作らない: 「張られていなければ検査しない」ではなく、張られていることを主張する。
    expect(st.squeeze.watch).not.toBeNull();
    expect(st.squeeze.watch!.kind).toBe('squeeze');
    expect(st.squeeze.watch!.firedAt).toBe(now);
    expect(st.squeeze.watch!.upDone).toBe(false);
    expect(st.squeeze.watch!.downDone).toBe(false);
  });

  it('②見張りの高安は **確定5分足** の h/l と一致し、形成中の足の h/l とは一致しない', () => {
    const seed = seedBars(db, 'squeeze');
    const st = createLevelDetectState();
    tick(st, insidePrice(seed), now);
    expect(st.squeeze.watch).not.toBeNull();
    const w = st.squeeze.watch!;
    // 確定足の高安(literal でも固定する: 62,001 ± 30/40)。
    expect(w.high).toBe(seed.closedHigh);
    expect(w.low).toBe(seed.closedLow);
    expect(w.high).toBe(62_031);
    expect(w.low).toBe(61_961);
    // ★形成中の足の高安ではない(差し替えたら赤くなる形)。
    expect(w.high).not.toBe(seed.formingHigh);
    expect(w.low).not.toBe(seed.formingLow);
  });

  it('③続けて 高値+5 を超える現値を流すと squeeze_break が up で出る', () => {
    const seed = seedBars(db, 'squeeze');
    const st = createLevelDetectState();
    tick(st, insidePrice(seed), now);
    expect(st.squeeze.watch).not.toBeNull();
    // 同じ5分枠の次のティック(slot が変わらないので見張りはそのまま)。
    const price = seed.closedHigh + 5.5;
    const out = tick(st, price, now + MIN).filter(e => e.detectionKind === 'squeeze_break');
    expect(out.length).toBe(1);
    expect(out[0]!.direction).toBe('up');
    expect(out[0]!.level).toBe(seed.closedHigh);
    expect(out[0]!.referenceKind).toBe('level');
    expect(out[0]!.referencePrice).toBe(seed.closedHigh);
    expect(out[0]!.note).toContain('スクイーズ後の上抜け');
  });

  it('③否定側: 確定足の高値+5 ちょうど(緩衝の内側)では出ない', () => {
    const seed = seedBars(db, 'squeeze');
    const st = createLevelDetectState();
    tick(st, insidePrice(seed), now);
    expect(st.squeeze.watch).not.toBeNull();
    let checked = 0;
    for (const p of [seed.closedHigh, seed.closedHigh + 5, seed.closedLow, seed.closedLow - 5]) {
      const st2 = createLevelDetectState();
      tick(st2, insidePrice(seed), now);
      expect(st2.squeeze.watch, `p=${p}`).not.toBeNull();
      expect(tick(st2, p, now + MIN).filter(e => e.detectionKind === 'squeeze_break').length, `p=${p}`).toBe(0);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it('④バルジ側も同じ経路で見張りが張られ、安値−5 割れで bulge_break が down で出る', () => {
    const seed = seedBars(db, 'bulge');
    const st = createLevelDetectState();
    const parent = tick(st, insidePrice(seed), now);
    expect(parent.filter(e => e.detectionKind === 'bulge').length).toBe(1);
    expect(st.squeeze.watch).not.toBeNull();
    const w = st.squeeze.watch!;
    expect(w.kind).toBe('bulge');
    expect(w.high).toBe(seed.closedHigh);
    expect(w.low).toBe(seed.closedLow);
    expect(w.low).not.toBe(seed.formingLow);          // 形成中の足ではない
    const out = tick(st, seed.closedLow - 6, now + MIN).filter(e => e.detectionKind === 'bulge_break');
    expect(out.length).toBe(1);
    expect(out[0]!.direction).toBe('down');
    expect(out[0]!.level).toBe(seed.closedLow);
    expect(out[0]!.note).toContain('バルジ後の下抜け');
  });
});
