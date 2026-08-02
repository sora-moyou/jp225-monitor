// ─── チャート撮影キャッシュの「呼び出し元(caller)分離」 ─────────────────────────
//
// 欠陥(修正前): 撮影キャッシュ/進行中(in-flight)はモジュール単位でプロセスに1個しかなく、
// caller で分かれていなかった。そこへ 2分間隔で回る生成器(caller='generator')を挿すと:
//   S1) TTL 60秒 < plan間隔 180秒 という「A は毎サイクル撮り直す」不変条件が壊れ、
//       A は二度と自前で撮影せず、常に最大60秒前の画像で判断するようになる。
//       refPrice は毎回新鮮に取り直すので「数値だけ新しく画像だけ古い」不整合が入り、
//       checkRefDrift/checkStaleLegs は価格しか見ないので誰も検出しない。
//   S2) 生成器の進行中撮影に A が相乗りし、その遅延(最大42s)や失敗をそのまま継承する。
//       2回失敗すればテキストのみへ縮退=A の入力から画像が消える。
//
// 一方で **'default'(A と B)の共有は壊してはいけない**: 同時2起動で Chrome が資源逼迫し
// ws-error/クラッシュを誘発した実績があるため、その対策としてのキャッシュ/相乗りは維持する。
//
// このファイルは「generator だけが分離され、default(A/B)は従来どおり共有される」を固定する。
// ★否定対照: 修正前の chartShot.ts では下記「否定対照」ケースが赤になる。

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../configStore.js', () => ({ loadConfig: () => ({}) }));

import { captureChartPngCached, resetChartCache, type CaptureResult } from './chartShot.js';

const ok = (tag: string): CaptureResult => ({
  buffer: Buffer.from(tag), reason: null, chromePath: 'c', chromeVersion: 'v',
});
const fail: CaptureResult = { buffer: null, reason: 'ws-error', chromePath: 'c', chromeVersion: 'v' };

describe('captureChartPngCached — caller ごとのプール分離', () => {
  beforeEach(() => resetChartCache());

  // ★否定対照(修正前は赤): 生成器が撮ると A の撮影がスキップされる。
  it('★否定対照: 生成器の撮影は A(default) の撮影をスキップさせない', async () => {
    let now = 1_000;
    const cap = vi.fn(async () => ok(`shot-${now}`));

    // 生成器が撮影(2分間隔の実験系)。
    const gen = await captureChartPngCached(3000, cap, () => now, 'generator');
    expect(cap).toHaveBeenCalledTimes(1);

    // 10秒後に A が来る = 旧実装なら「TTL(60s)内の新鮮なキャッシュ」に当たって撮影しない。
    now += 10_000;
    const a = await captureChartPngCached(3000, cap, () => now, 'default');

    // ★A は自分で撮り直す(毎サイクル新鮮な画像、という不変条件)。
    expect(cap).toHaveBeenCalledTimes(2);
    // ★A の画像は生成器の画像の使い回しではない。
    expect(a.buffer).not.toBe(gen.buffer);
    expect(a.buffer?.toString()).toBe('shot-11000');
  });

  // ★否定対照(修正前は赤): 生成器の進行中撮影に A が相乗りして遅延/失敗を継承する。
  it('★否定対照: A は生成器の進行中撮影に相乗りしない(遅延/失敗を継承しない)', async () => {
    const calls: Array<(r: CaptureResult) => void> = [];
    const cap = vi.fn(() => new Promise<CaptureResult>((res) => { calls.push(res); }));

    // 生成器が撮影開始(まだ解決しない = Chrome 起動中)。
    const genP = captureChartPngCached(3000, cap, () => 1_000, 'generator');
    expect(cap).toHaveBeenCalledTimes(1);

    // その最中に A が来る。旧実装は in-flight に相乗りする。
    const aP = captureChartPngCached(3000, cap, () => 1_000, 'default');
    // ★A は自分の撮影を開始する(生成器の完了を待たない)。
    expect(cap).toHaveBeenCalledTimes(2);

    // A の撮影だけ先に成功させる。
    calls[1]!(ok('a'));
    const a = await aP;
    expect(a.buffer?.toString()).toBe('a');

    // 生成器が後から失敗しても A には影響しない。
    calls[0]!(fail);
    const gen = await genP;
    expect(gen.buffer).toBeNull();
    expect(a.buffer?.toString()).toBe('a');
  });

  it('★否定対照: 生成器は default のキャッシュを読まない(A の画像を使い回さない)', async () => {
    let now = 1_000;
    const cap = vi.fn(async () => ok(`shot-${now}`));

    await captureChartPngCached(3000, cap, () => now, 'default');
    now += 10_000;
    const gen = await captureChartPngCached(3000, cap, () => now, 'generator');

    expect(cap).toHaveBeenCalledTimes(2);
    expect(gen.buffer?.toString()).toBe('shot-11000');
  });

  it('生成器の撮影は default のキャッシュを書かない(A のキャッシュ齢を汚さない)', async () => {
    let now = 1_000;
    const cap = vi.fn(async () => ok(`shot-${now}`));

    // A が撮影 → default キャッシュは t=1000 の画像。
    await captureChartPngCached(3000, cap, () => now, 'default');
    // 30秒後に生成器が撮影(default キャッシュを更新してはいけない)。
    now += 30_000;
    await captureChartPngCached(3000, cap, () => now, 'generator');
    expect(cap).toHaveBeenCalledTimes(2);

    // さらに 31秒後(A の最初の撮影から 61秒 = default の TTL 超過)。
    // 生成器の撮影がキャッシュを温めていたら A は撮り直さない(=旧実装の欠陥)。
    now += 31_000;
    await captureChartPngCached(3000, cap, () => now, 'default');
    expect(cap).toHaveBeenCalledTimes(3);   // ★A は TTL 超過でちゃんと撮り直す
  });

  it('★A/B 共有は維持: default 同士の同時要求は1回しか撮影しない(Chrome 同時2起動なし)', async () => {
    let resolveCap!: (v: CaptureResult) => void;
    const cap = vi.fn(() => new Promise<CaptureResult>((res) => { resolveCap = res; }));

    const a = captureChartPngCached(3000, cap, () => 1_000, 'default');   // A エンジン
    const b = captureChartPngCached(3000, cap, () => 1_000, 'default');   // B エンジン(同時)
    resolveCap(ok('ab'));
    const [ra, rb] = await Promise.all([a, b]);

    expect(cap).toHaveBeenCalledTimes(1);   // ★同時2起動しない(ws-error 対策)
    expect(ra.buffer).toBe(rb.buffer);      // ★同じ画像を共有
  });

  it('★A/B 共有は維持: caller 省略(既存呼び出し元)は default プールと同一', async () => {
    let now = 1_000;
    const cap = vi.fn(async () => ok('a'));

    await captureChartPngCached(3000, cap, () => now);                       // caller 省略
    now += 30_000;                                                          // TTL(60s)内
    await captureChartPngCached(3000, cap, () => now, 'default');           // 明示 default
    expect(cap).toHaveBeenCalledTimes(1);                                   // ★同じプール
  });

  it('生成器プールも従来どおり TTL/相乗り/失敗非キャッシュが効く', async () => {
    let now = 1_000;
    const okCap = vi.fn(async () => ok('g'));
    await captureChartPngCached(3000, okCap, () => now, 'generator');
    now += 30_000;
    await captureChartPngCached(3000, okCap, () => now, 'generator');
    expect(okCap).toHaveBeenCalledTimes(1);   // TTL 内は共有
    now += 31_000;
    await captureChartPngCached(3000, okCap, () => now, 'generator');
    expect(okCap).toHaveBeenCalledTimes(2);   // TTL 超過で再撮影

    now += 61_000;                            // 直前の成功キャッシュを失効させてから失敗経路を見る
    const failCap = vi.fn(async () => fail);
    await captureChartPngCached(3000, failCap, () => now, 'generator');
    await captureChartPngCached(3000, failCap, () => now, 'generator');
    expect(failCap).toHaveBeenCalledTimes(2); // 失敗はキャッシュしない
  });

  it('resetChartCache() は全プールをリセットする', async () => {
    const now = () => 1_000;
    const cap = vi.fn(async () => ok('x'));
    await captureChartPngCached(3000, cap, now, 'default');
    await captureChartPngCached(3000, cap, now, 'generator');
    expect(cap).toHaveBeenCalledTimes(2);

    resetChartCache();
    await captureChartPngCached(3000, cap, now, 'default');
    await captureChartPngCached(3000, cap, now, 'generator');
    expect(cap).toHaveBeenCalledTimes(4);   // ★両プールとも消えている
  });
});

describe('captureChartPngCached — 撮影の由来をログで区別できる(無音をやめる)', () => {
  beforeEach(() => resetChartCache());

  it('新規撮影 / キャッシュ流用 / 相乗り が別文言で出て、流用時は画像の齢が出る', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    try {
      let now = 1_000;
      let release!: (v: CaptureResult) => void;
      const hang = vi.fn(() => new Promise<CaptureResult>((res) => { release = res; }));

      // 相乗り(default 同士)。
      const p1 = captureChartPngCached(3000, hang, () => now, 'default');
      const p2 = captureChartPngCached(3000, hang, () => now, 'default');
      release(ok('a'));
      await Promise.all([p1, p2]);

      // キャッシュ流用(12.5秒後)。
      now += 12_500;
      await captureChartPngCached(3000, hang, () => now, 'default');

      expect(logs.some((l) => l.includes('新規撮影') && l.includes('caller=default'))).toBe(true);
      expect(logs.some((l) => l.includes('相乗り'))).toBe(true);
      const reuse = logs.find((l) => l.includes('キャッシュ流用'));
      expect(reuse).toBeTruthy();
      expect(reuse).toContain('齢=12.5s');   // ★画像の齢が分かる(=A の鮮度低下に気づける)
    } finally { spy.mockRestore(); }
  });
});
