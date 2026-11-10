// 立会中なのにティックが古い重要価格を AI チャットに渡さないこと(server/chatContext.ts buildNikkeiTechnical)。
//
// ★実例(2026-10-28〜11-10): collector が止まって ticks が 10/28 05:59 のまま。levelsLoop は古いティック(64,395)を
//   基準に重要価格を計算し続け、AI チャットにはライブ現値 61,0xx と並んで渡っていた。
// ★変更前の実装(鮮度を見ずに formatLevelsBlock をそのまま出す)に戻すと、「古い」ケースが赤になる。
//   別ファイルにしているのは vi.mock のホイスティングで他のテストの levels を汚さないため
//   (chatContext.forecast.test.ts と同じ理由)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LevelsResult } from './levels.js';

const J = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 9, mi);

let snapshot: LevelsResult;
function levels(latestTickAt: number | undefined): LevelsResult {
  return {
    current: 64_395,
    up: [{ price: 64_600, dist: 205, labels: ['10/27夜高'], strong: true, score: 0, tier: 0, confluence: false }],
    down: [{ price: 64_100, dist: -295, labels: ['Fib50%'], strong: false, score: 0, tier: 0, confluence: false }],
    swing: { high: 64_800, low: 63_800, leg: 'up' },
    reversalSatisfied: false,
    asOf: 0,
    ...(latestTickAt !== undefined ? { latestTickAt } : {}),
  };
}
vi.mock('./loops/levelsLoop.js', () => ({ getLevelsSnapshot: (): LevelsResult => snapshot }));
vi.mock('./loops/forecastLoop.js', () => ({
  getForecastSnapshot: () => ({ adr: null, targets: null, seasonalityNow: null, seasonalityNext: null, asOf: 0 }),
}));

const { buildNikkeiTechnical, staleLevelsTickAt } = await import('./chatContext.js');
const { DETECT_FRESH_MS } = await import('./detect/registry.js');

const noBars = (): never[] => [];
const NOW_DAY = J(2026, 11, 10, 11, 0);          // 2026-11-10(火) 11:00 JST = 立会中
const LAST_TICK = J(2026, 10, 28, 5, 59);         // 10/28 05:59 JST(実例の最終ティック)

describe('buildNikkeiTechnical — 立会中に古い重要価格を AI チャットへ渡さない', () => {
  beforeEach(() => { snapshot = levels(LAST_TICK); });

  it('★実例: 立会中・最終ティック 10/28 05:59 → 重要価格/フィボの数値を一切出さず、止まっている事実を1行で書く', () => {
    const out = buildNikkeiTechnical(noBars, 61_050, { guardStaleLevels: true, now: NOW_DAY })!;
    expect(out).toContain('現値 61,050円');   // ライブ現値はそのまま渡す
    expect(out).toContain('重要価格: 収集停止中のため算出できません(最終ティック 10/28 05:59 JST)');
    for (const stale of ['64,600', '64,100', '64,800', '63,800', '上値メド', '下値メド', 'フィボ']) {
      expect(out).not.toContain(stale);
    }
  });

  it('閾値ちょうど(DETECT_FRESH_MS)までは従来どおり渡す / 1ms 超えたら渡さない', () => {
    snapshot = levels(NOW_DAY - DETECT_FRESH_MS);
    expect(buildNikkeiTechnical(noBars, 64_400, { guardStaleLevels: true, now: NOW_DAY })!).toContain('上値メド: 64,600円');
    snapshot = levels(NOW_DAY - DETECT_FRESH_MS - 1);
    expect(buildNikkeiTechnical(noBars, 64_400, { guardStaleLevels: true, now: NOW_DAY })!).not.toContain('上値メド');
  });

  it('時間外(引け後・週末)は古くて当たり前なので従来どおり渡す', () => {
    const afterClose = J(2026, 11, 10, 15, 50);   // 引けの5分後(inPollWindow は true だが立会外)
    snapshot = levels(J(2026, 11, 10, 15, 44));
    expect(buildNikkeiTechnical(noBars, 64_400, { guardStaleLevels: true, now: afterClose })!).toContain('上値メド');
    const saturday = J(2026, 11, 14, 12, 0);
    snapshot = levels(LAST_TICK);
    expect(buildNikkeiTechnical(noBars, 64_400, { guardStaleLevels: true, now: saturday })!).toContain('上値メド');
  });

  it('既定(guardStaleLevels 無し)は従来と同じ出力(取引系の呼び手 scalpPlanRunner は変えない)', () => {
    const guarded = buildNikkeiTechnical(noBars, 61_050, { now: NOW_DAY })!;
    expect(guarded).toContain('上値メド: 64,600円(強)(10/27夜高)');
    expect(guarded).toContain('■ 日経225先物 (NIY=F) テクニカル(セッションH/L・フィボ):');
  });

  it('staleLevelsTickAt: latestTickAt が無い(古いペイロード)は判定しない', () => {
    expect(staleLevelsTickAt(levels(undefined), NOW_DAY)).toBeNull();
    expect(staleLevelsTickAt(levels(LAST_TICK), NOW_DAY)).toBe(LAST_TICK);
  });

  // ★エバリュエーター指摘(v0.9.114 の欠陥): 08:45:00 / 17:00:00 で立会中になった瞬間、latestTickAt は前のセッションの
  //   最後(06:00 / 15:44:59)のまま。新しいティックが届いて levelsLoop が回るまで(実測: 最初のティックは寄り+4.0秒、
  //   levelsLoop は8秒周期)「収集停止中」と判定していた。運用DBのコピーでは寄り後60秒以内の計画62件が全件 寄り+0.3〜4.7秒。
  //   → 寄りから DETECT_FRESH_MS は前のセッションの最後の価格を正当とみなす。猶予を過ぎても来なければ古い。
  it('★寄りの猶予内(17:00:00〜+90秒): 前のセッション最後のティック(15:44:59)でも古いと判定せず、従来どおり渡す', () => {
    const lastDay = J(2026, 10, 26, 15, 44) + 59_491;
    for (const sec of [0, 0.3, 3.482, 4.7, 60, 90]) {
      const now = J(2026, 10, 26, 17, 0) + sec * 1000;
      snapshot = { ...levels(lastDay), collectorHeartbeatAt: now - 2_000 };   // collector は生きている
      expect(staleLevelsTickAt(snapshot, now)).toBeNull();
      expect(buildNikkeiTechnical(noBars, 64_400, { guardStaleLevels: true, now })!).toContain('上値メド: 64,600円');
    }
    // 日中の寄り(08:45)も同じ: 最後のティックは夜間の 05:59:59
    snapshot = { ...levels(J(2026, 10, 27, 5, 59) + 59_000), collectorHeartbeatAt: J(2026, 10, 27, 8, 45) + 2_000 };
    expect(staleLevelsTickAt(snapshot, J(2026, 10, 27, 8, 45) + 4_000)).toBeNull();
  });

  it('★猶予を過ぎてもティックが来ない(17:01:30 + 1ms)なら古い(本当に止まっている)', () => {
    const lastDay = J(2026, 10, 26, 15, 44) + 59_491;
    snapshot = levels(lastDay);
    const now = J(2026, 10, 26, 17, 0) + DETECT_FRESH_MS + 1;
    expect(staleLevelsTickAt(snapshot, now)).toBe(lastDay);
    expect(buildNikkeiTechnical(noBars, 64_400, { guardStaleLevels: true, now })!).toContain('重要価格: 収集停止中');
  });

  // ★エバリュエーター指摘(寄りの猶予の穴): 猶予は「最後のティックが **直前のセッションの終わり際** まで届いている」
  //   ときだけ。何時間・何日も前で止まったティックで寄りを迎えたら、寄りの瞬間から古い(本当に止まっている)。
  //   実例: 10/27 は collector が 08:01 に死亡。10/27 17:00 の計画 878A/879B は最終ティック(10/27 05:59:58)から約39,600秒。
  it('★停止中の寄り: 最終ティックが朝で止まったまま 17:00+3秒 → 古い(直前の日中セッションの末尾に届いていない)', () => {
    const lastTick = J(2026, 10, 27, 5, 59) + 58_000;
    snapshot = levels(lastTick);
    const now = J(2026, 10, 27, 17, 0) + 3_000;
    expect(staleLevelsTickAt(snapshot, now)).toBe(lastTick);
    expect(buildNikkeiTechnical(noBars, 64_400, { guardStaleLevels: true, now })!).toContain('重要価格: 収集停止中');
    // 前日の朝で止まっている場合も同じ
    snapshot = levels(J(2026, 10, 26, 8, 1));
    expect(staleLevelsTickAt(snapshot, J(2026, 10, 27, 8, 45) + 3_000)).not.toBeNull();
  });

  it('★週明け: 金曜夜間の末尾(土 05:59:58)→ 月曜 08:45+3秒 は健全な寄り(古いと判定しない)', () => {
    const now = J(2026, 11, 9, 8, 45) + 3_000;           // 2026-11-09(月) 08:45:03
    // 2026-11-07(土) 05:59:58 = 11/6(金) Night の末尾。collector は生きている(心拍 2秒前)。
    snapshot = { ...levels(J(2026, 11, 7, 5, 59) + 58_000), collectorHeartbeatAt: now - 2_000 };
    expect(staleLevelsTickAt(snapshot, now)).toBeNull();
    expect(buildNikkeiTechnical(noBars, 64_400, { guardStaleLevels: true, now })!).toContain('上値メド: 64,600円');
  });

  it('★祝日明け: 2026-11-23(月・祝日取引なし)を挟む → 金曜夜間の末尾(土 05:59:58)から火曜 08:45+3秒 は健全', () => {
    snapshot = { ...levels(J(2026, 11, 21, 5, 59) + 58_000), collectorHeartbeatAt: J(2026, 11, 24, 8, 45) + 1_000 };
    expect(staleLevelsTickAt(snapshot, J(2026, 11, 24, 8, 45) + 3_000)).toBeNull();
    // 猶予(90秒)を過ぎてもティックが来なければ古い
    expect(staleLevelsTickAt(snapshot, J(2026, 11, 24, 8, 45) + DETECT_FRESH_MS + 1)).not.toBeNull();
  });

  // ★818A/819B(今回の事故そのものの形): collector は 08:01 に死亡。08:45 の寄りの時点で最終ティックは直前の夜間の末尾
  //   (05:59:58)なので、ティックだけでは健全な寄り待ちと区別できない。→ 心拍が古い/読めないなら寄りの猶予を認めない。
  it('★818A/819B: 最終ティック 05:59:58・寄り 08:45+1.4秒・心拍が 08:01:08 で止まっている → 古い', () => {
    const lastTick = J(2026, 10, 27, 5, 59) + 58_000;
    snapshot = { ...levels(lastTick), collectorHeartbeatAt: J(2026, 10, 27, 8, 1) + 8_000 };
    const now = J(2026, 10, 27, 8, 45) + 1_400;
    expect(staleLevelsTickAt(snapshot, now)).toBe(lastTick);
    expect(buildNikkeiTechnical(noBars, 64_400, { guardStaleLevels: true, now })!).toContain('重要価格: 収集停止中');
  });

  it('★心拍が読めない(meta に無い=null / 古いペイロード=undefined)ときは寄りの猶予を認めない', () => {
    const now = J(2026, 10, 26, 17, 0) + 3_482;
    const lastDay = J(2026, 10, 26, 15, 44) + 59_491;
    expect(staleLevelsTickAt({ ...levels(lastDay), collectorHeartbeatAt: null }, now)).toBe(lastDay);
    expect(staleLevelsTickAt(levels(lastDay), now)).toBe(lastDay);
  });

  it('心拍は「寄りの猶予」だけに使う: 立会中の途中は心拍が死んでいてもティックが新しければ古くない', () => {
    const now = J(2026, 10, 26, 11, 0);
    expect(staleLevelsTickAt({ ...levels(now - 2_000), collectorHeartbeatAt: null }, now)).toBeNull();
  });

  // ★collector は生きていて心拍も新しいが、ティックを書けていない(poll が失敗し続けても心拍は打たれる)まま寄りを迎えた。
  //   このとき古い数値を止めているのは「最終ティックが直前の引けから DETECT_FRESH_MS 以内」の条件だけ。
  it('★心拍は新しいが、最終ティックが直前の引けより十分前(05:58:28)→ 寄り+2秒でも古い', () => {
    const lastTick = J(2026, 10, 27, 5, 58) + 28_000;   // 直前の夜間の引け 06:00 の 92秒前(> 90秒)
    const now = J(2026, 10, 27, 8, 45) + 2_000;
    snapshot = { ...levels(lastTick), collectorHeartbeatAt: now - 2_000 };   // 心拍は新しい
    expect(staleLevelsTickAt(snapshot, now)).toBe(lastTick);
    expect(buildNikkeiTechnical(noBars, 64_400, { guardStaleLevels: true, now })!).toContain('重要価格: 収集停止中');
    // 対照: 引けの 90秒前(05:58:30)なら猶予を認める(境界の内側)
    snapshot = { ...levels(J(2026, 10, 27, 5, 58) + 30_000), collectorHeartbeatAt: now - 2_000 };
    expect(staleLevelsTickAt(snapshot, now)).toBeNull();
  });
});
