import type { Request, Response } from 'express';

// スクリーンショット専用のチャートページ(SSE 非依存)。
// 監視ボード(web/components/chart.ts)と同じ TradingView 埋め込みウィジェットを全画面で描画し、
// ヘッドレス Chrome がこの URL を撮影する。=> AI に渡る画像は「ボードでユーザーが見ている TradingView チャート」そのもの。
// チャート準備完了(onChartReady)で document.title='chart-ready' / data-ready を立て、
// --virtual-time-budget と合わせて「描き切ってから撮る」安全網にする。localhost 診断用途・秘匿情報なし。
// tv.js の読込失敗など全ての失敗経路でもページはハングせず、撮影側のタイムアウトで有界。

const VIEW_W = 1280;
const VIEW_H = 760;

// ボード(web/components/chart.ts)の new TradingView.widget({...}) 設定を複製する。
// 撮影用途なのでツールバー等は非表示・非インタラクティブに寄せるが、
// 銘柄/足/スタジオ/テーマ/timezone/locale はボードと一致させる(AI が見る絵をボードと揃える)。
const TV_SCRIPT_URL = 'https://s3.tradingview.com/tv.js';
const CHART_SYMBOL = 'FOREXCOM:JP225';   // FOREXCOM Japan 225 CFD(ボードと同一)
const CHART_INTERVAL = '5';              // 5分足(ボードと同一)
const CHART_STUDIES = ['MovingAvgRibbon@tv-basicstudies'];   // MA Ribbon(ボードと同一)

/** ボードの TradingView ウィジェットを全画面で描く自己完結 HTML を生成する(純粋・テスト可能)。 */
export function renderChartShotHtml(): string {
  // ウィジェット設定(ボードと一致)。撮影用に非インタラクティブ寄せ(hide_top_toolbar 等)。
  const widgetConfig = {
    autosize: true,
    symbol: CHART_SYMBOL,
    interval: CHART_INTERVAL,
    timezone: 'Asia/Tokyo',
    theme: 'dark',
    style: '1',
    locale: 'ja',
    enable_publishing: false,
    hide_top_toolbar: true,       // 撮影なのでツールバー非表示
    hide_side_toolbar: true,      // 描画ツール非表示
    hide_legend: false,
    hide_volume: true,            // 出来高ペイン非表示(ボードと同一)
    save_image: false,
    container_id: 'tradingview-shot',
    allow_symbol_change: false,   // 撮影なので銘柄変更不可
    withdateranges: false,
    studies: CHART_STUDIES,       // MA Ribbon(ボードと同一)
    disabled_features: ['create_volume_indicator_by_default', 'header_widget', 'left_toolbar'],
  };
  // JSON はスクリプト終了タグ注入を避けるため </ をエスケープ(破損対策)。localhost だが二重の安全網。
  const cfgJson = JSON.stringify(widgetConfig).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>chart-loading</title>
<style>
  html, body { margin: 0; padding: 0; background: #0b0e14; overflow: hidden; }
  #tradingview-shot { width: ${VIEW_W}px; height: ${VIEW_H}px; }
</style>
</head>
<body>
<div id="tradingview-shot"></div>
<script id="tv-config" type="application/json">${cfgJson}</script>
<script src="${TV_SCRIPT_URL}"></script>
<script>
(function () {
  function ready() {
    if (document.title === 'chart-ready') return;
    document.title = 'chart-ready';
    document.body.setAttribute('data-ready', '1');
    window.__chartReady = true;
  }
  var cfg;
  try { cfg = JSON.parse(document.getElementById('tv-config').textContent); }
  catch (e) { cfg = { symbol: '${CHART_SYMBOL}', interval: '${CHART_INTERVAL}', container_id: 'tradingview-shot' }; }

  // 保険: onChartReady が来なくても撮影がハングしないよう、一定時間で settle させる。
  // --virtual-time-budget(~14s)より短く置き、通常はウィジェットの onChartReady が先に立つ。
  var settleTimer = setTimeout(ready, 12000);

  function boot() {
    if (!window.TradingView || !window.TradingView.widget) {
      // tv.js が読めない(オフライン/ブロック)。ページを解決させて撮影側のタイムアウトで有界に。
      clearTimeout(settleTimer); ready(); return;
    }
    try {
      var widget = new window.TradingView.widget(cfg);
      // tv.js ウィジェットは onChartReady(cb) を公開する版が多い。あれば実 ready で立てる。
      if (widget && typeof widget.onChartReady === 'function') {
        widget.onChartReady(function () { clearTimeout(settleTimer); ready(); });
      }
      // onChartReady 非対応版でも settleTimer で確実に ready になる。
    } catch (e) {
      clearTimeout(settleTimer); ready();
    }
  }

  // tv.js は同期 <script> なので通常この時点で TradingView は存在するが、
  // 念のため読込完了(load)後にブートする。
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
</script>
</body>
</html>`;
}

/** GET /chart-shot — ボードの TradingView ウィジェットを全画面描画したページを返す。localhost 診断用途。 */
export function chartShotHandler(_req: Request, res: Response): void {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderChartShotHtml());
  } catch (err) {
    // 失敗しても最低限の HTML(readiness マーカー付き)を返し、撮影側がタイムアウトせず null 判定できるようにする。
    const msg = err instanceof Error ? err.message : String(err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><title>chart-ready</title></head>`
      + `<body data-ready="1" style="background:#0b0e14;color:#889"><pre>chart unavailable: ${msg.slice(0, 200)}</pre></body></html>`);
  }
}
