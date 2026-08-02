import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── ★①と②が「同じ画像を見た」ことを、仮定でなく記録にする ─────────────────────────
//
// 何を守っているか:
//   提案生成器は1サイクルで ①現行仕様 → ②候補仕様 を直列に問う。①②が同じ相場・同じ画像を
//   見ていることが対応比較の前提だが、その保証は「撮影キャッシュの TTL が60秒だから間に合うはず」
//   という **仮定** でしかない。1サイクルが60秒を超えれば②は別の画像を見るが、**誰にも分からない**。
//   → 撮影1回ごとに識別子を振り、応答に「識別子と齢」を載せる。
//
// ★否定対照(この機能が無い/壊れた場合):
//   撮影が identity を返さないと、①②の shotId を比較する手段が無く、「別の画像を見た」という
//   状態を記録から検出できない。実証手順: git show HEAD:server/chart/chartShot.ts で旧版に
//   差し替えて実行 → identity が undefined になり、このファイルのほぼ全件が赤。
//
// ★関数は1本のまま(captureChartPngCached が identity を additive に返す)。
//   「identity を返す版/返さない版」に分けると経路が2本になり、記録に載る画像と
//   実際に AI が見た画像がずれる余地ができる。

vi.mock('../configStore.js', () => ({ loadConfig: () => ({}) }));

import { captureChartPngCached, resetChartCache, type CaptureResult } from './chartShot.js';

const okShot = (): CaptureResult => ({ buffer: Buffer.from('png'), chromePath: 'x', chromeVersion: 'v', reason: null });
const failShot = (): CaptureResult => ({ buffer: null, chromePath: 'x', chromeVersion: 'v', reason: 'ws-error' });

describe('撮影の同一性(shotId / 齢 / 由来)', () => {
  beforeEach(() => { resetChartCache(); });

  it('新規撮影は origin=fresh・齢0・識別子つき', async () => {
    const t = await captureChartPngCached(3000, async () => okShot(), () => 1_000_000, 'generator');
    expect(t.identity).not.toBeNull();
    expect(t.identity!.origin).toBe('fresh');
    expect(t.identity!.ageMs).toBe(0);
    expect(t.identity!.shotId).toMatch(/^[0-9a-f]{8}-\d+$/);
  });

  it('★TTL 内の2回目は **同じ shotId**(= ①と②が同じ1枚を見た)', async () => {
    let now = 1_000_000;
    const cap = vi.fn(async () => okShot());
    const a = await captureChartPngCached(3000, cap, () => now, 'generator');
    now += 30_000;                                   // 1サイクルが30秒で終わった場合
    const b = await captureChartPngCached(3000, cap, () => now, 'generator');
    expect(cap).toHaveBeenCalledTimes(1);            // Chrome は1回しか起動していない
    expect(b.identity!.shotId).toBe(a.identity!.shotId);
    expect(b.identity!.origin).toBe('cache');
    expect(b.identity!.ageMs).toBe(30_000);
  });

  it('★60秒を超えたサイクルでは **別の shotId**(= 別の画像を見たと記録される)', async () => {
    let now = 1_000_000;
    const cap = vi.fn(async () => okShot());
    const a = await captureChartPngCached(3000, cap, () => now, 'generator');
    now += 60_001;                                   // 1サイクルが TTL を超えた場合
    const b = await captureChartPngCached(3000, cap, () => now, 'generator');
    expect(cap).toHaveBeenCalledTimes(2);            // 撮り直している
    expect(b.identity!.shotId).not.toBe(a.identity!.shotId);
    expect(b.identity!.origin).toBe('fresh');
  });

  it('進行中の撮影に相乗りした要求は origin=joined で **同じ shotId**', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(r => { release = r; });
    const cap = vi.fn(async () => { await gate; return okShot(); });
    const p1 = captureChartPngCached(3000, cap, () => 2_000_000, 'generator');
    const p2 = captureChartPngCached(3000, cap, () => 2_000_000, 'generator');
    release!();
    const [a, b] = await Promise.all([p1, p2]);
    expect(cap).toHaveBeenCalledTimes(1);
    expect(b.identity!.shotId).toBe(a.identity!.shotId);
    expect([a.identity!.origin, b.identity!.origin].sort()).toEqual(['fresh', 'joined']);
  });

  it('撮影失敗は identity を持たない(画像を見ていないことを NULL で表す)', async () => {
    const t = await captureChartPngCached(3000, async () => failShot(), () => 1_000_000, 'generator');
    expect(t.buffer).toBeNull();
    expect(t.identity).toBeNull();
  });

  it('プールが違えば別の画像(default と generator で shotId が一致しない)', async () => {
    const cap = vi.fn(async () => okShot());
    const d = await captureChartPngCached(3000, cap, () => 3_000_000, 'default');
    const g = await captureChartPngCached(3000, cap, () => 3_000_000, 'generator');
    expect(cap).toHaveBeenCalledTimes(2);
    expect(g.identity!.shotId).not.toBe(d.identity!.shotId);
  });

  it('★既存の呼び出し元から見た形は不変(buffer/reason はそのまま・identity が additive に増えるだけ)', async () => {
    let now = 4_000_000;
    const cap = vi.fn(async () => okShot());
    const first = await captureChartPngCached(3000, cap, () => now, 'generator');
    now += 1000;
    const second = await captureChartPngCached(3000, cap, () => now, 'generator');
    expect(cap).toHaveBeenCalledTimes(1);
    expect(second.buffer).toBe(first.buffer);   // ★同じ画像を共有(既存の不変条件)
    expect(second.reason).toBeNull();
    expect(Object.keys(second).sort()).toEqual(['buffer', 'chromePath', 'chromeVersion', 'identity', 'reason']);
  });
});
