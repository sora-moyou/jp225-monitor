import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath } from '../db/store.js';
import { broadcast } from '../sse/broker.js';
import { inPollWindow } from '../../core/session.js';
import { resolveIndicatorsEnabled } from '../configStore.js';
import { collectRecentBars } from '../barsSource.js';
import {
  aggregate5m, computeIndicators, indicatorProgress, valuesOf, hasMainValues, MIN_CLOSES_FOR_MAIN,
  type IndicatorSnapshot, type IndicatorReadyState, type OHLCBar,
} from '../indicators.js';

// テクニカル指標(RSI/SMA/BB)を 5分足 close から算出して SSE 配信するループ。
//   ・15秒ごと(取引時間内のみ=inPollWindow でゲート・軽量)に 直近6時間の1分足→5分足へ集約。
//   ・足は「DBの bars_1m ∪ メモリ内のライブ足(feedBars)」= collectRecentBars。DB だけに繋いでいた
//     ため collector 未稼働の環境で窓内0本→無音 return となり、パネルが永久に「蓄積中…」だった(修正)。
//   ・安定値のため「確定した足(形成中の最後の1本を除く)」で主指標を算出し、形成中足込みの live 値も併算。
//   ・前回と JSON が変わったときだけ broadcast(correlation/levels ループと同じ署名 de-dup 方式)。
//   ・検知(アラート)には一切関与しない=表示 + AI 文脈専用。indicatorsEnabled=false で配信停止。

const SYMBOL = 'NIY=F';
const POLL_MS = 15_000;
const BARS_WINDOW_MS = 6 * 60 * 60_000;   // 直近6時間の 1分足(scalpContext と同窓)

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let last: IndicatorSnapshot | null = null;
let lastJson = '';
let warnedNoBars = false;

/** 窓内(直近6時間)の1分足を DB + メモリ内ライブ足から集めて返す。無ければ空配列。 */
function fetch1mBars(now: number): OHLCBar[] {
  return collectRecentBars(db, SYMBOL, now - BARS_WINDOW_MS);
}

/** 算出をしない状態(取引時間外/機能OFF)を SSE に反映する。DB読み/計算はしない(ドーマント化の意図は維持)。
 *  ・直前に算出できていれば「値はそのまま + 状態マーカー」で配信する。
 *    引け後に「そのセッションが最終的にどこで終わったか(RSI/BB)」を見るのは実用的な用途なので値は消さない。
 *  ・一度も算出できていない(起動が時間外/足が無い)ときだけ、値 null + 理由のマーカーを配信する(自己診断)。
 *  JSON de-dup があるので同じ状態の再送はされない。引け後/早朝にパネルが無言で「蓄積中…」を出し続けるのを防ぐ。 */
function broadcastState(state: IndicatorReadyState): void {
  let snap: IndicatorSnapshot;
  if (hasMainValues(last)) {
    snap = { ...last!, progress: { state, remaining: last!.progress?.remaining ?? 0 } };
  } else {
    snap = computeIndicators([], []);
    snap.live = valuesOf(snap);
    snap.progress = { state, remaining: MIN_CLOSES_FOR_MAIN };
  }
  last = snap;
  const json = JSON.stringify(snap);
  if (json === lastJson) return;
  lastJson = json;
  broadcast({ type: 'indicators', payload: snap });
}

function tick(): void {
  // 取引時間外/機能OFF: 算出はしない(軽量化・DB読み停止)が、その理由だけは1回配信して画面に出す。
  if (!inPollWindow(Date.now())) { broadcastState('closed'); return; }
  if (!resolveIndicatorsEnabled()) { broadcastState('disabled'); return; }
  try {
    const now = Date.now();
    const bars1 = fetch1mBars(now);
    // 足が1本も集まらない=データ供給そのものが無い。一度だけ警告(復帰したらフラグを戻す)。
    //   levelsLoop の warnedNoTick と同じ流儀。ログが見えない配布環境向けに、状態は下の progress で画面にも出す。
    if (bars1.length === 0) {
      if (!warnedNoBars) {
        console.warn('[indicatorsLoop] NIY=F の1分足が窓内(直近6時間)に0本のため指標を計算できません'
          + '(価格フィード停止 or 収集デーモン未稼働 or データ未蓄積)');
        warnedNoBars = true;
      }
    } else {
      warnedNoBars = false;
    }
    const bars5 = aggregate5m(bars1);
    // ★足0本でも早期 return しない: null 値のスナップショットを状態マーカー付きで配信し、
    //   パネルが「足データ未取得」と「本数不足」を区別できるようにする(JSON de-dup があるので再送はされない)。
    // 確定足(形成中の最後の1本を除く)で主指標を算出=安定値。形成中足込みで live を併算。
    const closesLive = bars5.map(b => b.c);
    const timesLive = bars5.map(b => b.t);
    const closesClosed = closesLive.slice(0, -1);
    const timesClosed = timesLive.slice(0, -1);
    // 確定足が空(=まだ1本目が形成中)なら live のみで算出する(初期表示を出せるように)。
    const useClosed = closesClosed.length > 0;
    const usedCloses = useClosed ? closesClosed : closesLive;
    const usedTimes = useClosed ? timesClosed : timesLive;
    const snap = computeIndicators(usedCloses, usedTimes);
    snap.live = valuesOf(computeIndicators(closesLive, timesLive));
    snap.progress = indicatorProgress(bars1.length, usedCloses.length);
    last = snap;
    const json = JSON.stringify(snap);
    if (json !== lastJson) {
      lastJson = json;
      broadcast({ type: 'indicators', payload: snap });
    }
  } catch (err) {
    console.warn('[indicatorsLoop] tick failed:', err instanceof Error ? err.message : String(err));
  }
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(() => { tick(); schedule(); }, POLL_MS);
}

export function startIndicatorsLoop(): void {
  if (running) return;
  // DB が開けなくても止めない: メモリ内ライブ足(feedBars)だけで指標は算出できる(表示を落とさない)。
  try { db = openDb(resolveDbPath()); }
  catch (err) {
    db = null;
    console.warn('[indicatorsLoop] open db failed(メモリ内ライブ足のみで継続):', err instanceof Error ? err.message : String(err));
  }
  running = true;
  tick();
  schedule();
}

export function stopIndicatorsLoop(): void {
  running = false;
  warnedNoBars = false;   // 再起動時にもう一度だけ警告できるように戻す
  if (timer) { clearTimeout(timer); timer = null; }
  if (db) { db.close(); db = null; }
}

/** 現在の指標スナップショット(stream.ts の初回送出用)。まだ算出できていなければ null。 */
export function getIndicatorsSnapshot(): IndicatorSnapshot | null { return last; }

// テスト用: 配信状態(直近スナップショット / de-dup 署名 / 警告フラグ)を初期化する。
export function _reset(): void { last = null; lastJson = ''; warnedNoBars = false; }
