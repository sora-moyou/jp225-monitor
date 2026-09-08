import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  feedClock, FeedFreezeWatch, FROZEN_AFTER_MS, fetchAjaxCmePrices, ajaxCmeFreezeWatch,
  AJAX_CME_CLOCK_CODES,
} from './ajaxCmePrice.js';

afterEach(() => { vi.unstubAllGlobals(); ajaxCmeFreezeWatch.reset(); });

// ★実データ: 2026-09-08 16:32 JST に実HTTPで取った **凍結した旧ファイル**(ajax_cme.js)の 3 行。
//   136 は liveFlag=0 で止まったが、731/737 は **liveFlag=1 のまま 08:19 で凍っている**。
//   これが「liveFlag だけでは凍結を検出できない」ことの現物。
const FROZEN = `A[136]="65820.00_+805.00_+1.24_06:00_0_65970.00_64655.00";
A[731]="53241.20_+15.80_+0.03_08:19_1_53301.90_53165.10";
A[737]="29561.60_+69.00_+0.23_08:19_1_29606.70_29448.40";`;

// ★実データ: 同時刻に取った **生きている新ファイル**(ajax_cme2.js)の 3 行(提供元の時計=16:32)。
const LIVE = `A[136]="65190.00_-1300.00_-1.96_09/08_0_66785.00_65105.00";
A[731]="53001.90_-48.70_-0.09_16:32_1_53170.30_52895.80";
A[737]="29580.90_+19.50_+0.07_16:32_1_29754.30_29478.80";`;

// ★実ファイルの形の断面を作る(2026-09-08 17:10 の実応答をひな形にした)。
//   136/731/737 は `hhmm` ちょうど。それ以外は **liveFlag=1 のまま遅れている実在の行**:
//     A[621] = 15分遅れ(実測で常時10〜16分遅れ) / A[713][715] = 10分遅れ / A[716][717][721] = 12分遅れ
//   ★日跨ぎの再現に必要なのは「遅れた行が 23時台に居座る」ことだけなので、遅れ分は固定文字列で置く。
const LAGGARDS: ReadonlyArray<readonly [string, string]> = [
  ['621', '23:58'], ['713', '23:57'], ['715', '23:57'], ['716', '23:55'], ['717', '23:55'], ['721', '23:56'],
];
export const ALL_CODES = ['136', '731', '737', ...LAGGARDS.map(([c]) => c)];

function crossSection(hhmm: string): string {
  const lag = hhmm >= '17:00' && hhmm < '23:00'
    ? LAGGARDS.map(([c]) => [c, hhmm] as const)   // 昼の断面では遅れ行も同じ帯に居る
    : LAGGARDS;
  const rows = [
    `A[136]="65080.00_-110.00_-0.17_${hhmm}_1_65175.00_64920.00";`,
    `A[731]="52961.90_-88.70_-0.17_${hhmm}_1_53170.30_52868.70";`,
    `A[737]="29471.10_-90.30_-0.31_${hhmm}_1_29754.30_29435.40";`,
    ...lag.map(([c, t]) => `A[${c}]="64920.00_-500.00_-0.76_${t}_1_65490.00_64920.00";`),
    // 清算中の行(HH:MM ではない)も実ファイルには常に混ざる。
    `A[131]="39000.00_+50.00_+0.13_09/08_0_39100.00_38900.00";`,
  ];
  return rows.join('\n');
}

describe('feedClock — 提供元自身の時計', () => {
  it('liveFlag=1 かつ HH:MM の行だけを見て最大値を返す', () => {
    expect(feedClock(LIVE)).toBe('16:32');       // 136 は liveFlag=0 なので無視される
    expect(feedClock(FROZEN)).toBe('08:19');
  });

  it('liveFlag=1 でも [3] が MM/DD なら時計ではない', () => {
    expect(feedClock('A[136]="1_0_0_09/08_1__";')).toBeNull();
  });

  it('liveFlag=1 の行が1つも無ければ null(週末・全銘柄清算=判定しない)', () => {
    expect(feedClock('A[136]="1_0_0_09/08_0__";\nA[731]="2_0_0_09/08_0__";')).toBeNull();
    expect(feedClock('')).toBeNull();
  });

  it('複数の時計が混ざったら最大値(最も進んだ行)を採る', () => {
    const t = `A[136]="1_0_0_16:30_1__";\nA[731]="2_0_0_16:32_1__";`;
    expect(feedClock(t)).toBe('16:32');
  });
});

describe('見る行の絞り込み', () => {
  it('既定で見るのは本番でゲートしている 136/731/737 だけ', () => {
    expect([...AJAX_CME_CLOCK_CODES]).toEqual(['136', '731', '737']);
  });

  it('指定したコードが1つも無ければ null(判定しない)', () => {
    expect(feedClock(crossSection('10:00'), ['99999'])).toBeNull();
  });
});

describe('FeedFreezeWatch — 時計が進んでいるか', () => {
  it('時計が変わっている間は frozen=false', () => {
    const w = new FeedFreezeWatch();
    expect(w.observe('A[731]="1_0_0_16:30_1__";', 0)).toEqual({ clock: '16:30', frozen: false, frozenMs: 0 });
    const s = w.observe('A[731]="2_0_0_16:31_1__";', 60_000);
    expect(s).toEqual({ clock: '16:31', frozen: false, frozenMs: 0 });   // 変化 → 基準リセット
  });

  it('時計が変わらないまま 5 分を超えたら frozen=true', () => {
    const w = new FeedFreezeWatch();
    w.observe(FROZEN, 0);
    expect(w.observe(FROZEN, FROZEN_AFTER_MS).frozen).toBe(false);        // ちょうどはまだ
    expect(w.observe(FROZEN, FROZEN_AFTER_MS + 1).frozen).toBe(true);
    expect(w.observe(FROZEN, FROZEN_AFTER_MS + 1).frozenMs).toBe(FROZEN_AFTER_MS + 1);
  });

  it('★価格が動いても時計が同じなら凍結(価格の変化では判定しない)', () => {
    const w = new FeedFreezeWatch();
    w.observe('A[731]="1_0_0_08:19_1__";', 0);
    const s = w.observe('A[731]="999_0_0_08:19_1__";', 600_000);
    expect(s.frozen).toBe(true);
  });

  it('★23:59 → 00:00 の日跨ぎで誤検知しない(等値比較のみ・1行だけの断面)', () => {
    const w = new FeedFreezeWatch();
    w.observe('A[731]="1_0_0_23:59_1__";', 0);
    const s = w.observe('A[731]="1_0_0_00:00_1__";', 600_000);
    expect(s).toEqual({ clock: '00:00', frozen: false, frozenMs: 0 });    // 戻ったのではなく「変わった」
  });

  // ★★ここが差し戻しの本体(2026-09-08)。上の「1行だけの断面」のテストは緑のまま、
  //   **実ファイルの形(45〜48行・遅れている liveFlag=1 の行が混ざる)では frozen が誤って立っていた**。
  //   1行の断面しか見ないテストは恒真に近い。実ファイルの形で回帰させる。
  it('★★日跨ぎ回帰: 遅れた行が混ざった実ファイル形の断面でも frozen が立たない', () => {
    const w = new FeedFreezeWatch();
    const seen: Array<{ at: string; clock: string | null; frozen: boolean }> = [];
    // 23:55 → 00:20 を1分刻み。136/731/737 は毎分進み、A[621] 等は 23時台で遅れたまま。
    for (let i = 0; i <= 25; i++) {
      const mins = (23 * 60 + 55 + i) % (24 * 60);
      const hhmm = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      const now = i * 60_000;
      const st = w.observe(crossSection(hhmm), now);
      seen.push({ at: hhmm, clock: st.clock, frozen: st.frozen });
    }
    // 全断面で frozen=false、かつ clock は **自分の3銘柄の時計** を追っている。
    expect(seen.filter(x => x.frozen)).toEqual([]);
    expect(seen.at(-1)).toEqual({ at: '00:20', clock: '00:20', frozen: false });
    // 否定対照(この場でファイル全体を見た場合): 最大値は 23時台の遅れた行にピン留めされる。
    expect(feedClock(crossSection('00:20'), ALL_CODES)).toBe('23:58');
    expect(feedClock(crossSection('00:20'))).toBe('00:20');   // 既定(136/731/737)なら正しい
  });

  it('★遅れた別銘柄(A[621] 等)は時計として採用しない(実ファイル 2026-09-08 17:10 の形)', () => {
    // 実測: A[621] は常時10〜16分遅れ、A[713]/[715]/[716]/[717]/[721] も5〜12分遅れで liveFlag=1。
    expect(feedClock(crossSection('17:10'))).toBe('17:10');
    expect(feedClock(crossSection('17:10'), ALL_CODES)).toBe('17:10');   // 昼はたまたま一致する
  });

  it('全銘柄が清算(clock=null)の回は判定しない。基準時刻は据え置く(凍結の記憶を消さない)', () => {
    const w = new FeedFreezeWatch();
    w.observe(FROZEN, 0);
    expect(w.observe('A[136]="1_0_0_09/08_0__";', 100_000)).toEqual({ clock: null, frozen: false, frozenMs: 0 });
    expect(w.observe(FROZEN, 600_000).frozen).toBe(true);                  // 記憶は生きている
  });

  it('reset() で初期状態に戻る(テストから注入・リセットできる)', () => {
    const w = new FeedFreezeWatch();
    w.observe(FROZEN, 0);
    w.observe(FROZEN, 600_000);
    expect(w.state.frozen).toBe(true);
    w.reset();
    expect(w.state).toEqual({ clock: null, frozen: false, frozenMs: 0 });
  });
});

describe('fetchAjaxCmePrices — 凍結中は全銘柄 stale', () => {
  const stub = (text: string) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => text })));

  it('★否定対照: 凍結した旧ファイルを食わせると liveFlag=1 の 731/737 も stale になる', async () => {
    stub(FROZEN);
    const w = new FeedFreezeWatch();
    const first = await fetchAjaxCmePrices(undefined, w, 0);
    expect(first.find(p => p.symbol === 'YM=F')!.stale).toBe(false);       // まだ凍結と判定できない
    const later = await fetchAjaxCmePrices(undefined, w, FROZEN_AFTER_MS + 1);
    expect(later.length).toBe(3);
    expect(later.every(p => p.stale)).toBe(true);                          // ★全て stale
  });

  it('生きているファイルなら凍結扱いにしない(731/737 は fresh のまま)', async () => {
    stub(LIVE);
    const w = new FeedFreezeWatch();
    await fetchAjaxCmePrices(undefined, w, 0);
    const p = await fetchAjaxCmePrices(undefined, w, 60_000);
    const by = Object.fromEntries(p.map(x => [x.symbol, x]));
    expect(by['YM=F']!.stale).toBe(false);
    expect(by['NQ=F']!.stale).toBe(false);
    expect(by['NIY=F']!.stale).toBe(true);   // 136 は liveFlag=0(引け〜夜間の間)= 従来どおり
  });

  it('取得失敗(両ホスト null)は凍結判定に混ぜない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));
    const w = new FeedFreezeWatch();
    expect(await fetchAjaxCmePrices(undefined, w, 999_999)).toEqual([]);
    expect(w.state).toEqual({ clock: null, frozen: false, frozenMs: 0 });
  });
});
