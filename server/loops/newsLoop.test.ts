import { describe, it, expect } from 'vitest';
import { newsShouldFetch, newsNextDelayMs, msUntilPollWindowOpens, NEWS_OFF_HOURS_POLL_MS } from './newsLoop.js';
import { inPollWindow } from '../../core/session.js';

// ★何を守っているか
//   v0.7.5 の「取引時間外ドーマント化」は news ループも止める。今回そこに **設定(既定OFF)** を足した。
//   守るべきは 3つ:
//     ① 既定(OFF)では現行と 1ミリも変わらない(時間外は取りに行かない・待ちは常に場中の間隔)。
//     ② ON のときだけ時間外も取りに行く。
//     ③ ON のときの時間外の待ちは **15分**(ユーザー指示・固定)。場中は従来どおり。
//   ★否定対照: git show HEAD:server/loops/newsLoop.ts の旧版には newsShouldFetch / newsNextDelayMs が
//     無く(tick 冒頭の inPollWindow 直帰のみ・待ちは常に intervalMs)、ON 側の 5件が全部落ちる。

const IN_HOURS = 60_000;   // resolveNewsPollMs() の既定

/** JST 壁時計から epoch ms(JST=UTC+9・DSTなし)。 */
const jst = (y: number, m: number, d: number, H: number, M: number): number => Date.UTC(y, m - 1, d, H - 9, M);

// 2026-08-19(水)= 平日・祝日でない。8/20(木)も同様。8/22(土)は週末。
const WED_DAY = jst(2026, 8, 19, 10, 0);       // 日中セッション中
const WED_NIGHT = jst(2026, 8, 19, 20, 0);     // ナイトセッション中
const WED_GAP = jst(2026, 8, 19, 16, 30);      // 日中引け後〜ナイト前の谷間(時間外)
const THU_MORNING = jst(2026, 8, 20, 7, 0);    // 早朝(ナイト終了後)= 時間外
const SAT_NOON = jst(2026, 8, 22, 12, 0);      // 週末 = 時間外
const WED_PREOPEN = jst(2026, 8, 19, 8, 30);   // 寄り前(時間外・15分後の 8:45 には窓が開いている)

describe('前提: 選んだ時刻が期待どおりの窓の内外にある', () => {
  it('場中と判定される時刻', () => {
    expect(inPollWindow(WED_DAY)).toBe(true);
    expect(inPollWindow(WED_NIGHT)).toBe(true);
  });
  it('時間外と判定される時刻', () => {
    expect(inPollWindow(WED_GAP)).toBe(false);
    expect(inPollWindow(THU_MORNING)).toBe(false);
    expect(inPollWindow(SAT_NOON)).toBe(false);
    expect(inPollWindow(WED_PREOPEN)).toBe(false);
  });
});

describe('newsShouldFetch — 時間外に取りに行くか', () => {
  it('★既定(OFF): 時間外は取りに行かない(=現行と同一)', () => {
    expect(newsShouldFetch(WED_GAP, false)).toBe(false);
    expect(newsShouldFetch(THU_MORNING, false)).toBe(false);
    expect(newsShouldFetch(SAT_NOON, false)).toBe(false);
  });
  it('既定(OFF)でも場中は従来どおり取りに行く', () => {
    expect(newsShouldFetch(WED_DAY, false)).toBe(true);
    expect(newsShouldFetch(WED_NIGHT, false)).toBe(true);
  });
  it('★ON: 時間外(谷間/早朝/週末)でも取りに行く', () => {
    expect(newsShouldFetch(WED_GAP, true)).toBe(true);
    expect(newsShouldFetch(THU_MORNING, true)).toBe(true);
    expect(newsShouldFetch(SAT_NOON, true)).toBe(true);
  });
  it('ON でも場中の判定は変わらない', () => {
    expect(newsShouldFetch(WED_DAY, true)).toBe(true);
  });
});

describe('newsNextDelayMs — 次の tick までの待ち', () => {
  it('★既定(OFF)は時刻に関係なく常に場中の間隔(=現行の setTimeout(schedule, intervalMs) と同じ)', () => {
    for (const t of [WED_DAY, WED_NIGHT, WED_GAP, THU_MORNING, SAT_NOON, WED_PREOPEN]) {
      expect(newsNextDelayMs(t, IN_HOURS, false)).toBe(IN_HOURS);
    }
  });

  it('ON でも場中は従来どおり(60秒)', () => {
    expect(newsNextDelayMs(WED_DAY, IN_HOURS, true)).toBe(IN_HOURS);
    expect(newsNextDelayMs(WED_NIGHT, IN_HOURS, true)).toBe(IN_HOURS);
  });

  it('★ON の時間外は 15分', () => {
    expect(NEWS_OFF_HOURS_POLL_MS).toBe(15 * 60_000);
    expect(newsNextDelayMs(WED_GAP, IN_HOURS, true)).toBe(15 * 60_000);
    expect(newsNextDelayMs(THU_MORNING, IN_HOURS, true)).toBe(15 * 60_000);
    expect(newsNextDelayMs(SAT_NOON, IN_HOURS, true)).toBe(15 * 60_000);
  });

  it('★場中の間隔を変えても、時間外は 15分のまま(場中の設定に引きずられない)', () => {
    expect(newsNextDelayMs(SAT_NOON, 10_000, true)).toBe(15 * 60_000);
    expect(newsNextDelayMs(SAT_NOON, 600_000, true)).toBe(15 * 60_000);
  });

  it('★窓が 15分以内に開くなら「開く瞬間まで」で頭を打つ(15分より短くはするが、長くはしない)', () => {
    // 8:30 の 10分後(8:40 = 寄り 8:45 の 5分前マージン)に窓が開く。
    expect(newsNextDelayMs(WED_PREOPEN, IN_HOURS, true)).toBe(10 * 60_000);
    // ★待った先はちょうど窓の中 = 起きた瞬間に取りに行ける(逆転が消える)。
    expect(inPollWindow(WED_PREOPEN + newsNextDelayMs(WED_PREOPEN, IN_HOURS, true))).toBe(true);
    // ★その1分前は窓の外 = 早く起きすぎてもいない。
    expect(inPollWindow(WED_PREOPEN + newsNextDelayMs(WED_PREOPEN, IN_HOURS, true) - 60_000)).toBe(false);
  });

  it('★「時間外は15分」を破らない: 開場直前は 60秒周期に落ちず「開くまでの残り」を一度だけ待つ', () => {
    for (let m = 1; m <= 15; m++) {
      const t = jst(2026, 8, 19, 8, 40) - m * 60_000;   // 窓が開く 8:40 の m分前
      expect(inPollWindow(t)).toBe(false);
      const d = newsNextDelayMs(t, IN_HOURS, true);
      expect(d).toBe(m * 60_000);                       // 常に「開くまでの残り」ちょうど
      expect(d).toBeLessThanOrEqual(NEWS_OFF_HOURS_POLL_MS);
      // ★次に起きるのは窓の中(=時間外の tick はこの1回で終わり・60秒周期にはならない)
      expect(inPollWindow(t + d)).toBe(true);
    }
  });

  it('週末のように次の開場が遠いときは 15分のまま(短くしない)', () => {
    expect(msUntilPollWindowOpens(SAT_NOON)).toBeNull();
    expect(newsNextDelayMs(SAT_NOON, IN_HOURS, true)).toBe(NEWS_OFF_HOURS_POLL_MS);
  });
});

describe('msUntilPollWindowOpens — 前方探索は 15分で打ち切る', () => {
  it('15分より先に開く場合は null(=何日も先まで走査しない)', () => {
    expect(msUntilPollWindowOpens(SAT_NOON)).toBeNull();                     // 次の開場は月曜
    expect(msUntilPollWindowOpens(jst(2026, 8, 19, 8, 20))).toBeNull();      // 20分先 → 見ない
    expect(msUntilPollWindowOpens(jst(2026, 8, 19, 8, 24))).toBeNull();      // 16分先 → 見ない
  });

  it('15分以内に開く場合はその残り時間(分ちょうど)', () => {
    expect(msUntilPollWindowOpens(jst(2026, 8, 19, 8, 25))).toBe(15 * 60_000);
    expect(msUntilPollWindowOpens(jst(2026, 8, 19, 8, 39))).toBe(60_000);
    expect(msUntilPollWindowOpens(jst(2026, 8, 19, 16, 50))).toBe(5 * 60_000);   // ナイト 17:00 の5分前=16:55
  });

  it('分の途中(秒・ミリ秒つき)でも次の分境界を正しく返す', () => {
    const t = jst(2026, 8, 19, 8, 39) + 30_000 + 250;   // 8:39:30.250
    expect(msUntilPollWindowOpens(t)).toBe(60_000 - 30_250);
    expect(inPollWindow(t + msUntilPollWindowOpens(t)!)).toBe(true);
  });

  it('★休場(年末年始 / BCP)を跨いでも探索は 15分で打ち切る=何日も走査しない', () => {
    expect(msUntilPollWindowOpens(jst(2027, 1, 1, 12, 0))).toBeNull();    // 元日(先物 非取引日)
    expect(msUntilPollWindowOpens(jst(2026, 11, 23, 12, 0))).toBeNull();  // BCPテストで祝日取引なしの月曜
  });

  it('★GW(祝日取引あり)は普通の平日と同じ扱い=谷間だけが時間外', () => {
    // 2026-05-05(火・こどもの日)は先物は取引あり。日中は窓の中、引け後の谷間だけ時間外。
    expect(inPollWindow(jst(2026, 5, 5, 12, 0))).toBe(true);
    expect(inPollWindow(jst(2026, 5, 5, 16, 0))).toBe(false);
    expect(newsNextDelayMs(jst(2026, 5, 5, 16, 0), IN_HOURS, true)).toBe(NEWS_OFF_HOURS_POLL_MS);
    expect(newsNextDelayMs(jst(2026, 5, 5, 16, 50), IN_HOURS, true)).toBe(5 * 60_000);   // ナイト 16:55 開始
  });
});

describe('★1取引日あたりの取得回数(見積もりの根拠を数字で固定する)', () => {
  /** [from, to) を歩いて tick 回数を数える(実装と同じ判定を使う)。 */
  function countTicks(from: number, to: number, offHours: boolean): { ticks: number; fetches: number } {
    let t = from, ticks = 0, fetches = 0;
    while (t < to) {
      ticks++;
      if (newsShouldFetch(t, offHours)) fetches++;
      t += newsNextDelayMs(t, IN_HOURS, offHours);
    }
    return { ticks, fetches };
  }

  it('平日24時間(水 6:00 → 木 6:00): 取得は 1230 → 1244 回(+14 = +1.1%)', () => {
    const from = jst(2026, 8, 19, 6, 0), to = jst(2026, 8, 20, 6, 0);
    const off = countTicks(from, to, false);
    const on = countTicks(from, to, true);
    // 現行: 60秒で 1440 回まわり、実際に取りに行くのは窓内(20.5h=1230分)だけ。
    expect(off).toEqual({ ticks: 1440, fetches: 1230 });
    // ON: 窓内 1230 + 時間外の谷間 60分(15分×4) + 早朝 150分(15分×10)= 14。
    expect(on).toEqual({ ticks: 1244, fetches: 1244 });
    expect(on.fetches - off.fetches).toBe(14);
  });

  it('週末24時間(土 6:00 → 日 6:00): 取得は 10 → 106 回(丸1日 時間外でも +96 回)', () => {
    const from = jst(2026, 8, 22, 6, 0), to = jst(2026, 8, 23, 6, 0);
    // OFF の 10 は金曜ナイトの終了マージン(TRAIL 10分)ぶん。それ以外は丸一日何もしない。
    expect(countTicks(from, to, false).fetches).toBe(10);
    expect(countTicks(from, to, true).fetches).toBe(106);   // 10 + 96(=15分間隔の 24時間)
  });

  it('1週間(月 6:00 → 翌月 6:00): 取得は 6150 → 6413 回(+263 = +4.3%)', () => {
    const from = jst(2026, 8, 17, 6, 0), to = jst(2026, 8, 24, 6, 0);
    expect(countTicks(from, to, false).fetches).toBe(6150);
    expect(countTicks(from, to, true).fetches).toBe(6413);
  });

  it('★開場あたりの余分な時間外 tick は 1回だけ(寄り前15分に何回入るか)', () => {
    let n = 0;
    for (let t = jst(2026, 8, 19, 8, 25); t < jst(2026, 8, 19, 8, 40); t += newsNextDelayMs(t, IN_HOURS, true)) n++;
    expect(n).toBe(1);
  });
});
