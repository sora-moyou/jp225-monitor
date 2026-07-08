import { describe, it, expect } from 'vitest';
import { renderChartShotHtml } from './chartShot.js';
import type { ChartSnapshot } from '../chart/chartData.js';

const baseSnap: ChartSnapshot = {
  symbol: 'NIY=F', symbolLabel: '日経225先物', asOf: 1_700_000_000_000, current: 40000,
  candles: [
    { t: 1, o: 39900, h: 40050, l: 39880, c: 40000 },
    { t: 2, o: 40000, h: 40120, l: 39990, c: 40100 },
  ],
  levels: [{ price: 40200, label: '直近高', side: 'up', tier: 2 }],
  markers: [{ t: 2, price: 40100, direction: 'down', kind: 'crash', text: 'crash' }],
  barCount: 2,
  range: { from: 1, to: 2 },
};

describe('renderChartShotHtml', () => {
  it('canvas コンテナと埋め込みデータ・readiness マーカーを含む', () => {
    const html = renderChartShotHtml(baseSnap);
    expect(html).toContain('<canvas id="c"');
    expect(html).toContain('id="chart-data"');
    expect(html).toContain('chart-ready');            // document.title / <title> の readiness
    expect(html).toContain('__chartReady');           // JS readiness マーカー
    expect(html).toContain('data-ready');
    // スナップショットのデータが埋め込まれている。
    expect(html).toContain('40000');
    expect(html).toContain('日経225先物');
  });

  it('埋め込み JSON はスクリプト終了タグ注入を防ぐため < をエスケープする', () => {
    const evil: ChartSnapshot = { ...baseSnap, symbolLabel: '</script><script>x' };
    const html = renderChartShotHtml(evil);
    // 生の </script> がデータ由来で入っていない(\\u003c にエスケープ)。
    expect(html).not.toContain('</script><script>x');
    expect(html).toContain('\\u003c/script');
  });

  it('空スナップでも描画スクリプトと readiness を返す(撮影がタイムアウトしない)', () => {
    const empty: ChartSnapshot = {
      symbol: 'NIY=F', symbolLabel: '', asOf: 0, current: 0,
      candles: [], levels: [], markers: [], barCount: 0, range: null,
    };
    const html = renderChartShotHtml(empty);
    expect(html).toContain('__chartReady');
    expect(html).toContain('<canvas');
  });
});
