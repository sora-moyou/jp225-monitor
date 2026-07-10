import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installLogCapture } from './logBuffer.js';
// バンドルした依存(express/rss-parser/https-proxy-agent 等)が出す非推奨警告(DEP0169 url.parse 等)を抑制。
// 自前コードは url.parse 不使用。deprecation 種別のみ抑え、他の警告は残す。
process.noDeprecation = true;
installLogCapture();   // 最初に install してすべての console を捕捉

import { streamHandler } from './routes/stream.js';
import { startHeartbeat, stopHeartbeat } from './sse/broker.js';
import { explainHandler } from './routes/explain.js';
import { chatHandler } from './routes/chat.js';
import { scalpPlanHandler } from './routes/scalpPlan.js';
import { chartShotHandler } from './routes/chartShot.js';
import { captureChartPng } from './chart/chartShot.js';
import { getSettingsHandler, postSettingsHandler, testSettingsHandler } from './routes/settings.js';
import { statusHandler } from './routes/status.js';
import { logsHandler } from './routes/logs.js';
import { translateHandler } from './routes/translate.js';
import { correlationHandler } from './routes/correlation.js';
import { forecastHandler } from './routes/forecast.js';
import { alertsHistoryHandler } from './routes/alerts.js';
import { levelsHandler } from './routes/levels.js';
import { basedataImportHandler, basedataStatusHandler } from './routes/basedata.js';
import { mergeHandler } from './routes/merge.js';
import { exportHandler } from './routes/export.js';
import { replaceHandler } from './routes/replace.js';
import { startPriceLoop } from './loops/priceLoop.js';
import { startNewsLoop } from './loops/newsLoop.js';
import { startCorrelationLoop } from './loops/correlationLoop.js';
import { startAlertLoop } from './loops/alertLoop.js';
import { startLevelsLoop } from './loops/levelsLoop.js';
import { startForecastLoop } from './loops/forecastLoop.js';
import { startAlertHistoryLoop } from './alertHistory.js';
import { warmFromDb } from './warmup.js';
import { isLLMEnabled } from './llm/openai.js';
import { resolvePort, ensureDefaults, resolveCooldownMin } from './configStore.js';
import { setCooldownMs } from './alertCooldown.js';

ensureDefaults();   // 起動時に polling 設定の default を config.json に書き込む
setCooldownMs(resolveCooldownMin() * 60_000);   // 設定のクールダウン(分)を反映

declare const __APP_VERSION__: string | undefined;

const PORT = resolvePort();

const APP_VERSION: string = (typeof __APP_VERSION__ === 'string')
  ? __APP_VERSION__
  : (() => {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
      return pkg.version;
    })();

console.log(`[server] JP225 Monitor v${APP_VERSION}`);

const app = express();

// CORS: Tauri 配布版では Webview origin (tauri://localhost or http://tauri.localhost)
// が sidecar (localhost:3000) と異なるため、明示的に許可する。
// サイドカーは localhost 専用 (loopback only) を想定しているので * で安全。
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: '256kb' }));
app.get('/api/stream', streamHandler);
app.post('/api/explain', explainHandler);
app.post('/api/chat', chatHandler);
app.post('/api/scalp-plan', scalpPlanHandler);
app.get('/api/settings', getSettingsHandler);
app.post('/api/settings/keys', postSettingsHandler);
app.get('/api/settings/test', testSettingsHandler);
app.get('/api/status', statusHandler);
app.get('/api/logs', logsHandler);
app.post('/api/translate', translateHandler);
app.get('/api/correlation', correlationHandler);
app.get('/api/forecast', forecastHandler);
app.get('/api/alerts/history', alertsHistoryHandler);
app.get('/api/levels', levelsHandler);
app.get('/api/basedata/status', basedataStatusHandler);
app.post('/api/basedata/import', basedataImportHandler);
app.post('/api/merge', mergeHandler);
app.post('/api/export', exportHandler);
app.post('/api/replace', replaceHandler);
// スクショ専用の軽量チャートページ(scalp-plan のビジョン入力用・localhost 診断)。SSE 非依存。
app.get('/chart-shot', chartShotHandler);
app.get('/api/health', (_req, res) => res.json({ ok: true, llm: isLLMEnabled(), version: APP_VERSION }));
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION, name: 'JP225 Monitor' }));

const isPkg = (process as unknown as { pkg?: unknown }).pkg !== undefined;
const distWeb = isPkg
  ? join(dirname(process.execPath), 'web')
  : join(process.cwd(), 'dist', 'web');
if (existsSync(distWeb)) {
  app.use(express.static(distWeb));
  console.log(`[server] serving static frontend from ${distWeb}`);
}

// 127.0.0.1(ループバック)限定で待ち受ける。0.0.0.0 だと Windows ファイアウォールが
// 「Node.js JavaScript Runtime のアクセスを許可しますか?」を出し、ユーザーが拒否すると詰まる。
// このアプリは Webview→サイドカーの localhost 通信だけなのでループバック限定が正しく、プロンプトも出ない。
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] listening on http://127.0.0.1:${PORT} (LLM ${isLLMEnabled() ? 'enabled' : 'disabled'})`);
  warmFromDb();          // v0.3.37: 収集デーモンの DB から即ウォームアップ (現在進行中なら)
  startPriceLoop();      // v0.7.20: 価格は priceLoop 内で公開 HTTP(ajax_cme/ajax_fx)を直接ポール(socket 廃止)
  startNewsLoop();
  startCorrelationLoop();
  startAlertLoop();
  startAlertHistoryLoop();
  startLevelsLoop();
  startForecastLoop();
  startHeartbeat();      // SSE ハートビート(取引時間外でも接続に一定トラフィックを流す)

  // 起動時に一度だけチャットショット(~/Desktop/jp225-chart-shot.png)を撮って確認用画像を更新する。
  // 撮影パイプライン(Chrome ヘッドレス→/chart-shot)が起動直後に動く証拠にもなる。ベストエフォート:
  // Chrome 不在・取引時間外の空チャート等はすべて許容(撮れた分を保存 or 失敗理由をログするだけ)。
  // 起動を絶対にブロック/throw しない(try/catch で握りつぶす)。ルートが温まるよう少し遅延させる。
  // 実撮影は /api/scalp-plan のリクエスト時にオンデマンドで行う(常時バックグラウンドループは持たない)。
  setTimeout(() => {
    void (async () => {
      try {
        const r = await captureChartPng(PORT);
        if (r.buffer) console.log('[startup] chart-shot saved (~/Desktop/jp225-chart-shot.png)');
        else console.warn(`[startup] chart-shot skipped: ${r.reason ?? 'unknown'}`);
      } catch (e) {
        console.warn('[startup] chart-shot error:', e instanceof Error ? e.message : String(e));
      }
    })();
  }, 1500);
});

// 終了時にハートビート interval を止めてプロセスが即座に落ちられるようにする。
function shutdown(): void {
  stopHeartbeat();
  server.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port ${PORT} already in use — another jp225-monitor is running. Exiting.`);
    process.exit(0);
  }
  console.error('[server] fatal listen error:', err);
  process.exit(1);
});
