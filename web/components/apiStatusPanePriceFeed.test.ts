import { describe, it, expect } from 'vitest';
import { renderPriceDot } from './apiStatusPane.js';

// ─── ★価格フィードが「取れているのに中身が止まっている」のを画面に出す ───────────
//
// 実運用(2026-09-06 08:19 JST): 提供元の ajax_cme.js が凍結。136 は liveFlag=0 で消え、
// 731/737 は **liveFlag=1 のまま同じ値を配り続けた**。取得自体は成功していたので
// data.yahoo.fallback は false のまま = **画面は緑**。2 営業日、誰も気づかなかった。
//
// ★この画面は **判定しない**。サーバ(server/db/priceFeedHeartbeat.ts)が出した state に色を付け、
//   reason をそのまま出すだけ。以前の版はここで frozen を独自に最優先で見ており、両ホスト取得失敗時に
//   サーバ='down' / 画面='提供元の更新が停止' と **結論が食い違っていた**(2箇所で判定する形が欠陥)。
//
// ★否定対照(git show HEAD:web/components/apiStatusPane.ts > <tmp>):
//   HEAD には renderPriceDot が無く、判定は data.yahoo.fallback だけ。凍結中も NIY=F 欠測中も緑。

const NOW = 1_788_853_372_000;
const OK = { fallback: false, skipUntil: 0 };

describe('価格フィードのドット(P)', () => {
  it('正常時は緑 + サーバの理由をそのまま出す', () => {
    const html = renderPriceDot(OK, { state: 'ok', reason: '新鮮(提供元の時計=16:42・0s前に更新)' }, NOW);
    expect(html).toContain('🟢');
    expect(html).toContain('提供元の時計=16:42');
  });

  it('★提供元が凍結していたら赤(見逃すと2営業日止まる)', () => {
    const html = renderPriceDot(OK, { state: 'frozen', reason: '★提供元の時計が凍結(clock=08:19 のまま8h00m)' }, NOW);
    expect(html).toContain('🔴');
    expect(html).toContain('08:19');
  });

  it('★立会中に NIY=F が来ていない(損害の本体)も赤', () => {
    const html = renderPriceDot(OK, { state: 'stalled', reason: '★立会中なのに NIY=F が4m00sきていない' }, NOW);
    expect(html).toContain('🔴');
    expect(html).toContain('NIY=F');
  });

  it('清算中・取引時間外は緑のまま(週末や夜間を警告色にしない)', () => {
    expect(renderPriceDot(OK, { state: 'settled', reason: '全銘柄が清算/停止' }, NOW)).toContain('🟢');
    expect(renderPriceDot(OK, { state: 'offhours', reason: '取引時間外' }, NOW)).toContain('🟢');
  });

  it('★取得失敗は黄(サーバと同じ結論。「提供元の更新が停止」とは言わない)', () => {
    const html = renderPriceDot({ fallback: true, skipUntil: NOW + 30_000 }, { state: 'down', reason: '取得失敗(両ホストが応答しない)' }, NOW);
    expect(html).toContain('🟡');
    expect(html).toContain('取得失敗');
    expect(html).not.toContain('提供元の時計が凍結');
  });

  it('priceFeed を返さない旧 monitor では従来の判定だけで動く(表示を壊さない)', () => {
    expect(renderPriceDot(OK, undefined, NOW)).toContain('🟢');
    expect(renderPriceDot({ fallback: true, skipUntil: NOW + 30_000 }, undefined, NOW)).toContain('🟡');
  });
});
