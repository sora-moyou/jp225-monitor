// ★1行目: これより後の import が評価される前にファイルログを開く。
//   末尾で installProcessFileLog() を呼ぶ形だと **import の途中で落ちた場合に1バイトも残らない**
//   (SEA バイナリで起きうる代表的な失敗形)。落ちてから書くのでは間に合わない。
import './logInstall.js';

// 日経225 データ収集デーモン v0.5.00。公開 HTTP フィード(ajax_cme/ajax_fx)を 2秒ごとに DB へ。
// v0.5.00: デーモン単独でアラート検知→DB記録(単一ライター・ハートビート調停)。アプリ閉でも24/7記録。
// v0.7.20: 価格源を公開 HTTP のみに統一(socket / Yahoo backfill を全廃)。
import { openDb, resolveDbPath, pruneTicks } from '../server/db/store.js';
// ★ティック長期保管(将来の分析用・RECORD-ONLY)。共有DB(jp225.db)とは別ファイルに NIY=F だけを溜め、
//   自動削除は一切置かない。理由と設計は server/db/tickArchive.ts の冒頭コメント参照。
import {
  openTickArchiveDb, resolveTickArchiveDbPath, archiveTicks,
  resolveTickExportDir, runDailyTickExport,
} from '../server/db/tickArchive.js';
// ★保管の健全性を **共有DB(jp225.db)の meta** に書く。専用DBは trade2 の 30分スナップショット
//   (prices_<host>.db = jp225.db 全体の VACUUM INTO)に含まれないため、状態だけを共有DB側に置いて
//   既存の書き出し経路にそのまま乗せる。設計と理由は server/db/tickArchiveHeartbeat.ts の冒頭参照。
import {
  writeTickArchiveHeartbeat, formatTickArchiveStatus, TICK_ARCHIVE_HEARTBEAT_MS,
  type TickArchiveExportInfo, type TickArchiveErrorInfo,
} from '../server/db/tickArchiveHeartbeat.js';
// ★台帳(分析用/影)の同期フォルダへの書き出し。ティックの日次書き出しと同じ置き場所・同じ間隔で、
//   状態も同じ共有DB(jp225.db)の meta に残す。設計は server/db/ledgerExport.ts の冒頭参照。
import { runLedgerExport, writeLedgerExportStatus, formatLedgerExportStatus, writeLedgerExportStatusFile } from '../server/db/ledgerExport.js';
import { recordFeedPrices } from './record.js';
// v0.7.20(全銘柄 HTTP 化): 価格の主経路を monitor の priceLoop と同一にする。socket / Yahoo realtime を全廃し、
// 監視 4 銘柄すべてを公開 HTTP から取る: ajax_cme.js(NIY=F/YM=F/NQ=F)+ ajax_fx.js(JPY=X)。両者とも毎 GET
// 新スナップショット(long-lived セッション無し=ドリフト無し)。合成は priceLoop の純関数 mergeSources を再利用。
import { fetchAjaxCmePrices } from '../server/sources/ajaxCmePrice.js';
import { fetchAjaxFxPrices } from '../server/sources/ajaxFxPrice.js';
import { mergeSources } from '../server/loops/priceLoop.js';
import type { Price } from '../server/types.js';
import { inPollWindow } from '../core/session.js';
import { acquireLock, releaseLock } from './lock.js';
import { AlertCollector } from './alertCollector.js';
import { writeHeartbeat } from '../server/collectorHeartbeat.js';
import { setCooldownMs } from '../server/alertCooldown.js';
import { resolveCooldownMin } from '../server/configStore.js';
import { warmFromDb } from '../server/warmup.js';
// ★ティック長期保管は **分析専用**。公開版(lite)では一切開始しない(DBを作らない・書き出さない・
//   ハートビートも書かない)。判定は単一ゲート isAnalysisEnabled() に集約する。
//   variant は Rust が collector にも MONITOR_VARIANT で渡す(src-tauri/src/lib.rs)。
//   ★従来どおりの3日削除の短期ティック(共有DB)は **両 variant で維持** する。
import { isAnalysisEnabled } from '../server/analysisGate.js';
// ★死因の手がかりを残す。collector の出力は Rust のコンソール止まりで、異常終了は痕跡ゼロで消えていた
//   (実運用で 10:13:44 に停止したが、なぜ止まったかを示すものが1バイトも残っていなかった)。
//   ファイルログ(書き出しフォルダ / 無ければ %APPDATA%)に全出力を、起動と終了の節目だけを
//   Rust が spawn の成否を書いているのと **同じ** sidecar-spawn.log にも相乗りさせる。
import { recordProcessLogSignals } from '../server/processLog.js';
import { appendSpawnLog, shouldReportStreak } from '../server/spawnLog.js';

// バンドルした依存(express/rss-parser/https-proxy-agent 等)が出す非推奨警告(DEP0169 url.parse 等)を抑制。
// 自前コードは url.parse 不使用。これは deprecation 種別のみを抑え、他の警告は残す。
process.noDeprecation = true;

export const COLLECTOR_VERSION = '0.5.00';
const POLL_MS = 2000;
const IDLE_MS = 30_000;
/** 日次ティック書き出しの点検間隔。対象は1日1回しか増えないので1時間で十分。 */
const TICK_EXPORT_CHECK_MS = 60 * 60_000;

// 公開 HTTP(ajax_cme/ajax_fx)へのポライトネス: collector は 2s ポールだが、monitor の priceLoop も同じ
// エンドポイントを叩くため、collector 側の GET は ~4s に間引く(直近取得をキャッシュ)。
const AJAX_MIN_INTERVAL_MS = 4000;
let ajaxCache: Price[] = [];
let ajaxCacheAt = 0;

/** ~4s に間引いて ajax_cme(NIY=F/YM=F/NQ=F)+ ajax_fx(JPY=X)の全 fresh 価格を取得。前回取得が新しければ
 *  キャッシュを、その現在値として「新鮮な timestamp を付け直して」返す(recordFeedPrices が今この瞬間の
 *  tick として記録できるように)。取得不能は []。stale はここで既に落としてある(mergeSources)。 */
async function fetchAjaxThrottled(now: number): Promise<Price[]> {
  if (now - ajaxCacheAt >= AJAX_MIN_INTERVAL_MS) {
    const [cme, fx] = await Promise.all([fetchAjaxCmePrices(), fetchAjaxFxPrices()]);
    const fresh = mergeSources([cme, fx]);   // fresh(stale:false)のみ
    if (fresh.length) { ajaxCache = fresh; ajaxCacheAt = now; }
    return fresh;
  }
  // キャッシュ再利用: 直近取得値をこの瞬間の現在値として timestamp を更新して返す。
  return ajaxCache.map(p => ({ ...p, timestamp: now }));
}

async function main(): Promise<void> {
  if (!acquireLock()) { console.log('[collector] another instance is running — exiting'); return; }
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  // ★分析(=ティック長期保管)を走らせるかの唯一の判断。lite では archiveDb を **開かない**
  //   (=専用DBファイルを作らない)。以降の保管/書き出し/ハートビートは全て archiveDb の有無で分岐する。
  const analysis = isAnalysisEnabled();
  const archivePath = analysis ? resolveTickArchiveDbPath() : null;
  const archiveDb = archivePath !== null ? openTickArchiveDb(archivePath) : null;
  const tickExportDir = analysis ? resolveTickExportDir() : '';   // '' = 書き出し無効(既存の「未設定」と同じ表現)
  console.log(`[collector ${COLLECTOR_VERSION}] db=${dbPath}`);
  if (archivePath !== null) {
    console.log(`[collector] tick archive=${archivePath} (NIY=F only, no auto-prune)`);
    console.log(tickExportDir
      ? `[collector] tick daily export -> ${tickExportDir}`
      : '[collector] tick daily export DISABLED (no export dir configured — ticks still accumulate in the archive DB)');
  } else {
    // 無音にしない: 「保管していない」ことが起動ログから読めるようにする。
    console.log('[collector] tick archive DISABLED (lite/公開版 — 分析用の長期保管は走らせない)');
  }
  console.log(`[collector] started ${new Date().toISOString()} (node ${process.version})`);

  // v0.7.20(全銘柄 HTTP 化 / no-Yahoo): 起動時 Yahoo backfill を全廃した。全 4 銘柄(NIY=F/YM=F/NQ=F/JPY=X)の
  // bars_1m は公開 HTTP のリアルタイム tick 経路(recordFeedPrices)だけで積む。ウォームアップは収集 DB からの
  // warmFromDb で賄う(Yahoo の遅延足を混ぜない = 実取引安全 v0.7.9 を全銘柄へ徹底)。
  setCooldownMs(resolveCooldownMin() * 60_000);   // match the monitor's configured cooldown (before AlertCollector, which reads it)
  warmFromDb();                                    // freshness-gated seed of the feedBars realtime buffer (reused, tested)
  const alerts = new AlertCollector(db);
  console.log('[collector] alert detection armed');
  let lastFollowup = 0;

  let running = true;
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  let lastPrune = 0;
  let lastTickExport = 0;   // 0 = 起動直後に1回走らせる(取りこぼした過去日を拾う)
  /** ★poll が連続で失敗している回数。握りつぶして周回を続ける経路が **無音にならない** ようにする。 */
  let pollErrorStreak = 0;
  // ★ティック保管の健全性ハートビート用の状態。失敗と最終書き出しは「最後に分かっている事実」を
  //   持ち回り、ハートビートに毎回渡す(渡さない回は前回の値が meta 側で引き継がれる)。
  let lastTickHeartbeat = 0;   // 0 = 起動直後に1回書く(起動した瞬間から状態が見える)
  let lastTickExportInfo: TickArchiveExportInfo | null = null;
  let lastTickArchiveError: TickArchiveErrorInfo | null = null;
  let lastTickArchiveState = '';
  while (running) {
    const start = Date.now();
    let wait = IDLE_MS;
    writeHeartbeat(db, start);
    if (inPollWindow(start)) {
      try {
        // 価格の主経路(monitor priceLoop と同一): 全 4 銘柄を公開 HTTP から(~4s 間引き)。
        // fetchAjaxThrottled は既に fresh(stale:false)のみを返す(mergeSources 済み)。
        const prices = await fetchAjaxThrottled(start);
        recordFeedPrices(db, prices);
        // ★長期保管(別ファイル・NIY=F のみ)。共有DBへの記録とは独立=既存の記録経路は一切変えない。
        //   archiveDb===null(lite)なら丸ごとスキップ。
        if (archiveDb) {
          try { archiveTicks(archiveDb, prices); } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            lastTickArchiveError = { at: Date.now(), where: 'archive', message };
            console.error('[collector] tick archive error:', message);
          }
        }
        // Feed the realtime detector for the SAME set the monitor's priceLoop feeds: all fresh
        // (non-stale) prices, no session gate here. The sink stamps session metadata per alert;
        // the engine only fires for NIY=F. recordFeedPrices already handles DB persistence + its
        // own stale/session gating for tick storage.
        for (const p of prices) {
          if (p.stale) continue;
          alerts.onPrice(p.symbol, p.price, p.timestamp);
        }
        alerts.onMinute(Date.now());
        // level 検知は bar 検知と別周期(8秒・monitor の levelsLoop と同じ)。毎ポール(2秒)呼んでよく、
        // 8秒スロットの重複は onLevelTick 内で弾く。bar 検知/crash/followup/prune の周期は不変。
        alerts.onLevelTick(Date.now());
        // ★復帰も残す。「いつ壊れて・いつ戻ったか」が1ファイルで時系列に並ぶ。
        if (pollErrorStreak > 0) {
          const line = `[collector] poll が復帰しました(直前まで ${pollErrorStreak} 回連続で失敗)`;
          console.log(line);
          appendSpawnLog(line);
          pollErrorStreak = 0;
        }
      } catch (err) {
        // ★握って周回を続けるのは従来どおり(1回の失敗で収集を止めない)。変えたのは **無音をやめた** ことだけ。
        //   ここで失敗し続けると心拍だけが打たれ、プロセスは生きたまま1件も記録しない
        //   =「生きているが仕事をしていない」。心拍・pid・書き出しのどの網にもかからないので、
        //   続いている事実を共用ログ(sidecar-spawn.log)へ出す
        //   → monitor が meta(collector_watch.spawn)に載せ、既存の同期で別PCまで届く。
        pollErrorStreak += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[collector] poll error(連続 ${pollErrorStreak} 回):`, message);
        if (shouldReportStreak(pollErrorStreak)) {
          appendSpawnLog(`[collector] ★poll が ${pollErrorStreak} 回連続で失敗しています(プロセスは生存・記録は止まっています): ${message}`);
        }
      }
      wait = POLL_MS;
    }
    if (start - lastFollowup > 30_000) { try { alerts.followup(start); } catch { /* ignore */ } lastFollowup = start; }
    // 1分に1回、3日より古い tick を間引く (bars_1m は長期保持)
    // ★共有DB(jp225.db)側の保持方針は **一切変えない**: 4銘柄とも従来どおり3日で消す。
    //   長期保管は別ファイル(ticks_archive.db)の役目で、そちらには prune を置かない。
    //   共有DBを太らせると trade2 の 30分ごとの `VACUUM INTO`(実測 102MB で約1.3秒の同期ブロック)が
    //   重くなり、実取引のフィード/発注/約定検知を止めてしまう。
    if (Date.now() - lastPrune > 60_000) {
      pruneTicks(db, Date.now() - 3 * 24 * 60 * 60 * 1000);
      lastPrune = Date.now();
    }
    // ★確定済みの過去日を1日1ファイルで同期フォルダへ書き出す(append-only・冪等・既存ファイルは触らない)。
    //   1時間に1回で十分(1日1回しか対象が増えない)。失敗しても収集は止めない。
    if (archiveDb && tickExportDir && Date.now() - lastTickExport > TICK_EXPORT_CHECK_MS) {
      lastTickExport = Date.now();
      try {
        for (const r of runDailyTickExport(archiveDb, Date.now(), tickExportDir)) {
          if (r.skipped) continue;
          lastTickExportInfo = { at: Date.now(), sessionDate: r.sessionDate, file: r.file, rows: r.rows };
          console.log(`[collector] tick export ${r.file} rows=${r.rows} bytes=${r.bytes}`);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        lastTickArchiveError = { at: Date.now(), where: 'export', message };
        console.error('[collector] tick export error:', message);
      }
      // ★台帳(分析用・影)も同じ機会に同期フォルダへスナップショットする。
      //   1年分の標本がこの PC の1ファイルにしか無い状態を作らない(過去に「別PCの書き出しが空」の実事故)。
      //   原本は readOnly で開き、一時ファイル → rename。結末(件数つき)は共有DBの meta に残すので、
      //   trade2 の 30分スナップショット経由で **別PCからでも** 成否が読める。
      try {
        const now = Date.now();
        const results = runLedgerExport(tickExportDir, now);
        const hb = writeLedgerExportStatus(db, results, now, tickExportDir);
        // ★状態を **書き出し先そのもの** にも置く(循環を断つ)。共有DBの meta だけだと、その meta が
        //   別PCへ届く経路は trade2 の30分スナップショットしか無く、collector が止まると
        //   「止まる直前の状態」が現在の状態として読めてしまう(実害: 2時間の誤診断)。
        const fileStatus = writeLedgerExportStatusFile(tickExportDir, hb);
        const line = `[collector] ledger export: ${formatLedgerExportStatus(results, now, tickExportDir)}`
          + (fileStatus.ok ? ` | 状態ファイル=${fileStatus.file}` : ` | ★状態ファイル書込失敗: ${fileStatus.error}`);
        if (results.some(r => r.state === 'error') || !fileStatus.ok) console.error(line); else console.log(line);
      } catch (e) {
        // ここが失敗すると書き出しの成否そのものが無音になるので、必ず声を出す。
        console.error('[collector] ledger export FAILED:', e instanceof Error ? e.message : String(e));
      }
    }
    // ★ティック保管の健全性を共有DB(jp225.db)の meta に書く。**inPollWindow の外でも必ず書く**:
    //   場外で更新が止まると「収集が死んだ」と区別がつかなくなる(場外は idle として記録する)。
    //   保管は「1年後に効く」機構で、最悪の失敗形は「書けていないのに1年間気づかない」ことなので、
    //   状態は常時・自動で書き出しに乗せる。取引経路(signalTrade)からは一切呼ばない。
    //   ★lite(archiveDb===null)では保管そのものを走らせないので、健全性も書かない。
    if (archiveDb && Date.now() - lastTickHeartbeat >= TICK_ARCHIVE_HEARTBEAT_MS) {
      lastTickHeartbeat = Date.now();
      try {
        const hb = writeTickArchiveHeartbeat(db, archiveDb, {
          now: lastTickHeartbeat, exportDir: tickExportDir,
          lastExport: lastTickExportInfo, lastError: lastTickArchiveError,
        });
        // 状態が変わった時だけログに出す(毎分出すと誰も読まなくなる = 実質的な無音)。
        if (hb.state !== lastTickArchiveState) {
          lastTickArchiveState = hb.state;
          const line = `[collector] tick archive: ${formatTickArchiveStatus(hb)}`;
          if (hb.state === 'stalled' || hb.state === 'error') console.error(line); else console.log(line);
        }
      } catch (e) {
        // ここが失敗すると健全性そのものが無音になるので、必ず声を出す。
        console.error('[collector] tick archive heartbeat FAILED:', e instanceof Error ? e.message : e);
      }
    }
    await new Promise(r => setTimeout(r, Math.max(0, wait - (Date.now() - start))));
  }
  releaseLock();
  db.close();
  if (archiveDb) { try { archiveDb.close(); } catch { /* ignore */ } }
  console.log('[collector] stopped');
}

// ★ファイルログ自体は1行目の import(./logInstall.js)で **既に開いている**。
//   ここで足すのはシグナルの記録だけ: main() が自分で listen している SIGINT/SIGTERM に限る
//   (listener を新たに足すと Node の既定終了動作が止まり、挙動が変わってしまう)。
recordProcessLogSignals(['SIGINT', 'SIGTERM']);

void main();
