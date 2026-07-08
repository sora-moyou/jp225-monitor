import { describe, it, expect } from 'vitest';
import { buildNiyStaleCard } from './priceGrid.js';

// buildNiyStaleCard は DOM 非依存の純関数。NIY=F(実弾銘柄)が stale のとき、
// 市場閉場(取引時間外=正常)と取引時間中のフィード障害(取得不能)を出し分けることを検証する。

describe('buildNiyStaleCard — 取引時間外 vs 取得不能の出し分け', () => {
  it('市場閉場(marketOpen=false)は「取引時間外」(中立・非 down・数字なし)', () => {
    const { classes, html } = buildNiyStaleCard('日経225先物', false);
    expect(html).toContain('取引時間外');
    expect(html).not.toContain('取得不能');
    expect(html).not.toContain('停止');
    expect(classes).toContain('offhours');
    expect(classes).toContain('stale');
    // 取引時間外は障害ではないので警告色(down)を付けない。
    expect(classes).not.toContain('down');
    expect(classes).not.toContain('unavailable');
  });

  it('取引時間中の stale(marketOpen=true)は従来どおり「取得不能 / 停止」(down)', () => {
    const { classes, html } = buildNiyStaleCard('日経225先物', true);
    expect(html).toContain('取得不能');
    expect(html).toContain('停止');
    expect(html).not.toContain('取引時間外');
    expect(classes).toContain('unavailable');
    expect(classes).toContain('down');
    expect(classes).toContain('stale');
    expect(classes).not.toContain('offhours');
  });
});
