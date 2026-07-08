import type { Request, Response } from 'express';
import { openDb, resolveDbPath } from '../db/store.js';
import { buildChartSnapshot, type ChartSnapshot } from '../chart/chartData.js';

// スクリーンショット専用の軽量チャートページ(SSE 非依存)。
// 当日セッションのローソク足 + 主要水準 + 直近アラートマーカーを、外部依存なしの inline canvas で描く。
// ヘッドレス Chrome がこの URL を撮影する。描画完了で document.title='chart-ready' を立て、
// --virtual-time-budget と合わせて「描き切ってから撮る」安全網にする。localhost 診断用途・秘匿情報なし。

const VIEW_W = 1280;
const VIEW_H = 760;

/** スナップショット JSON を埋め込んだ自己完結 HTML を生成する(純粋・テスト可能)。 */
export function renderChartShotHtml(snap: ChartSnapshot): string {
  // JSON はスクリプト終了タグ注入を避けるため </ をエスケープ(XSS/破損対策)。localhost だが二重の安全網。
  const dataJson = JSON.stringify(snap).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>chart-loading</title>
<style>
  html, body { margin: 0; padding: 0; background: #0b0e14; overflow: hidden; }
  #wrap { width: ${VIEW_W}px; height: ${VIEW_H}px; position: relative; }
  canvas { display: block; }
  #hdr { position: absolute; left: 14px; top: 10px; color: #c8d0dc;
    font: 600 15px/1.3 "Segoe UI", system-ui, sans-serif; }
  #hdr .sub { color: #7f8b9c; font-weight: 400; font-size: 12px; }
</style>
</head>
<body>
<div id="wrap">
  <canvas id="c" width="${VIEW_W}" height="${VIEW_H}"></canvas>
  <div id="hdr"></div>
</div>
<script id="chart-data" type="application/json">${dataJson}</script>
<script>
(function () {
  var W = ${VIEW_W}, H = ${VIEW_H};
  var snap;
  try { snap = JSON.parse(document.getElementById('chart-data').textContent); }
  catch (e) { snap = { candles: [], levels: [], markers: [], current: 0, symbolLabel: '' }; }

  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');
  var PAD_L = 8, PAD_R = 78, PAD_T = 46, PAD_B = 22;
  var plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;

  function ready() { document.title = 'chart-ready'; document.body.setAttribute('data-ready', '1'); window.__chartReady = true; }

  var candles = snap.candles || [];
  var levels = snap.levels || [];
  var markers = snap.markers || [];

  // 価格レンジ(足 + 水準 + 現値 から)。
  var lo = Infinity, hi = -Infinity;
  candles.forEach(function (b) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; });
  levels.forEach(function (l) { if (l.price < lo) lo = l.price; if (l.price > hi) hi = l.price; });
  if (snap.current > 0) { if (snap.current < lo) lo = snap.current; if (snap.current > hi) hi = snap.current; }
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { lo = (snap.current || 0) - 100; hi = (snap.current || 0) + 100; }
  var padY = (hi - lo) * 0.06 || 1; lo -= padY; hi += padY;

  function yOf(p) { return PAD_T + (hi - p) / (hi - lo) * plotH; }
  var n = candles.length;
  function xOf(i) { return n <= 1 ? PAD_L + plotW / 2 : PAD_L + (i / (n - 1)) * plotW; }

  // 背景
  ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, W, H);

  // 横グリッド + 右軸ラベル
  ctx.strokeStyle = '#1b2130'; ctx.fillStyle = '#5f6b7c';
  ctx.font = '11px "Segoe UI", system-ui, sans-serif'; ctx.textBaseline = 'middle';
  var ticks = 6;
  for (var g = 0; g <= ticks; g++) {
    var p = lo + (hi - lo) * (g / ticks); var y = yOf(p);
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
    ctx.fillText(Math.round(p).toLocaleString('ja-JP'), PAD_L + plotW + 6, y);
  }

  // 水準線(tier で色/強調)。上=緑寄り抵抗、下=赤寄り支持。
  levels.forEach(function (l) {
    var y = yOf(l.price);
    var strong = l.tier >= 2;
    ctx.strokeStyle = l.side === 'up' ? (strong ? '#3fb56a' : '#2c6e46') : (strong ? '#d15b5b' : '#8a3b3b');
    ctx.lineWidth = strong ? 1.5 : 1; ctx.setLineDash(strong ? [] : [4, 3]);
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = l.side === 'up' ? '#7fd6a0' : '#e79a9a';
    ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.textBaseline = 'bottom';
    ctx.fillText(String(l.label).slice(0, 14), PAD_L + 4, y - 1);
    ctx.textBaseline = 'middle';
  });

  // ローソク足
  var cw = n > 0 ? Math.max(1, Math.min(9, plotW / n * 0.7)) : 3;
  for (var i = 0; i < n; i++) {
    var b = candles[i]; var x = xOf(i);
    var up = b.c >= b.o;
    ctx.strokeStyle = up ? '#26a69a' : '#ef5350'; ctx.fillStyle = up ? '#26a69a' : '#ef5350';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yOf(b.h)); ctx.lineTo(x, yOf(b.l)); ctx.stroke();
    var yO = yOf(b.o), yC = yOf(b.c);
    var top = Math.min(yO, yC), bh = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(x - cw / 2, top, cw, bh);
  }

  // 現値ライン
  if (snap.current > 0) {
    var yc = yOf(snap.current);
    ctx.strokeStyle = '#e8b23a'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(PAD_L, yc); ctx.lineTo(PAD_L + plotW, yc); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e8b23a'; ctx.fillRect(PAD_L + plotW, yc - 8, PAD_R, 16);
    ctx.fillStyle = '#0b0e14'; ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(Math.round(snap.current).toLocaleString('ja-JP'), PAD_L + plotW + 5, yc);
  }

  // アラートマーカー(時刻→最寄り足のx、価格→y)。上向き=▲下、下向き=▼上。
  function xForTime(t) {
    if (n === 0) return PAD_L + plotW;
    var best = 0, bd = Infinity;
    for (var i = 0; i < n; i++) { var d = Math.abs(candles[i].t - t); if (d < bd) { bd = d; best = i; } }
    return xOf(best);
  }
  markers.forEach(function (m) {
    var mx = xForTime(m.t);
    var my = m.price != null && m.price > 0 ? yOf(m.price) : PAD_T + 12;
    var down = m.direction === 'down';
    ctx.fillStyle = down ? '#ef5350' : (m.direction === 'up' ? '#26a69a' : '#c0a020');
    ctx.beginPath();
    if (down) { ctx.moveTo(mx, my - 9); ctx.lineTo(mx - 5, my - 18); ctx.lineTo(mx + 5, my - 18); }
    else { ctx.moveTo(mx, my + 9); ctx.lineTo(mx - 5, my + 18); ctx.lineTo(mx + 5, my + 18); }
    ctx.closePath(); ctx.fill();
  });

  // ヘッダ
  var hdr = document.getElementById('hdr');
  var d = new Date(snap.asOf || Date.now());
  var when = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  hdr.innerHTML = (snap.symbolLabel || '') + ' ' +
    (snap.current > 0 ? Math.round(snap.current).toLocaleString('ja-JP') : '') +
    '<div class="sub">' + snap.barCount + '本 / 水準' + levels.length + ' / アラート' + markers.length + ' — ' + when + ' JST</div>';

  // 描画完了マーカー(次フレームで確実に反映してから立てる)。
  requestAnimationFrame(function () { requestAnimationFrame(ready); });
})();
</script>
</body>
</html>`;
}

/** GET /chart-shot — スクショ用の自己完結チャートページを返す。localhost 診断用途。 */
export function chartShotHandler(_req: Request, res: Response): void {
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    const snap = buildChartSnapshot(db);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderChartShotHtml(snap));
  } catch (err) {
    // 失敗しても最低限の HTML(readiness マーカー付き)を返し、撮影側がタイムアウトせず null 判定できるようにする。
    const msg = err instanceof Error ? err.message : String(err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><title>chart-ready</title></head>`
      + `<body data-ready="1" style="background:#0b0e14;color:#889"><pre>chart unavailable: ${msg.slice(0, 200)}</pre></body></html>`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
