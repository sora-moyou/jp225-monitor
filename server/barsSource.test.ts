import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  mergeBars, mergeBarsWithDivergence, collectRecentBars,
  BASE_LIVE_DIVERGENCE_WARN_YEN, _resetDivergenceWarning, type DbOHLCBar,
} from './barsSource.js';
import { feedRealtimePrice, _reset } from './feedBars.js';
import { initSchema, recordTick, upsertBar } from './db/store.js';

// mergeBars は「DBの1分足 ∪ メモリ内のライブ足」を作る純関数。
// 指標/AI文脈が DB(collector 依存・常時ライブとは限らない)だけに繋がっていたため
// 「蓄積中…」から永久に抜けなかった事故の修正点。ここでは合成規則を固定する。

const T0 = Date.UTC(2026, 6, 29, 0, 0, 0);
const MIN = 60_000;

function db(t: number, o: number, h: number, l: number, c: number): { t: number; o: number; h: number; l: number; c: number } {
  return { t, o, h, l, c };
}

describe('mergeBars', () => {
  it('DBが空でもメモリ足だけで1分足が得られる(メモリ側も実 O/H/L/C を持つ)', () => {
    const mem = [db(T0, 38000, 38050, 37990, 38010), db(T0 + MIN, 38010, 38020, 38000, 38015)];
    const out = mergeBars([], mem);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ t: T0, o: 38000, h: 38050, l: 37990, c: 38010 });
    expect(out[1]!.c).toBe(38015);
  });

  it('メモリが空でもDB足だけで返る(実OHLCはそのまま)', () => {
    const out = mergeBars([db(T0, 1, 5, 0, 3)], []);
    expect(out).toEqual([{ t: T0, o: 1, h: 5, l: 0, c: 3 }]);
  });

  it('同一 t の重複は c を常にメモリ(ライブ)側で上書きする', () => {
    const out = mergeBars([db(T0, 100, 105, 95, 101)], [db(T0, 101, 104, 99, 103)]);
    expect(out.length).toBe(1);
    expect(out[0]!.c).toBe(103);          // 時刻比較はせず常にメモリ側
  });

  it('同一 t の h/l は両者の和集合(h=max・l=min)、o は DB 優先', () => {
    const out = mergeBars([db(T0, 100, 105, 95, 101)], [db(T0, 102, 110, 99, 108)]);
    expect(out[0]!.o).toBe(100);          // DB の実始値を優先(ライブは分の途中から始まりうる)
    expect(out[0]!.h).toBe(110);          // max(105, 110)
    expect(out[0]!.l).toBe(95);           // min(95, 99)
  });

  it('t 昇順でユニーク化する(入力順は問わない)', () => {
    const out = mergeBars(
      [db(T0 + 2 * MIN, 3, 3, 3, 3), db(T0, 1, 1, 1, 1)],
      [db(T0 + MIN, 2, 2, 2, 2), db(T0, 1.5, 1.5, 1.5, 1.5)],
    );
    expect(out.map(b => b.t)).toEqual([T0, T0 + MIN, T0 + 2 * MIN]);
  });

  it('不正なライブ値(NaN/0以下)は無視する', () => {
    const out = mergeBars([], [
      db(T0, Number.NaN, Number.NaN, Number.NaN, Number.NaN),
      db(T0 + MIN, 0, 0, 0, 0),
      db(T0 + 2 * MIN, 38000, 38000, 38000, 38000),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.t).toBe(T0 + 2 * MIN);
  });

  it('両方空なら空配列', () => {
    expect(mergeBars([], [])).toEqual([]);
  });
});

// ─── 基礎データ優先(v0.9.75) ───────────────────────────────────────────
// DB 側の行が基礎データ(src='base')なら、メモリ内ライブ足では一切上書きしない。
// src が NULL(既存環境の全行)や 'live' の行は従来どおり = 既存環境の合成結果は1ミリも変わらない。
describe('mergeBars — DB 行の出所(src)による優先', () => {
  const dbBar = (t: number, o: number, h: number, l: number, c: number, src: string | null): DbOHLCBar =>
    ({ t, o, h, l, c, src });

  it('★src=base の分はライブで上書きしない(c も h/l も基礎データのまま)', () => {
    const out = mergeBars(
      [dbBar(T0, 100, 105, 95, 101, 'base')],
      [db(T0, 102, 110, 90, 108)],
    );
    expect(out).toEqual([{ t: T0, o: 100, h: 105, l: 95, c: 101 }]);
  });

  it('src=live の分は従来どおり合成する(c=ライブ・h/l=和集合・o=DB)', () => {
    const out = mergeBars(
      [dbBar(T0, 100, 105, 95, 101, 'live')],
      [db(T0, 102, 110, 90, 108)],
    );
    expect(out).toEqual([{ t: T0, o: 100, h: 110, l: 90, c: 108 }]);
  });

  it('src=NULL(出所不明=既存環境の全行)は従来どおり合成する', () => {
    const out = mergeBars(
      [dbBar(T0, 100, 105, 95, 101, null)],
      [db(T0, 102, 110, 90, 108)],
    );
    expect(out).toEqual([{ t: T0, o: 100, h: 110, l: 90, c: 108 }]);
  });

  it('src を持たない行(旧 DB の読み取り結果)も従来どおり合成する', () => {
    const out = mergeBars([db(T0, 100, 105, 95, 101)], [db(T0, 102, 110, 90, 108)]);
    expect(out).toEqual([{ t: T0, o: 100, h: 110, l: 90, c: 108 }]);
  });

  it('base の分だけを守り、同じ窓の live/NULL の分は従来どおり合成する(混在)', () => {
    const out = mergeBars(
      [dbBar(T0, 1, 1, 1, 1, 'base'), dbBar(T0 + MIN, 2, 2, 2, 2, 'live'), dbBar(T0 + 2 * MIN, 3, 3, 3, 3, null)],
      [db(T0, 9, 9, 9, 9), db(T0 + MIN, 9, 9, 9, 9), db(T0 + 2 * MIN, 9, 9, 9, 9)],
    );
    expect(out.map(b => b.c)).toEqual([1, 9, 9]);
  });

  it('メモリ側にしか無い分は base の有無に関わらず採用する(基礎データは過去しか無い)', () => {
    const out = mergeBars([dbBar(T0, 1, 1, 1, 1, 'base')], [db(T0 + MIN, 9, 10, 8, 9)]);
    expect(out.map(b => b.t)).toEqual([T0, T0 + MIN]);
    expect(out[1]).toEqual({ t: T0 + MIN, o: 9, h: 10, l: 8, c: 9 });
  });
});

// ★既存環境(src が全て NULL = この列より前に書かれた行しか無い DB)で合成結果が1ミリも変わらないこと。
//   旧実装(HEAD の mergeBars)をここに写して、無作為入力で完全一致することを示す。
describe('mergeBars — 既存環境(src 全 NULL)では旧実装と完全一致', () => {
  /** v0.9.74 までの mergeBars(git show HEAD:server/barsSource.ts の本体をそのまま写したもの)。 */
  function legacyMergeBars(dbBars: any[], memBars: any[]): any[] {
    const m = new Map<number, any>();
    for (const b of dbBars ?? []) {
      if (!Number.isFinite(b?.t)) continue;
      m.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
    }
    for (const b of memBars ?? []) {
      if (!Number.isFinite(b?.t)) continue;
      if (!Number.isFinite(b.c) || b.c <= 0) continue;
      const e = m.get(b.t);
      if (!e) { m.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }); continue; }
      e.c = b.c;
      if (b.h > e.h) e.h = b.h;
      if (b.l < e.l) e.l = b.l;
    }
    return [...m.values()].sort((a, b) => a.t - b.t);
  }

  // 決定的な擬似乱数(seed 固定=失敗が再現する)
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  it('無作為な 200 ケースで旧実装と一致する(NULL の行も src 列を持たない行も)', () => {
    const r = rng(20260815);
    for (let k = 0; k < 200; k++) {
      const dbBars: DbOHLCBar[] = [];
      const mem: any[] = [];
      for (let i = 0; i < 12; i++) {
        const t = T0 + Math.floor(r() * 10) * MIN;
        const c = 38000 + Math.floor(r() * 200) - 100;
        // 半分は src を持たない行(旧 DB 読み取り)・半分は明示的な NULL。どちらも「出所不明」。
        if (r() < 0.6) {
          const bar = { t, o: c - 5, h: c + 10, l: c - 12, c };
          dbBars.push(r() < 0.5 ? bar : { ...bar, src: null });
        }
        if (r() < 0.6) mem.push({ t, o: c + 2, h: c + 15, l: c - 8, c: c + 3 });
      }
      expect(mergeBars(dbBars, mem)).toEqual(legacyMergeBars(dbBars, mem));
    }
  });

  it('src が全 NULL の入力では divergence も必ず null(警告は鳴りようがない)', () => {
    const r = rng(7);
    for (let k = 0; k < 50; k++) {
      const t = T0 + Math.floor(r() * 5) * MIN;
      const out = mergeBarsWithDivergence(
        [{ t, o: 1, h: 2, l: 0, c: 38000, src: null }],
        [{ t, o: 1, h: 2, l: 0, c: 38000 + Math.floor(r() * 5000) }],
      );
      expect(out.divergence).toBeNull();
    }
  });
});

describe('mergeBarsWithDivergence — 食い違いの計測(無音にしない)', () => {
  const dbBar = (t: number, c: number, src: string | null): DbOHLCBar => ({ t, o: c, h: c, l: c, c, src });

  it('base と live が同じ分にあれば差を測って返す(最大の1件+母数)', () => {
    const r = mergeBarsWithDivergence(
      [dbBar(T0, 38000, 'base'), dbBar(T0 + MIN, 38000, 'base')],
      [db(T0, 38010, 38010, 38010, 38010), db(T0 + MIN, 37800, 37800, 37800, 37800)],
    );
    expect(r.divergence).toEqual({ t: T0 + MIN, baseC: 38000, liveC: 37800, diff: 200, overlap: 2 });
  });

  it('base 行が無ければ divergence は null(既存環境では常に null)', () => {
    const r = mergeBarsWithDivergence([dbBar(T0, 38000, null)], [db(T0, 30000, 30000, 30000, 30000)]);
    expect(r.divergence).toBeNull();
  });

  it('合成結果は mergeBars と同一(計測は値に影響しない)', () => {
    const dbBars = [dbBar(T0, 38000, 'base'), dbBar(T0 + MIN, 38000, 'live')];
    const mem = [db(T0, 38010, 38010, 38010, 38010), db(T0 + MIN, 37800, 37800, 37800, 37800)];
    expect(mergeBarsWithDivergence(dbBars, mem).bars).toEqual(mergeBars(dbBars, mem));
  });
});

describe('collectRecentBars — 基礎データとライブの食い違い警告', () => {
  let warn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    _reset(); _resetDivergenceWarning();
    warn = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(warn);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function dbWithBase(t: number, c: number): DatabaseSync {
    const d = new DatabaseSync(':memory:');
    initSchema(d);
    upsertBar(d, 'NIY=F', t, c, c, c, c, 1, '2026-07-29', 'Day');
    return d;
  }

  it('閾値以上ずれたら1回だけ警告する(2回目以降は黙る)', () => {
    const d = dbWithBase(T0, 38000);
    feedRealtimePrice('NIY=F', 38000 + BASE_LIVE_DIVERGENCE_WARN_YEN, T0);
    collectRecentBars(d, 'NIY=F', T0 - MIN);
    collectRecentBars(d, 'NIY=F', T0 - MIN);
    collectRecentBars(d, 'NIY=F', T0 - MIN);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('基礎データとライブ足');
    d.close();
  });

  it('閾値未満のずれ(通常のサンプリング差)では警告しない', () => {
    const d = dbWithBase(T0, 38000);
    feedRealtimePrice('NIY=F', 38000 + BASE_LIVE_DIVERGENCE_WARN_YEN - 1, T0);
    collectRecentBars(d, 'NIY=F', T0 - MIN);
    expect(warn).not.toHaveBeenCalled();
    d.close();
  });

  it('DB 行が live(=既存環境と同じ)なら、どれだけずれても警告しない', () => {
    const d = new DatabaseSync(':memory:');
    initSchema(d);
    recordTick(d, 'NIY=F', T0, 38000, '2026-07-29', 'Day');
    feedRealtimePrice('NIY=F', 38000 + 10 * BASE_LIVE_DIVERGENCE_WARN_YEN, T0);
    collectRecentBars(d, 'NIY=F', T0 - MIN);
    expect(warn).not.toHaveBeenCalled();
    d.close();
  });

  it('★基礎データがある分は DB(基礎)の値が返り、メモリのライブ値では上書きされない', () => {
    const d = dbWithBase(T0, 38000);
    feedRealtimePrice('NIY=F', 38500, T0);
    const bars = collectRecentBars(d, 'NIY=F', T0 - MIN);
    expect(bars).toEqual([{ t: T0, o: 38000, h: 38000, l: 38000, c: 38000 }]);
    d.close();
  });
});

describe('collectRecentBars', () => {
  beforeEach(() => { _reset(); });

  it('DB ハンドルが無くてもメモリ内ライブ足から窓内の1分足を集める(collector 未稼働でも指標が出る)', () => {
    const now = T0 + 10 * MIN;
    feedRealtimePrice('NIY=F', 38000, T0 + 8 * MIN);
    feedRealtimePrice('NIY=F', 38020, T0 + 9 * MIN);
    const bars = collectRecentBars(null, 'NIY=F', now - 60 * MIN);
    expect(bars.length).toBe(2);
    expect(bars[bars.length - 1]!.c).toBe(38020);
  });

  it('メモリ足の分内高安が保たれる(レンジ0のローソクにならない=ATRが潰れない)', () => {
    feedRealtimePrice('NIY=F', 38000, T0 + 8 * MIN);
    feedRealtimePrice('NIY=F', 38060, T0 + 8 * MIN + 20_000);
    feedRealtimePrice('NIY=F', 37980, T0 + 8 * MIN + 40_000);
    const bars = collectRecentBars(null, 'NIY=F', T0);
    expect(bars[0]).toEqual({ t: T0 + 8 * MIN, o: 38000, h: 38060, l: 37980, c: 37980 });
  });

  it('窓より古いライブ足は落とす', () => {
    feedRealtimePrice('NIY=F', 37000, T0);
    feedRealtimePrice('NIY=F', 38000, T0 + 30 * MIN);
    const bars = collectRecentBars(null, 'NIY=F', T0 + 10 * MIN);
    expect(bars.length).toBe(1);
    expect(bars[0]!.t).toBe(T0 + 30 * MIN);
  });
});
