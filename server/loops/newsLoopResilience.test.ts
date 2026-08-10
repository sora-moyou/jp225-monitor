import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ★何を守っているか: **設定読みが投げても newsLoop が死なないこと**。
//
//   旧実装はループ内で設定を一切読まなかったので、この経路は今回の変更で新しく生まれた。
//   tick 冒頭のゲートと schedule の再武装式が try の外にあると、例外1回で setTimeout が
//   再設定されず、ループが **永久に静かに止まる**(v0.9.37 の「無音で死ぬ」と同じ形)。
//
//   ★否定対照: nextDelayMsSafe / offHoursEnabledSafe の try を外し、schedule の finally を
//     素の逐次実行に戻すと、下の「タイマーが再武装される」2件が落ちる(タイマー数が 0 になる)。

const throwing = { should: false };
vi.mock('../configStore.js', () => ({
  resolveNewsPollMs: () => 60_000,
  resolveNewsOffHoursEnabled: () => {
    if (throwing.should) throw new Error('config-boom');
    return false;
  },
}));
// 取得と保存はモックする(このテストはネットワークにも DB にも触らない)。
const fetchAllNews = vi.fn(async () => []);
vi.mock('../sources/rssAggregator.js', () => ({ fetchAllNews: () => fetchAllNews() }));
vi.mock('../newsPersist.js', () => ({
  persistNews: () => {}, attachStoredConfidence: (x: unknown) => x,
}));
vi.mock('../newsTranslate.js', () => ({
  attachStoredTranslations: (x: unknown) => x,
  translatePass: async () => ({ updates: new Map() }),
  applyTranslations: (x: unknown) => x,
}));

const { startNewsLoop, stopNewsLoop } = await import('./newsLoop.js');

/** JST 壁時計 → epoch。 */
const jst = (y: number, m: number, d: number, H: number, M: number): number => Date.UTC(y, m - 1, d, H - 9, M);
const SAT_NOON = jst(2026, 8, 22, 12, 0);    // 週末=取引時間外
const WED_DAY = jst(2026, 8, 19, 10, 0);     // 平日 日中=取引時間内

let warns: unknown[][];
let errors: unknown[][];

beforeEach(() => {
  throwing.should = false;
  fetchAllNews.mockClear();
  warns = []; errors = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a); });
  vi.useFakeTimers();
});
afterEach(() => {
  stopNewsLoop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 保留中のマイクロタスクを流す(fake timer は進めない)。 */
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('設定読みが投げてもループが死なない', () => {
  it('健全時: 時間外(既定OFF)は取りに行かず、次の tick が予約されている', async () => {
    vi.setSystemTime(SAT_NOON);
    startNewsLoop();
    await settle();
    expect(fetchAllNews).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);          // 再武装されている
  });

  it('★設定読みが投げても: 既定(OFF)へ倒れ、理由がログに残り、タイマーが再武装される', async () => {
    vi.setSystemTime(SAT_NOON);
    throwing.should = true;
    startNewsLoop();
    await settle();

    // ① 既定(OFF=現行挙動)に倒れる → 時間外なので取りに行かない
    expect(fetchAllNews).not.toHaveBeenCalled();
    // ② 理由がログに残る(無言で倒れない)。例外のメッセージそのものが出ていること。
    expect(JSON.stringify(warns)).toContain('config-boom');
    expect(JSON.stringify(warns)).toContain('[newsLoop]');
    // ③ ★タイマーが再武装されている(= 次の tick が来る)
    expect(vi.getTimerCount()).toBe(1);
  });

  it('★投げ続けてもループは生き続ける(何周しても再武装される)', async () => {
    vi.setSystemTime(SAT_NOON);
    throwing.should = true;
    startNewsLoop();
    await settle();
    for (let i = 0; i < 3; i++) {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
    }
    expect(vi.getTimerCount()).toBe(1);
    expect(fetchAllNews).not.toHaveBeenCalled();
  });

  it('★設定読みが投げても、取引時間内の取得は止まらない(フォールバックが場中を殺さない)', async () => {
    vi.setSystemTime(WED_DAY);
    throwing.should = true;
    startNewsLoop();
    await settle();
    expect(fetchAllNews).toHaveBeenCalledTimes(1);   // 窓内は設定に関係なく取りに行く
    expect(vi.getTimerCount()).toBe(1);
  });

  it('例外が止まれば設定は普通に効く(倒れっぱなしにならない)', async () => {
    vi.setSystemTime(SAT_NOON);
    throwing.should = true;
    startNewsLoop();
    await settle();
    expect(fetchAllNews).not.toHaveBeenCalled();

    throwing.should = false;   // 設定が読めるように戻る(既定 OFF)
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await settle();
    expect(fetchAllNews).not.toHaveBeenCalled();     // OFF なので時間外は依然取らない
    expect(vi.getTimerCount()).toBe(1);
  });
});
