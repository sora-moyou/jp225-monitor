import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getSessionOHLC, getLatestTick } from '../db/store.js';
import { computeLevels, LOOKBACK_SESSIONS, type LevelsResult } from '../levels.js';
import { broadcast } from '../sse/broker.js';
import { classifySession } from '../../collector/session.js';
import { getForecastSnapshot } from './forecastLoop.js';

const SYMBOL = 'NIY=F';
const POLL_MS = 8_000;   // 当日H/Lをほぼリアルタイム化(従来60s)。NIY=Fのみで軽い。
const FETCH_SESSIONS = Math.max(LOOKBACK_SESSIONS, 20) + 4;   // 20Sスイング + 長期高安 + 余裕

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let last: LevelsResult = { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
let lastSig = '';
let tickCount = 0;
let warnedNoTick = false;
// 診断用: 各ステージの所要時間を記録。「価格水準の計算が終わらない」の原因切り分け用。
// DB取得(getSessionOHLC)が支配的なら索引/データ量が原因、computeLevels が支配的ならロジックが原因。

export function sessionKey(cs: { sessionDate: string; session: string } | null): string {
  return cs ? `${cs.sessionDate}/${cs.session}` : 'none';
}

/** レベル集合(価格+tier+丸めスコア+swing)の署名。current は UI が price SSE でライブ追従するため除外。
 *  価格が同じでも tier/score(強さ)が変わったら再配信されるよう、各 level の tier と
 *  0.5刻みに丸めた score も署名に含める。price 昇順ソートで決定性を保つ。
 *  これが変わった時だけ SSE 配信し、8秒間隔でも無駄な配信をしない。 */
export function levelSignature(r: LevelsResult): string {
  const prices = [...r.up, ...r.down]
    .sort((a, b) => a.price - b.price)
    .map(l => `${l.price}:${l.tier}:${Math.round(l.score * 2) / 2}`)
    .join(',');
  return `${prices}#${r.swing ? `${r.swing.high}-${r.swing.low}-${r.swing.leg}` : ''}`;
}

function tick(): void {
  if (!db) return;
  tickCount++;
  const tStart = Date.now();
  try {
    const now = Date.now();
    const latest = getLatestTick(db, SYMBOL);
    if (!latest) {
      // ticks テーブルに NIY=F が無い → 水準は出ない(「蓄積中…」のまま)。一度だけ警告。
      if (!warnedNoTick) { console.warn('[levelsLoop] NIY=F の tick がDBに無いため水準を計算できません(収集デーモン未稼働 or データ未蓄積)'); warnedNoTick = true; }
      return;
    }
    warnedNoTick = false;
    const tDb = Date.now();
    const sessions = getSessionOHLC(db, SYMBOL, FETCH_SESSIONS);
    const dbMs = Date.now() - tDb;
    const cs = classifySession(now);
    const fc = getForecastSnapshot();
    const extra = fc.targets
      ? [{ price: fc.targets.projHigh, label: 'ADR上限予測' }, { price: fc.targets.projLow, label: 'ADR下限予測' }]
      : [];
    const tCompute = Date.now();
    const result = computeLevels(sessions, latest.price, now, cs, extra);
    const computeMs = Date.now() - tCompute;
    last = result;
    const sig = levelSignature(result);
    let sent = false;
    if (sig !== lastSig) {
      lastSig = sig;
      broadcast({ type: 'levels', payload: result });
      sent = true;
    }
    // 診断ログ: 最初の3tick / 遅い時(DB>500ms or compute>150ms) / 水準が空の時 に出す。
    // 通常は無音。これを見れば「どのステージで詰まるか」「水準が空になっていないか」が分かる。
    const empty = result.up.length === 0 && result.down.length === 0;
    if (tickCount <= 3 || dbMs > 500 || computeMs > 150 || empty) {
      console.log(`[levelsLoop] db=${dbMs}ms compute=${computeMs}ms total=${Date.now() - tStart}ms `
        + `sessions=${sessions.length} up=${result.up.length} down=${result.down.length} `
        + `${sent ? 'broadcast' : 'unchanged'}${empty ? ' ⚠空(蓄積中表示)' : ''}`
        + `${dbMs > 500 ? ' ⚠DB遅延' : ''}`);
    }
  } catch (err) {
    // 原因解明のためスタックトレースまで出す(従来は message のみ)。
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
