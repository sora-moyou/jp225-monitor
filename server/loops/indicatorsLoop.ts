import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getRecentBars } from '../db/store.js';
import { broadcast } from '../sse/broker.js';
import { inPollWindow } from '../../core/session.js';
import { resolveIndicatorsEnabled } from '../configStore.js';
import { aggregate5m, computeIndicators, valuesOf, type IndicatorSnapshot, type OHLCBar } from '../indicators.js';

// テクニカル指標(RSI/SMA/BB)を 5分足 close から算出して SSE 配信するループ。
//   ・15秒ごと(取引時間内のみ=inPollWindow でゲート・軽量)に DB の直近6時間 1分足→5分足へ集約。
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

/** DB の 1分足(直近6時間)→ 5分足へ集約して返す。無ければ空配列。 */
function fetch5mBars(now: number): OHLCBar[] {
  if (!db) return [];
  const bars = getRecentBars(db, SYMBOL, now - BARS_WINDOW_MS) as unknown as OHLCBar[];
  return aggregate5m(bars);
}

function tick(): void {
  if (!inPollWindow(Date.now())) return;   // 取引時間外は何もしない(軽量化・DB読み停止)。
  if (!db) return;
  if (!resolveIndicatorsEnabled()) return; // OFF のときは算出/配信しない(パネルは「蓄積中…」のまま)。
  try {
    const now = Date.now();
    const bars5 = fetch5mBars(now);
    if (bars5.length === 0) return;
    // 確定足(形成中の最後の1本を除く)で主指標を算出=安定値。形成中足込みで live を併算。
    const closesLive = bars5.map(b => b.c);
    const timesLive = bars5.map(b => b.t);
    const closesClosed = closesLive.slice(0, -1);
    const timesClosed = timesLive.slice(0, -1);
    // 確定足が空(=まだ1本目が形成中)なら live のみで算出する(初期表示を出せるように)。
    const snap = closesClosed.length > 0
      ? computeIndicators(closesClosed, timesClosed)
      : computeIndicators(closesLive, timesLive);
    snap.live = valuesOf(computeIndicators(closesLive, timesLive));
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
  try { db = openDb(resolveDbPath()); }
  catch (err) { console.warn('[indicatorsLoop] open db failed:', err instanceof Error ? err.message : String(err)); return; }
  running = true;
  tick();
  schedule();
}

export function stopIndicatorsLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (db) { db.close(); db = null; }
}

/** 現在の指標スナップショット(stream.ts の初回送出用)。まだ算出できていなければ null。 */
export function getIndicatorsSnapshot(): IndicatorSnapshot | null { return last; }
