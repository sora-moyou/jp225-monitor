import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installLogCapture, setLogFile } from './logBuffer.js';
import { resolveAppDataDir } from './appDataDir.js';
// バンドルした依存(express/rss-parser/https-proxy-agent 等)が出す非推奨警告(DEP0169 url.parse 等)を抑制。
// 自前コードは url.parse 不使用。deprecation 種別のみ抑え、他の警告は残す。
process.noDeprecation = true;
installLogCapture();   // 最初に install してすべての console を捕捉
// ★サーバログをファイルへ永続化(書き出しに同梱=post-mortem用)。DB と同じ %APPDATA%/jp225-monitor 配下。
setLogFile(join(resolveAppDataDir(), 'server.log'));

import { streamHandler } from './routes/stream.js';
import { startHeartbeat, stopHeartbeat } from './sse/broker.js';
import { explainHandler } from './routes/explain.js';
import { chatHandler } from './routes/chat.js';
import { scalpPlanHandler, generatorSessionGate } from './routes/scalpPlan.js';
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
import { basedataImportHandler, basedataStatusHandler, basedataPublishHandler, autoImportBasedataOnStart } from './routes/basedata.js';
import { mergeHandler } from './routes/merge.js';
import { exportHandler } from './routes/export.js';
import { replaceHandler } from './routes/replace.js';
import { signalTradesHandler, signalTradesClearHandler } from './routes/signalTrades.js';
import { currentSignalHandler } from './routes/currentSignal.js';
import { exitStopHandler } from './routes/exitStop.js';
import { startSignalEngine } from './signalTrade/engine.js';
import { loadExitImpl } from './signalTrade/exit/index.js';
import { warmExitConfigHash, markFallbackExitConfigVersion } from './signalTrade/exitConfigVersion.js';
import { startPriceLoop } from './loops/priceLoop.js';
import { startNewsLoop } from './loops/newsLoop.js';
import { startCorrelationLoop } from './loops/correlationLoop.js';
import { startAlertLoop } from './loops/alertLoop.js';
import { startLevelsLoop } from './loops/levelsLoop.js';
import { startIndicatorsLoop } from './loops/indicatorsLoop.js';
import { startForecastLoop } from './loops/forecastLoop.js';
import { startAlertHistoryLoop } from './alertHistory.js';
import { warmFromDb } from './warmup.js';
import { isLLMEnabled } from './llm/openai.js';
import { resolvePort, ensureDefaults, resolveCooldownMin } from './configStore.js';
import { setCooldownMs } from './alertCooldown.js';
import { resolveVariant } from './variant.js';
import { startBasedataAutoScheduler } from './basedata/autoPublish.js';
import { normalizeCorsPath } from './corsPolicy.js';
import { startGeneratorHeartbeat, stopGeneratorHeartbeat } from './db/generatorHeartbeat.js';
import { startCollectorWatch, stopCollectorWatch } from './collectorWatch.js';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath } from './db/store.js';

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
//
// ★例外: /api/exit-stop。ここは「秘密のパラメータを引ける経路」なので * は成立しない
//   (ブラウザで任意の頁を開いているだけで、その頁の JS がループバックへ POST して応答を読める。
//    実測 121 リクエストで段構造を完全復元)。この経路だけ CORS を **付けない** =
//   ブラウザは応答を読めない。加えてハンドラ側が Origin/Referer 付き要求を 403 で拒否する
//   (trade2 は Node fetch = これらを送らないので従来どおり引ける)。
//
// ★照合はパスを **正規化してから**(直した欠陥)。express は既定で caseSensitive=false / strict=false
//   なので `/API/exit-stop` も `/api/exit-stop/` も同じハンドラへ届く。完全一致で照合していたため
//   実測では例外をすり抜けて ACAO:* が付いていた:
//     POST /api/exit-stop  → ACAO=(none) / POST /API/exit-stop → ACAO=* / POST /api/exit-stop/ → ACAO=*
//   ハンドラ側の access gate(Origin/Referer/Sec-Fetch-Site → 403)が効くのでオラクルにはならないが、
//   多層防御の1層が効いていない状態だった。照合はルーティングと同じ規約(小文字化+末尾スラッシュ除去)にする。
const NO_CORS_PATHS: ReadonlySet<string> = new Set(['/api/exit-stop']);
app.use((req, res, next) => {
  if (NO_CORS_PATHS.has(normalizeCorsPath(req.path))) {
    // preflight にも成功を返さない(ブラウザからは到達不能にする)。
    if (req.method === 'OPTIONS') {
      res.sendStatus(403);
      return;
    }
    next();
    return;
  }
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
// ★generatorSessionGate は **ハンドラより前**: 場外(取引セッション外)の分析用要求を、
//   チャート撮影(Chrome 起動)にも LLM にも予算計上にも到達させずに 429 で弾く。
//   caller 省略/'default'(実取引につながる既存の呼び出し元)は素通しする=挙動不変。
app.post('/api/scalp-plan', generatorSessionGate, scalpPlanHandler);
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
app.post('/api/basedata/publish', basedataPublishHandler);
app.post('/api/merge', mergeHandler);
app.post('/api/export', exportHandler);
app.post('/api/replace', replaceHandler);
app.get('/api/signal-trades', signalTradesHandler);
app.post('/api/signal-trades/clear', signalTradesClearHandler);
app.get('/api/current-signal', currentSignalHandler);
// 決済逆指値の権威(trade2 の孤児建玉保護)。状態を受けて価格だけを返す=決済パラメータは通信路に出さない。
// ★variant ゲートしない: /api/current-signal・/api/version と同じ「trade2 追従の面」であり、
//   lite で塞ぐと lite に繋いだ trade2 の孤児保護だけが無音で劣化する(本件で潰そうとしている壊れ方そのもの)。
app.post('/api/exit-stop', exitStopHandler);
// スクショ専用の軽量チャートページ(scalp-plan のビジョン入力用・localhost 診断)。SSE 非依存。
app.get('/chart-shot', chartShotHandler);
app.get('/api/health', (_req, res) => res.json({ ok: true, llm: isLLMEnabled(), version: APP_VERSION }));
// name は製品名(variant 由来): full=JP225 Monitor2 / lite=JP225 Monitor。trade2 が接続先を書き出しで判別できるように。
app.get('/api/version', (_req, res) => {
  const variant = resolveVariant();
  res.json({ version: APP_VERSION, name: variant === 'full' ? 'JP225 Monitor2' : 'JP225 Monitor', variant });
});

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
  startIndicatorsLoop();   // テクニカル指標(RSI/SMA/BB)の SSE 配信(表示/AI文脈専用)
  startForecastLoop();
  // ★決済逆指値の権威(POST /api/exit-stop)は **エンジンの有無と無関係** に成立させる。
  //   従来は loadExitImpl() が startSignalEngine() の中にしか無く、SIGNAL_TRADE=0 では一度も走らず、
  //   ルートだけが生きて公開フォールバック(初期LC固定=劣化)を 200 で返していた(呼び出し側に判別不能)。
  //   冪等なのでエンジン側の呼び出しと二重にはならない。ロード完了までの窓はハンドラが 503 で塞ぐ。
  void loadExitImpl().then(kind => {
    console.log(`[server] exit impl = ${kind}`);
    // ★指紋を焼くのは「実装が確定したこの瞬間」だけ(RECORD-ONLY)。
    //   engine.start() も warm を呼ぶが、そちらは待たずに 'simple' を受け取る位置にあり、
    //   確定前は焼かない(exitConfigVersion.ts)。ここが唯一の確定点。
    warmExitConfigHash();
    // ★過去に確定前の指紋で採番されてしまった版に印をつける(追記のみ・過去の行は書き換えない)。
    auditExitConfigLedger();
  });
  void startSignalEngine();   // トレードシグナル紙エンジン(非公開 exit をロードして有効化)
  startHeartbeat();      // SSE ハートビート(取引時間外でも接続に一定トラフィックを流す)
  // ★分析用の状態(有効か/生きているか/標本/従属停止)を共有DBの meta に定期記録する。
  //   別PCの書き出しから「無効なのか・止まったのか・起動していないのか」を判別するため
  //   (ティック保管・台帳書き出しと同じ meta 経由=trade2 の30分スナップショットに乗る)。
  //   分析用なので lite では起動しない(モジュール側でゲート)。記録専用=取引挙動に関与しない。
  startGeneratorHeartbeat();
  // ★収集デーモン(collector)の死活を **生きている側(monitor)が** 判定して記録する。
  //   collector はデタッチ起動で、死んでも次にアプリを起動するまで誰も再起動しない。実運用で
  //   心拍が10:13:44 に凍結したのに画面にも書き出しにも何も出ず、誰も気づかなかった。
  //   状態を collector 自身に書かせると死んだ瞬間に状態も凍る(誤診断の原因)ので、ここで書く。
  //   ★lite でもゲートしない: 収集デーモンは lite でも走り、止まれば同じ被害が出る。
  //   ★記録専用=取引挙動には一切関与しない。
  startCollectorWatch();
  // ★基礎データ自動公開スケジューラは monitor2(full)専用。lite では絶対に起動しない(ハードゲート)。
  if (resolveVariant() === 'full') startBasedataAutoScheduler();

  // ★基礎データ自動取り込み(consume)は両 variant 共通・variant ゲートしない。
  // 公開版が新しければ起動直後に一度だけ取り込む。fire-and-forget・非ブロッキング・throw しない。
  // ルートが温まるよう少し遅延。上の自動公開(full 専用)とは別物。
  setTimeout(() => { void autoImportBasedataOnStart(); }, 3000);

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

/** ★決済設定の版台帳の自己点検(RECORD-ONLY・追記のみ・取引には一切関与しない)。
 *  実装が確定する前に採番されてしまった「公開フォールバックの指紋」の版に印を残す。
 *  過去の行(hash/version/first_seen)も、既に取引へ刻まれた版番号も **書き換えない**
 *  (追記のみの設計)。印は別表 exit_config_version_notes に1行入るだけ。
 *  失敗は握りつぶす(記録専用なので起動を止めない)。 */
function auditExitConfigLedger(): void {
  let db: DatabaseSync | null = null;
  try {
    db = openDb(resolveDbPath());
    const note = markFallbackExitConfigVersion(db, Date.now());
    if (note) {
      console.warn(`[exit-config] ★版 ${note.version} は公開フォールバックの指紋(${note.hash})です。`
        + '非公開実装が有効なこのプロセスで採番されている=実装が確定する前に記録された誤りなので、'
        + '台帳に印を付けました(exit_config_version_notes)。この版が刻まれた取引/runs は集計から外してください。');
    }
  } catch (e) {
    console.warn('[exit-config] 版台帳の自己点検に失敗:', e instanceof Error ? e.message : String(e));
  } finally {
    try { db?.close(); } catch { /* close 失敗は無視 */ }
  }
}

// 終了時にハートビート interval を止めてプロセスが即座に落ちられるようにする。
function shutdown(): void {
  stopHeartbeat();
  stopGeneratorHeartbeat();
  stopCollectorWatch();
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
