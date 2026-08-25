import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache, resolveScalpBias, resolveScalpBiasDirective, resolveForcedTrend } from '../configStore.js';
import { getSettingsHandler, postSettingsHandler } from './settings.js';

// ★2026-08-25(ユーザー指示 + エバリュエーターのブロッカー1): 目線に「レンジ」を保存できる。
//
// ■ 何が壊れていたか(エバリュエーターが実HTTPで再現)
//   受理値に 'range' が無く、画面で「レンジ」を選んで保存すると **400** で落ち、
//   しかも postSettingsHandler は all-or-nothing なので **同時に変えた他の項目も全部捨てられて**いた:
//     status = 400  body = {"error":"scalpBias must be one of long|short|none"}
//     GET scalpBias = long / scalpLcFloorYen = 55(変更前のまま)
//   ★4,378件のテストは1本もこれを踏まなかった。**保存の経路を1本も試していなかった**のが原因。
//
// ■ このテストが固定する不変条件
//   ① A/B/lite の3経路とも 'range' を保存して読み戻せる
//   ② 'range' を含む保存で **他の項目も一緒に保存される**(all-or-nothing に巻き込まれない)
//   ③ 保存した 'range' が resolveForcedTrend まで届く(=B だけを呼ぶ経路に入る)
//   ④ ★恒真でない: 出鱈目な値は従来どおり 400 で弾く

const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
let dir: string;

function mockRes() {
  const out: { code: number; body: Record<string, unknown> } = { code: 200, body: {} };
  return {
    out,
    status(c: number) { out.code = c; return this; },
    json(b: Record<string, unknown>) { out.body = b; return this; },
  };
}
function post(body: Record<string, unknown>) {
  const res = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postSettingsHandler({ body } as any, res as any);
  return res.out;
}
function get(): Record<string, unknown> {
  const res = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSettingsHandler({} as any, res as any);
  return res.out.body;
}

describe('★/api/settings: 目線に「レンジ」を保存できる(実ファイル round-trip)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-bias-range-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    resetConfigCache();
  });
  afterEach(() => {
    process.env.HOME = ORIG_HOME; process.env.USERPROFILE = ORIG_USERPROFILE;
    resetConfigCache();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('① A: 手動 + レンジ を保存して読み戻せる(200)', () => {
    const r = post({ scalpBias: 'range', scalpBiasSource: 'manual' });
    expect(r.code).toBe(200);
    resetConfigCache();
    expect(get().scalpBias).toBe('range');
    expect(resolveScalpBias()).toBe('range');
  });

  it('① B(signalB): 手動 + レンジ を保存して読み戻せる', () => {
    const r = post({ signalB: { scalpBias: 'range', scalpBiasSource: 'manual' } });
    expect(r.code).toBe(200);
    resetConfigCache();
    expect(resolveScalpBias('B')).toBe('range');
    expect(resolveScalpBiasDirective('B').mode).toBe('manual');
  });

  it('★②「保存」1回で他の項目も一緒に保存される(all-or-nothing に巻き込まれない)', () => {
    // ★エバリュエーターが再現した実ペイロード相当: 目線をレンジにしつつ他も同時に変える。
    const r = post({
      scalpBias: 'range', scalpBiasSource: 'manual',
      scalpLcFloorYen: 60, scalpCooldownSec: 30,
      signalB: { scalpBias: 'range', scalpBiasSource: 'manual' },
    });
    expect(r.code).toBe(200);
    expect(r.body.error).toBeUndefined();
    resetConfigCache();
    const g = get();
    expect(g.scalpBias).toBe('range');
    expect(g.scalpLcFloorYen).toBe(60);       // ★直す前はここが 55(=捨てられた)
    expect(g.scalpCooldownSec).toBe(30);      // ★同上
  });

  it('★③ 保存した「レンジ」が目線の固定(A を呼ばない経路)まで届く', () => {
    post({ scalpBias: 'range', scalpBiasSource: 'manual' });
    resetConfigCache();
    expect(resolveForcedTrend()).toBe('range');
    // ★「レンジを許可」の ON/OFF に依存しない(ユーザー確定の⑤)。
    post({ scalpRangeEnabled: false });
    resetConfigCache();
    expect(resolveForcedTrend()).toBe('range');
  });

  it('★① lite(config.lite の独立名前空間)でも レンジ を保存できる', () => {
    // ★lite は buildLiteConfig という **別の受理経路** を通る。ここを守らないと
    //   lite 版だけ「レンジを選んでも黙って捨てられる」(lite は errors を積まず捨てる)。
    const ORIG = process.env.MONITOR_VARIANT;
    process.env.MONITOR_VARIANT = 'lite';
    try {
      resetConfigCache();
      const r = post({ scalpBias: 'range', scalpBiasSource: 'manual', scalpLcFloorYen: 62 });
      expect(r.code).toBe(200);
      resetConfigCache();
      expect(resolveScalpBias()).toBe('range');
      expect(resolveForcedTrend()).toBe('range');
      expect(get().scalpLcFloorYen).toBe(62);   // ★同時に変えた項目も保存される
    } finally {
      if (ORIG === undefined) delete process.env.MONITOR_VARIANT; else process.env.MONITOR_VARIANT = ORIG;
      resetConfigCache();
    }
  });

  it('★④ 恒真でない: 知らない値は従来どおり 400 で弾く', () => {
    const r = post({ scalpBias: 'bogus' });
    expect(r.code).toBe(400);
    expect(String(r.body.error)).toContain('scalpBias must be one of');
    const rb = post({ signalB: { scalpBias: 'bogus' } });
    expect(rb.code).toBe(400);
  });

  it('★既存値(long/short/none/未設定)は従来どおり(移行が要らない)', () => {
    for (const [v, want] of [['long', 'long'], ['short', 'short'], ['none', 'none']] as const) {
      post({ scalpBias: v });
      resetConfigCache();
      expect(resolveScalpBias()).toBe(want);
    }
  });
});
