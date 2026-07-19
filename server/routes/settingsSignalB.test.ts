import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../configStore.js';
import { getSettingsHandler, postSettingsHandler } from './settings.js';

// ★v0.8.2: /api/settings が System B(signalB)を round-trip する。'' / null = A追従(unset) / 明示値=保存。
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
function get() {
  const res = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSettingsHandler({} as any, res as any);
  return res.out.body;
}

describe('/api/settings signalB round-trip', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-setb-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    resetConfigCache();
  });
  afterEach(() => {
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('B に明示値を保存し、GET の signalB(raw)で読み戻せる', () => {
    const r = post({ signalB: { scalpLcCeilingYen: 40, scalpBias: 'short', scalpLcCeilingSource: 'ai', scalpRangeEnabled: 'true' } });
    expect(r.code).toBe(200);
    const g = get() as { signalB: Record<string, unknown>; signalBEffective: Record<string, unknown> };
    expect(g.signalB.scalpLcCeilingYen).toBe(40);
    expect(g.signalB.scalpBias).toBe('short');
    expect(g.signalB.scalpLcCeilingSource).toBe('ai');
    expect(g.signalB.scalpRangeEnabled).toBe(true);
    // 実効値(effective)も B の値を反映
    expect(g.signalBEffective.scalpLcCeilingYen).toBe(40);
  });

  it("B の空欄/''/'manual' は unset(=A追従)=signalB に残さない", () => {
    // まず何か保存 → その後 A追従へ戻す
    post({ signalB: { scalpLcCeilingYen: 40 } });
    const r = post({ signalB: { scalpLcCeilingYen: null, scalpLcCeilingSource: '', scalpBias: '', scalpRangeEnabled: '' } });
    expect(r.code).toBe(200);
    const g = get() as { signalB: Record<string, unknown>; scalpLcCeilingYen: number; signalBEffective: Record<string, unknown> };
    // signalB は空(=全て A追従)。effective は A(グローバル既定65)へフォールバック。
    expect(g.signalB.scalpLcCeilingYen).toBeUndefined();
    expect(g.signalBEffective.scalpLcCeilingYen).toBe(g.scalpLcCeilingYen);
  });

  it('B を保存しても A(グローバル)値は不変', () => {
    post({ scalpLcCeilingYen: 70, signalB: { scalpLcCeilingYen: 40 } });
    const g = get() as { scalpLcCeilingYen: number; signalB: Record<string, unknown> };
    expect(g.scalpLcCeilingYen).toBe(70);          // A 不変
    expect(g.signalB.scalpLcCeilingYen).toBe(40);  // B は独立
  });

  it('signalB 未指定(undefined)は既存の B を保持', () => {
    post({ signalB: { scalpCooldownSec: 30 } });
    post({ scalpLcCeilingYen: 60 });   // signalB を送らない
    const g = get() as { signalB: Record<string, unknown> };
    expect(g.signalB.scalpCooldownSec).toBe(30);   // 保持
  });
});
