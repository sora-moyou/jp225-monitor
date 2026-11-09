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
});
