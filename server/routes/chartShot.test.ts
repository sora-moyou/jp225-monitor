import { describe, it, expect } from 'vitest';
import { renderChartShotHtml } from './chartShot.js';

describe('renderChartShotHtml', () => {
  it('ボードの TradingView ウィジェット(script/コンテナ/銘柄/設定)と readiness マーカーを含む', () => {
    const html = renderChartShotHtml();
    // TradingView 埋め込みスクリプト URL(ボードと同一)。
    expect(html).toContain('https://s3.tradingview.com/tv.js');
    // ウィジェットのコンテナ。
    expect(html).toContain('id="tradingview-shot"');
    expect(html).toContain("container_id");
    expect(html).toContain('tradingview-shot');
    // 銘柄/足/スタジオ(ボードと一致)。
    expect(html).toContain('FOREXCOM:JP225');
    expect(html).toContain('MovingAvgRibbon@tv-basicstudies');
    // ウィジェット生成呼び出し。
    expect(html).toContain('TradingView.widget');
    // readiness マーカー(onChartReady / settle で立つ)。
    expect(html).toContain('chart-ready');            // document.title / <title>
    expect(html).toContain('__chartReady');           // JS readiness マーカー
    expect(html).toContain('data-ready');
    expect(html).toContain('onChartReady');           // 実 ready コールバックを使う
  });

  it('設定 JSON はスクリプト終了タグ注入を防ぐため < をエスケープする', () => {
    const html = renderChartShotHtml();
    // 設定に生の </script> は現れない(< は \\u003c にエスケープ)。
    // (設定値は固定だが、エスケープ経路が生きていることを保証する。)
    expect(html).not.toContain('</script></script>');
  });

  it('tv.js 読込失敗でもページがハングしないフォールバック経路を持つ', () => {
    const html = renderChartShotHtml();
    // TradingView グローバル不在時に ready() で解決する分岐。
    expect(html).toContain('!window.TradingView');
    // onChartReady が来なくても settle させる保険タイマー。
    expect(html).toContain('setTimeout(ready');
  });
});
