import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath } from '../db/store.js';
import { broadcast } from '../sse/broker.js';
import { inPollWindow } from '../../core/session.js';
import { resolveIndicatorsEnabled } from '../configStore.js';
import { collectRecentBars } from '../barsSource.js';
import {
  aggregate5m, computeIndicators, indicatorProgress, valuesOf, hasMainValues, MIN_CLOSES_FOR_MAIN,
  buildSqueezeSnapshot,
  type IndicatorSnapshot, type IndicatorReadyState, type OHLCBar, type SqueezeSnapshot,
} from '../indicators.js';

// テクニカル指標(RSI/SMA/BB)を 5分足 close から算出して SSE 配信するループ。
//   ・15秒ごと(取引時間内のみ=inPollWindow でゲート・軽量)に 直近6時間の1分足→5分足へ集約。
//   ・足は「DBの bars_1m ∪ メモリ内のライブ足(feedBars)」= collectRecentBars。DB だけに繋いでいた
//     ため collector 未稼働の環境で窓内0本→無音 return となり、パネルが永久に「蓄積中…」だった(修正)。
//   ・安定値のため「確定した足(形成中の最後の1本を除く)」で主指標を算出し、形成中足込みの live 値も併算。
//   ・スクイーズ用バンド(20本/2σ)は **別窓(7日)で足を取り直す**。既存窓を伸ばすと RSI の
//     Wilder 平滑化で既存値が動くため。確定足が増えたときだけ計算する(下の squeezeSnapshotFor)。
//   ・前回と JSON が変わったときだけ broadcast(correlation/levels ループと同じ署名 de-dup 方式)。
//   ・検知(アラート)には一切関与しない=表示 + AI 文脈専用。indicatorsEnabled=false で配信停止。

const SYMBOL = 'NIY=F';
const POLL_MS = 15_000;
const BARS_WINDOW_MS = 6 * 60 * 60_000;   // 直近6時間の 1分足(scalpContext と同窓)

/** ★スクイーズ用バンドだけが使う足の窓(既存の6時間窓とは **別に取り直す**)。
 *
 *  なぜ既存の窓を広げないか:
 *    computeIndicators の RSI は prefix 全体を Wilder 平滑化するため、窓を伸ばすと
 *    **既存の RSI 値そのものが変わる**(バンドウォーク判定と AI プロンプトが共有している系列)。
 *    「既存は1ミリも変えない」という約束を守るには、別系列は別の窓で取るしかない。
 *
 *  なぜ7日か:
 *    SQUEEZE_BW_LOOKBACK(=125本)ぶんの5分足が実際に張る **実時間** を実データで測ると、
 *    中央 13.1h / p95 61.1h / 最大 150h(=6.2日)だった(昼休み・引け・週末で足が飛ぶため
 *    「125本 × 5分 = 10.4時間」にはならない)。最大 6.2日を確実に含む窓として7日を取る。
 *    6時間窓のままだと5分足は最大72本しか作れず、ready は **永久に false**(=判定が死ぬ)。 */
const SQUEEZE_BARS_WINDOW_MS = 7 * 24 * 60 * 60_000;

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let last: IndicatorSnapshot | null = null;
let lastJson = '';
let warnedNoBars = false;
/** スクイーズの計算結果キャッシュ。key = 参照した「最後の確定5分足」の時刻(足が無ければ null)。 */
let squeezeCache: { key: number | null; snap: SqueezeSnapshot } | null = null;

/** 窓内(直近6時間)の1分足を DB + メモリ内ライブ足から集めて返す。無ければ空配列。 */
function fetch1mBars(now: number): OHLCBar[] {
  return collectRecentBars(db, SYMBOL, now - BARS_WINDOW_MS);
}

/** スクイーズ用スナップショット(7日窓・確定足のみ)。
 *
 *  ★15秒 tick のたびに7日ぶんの1分足を読み直さない: 確定足の終端時刻(lastClosedT)が前回と
 *    同じなら、入力が1本も増えていない=結果も必ず同じなので、**DB を読まずに前回の結果を返す**。
 *    実質「5分に1回だけ」計算される(この節約は indicatorsLoopSqueezeWindow.test.ts で固定してある)。
 *  ★確定足が1本も無いときは全 null を返す: 7日窓には古い足が残っていることがあり、
 *    それを現在値として出すと「6時間以内に足が無い(=フィード停止)」のに数字だけが出てしまう。 */
function squeezeSnapshotFor(now: number, lastClosedT: number | null): SqueezeSnapshot {
  if (squeezeCache && squeezeCache.key === lastClosedT) return squeezeCache.snap;
  let snap: SqueezeSnapshot;
  if (lastClosedT === null) {
    snap = buildSqueezeSnapshot([], []);
  } else {
    const bars5 = aggregate5m(collectRecentBars(db, SYMBOL, now - SQUEEZE_BARS_WINDOW_MS));
    // ★主指標と **同じ足** で終わらせる(形成中の足を落とすのではなく終端を合わせる)。
    //   snap.t と snap.squeeze.t がずれると、画面の2つの数字が別の時刻を指す。
    const closed = bars5.filter(b => b.t <= lastClosedT);
    snap = buildSqueezeSnapshot(closed.map(b => b.c), closed.map(b => b.t));
  }
  squeezeCache = { key: lastClosedT, snap };
  return snap;
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
    // ★ADD-ONLY: スクイーズ用バンド(20本/2σ)。**確定足の close だけ**から作る(形成中の足は使わない)。
    //   既存の値/系列/live/progress には一切触らない=別系列を snap に足すだけ。
    //   足は上の6時間窓ではなく **7日窓で取り直す**(SQUEEZE_BARS_WINDOW_MS のコメント参照)。
    //   上の usedCloses/usedTimes は 1要素も渡さない=既存経路とは完全に独立。
    const lastClosedT = timesClosed.length > 0 ? timesClosed[timesClosed.length - 1]! : null;
    snap.squeeze = squeezeSnapshotFor(now, lastClosedT);
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
  squeezeCache = null;    // DB ハンドルを捨てるので、次回起動では必ず取り直す
  if (timer) { clearTimeout(timer); timer = null; }
  if (db) { db.close(); db = null; }
}

/** 現在の指標スナップショット(stream.ts の初回送出用)。まだ算出できていなければ null。 */
export function getIndicatorsSnapshot(): IndicatorSnapshot | null { return last; }

// テスト用: 配信状態(直近スナップショット / de-dup 署名 / 警告フラグ)を初期化する。
export function _reset(): void { last = null; lastJson = ''; warnedNoBars = false; squeezeCache = null; }
