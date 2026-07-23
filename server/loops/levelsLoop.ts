import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath } from '../db/store.js';
import { broadcast } from '../sse/broker.js';
import { inPollWindow } from '../../core/session.js';
import { emitAlert } from '../alertHistory.js';
import { crashDrawdown, CRASH_DRAWDOWN_PCT, CRASH_HYSTERESIS_PCT } from '../crash.js';
import type { LevelsResult } from '../levels.js';
import type { SessionInfo } from '../../core/session.js';
import {
  computeLevelAnalytics, runLevelDetectors, createLevelDetectState, DETECT_FRESH_MS,
} from '../detect/registry.js';

// 検知の配線(解析+検知器)は server/detect/registry.ts に集約(STEP 6)。このループの責務は:
//   ・ポーリング/DB ハンドル管理、・levels の SSE broadcast(署名 de-dup)、・暴落(crash)検知(inline)、
//   ・registry の runLevelDetectors(sink=emitAlert)呼び出し、・診断ログ。
// 検知器の cooldown/dedup と解析キャッシュは `serverLevelState`(この consumer 専用インスタンス)に閉じ込める。

// テスト/監査互換のため registry の共有ヘルパを再 export(alert-audit.mts / levelsLoop.test.ts が参照)。
export { yenPct, LEVELS_TUNING, persistAndResolveDailyCloses } from '../detect/registry.js';

const SYMBOL = 'NIY=F';
const POLL_MS = 8_000;   // 当日H/Lをほぼリアルタイム化(従来60s)。NIY=Fのみで軽い。

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let last: LevelsResult = { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
let lastSig = '';
let tickCount = 0;
let warnedNoTick = false;
// ── 暴落(crash): セッション高値からの下落率がこれ以上(ユーザー定義)。閾値/計算は crash.ts に集約。
let crashSessionKey = '';
let crashSessionHigh = 0;
let crashFired = false;
// この consumer(server=levelsLoop)専用の検知状態(解析キャッシュ + 検知器 cooldown/dedup)。
const serverLevelState = createLevelDetectState();

export function sessionKey(cs: SessionInfo | null): string {
  return cs ? `${cs.sessionDate}/${cs.session}` : 'none';
}

/** レベル集合(価格+tier+丸めスコア+swing)の署名。current は UI が price SSE でライブ追従するため除外。 */
export function levelSignature(r: LevelsResult): string {
  const prices = [...r.up, ...r.down]
    .sort((a, b) => a.price - b.price)
    .map(l => `${l.price}:${l.tier}:${Math.round(l.score * 2) / 2}`)
    .join(',');
  return `${prices}#${r.swing ? `${r.swing.high}-${r.swing.low}-${r.swing.leg}` : ''}`;
}

function tick(): void {
  if (!inPollWindow(Date.now())) return;   // 取引時間外は何もしない(軽量化・DB読み停止)
  if (!db) return;
  tickCount++;
  const tStart = Date.now();
  try {
    const now = Date.now();
    // 解析(反応水準/出来高/もみ合い/トレンドライン/日足バンド/MA + computeLevels)は registry に集約。
    const a = computeLevelAnalytics(db, now, serverLevelState);
    if (!a) {
      // ticks テーブルに NIY=F が無い → 水準は出ない(「蓄積中…」のまま)。一度だけ警告。
      if (!warnedNoTick) { console.warn('[levelsLoop] NIY=F の tick がDBに無いため水準を計算できません(収集デーモン未稼働 or データ未蓄積)'); warnedNoTick = true; }
      return;
    }
    warnedNoTick = false;
    const { result, latest, sessions, cs } = a;
    last = result;
    const sig = levelSignature(result);
    let sent = false;
    if (sig !== lastSig) {
      lastSig = sig;
      broadcast({ type: 'levels', payload: result });
      sent = true;
    }
    // 最新tickが古い(収集停止/復帰中)なら、stale な価格でダブル/水準抜けを誤発火させない(水準配信は上で継続)。
    if (now - latest.t > DETECT_FRESH_MS) return;
    // ── 暴落検知: セッション高値から CRASH_DRAWDOWN_PCT 以上の下落でアラート ──
    // registry には含めない(collector 側は checkCrash で別実装・二重 emit を避ける)。
    try {
      const csk = sessionKey(cs);
      if (csk !== crashSessionKey) { crashSessionKey = csk; crashSessionHigh = 0; crashFired = false; }
      if (csk !== 'none') {
        const inProg = cs ? sessions.find(s => s.sessionDate === cs.sessionDate && s.session === cs.session) : undefined;
        crashSessionHigh = Math.max(crashSessionHigh, inProg?.high ?? 0, latest.price);
        const dd = crashDrawdown(crashSessionHigh, latest.price);
        if (dd >= CRASH_DRAWDOWN_PCT && !crashFired) {
          crashFired = true;
          const high = Math.round(crashSessionHigh), drop = Math.round(crashSessionHigh - latest.price);
          const pct = (dd * 100).toFixed(1);
          console.log(`[levelsLoop] 暴落 high=${high} now=${Math.round(latest.price)} -${pct}% (-${drop})`);
          emitAlert({
            symbol: SYMBOL, symbolLabel: '日経225先物',
            changePercent: -dd * 100, windowSeconds: 6 * 3600, detectionKind: 'crash', direction: 'down',
            triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0, level: high,
            note: `暴落: セッション高値${high.toLocaleString('ja-JP')}から -${pct}%(-${drop.toLocaleString('ja-JP')}円)`,
            referenceKind: 'sessionHigh', referencePrice: high,
          });
        } else if (dd < CRASH_DRAWDOWN_PCT - CRASH_HYSTERESIS_PCT) {
          crashFired = false;   // 戻したら次の暴落に備えてリセット
        }
      }
    } catch (err) {
      console.warn('[levelsLoop] crash detect failed:', err instanceof Error ? err.message : err);
    }
    // ── L2 価格系(break/level_sr/pivot/double)+ 日足バンド/MA 検知は registry に委譲(sink=emitAlert)──
    runLevelDetectors(db, a, now, serverLevelState, emitAlert);
    // 診断ログ: 最初の3tick / 遅い時(DB>500ms or compute>150ms) / 水準が空の時 に出す。
    const empty = result.up.length === 0 && result.down.length === 0;
    if (tickCount <= 3 || a.dbMs > 500 || a.computeMs > 150 || empty) {
      console.log(`[levelsLoop] db=${a.dbMs}ms compute=${a.computeMs}ms total=${Date.now() - tStart}ms `
        + `sessions=${sessions.length} up=${result.up.length} down=${result.down.length} `
        + `${sent ? 'broadcast' : 'unchanged'}${empty ? ' ⚠空(蓄積中表示)' : ''}`
        + `${a.dbMs > 500 ? ' ⚠DB遅延' : ''}`);
    }
  } catch (err) {
    console.warn(`[levelsLoop] tick FAILED (total=${Date.now() - tStart}ms): `
      + (err instanceof Error ? (err.stack ?? err.message) : String(err)));
  }
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(() => {
    tick();
    schedule();
  }, POLL_MS);
}

export function startLevelsLoop(): void {
  if (running) return;
  try { db = openDb(resolveDbPath()); }
  catch (err) { console.warn('[levelsLoop] open db failed:', err instanceof Error ? err.message : err); return; }
  running = true;
  tick();
  schedule();
}

export function stopLevelsLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (db) { db.close(); db = null; }
}

export function getLevelsSnapshot(): LevelsResult { return last; }
