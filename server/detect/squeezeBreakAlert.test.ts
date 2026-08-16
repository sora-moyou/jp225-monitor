import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema } from '../db/store.js';
import { resetConfigCache } from '../configStore.js';
import {
  createLevelDetectState, makeSqueezeBreakWatch, squeezeBreakFire, squeezeBreakKind,
  describeSqueezeBreak, runLevelDetectors, type LevelAnalytics, type LevelDetectState,
} from './registry.js';
import { isDirectionalKind } from '../../core/detectionKinds.js';
import type { AlertEventPayload } from '../types.js';
import type { LevelsResult } from '../levels.js';

// スクイーズ/バルジ **後の抜け**(squeeze_break / bulge_break)の発火規則。
//
// 親(squeeze/bulge)の規則は server/detect/squeezeAlert.test.ts が固定している。ここが固定するのは
// 「親が鳴った確定5分足のレンジを、その後どちらへ外したか」だけ:
//   ①上抜け = 現値 > その足の高値 + 5円(緩衝。呼値1つぶん外)/ 下抜け = 現値 < 安値 − 5円
//   ②1事象につき 上1回・下1回まで(往復したら両方鳴る = それが情報)
//   ③親の発火から60分を過ぎたら見張りを捨てる
//   ④新しい親が鳴ったら見張りごと差し替え(前の事象は終了)
// ★売買はしない(表示・記録のみ)。エンジン(server/signalTrade/**)はこの種別を見ない。

const T0 = 1_770_000_000_000;
const MIN = 60_000;
const HIGH = 62_490;
const LOW = 62_410;

/** 既定の見張り(スクイーズ足 高値 62,490 / 安値 62,410 を T0 に張った状態)。 */
function stateWithWatch(kind: 'squeeze' | 'bulge' = 'squeeze', firedAt = T0): LevelDetectState {
  const st = createLevelDetectState();
  st.squeeze.watch = makeSqueezeBreakWatch(kind, { h: HIGH, l: LOW }, firedAt);
  return st;
}

describe('squeezeBreakKind — 親の種別から検知種別へ', () => {
  it('squeeze→squeeze_break / bulge→bulge_break', () => {
    expect(squeezeBreakKind('squeeze')).toBe('squeeze_break');
    expect(squeezeBreakKind('bulge')).toBe('bulge_break');
  });
  it('★どちらも方向を持つ種別(親は方向なし・子は方向あり)', () => {
    expect(isDirectionalKind(squeezeBreakKind('squeeze'))).toBe(true);
    expect(isDirectionalKind(squeezeBreakKind('bulge'))).toBe(true);
    expect(isDirectionalKind('squeeze')).toBe(false);
    expect(isDirectionalKind('bulge')).toBe(false);
  });
});

describe('squeezeBreakFire — 見張りが無ければ何も起きない', () => {
  it('親がまだ鳴っていない(watch=null)なら、どんな価格でも null', () => {
    const st = createLevelDetectState();
    let checked = 0;
    for (const p of [0, 1, LOW - 10_000, HIGH, HIGH + 10_000, 1e9]) {
      expect(squeezeBreakFire(st, p, T0), `price=${p}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(6);
  });
});

describe('squeezeBreakFire — 緩衝5円(節目ちょうどには置かない)', () => {
  it('★上: 高値ちょうど / 高値+5 は鳴らない。高値+5 を **超えた** ら鳴る', () => {
    let checked = 0;
    // 鳴らない側: 高値以下 〜 高値+5(境界ちょうどを含む)
    for (const d of [-1, 0, 1, 4, 5]) {
      expect(squeezeBreakFire(stateWithWatch(), HIGH + d, T0), `high+${d}`).toBeNull();
      checked++;
    }
    // 鳴る側: 高値+5 超
    for (const d of [5.01, 6, 10, 100]) {
      const got = squeezeBreakFire(stateWithWatch(), HIGH + d, T0);
      expect(got, `high+${d}`).toEqual({ kind: 'squeeze', direction: 'up', level: HIGH });
      checked++;
    }
    expect(checked).toBe(9);
  });

  it('★下: 安値ちょうど / 安値−5 は鳴らない。安値−5 を **割った** ら鳴る(上と対称)', () => {
    let checked = 0;
    for (const d of [1, 0, -1, -4, -5]) {
      expect(squeezeBreakFire(stateWithWatch(), LOW + d, T0), `low${d}`).toBeNull();
      checked++;
    }
    for (const d of [-5.01, -6, -10, -100]) {
      const got = squeezeBreakFire(stateWithWatch(), LOW + d, T0);
      expect(got, `low${d}`).toEqual({ kind: 'squeeze', direction: 'down', level: LOW });
      checked++;
    }
    expect(checked).toBe(9);
  });

  it('水準は緩衝を足す前の素の高安を返す(アラート文に出すのは足の高安であって緩衝込みの値ではない)', () => {
    expect(squeezeBreakFire(stateWithWatch(), HIGH + 50, T0)?.level).toBe(HIGH);
    expect(squeezeBreakFire(stateWithWatch(), LOW - 50, T0)?.level).toBe(LOW);
  });

  it('バルジの見張りなら kind=bulge が返る', () => {
    expect(squeezeBreakFire(stateWithWatch('bulge'), HIGH + 50, T0))
      .toEqual({ kind: 'bulge', direction: 'up', level: HIGH });
    expect(squeezeBreakFire(stateWithWatch('bulge'), LOW - 50, T0))
      .toEqual({ kind: 'bulge', direction: 'down', level: LOW });
  });
});

describe('squeezeBreakFire — 1事象につき 上1回・下1回まで', () => {
  it('同じ方向は2度目以降 鳴らない(価格が上に居続けても連発しない)', () => {
    const st = stateWithWatch();
    expect(squeezeBreakFire(st, HIGH + 20, T0 + 1 * MIN)?.direction).toBe('up');
    let checked = 0;
    for (const p of [HIGH + 20, HIGH + 30, HIGH + 6, HIGH + 500]) {
      expect(squeezeBreakFire(st, p, T0 + 2 * MIN), `p=${p}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it('★往復したら両方鳴る(上抜け→戻して下抜け)', () => {
    const st = stateWithWatch();
    expect(squeezeBreakFire(st, HIGH + 20, T0 + 1 * MIN))
      .toEqual({ kind: 'squeeze', direction: 'up', level: HIGH });
    expect(squeezeBreakFire(st, (HIGH + LOW) / 2, T0 + 2 * MIN)).toBeNull();   // レンジ内へ戻る
    expect(squeezeBreakFire(st, LOW - 20, T0 + 3 * MIN))
      .toEqual({ kind: 'squeeze', direction: 'down', level: LOW });
    // 両方 済んだら以後は何をしても鳴らない。
    let checked = 0;
    for (const p of [HIGH + 100, LOW - 100, HIGH + 6, LOW - 6]) {
      expect(squeezeBreakFire(st, p, T0 + 4 * MIN), `p=${p}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it('下抜けが先でも対称に両方鳴る', () => {
    const st = stateWithWatch();
    expect(squeezeBreakFire(st, LOW - 20, T0 + 1 * MIN)?.direction).toBe('down');
    expect(squeezeBreakFire(st, HIGH + 20, T0 + 2 * MIN)?.direction).toBe('up');
    expect(squeezeBreakFire(st, HIGH + 30, T0 + 3 * MIN)).toBeNull();
  });
});

describe('squeezeBreakFire — 有効期限60分', () => {
  it('ちょうど60分は まだ有効 / 60分を超えたら見張りを捨てる', () => {
    const onTime = stateWithWatch();
    expect(squeezeBreakFire(onTime, HIGH + 20, T0 + 60 * MIN)?.direction).toBe('up');

    const late = stateWithWatch();
    expect(squeezeBreakFire(late, HIGH + 20, T0 + 60 * MIN + 1)).toBeNull();
    // 捨てたので、以後は時刻を戻しても価格を動かしても鳴らない。
    expect(late.squeeze.watch).toBeNull();
    let checked = 0;
    for (const [p, t] of [[HIGH + 20, T0 + 61 * MIN], [LOW - 20, T0 + 62 * MIN], [HIGH + 500, T0 + 5 * MIN]] as const) {
      expect(squeezeBreakFire(late, p, t), `p=${p}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it('期限内に上抜けだけ済ませ、期限後に下へ行っても下抜けは鳴らない', () => {
    const st = stateWithWatch();
    expect(squeezeBreakFire(st, HIGH + 20, T0 + 10 * MIN)?.direction).toBe('up');
    expect(squeezeBreakFire(st, LOW - 20, T0 + 61 * MIN)).toBeNull();
    expect(st.squeeze.watch).toBeNull();
  });
});

describe('makeSqueezeBreakWatch — 新しい事象は前の事象を終了させる', () => {
  it('★水準が差し替わる — 旧水準なら鳴っていた価格で鳴らなくなる', () => {
    const st = stateWithWatch();                       // 旧: 高値62,490 / 安値62,410(まだ何も鳴っていない)
    // 旧水準のままなら 62,850 は上抜け(62,490+5 を大きく超える)として鳴るはずの価格。
    expect(squeezeBreakFire(stateWithWatch(), 62_850, T0 + 31 * MIN)?.direction).toBe('up');
    // 新しいバルジが別の足(高値62,900 / 安値62,800)で発火 → 見張りごと張り直す。
    st.squeeze.watch = makeSqueezeBreakWatch('bulge', { h: 62_900, l: 62_800 }, T0 + 30 * MIN);
    // 同じ 62,850 は新レンジの内側なので **鳴らない**(= 旧水準はもう使われていない)。
    expect(squeezeBreakFire(st, 62_850, T0 + 31 * MIN)).toBeNull();
  });

  it('★済みフラグもリセットされる(旧事象で上抜け済みでも、新事象では改めて上抜けが鳴る)', () => {
    const st = stateWithWatch();
    expect(squeezeBreakFire(st, HIGH + 20, T0 + 1 * MIN)?.direction).toBe('up');   // 旧事象で上抜け済み
    st.squeeze.watch = makeSqueezeBreakWatch('bulge', { h: 62_900, l: 62_800 }, T0 + 30 * MIN);
    // 種別・水準とも新事象のものになり、up も改めて鳴る。
    expect(squeezeBreakFire(st, 62_920, T0 + 32 * MIN))
      .toEqual({ kind: 'bulge', direction: 'up', level: 62_900 });
    // 期限も新事象の発火時刻から数え直す(旧事象の T0 起点なら 62分後は切れている)。
    expect(squeezeBreakFire(st, 62_780, T0 + 62 * MIN))
      .toEqual({ kind: 'bulge', direction: 'down', level: 62_800 });
  });
});

describe('describeSqueezeBreak — アラート文(水準と現値の両方が出る)', () => {
  it('スクイーズ後の上抜け', () => {
    expect(describeSqueezeBreak('squeeze', 'up', 62_490, 62_495))
      .toBe('スクイーズ後の上抜け — 62,495円(スクイーズ足の高値 62,490 を突破)');
  });
  it('バルジ後の下抜け', () => {
    expect(describeSqueezeBreak('bulge', 'down', 62_910, 62_905))
      .toBe('バルジ後の下抜け — 62,905円(バルジ足の安値 62,910 を割り込み)');
  });
  it('スクイーズ後の下抜け / バルジ後の上抜け(4通り全部)', () => {
    expect(describeSqueezeBreak('squeeze', 'down', 62_410, 62_400))
      .toBe('スクイーズ後の下抜け — 62,400円(スクイーズ足の安値 62,410 を割り込み)');
    expect(describeSqueezeBreak('bulge', 'up', 63_000, 63_010))
      .toBe('バルジ後の上抜け — 63,010円(バルジ足の高値 63,000 を突破)');
  });
});

// ─── 否定対照: ノブを外すと発火が増える(= ノブが実際に効いている証拠)─────────────────────
describe('★否定対照: 期限/緩衝を外すと同じ価格系列で発火数が増える', () => {
  // 見張り(高値 62,490 / 安値 62,410)を T0 に張り、120分ぶんの現値を1分ごとに流す。
  //   m5  : 62,600 … 期限内・緩衝越えの明確な上抜け(既定でも鳴る = 基準の1件)
  //   m20 : 62,405 … 安値は割るが 緩衝(−5)の内側 → 既定では鳴らない(緩衝0なら鳴る)
  //   m80 : 62,300 … 明確な下抜けだが 60分を過ぎている → 既定では鳴らない(無期限なら鳴る)
  const SERIES: { m: number; price: number }[] = Array.from({ length: 120 }, (_, m) => ({ m, price: 62_450 }));
  SERIES[5]!.price = 62_600;
  SERIES[20]!.price = 62_405;
  SERIES[80]!.price = 62_300;

  function replay(bufferYen?: number, expireMs?: number): string[] {
    const st = stateWithWatch();
    const fires: string[] = [];
    for (const s of SERIES) {
      const got = squeezeBreakFire(
        st, s.price, T0 + s.m * MIN,
        bufferYen ?? undefined, expireMs ?? undefined,
      );
      if (got) fires.push(`m${s.m}:${got.direction}`);
    }
    return fires;
  }

  it('基準(緩衝5円・期限60分)は 上抜け1件だけ', () => {
    expect(replay()).toEqual(['m5:up']);
  });

  it('①期限を外す(無期限)と発火が増える', () => {
    const base = replay();
    const noExpire = replay(undefined, Number.MAX_SAFE_INTEGER);
    expect(noExpire.length).toBeGreaterThan(base.length);
    expect(noExpire).toEqual(['m5:up', 'm80:down']);   // 60分超の下抜けが増える
  });

  it('②緩衝を0にすると発火が増える', () => {
    const base = replay();
    const noBuffer = replay(0);
    expect(noBuffer.length).toBeGreaterThan(base.length);
    expect(noBuffer).toEqual(['m5:up', 'm20:down']);   // 安値ちょうど割れが増える
  });
});

// ─── 配線(runLevelDetectors)まで通す: 種別・方向・文言・基準が実際に sink へ出るか ─────────
describe('runLevelDetectors — 見張りがある状態で現値が抜けたら sink に流れる', () => {
  let db: DatabaseSync;
  const now = T0 + 10 * MIN;

  // ★config 隔離(周辺の検知が ~/.jp225-monitor/config.json を読む)。実ユーザー設定を読ませない。
  let cfgDir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  const analytics = (price: number): LevelAnalytics => ({
    result: { current: price, up: [], down: [], swing: null, reversalSatisfied: false, asOf: now } as LevelsResult,
    latest: { symbol: 'NIY=F', t: now, price },
    sessions: [], cs: null, dailyBandLevels: [], dailyMaLevels: [], dbMs: 0, computeMs: 0,
  });

  /** watch を張った state で1回回し、squeeze_break/bulge_break だけを取り出す。 */
  function run(price: number, kind: 'squeeze' | 'bulge' = 'squeeze', at = now, firedAt = T0): AlertEventPayload[] {
    const st = stateWithWatch(kind, firedAt);
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, analytics(price), at, st, e => calls.push(e));
    return calls.filter(e => e.detectionKind === 'squeeze_break' || e.detectionKind === 'bulge_break');
  }

  beforeEach(() => {
    db = new DatabaseSync(':memory:'); initSchema(db);
    cfgDir = mkdtempSync(join(tmpdir(), 'jp225-sqbrk-'));
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

  it('スクイーズ後の上抜けが detectionKind=squeeze_break / direction=up で1件出る', () => {
    const out = run(HIGH + 5.5);
    expect(out.length).toBe(1);
    const e = out[0]!;
    expect(e.detectionKind).toBe('squeeze_break');
    expect(e.direction).toBe('up');
    expect(e.level).toBe(HIGH);
    expect(e.referenceKind).toBe('level');
    expect(e.referencePrice).toBe(HIGH);
    // 文言に **水準と現値の両方** が出ている(片方だけだと何を超えたのか分からない)。
    expect(e.note).toBe(describeSqueezeBreak('squeeze', 'up', HIGH, HIGH + 5.5));
    expect(e.note).toContain('62,490');           // 水準
    expect(e.note).toContain('62,496');           // 現値(四捨五入)
  });

  it('バルジ後の下抜けが detectionKind=bulge_break / direction=down で1件出る', () => {
    const out = run(LOW - 6, 'bulge');
    expect(out.length).toBe(1);
    expect(out[0]!.detectionKind).toBe('bulge_break');
    expect(out[0]!.direction).toBe('down');
    expect(out[0]!.level).toBe(LOW);
    expect(out[0]!.note).toBe(describeSqueezeBreak('bulge', 'down', LOW, LOW - 6));
  });

  it('緩衝の内側 / レンジ内では1件も出ない', () => {
    let checked = 0;
    for (const p of [HIGH, HIGH + 5, LOW, LOW - 5, (HIGH + LOW) / 2]) {
      expect(run(p).length, `p=${p}`).toBe(0);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it('期限(60分)を過ぎた見張りでは出ない', () => {
    expect(run(HIGH + 50, 'squeeze', T0 + 60 * MIN).length).toBe(1);
    expect(run(HIGH + 50, 'squeeze', T0 + 60 * MIN + 1).length).toBe(0);
  });

  it('見張りが無ければ(親がまだ鳴っていない)出ない', () => {
    const calls: AlertEventPayload[] = [];
    runLevelDetectors(db, analytics(HIGH + 500), now, createLevelDetectState(), e => calls.push(e));
    expect(calls.filter(e => e.detectionKind === 'squeeze_break' || e.detectionKind === 'bulge_break').length).toBe(0);
  });
});
