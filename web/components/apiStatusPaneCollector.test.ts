import { describe, it, expect } from 'vitest';
import { renderCollectorDot } from './apiStatusPane.js';

// ─── ★収集デーモンが「黙って死ぬ」のを終わらせる表示 ───────────────────────────
//
// 実運用: collector のプロセスが 10:13:44 に停止 → ティック保管も台帳の毎時書き出しも止まったが、
// monitor は正常に動き続け、**画面には何も出なかった**。1年かけてティックを溜めている最中なので、
// 黙って死ぬとデータが虫食いになり、それに1年後に気づく。
//
// ★否定対照(git show HEAD:web/components/apiStatusPane.ts > <tmp>):
//   HEAD には renderCollectorDot が存在しない = 本ファイルは import すら解決できない
//   (= 死んでいても画面は何も言わない、という当時の状態そのもの)。

type C = Parameters<typeof renderCollectorDot>[0];
const c = (over: Partial<NonNullable<C>>): C => ({
  state: 'ok', reason: '', heartbeatAt: 1, ageMs: 0, inPollWindow: true, pidAlive: true, at: 1,
  ...over,
});

describe('収集デーモンの死活ドット(Co)', () => {
  it('★停止していたら赤 +「停止しています」(見逃せない色にする)', () => {
    const html = renderCollectorDot(c({
      state: 'dead', inPollWindow: false, pidAlive: false,
      reason: '★収集デーモンが停止しています(心拍が 2026-06-03 10:13:44 JST = 3h20m前で凍結)',
    }));
    expect(html).toContain('🔴');
    expect(html).toContain('Co');
    expect(html).toContain('停止しています');
    // 直し方(=アプリを起動し直せば collector も起動する)まで出す。
    expect(html).toContain('起動し直す');
  });

  it('稼働中は緑', () => {
    const html = renderCollectorDot(c({ state: 'ok', reason: '収集中(心拍 2s前)' }));
    expect(html).toContain('🟢');
    expect(html).not.toContain('停止');
  });

  // ★ここが本丸: 時間外(常態)を警告色にすると、警告そのものが読まれなくなる。
  it('★取引時間外(生存)は警告色にしない・かつ「生存」と言い切る', () => {
    const html = renderCollectorDot(c({
      state: 'idle', inPollWindow: false,
      reason: '生存・待機中(心拍 12s前 / 取引時間外は約30秒間隔 — ティックが増えないのは正常)',
    }));
    expect(html).not.toContain('🔴');
    expect(html).not.toContain('🟡');
    expect(html).toContain('生存');
    expect(html).toContain('取引時間外');
  });

  it('★時間外(生存)と停止が同じ見た目にならない', () => {
    const idle = renderCollectorDot(c({ state: 'idle', inPollWindow: false, reason: 'x' }));
    const dead = renderCollectorDot(c({ state: 'dead', inPollWindow: false, reason: 'y' }));
    expect(idle).not.toBe(dead);
    expect(dead).toContain('🔴');
    expect(idle).not.toContain('🔴');
  });

  it('心拍が一度も無い(missing)は黄 = 「まだ動いたことがない」', () => {
    const html = renderCollectorDot(c({
      state: 'missing', heartbeatAt: null, ageMs: null,
      reason: '心拍(collector_heartbeat)が1件も無い',
    }));
    expect(html).toContain('🟡');
  });

  it('測れない環境(旧 monitor)では何も出さない', () => {
    expect(renderCollectorDot(undefined)).toBe('');
  });
});
