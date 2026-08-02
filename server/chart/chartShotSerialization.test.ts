// ─── チャート撮影が「イベントループを止めない」ための3点 ────────────────────────
//
// ① 後始末を非同期化しても、Chrome を確実に始末する保証を弱めない
//    (順序 kill→rm / 失敗は声を出す / kill 未確認は登録簿に残して終了時掃除へ)
// ② Chrome の実起動をプロセス全体で直列化する。ただし **A(default)は絶対に待たせない**
//    (生成器が待つ・譲る)。キャッシュのプール分離(caller 別)は別の仕組みで、こことは直交。
// ③ 撮影の開始と完了をログして全体所要が後から測れる
//
// ★否定対照: 修正前(git show HEAD:server/chart/chartShot.ts)には runCaptureCleanup /
//   acquireChromeSlot / 撮影開始ログのいずれも存在しないため、このファイルは赤になる。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const existsMock = vi.fn<[string], boolean>();
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: (p: string) => existsMock(p) };
});
vi.mock('../configStore.js', () => ({ loadConfig: () => ({}) }));

import {
  runCaptureCleanup, acquireChromeSlot, resetChromeSlots, chromeSlotSnapshot,
  liveChromeSnapshot, clearLiveChromesForTest, captureChartPng, type CleanupDeps,
} from './chartShot.js';

/** 次のマクロタスクまで進める(「待たされていないか」を見るのに使う)。 */
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('① 後始末の非同期化 — 確実に始末する保証は弱めない', () => {
  beforeEach(() => { resetChromeSlots(); });
  // 「始末できなかった」ケースが登録簿に残す偽 PID を、次のケース/プロセス終了時掃除へ持ち越さない。
  afterEach(() => { clearLiveChromesForTest(); });

  /** 既定: 殺したら死んでいる。 */
  const dead = () => false;

  it('順序は必ず kill → rm(逆だと掴まれているファイルを消せない)', async () => {
    const order: string[] = [];
    const deps: CleanupDeps = {
      killTree: async () => { await tick(5); order.push('kill'); },
      removeDir: async () => { order.push('rm'); },
      isAlive: dead,
    };
    const r = await runCaptureCleanup({ pid: 4242, tmpDir: 'C:\\tmp\\x', id: 'cap1' }, deps);
    expect(order).toEqual(['kill', 'rm']);       // ★実行順(非同期でも直列)
    expect(r.order).toEqual(['kill', 'rm']);
  });

  it('後始末は同期ブロックしない(kill 中もイベントループが回る)', async () => {
    let ticks = 0;
    const hb = setInterval(() => { ticks++; }, 1);
    try {
      const deps: CleanupDeps = {
        killTree: () => new Promise((r) => setTimeout(r, 120)),   // 実 taskkill 相当の所要
        removeDir: () => new Promise((r) => setTimeout(r, 60)),
        isAlive: dead,
      };
      await runCaptureCleanup({ pid: 1, tmpDir: 'd', id: 'cap1' }, deps);
    } finally { clearInterval(hb); }
    // 同期ブロックなら 0 回(タイマーは1つも発火できない)。非同期なら 180ms の間に何度も回る。
    // (Windows のタイマー分解能が粗いので回数そのものは環境依存 — 「0 でないこと」が判定の本体。)
    expect(ticks).toBeGreaterThan(5);
  });

  it('★始末できず生存していたら声を出す(無音にしない)', async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')); });
    try {
      const deps: CleanupDeps = {
        killTree: async () => { throw new Error('Access is denied.'); },
        removeDir: async () => { /* ok */ },
        isAlive: () => true,                     // ★殺せていない
      };
      const r = await runCaptureCleanup({ pid: 777, tmpDir: 'd', id: 'capX' }, deps);
      expect(r.killError).toContain('Access is denied.');
      expect(warns.some((w) => w.includes('Chrome を始末できず生存中') && w.includes('777'))).toBe(true);
      // ★取り残しは登録簿に残る = プロセス終了時にもう一度始末される。
      expect(r.stillRegistered).toBe(true);
      expect(liveChromeSnapshot().some((e) => e.pid === 777)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('★kill は exit code でなく「本当に死んだか」で判定する(誤警報を出さない)', async () => {
    // taskkill /T はツリーの子が先に消えているだけでも非0で終わる。実際に死んでいれば警告しない。
    const warns: string[] = [];
    const logs: string[] = [];
    const w = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')); });
    const l = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    try {
      let calls = 0;
      const deps: CleanupDeps = {
        killTree: async () => { calls++; throw new Error('Command failed: taskkill /F /T /PID 1'); },
        removeDir: async () => { /* ok */ },
        isAlive: dead,                            // 実際には死んでいる
      };
      const r = await runCaptureCleanup({ pid: 1234, tmpDir: 'd', id: 'c' }, deps);
      expect(calls).toBe(2);                      // ★失敗したら間を置いてもう一度殺す
      expect(r.stillRegistered).toBe(false);
      expect(warns).toEqual([]);                  // ★誤警報しない
      expect(logs.some((x) => x.includes('Chrome 停止を確認'))).toBe(true);   // でも無音でもない
    } finally { w.mockRestore(); l.mockRestore(); }
  });

  it('kill が失敗しても rm は実行される(片方の失敗で後始末全体を止めない)', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    try {
      const order: string[] = [];
      const deps: CleanupDeps = {
        killTree: async () => { order.push('kill'); throw new Error('boom'); },
        removeDir: async () => { order.push('rm'); },
        isAlive: () => true,
      };
      await runCaptureCleanup({ pid: 5, tmpDir: 'd', id: 'c' }, deps);
      expect(order).toEqual(['kill', 'kill', 'rm']);
    } finally { spy.mockRestore(); }
  });

  it('rm の失敗も声を出す(作業ディレクトリの取り残しを無音にしない)', async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')); });
    try {
      const deps: CleanupDeps = {
        killTree: async () => { /* ok */ },
        removeDir: async () => { throw new Error('EBUSY'); },
        isAlive: dead,
      };
      const r = await runCaptureCleanup({ pid: 9, tmpDir: 'C:\\tmp\\zz', id: 'c' }, deps);
      expect(r.rmError).toContain('EBUSY');
      expect(warns.some((w) => w.includes('作業ディレクトリの削除に失敗'))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('pid が無ければ kill は試みず rm だけ行う', async () => {
    const order: string[] = [];
    const deps: CleanupDeps = {
      killTree: async () => { order.push('kill'); },
      removeDir: async () => { order.push('rm'); },
      isAlive: dead,
    };
    await runCaptureCleanup({ pid: null, tmpDir: 'd', id: 'c' }, deps);
    expect(order).toEqual(['rm']);
  });
});

describe('② Chrome 起動の直列化 — ただし A(default)は待たせない', () => {
  beforeEach(() => { resetChromeSlots(); });
  afterEach(() => { resetChromeSlots(); });

  it('★A(default)は待たない: 生成器が撮影中でも即座にスロットを取る', async () => {
    const gen = await acquireChromeSlot('generator', 'gen1');
    expect(gen.ok).toBe(true);

    // default の取得は「1マクロタスクも待たない」ことを、待ちを一切挟まずに検証する。
    let resolved = false;
    const p = acquireChromeSlot('default', 'a1').then((r) => { resolved = true; return r; });
    await Promise.resolve();          // マイクロタスク1回だけ
    await Promise.resolve();
    expect(resolved).toBe(true);      // ★タイマー待ちが1つも入っていない
    const a = await p;
    expect(a.ok).toBe(true);
  });

  it('★A が来たら生成器は中断される(譲る)', async () => {
    const gen = await acquireChromeSlot('generator', 'gen1');
    if (!gen.ok) throw new Error('unreachable');
    const preempts: string[] = [];
    gen.ticket.onPreempt((r) => preempts.push(r));
    expect(gen.ticket.preempted).toBe(false);

    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...x: unknown[]) => { warns.push(x.join(' ')); });
    try {
      await acquireChromeSlot('default', 'a1');
    } finally { spy.mockRestore(); }

    expect(gen.ticket.preempted).toBe(true);                 // ★譲った
    expect(preempts).toEqual(['preempted-by-default']);      // ★撮影側へ中断が届く
    expect(warns.some((w) => w.includes('生成器の撮影を中断') && w.includes('gen1'))).toBe(true);
  });

  it('中断が onPreempt 登録より先に起きても取りこぼさない', async () => {
    const gen = await acquireChromeSlot('generator', 'gen1');
    if (!gen.ok) throw new Error('unreachable');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    try { await acquireChromeSlot('default', 'a1'); } finally { spy.mockRestore(); }

    const preempts: string[] = [];
    gen.ticket.onPreempt((r) => preempts.push(r));   // 中断の**後**に登録
    expect(preempts).toEqual(['preempted-by-default']);
  });

  it('★生成器は default が終わるまで Chrome を起動しない(直列化)', async () => {
    const a = await acquireChromeSlot('default', 'a1');
    if (!a.ok) throw new Error('unreachable');

    let genGot = false;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { /* silence */ });
    const genP = acquireChromeSlot('generator', 'gen1').then((r) => { genGot = true; return r; });
    await tick(30);
    expect(genGot).toBe(false);            // ★A が握っている間は起動しない

    a.ticket.release();                    // A の後始末まで終わってから解放される
    const gen = await genP;
    spy.mockRestore();
    expect(genGot).toBe(true);
    expect(gen.ok).toBe(true);
    expect(chromeSlotSnapshot().map((s) => s.caller)).toEqual(['generator']);
  });

  it('生成器が待ち切れなければ撮影せず縮退する(無限待ちしない)', async () => {
    const a = await acquireChromeSlot('default', 'a1');
    expect(a.ok).toBe(true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { /* silence */ });
    const wspy = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    try {
      const gen = await acquireChromeSlot('generator', 'gen1', Date.now, 150);
      expect(gen.ok).toBe(false);
      if (gen.ok) throw new Error('unreachable');
      expect(gen.reason).toBe('chrome-slot-busy');
    } finally { spy.mockRestore(); wspy.mockRestore(); }
  });

  it('同時に待った生成器は1つずつしか起動しない(起きても再確認する)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { /* silence */ });
    try {
      const a = await acquireChromeSlot('default', 'a1');
      if (!a.ok) throw new Error('unreachable');
      const g1 = acquireChromeSlot('generator', 'g1');
      const g2 = acquireChromeSlot('generator', 'g2');
      a.ticket.release();
      const r1 = await g1;
      expect(r1.ok).toBe(true);
      await tick(20);
      // g2 はまだ待っている(g1 が握っているため)。
      expect(chromeSlotSnapshot().length).toBe(1);
      if (!r1.ok) throw new Error('unreachable');
      r1.ticket.release();
      const r2 = await g2;
      expect(r2.ok).toBe(true);
      expect(chromeSlotSnapshot().length).toBe(1);
      if (r2.ok) r2.ticket.release();
    } finally { spy.mockRestore(); }
  });

  it('release は冪等(二重解放でスロットが壊れない)', async () => {
    const a = await acquireChromeSlot('default', 'a1');
    if (!a.ok) throw new Error('unreachable');
    a.ticket.release();
    a.ticket.release();
    expect(chromeSlotSnapshot()).toEqual([]);
  });
});

describe('③ 撮影の開始と完了がログに出る(全体所要が後から測れる)', () => {
  beforeEach(() => { existsMock.mockReset(); existsMock.mockReturnValue(false); resetChromeSlots(); });

  it('★撮影開始ログが出て、完了ログに所要が載る', async () => {
    const lines: string[] = [];
    const l = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    const w = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    try {
      const r = await captureChartPng(3000, 'generator');
      // このテスト環境では Chrome を解決できない(existsSync=false)= 実起動しない経路。
      expect(r.buffer).toBeNull();
    } finally { l.mockRestore(); w.mockRestore(); }

    const start = lines.find((x) => x.includes('撮影開始'));
    expect(start).toBeTruthy();
    expect(start).toContain('caller=generator');
    expect(start).toMatch(/id=cap\d+-/);           // 撮影1回の識別子
    const end = lines.find((x) => x.includes('TradingView 撮影'));
    expect(end).toBeTruthy();
    expect(end).toMatch(/所要=\d+\.\d+s/);          // ★全体所要が記録される
    expect(end).toMatch(/id=cap\d+-/);              // 開始と完了が id で結べる
  });

  it('撮影できなかった経路でもスロットも登録簿も残さない', async () => {
    const before = liveChromeSnapshot().length;   // 他ケースが仕込んだ「始末できなかった Chrome」は残っていてよい
    const l = vi.spyOn(console, 'log').mockImplementation(() => { /* silence */ });
    const w = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    try { await captureChartPng(3000, 'default'); } finally { l.mockRestore(); w.mockRestore(); }
    expect(chromeSlotSnapshot()).toEqual([]);         // ★スロットは必ず解放される
    expect(liveChromeSnapshot().length).toBe(before); // ★この撮影は登録簿に何も足さない
  });
});
