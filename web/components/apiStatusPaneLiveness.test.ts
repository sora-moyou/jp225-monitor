import { describe, it, expect } from 'vitest';
import { renderGeneratorDot } from './apiStatusPane.js';

// ─── ★B1(死活): 停止中に緑にならないこと ──────────────────────────────────────
//
// 旧表示は「最終記録 N分前」だけを見ていた。生成器はゲートに弾かれている間も2分ごとに
// status='skipped' を書き続けるので、**セッションの 91〜100% が停止していても表示は緑のまま**
// だった(実売買PCの実ログで確認済み)。無音の失敗は欠陥。
//
// ★否定対照(修正前 = git show HEAD:web/components/apiStatusPane.ts):
//   planLastHour を見ない実装なので、下の「停止中は緑にならない」が **赤**(🟢 が返る)。

describe('★生成器の死活は標本の量で決まる', () => {
  it('★停止中(標本 0 / 取引時間内)は緑にならない', () => {
    const html = renderGeneratorDot({
      available: true, lastRecordAt: 1, ageMin: 0, total: 5_000,
      planLastHour: 0, inSessionLastHour: 90,
    });
    expect(html).not.toContain('🟢');
    expect(html).toContain('🟡');
    expect(html).toContain('標本が溜まっていません');
    // ★「最終記録 0分前」= プロセスは生きている、という事実は消さない(隠すのではなく併記する)。
    expect(html).toContain('最終記録 0分前');
  });

  it('標本が十分あれば緑(件数を出す)', () => {
    const html = renderGeneratorDot({
      available: true, lastRecordAt: 1, ageMin: 1, total: 5_000,
      planLastHour: 88, inSessionLastHour: 90,
    });
    expect(html).toContain('🟢');
    expect(html).toContain('直近1時間の標本 88 件');
    expect(html).not.toContain('溜まっていません');
  });

  it('取引時間外は灰色(常態を警告色にすると警告が読まれなくなる)', () => {
    const html = renderGeneratorDot({
      available: true, lastRecordAt: 1, ageMin: 2, total: 5_000,
      planLastHour: 0, inSessionLastHour: 0,
    });
    expect(html).toContain('⚪');
    expect(html).toContain('取引時間外');
  });

  it('標本が細っている(取引時間内で1時間に数件)なら警告色', () => {
    const html = renderGeneratorDot({
      available: true, lastRecordAt: 1, ageMin: 1, total: 5_000,
      planLastHour: 3, inSessionLastHour: 90,
    });
    expect(html).toContain('🟡');
  });
});
