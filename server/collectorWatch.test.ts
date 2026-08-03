import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, getMeta } from './db/store.js';
import { writeHeartbeat, HEARTBEAT_IDLE_MS } from './collectorHeartbeat.js';
import { COLLECTOR_PID_FILE as LOCK_PID_FILE } from '../collector/lock.js';
import {
  COLLECTOR_DEAD_MS, COLLECTOR_PID_FILE, COLLECTOR_WATCH_KEY, COLLECTOR_WATCH_STATUS_KEY,
  COLLECTOR_WATCH_FRESH_MS, COLLECTOR_STATUS_FILE_MS,
  buildCollectorWatch, formatCollectorWatchStatus, formatCollectorStatusFile,
  writeCollectorWatch, readCollectorWatch, describeCollectorWatch, writeCollectorStatusFile,
  collectorStatusFileName, shouldWriteStatusFile, shouldLogTransition,
  type CollectorPidInfo,
} from './collectorWatch.js';

// ★このテストが守る契約(収集デーモンの死活・RECORD-ONLY・取引挙動には一切関与しない):
//   ① 心拍の凍結を **死亡** として言い切る(黙って死ぬのを終わらせる)。
//   ② ★取引時間外(場外)と死亡を取り違えない。心拍は場外でも打たれる設計なので、
//      場外でも心拍が新しければ「生存(idle)」、場外でも心拍が凍れば「死亡(dead)」。
//   ③ 判定を書くのは **monitor(生きている側)**。収集デーモン本人の自己申告に依存しない
//      (本人に書かせると死んだ瞬間に「最後に生きていた時の状態」が固まる = 今回の誤診断の原因)。
//   ④ 判定そのものが古くなったら、それも読み手に分かる(OK のまま凍らせない)。
//   ⑤ 別PCから読める形(書き出しフォルダの状態ファイル)にも同じ判定が出る。
//
// ★否定対照(この機構が無かった状態):
//     git show HEAD:server/collectorHeartbeat.ts > <tmp>
//   HEAD には死活の判定も、それを書き出す経路も **存在しない**(isCollectorAlive はアラートの
//   単一書き手調停専用で、画面にも書き出しにも出ていない)。本ファイルは import すら解決できない。

const JST = 9 * 60 * 60_000;
const jst = (y: number, m: number, d: number, hh: number, mm: number, ss = 0): number =>
  Date.UTC(y, m - 1, d, hh, mm, ss) - JST;

// 2026-06-03(水)は平日・休場日でない。
const IN_SESSION = jst(2026, 6, 3, 10, 0);    // Day セッション中
const OUT_SESSION = jst(2026, 6, 3, 16, 0);   // 15:45–17:00 の空白帯(場外)
const WEEKEND = jst(2026, 6, 7, 12, 0);       // 日曜(完全に場外)

const NO_PID: CollectorPidInfo = { file: 'C:/x/collector.pid', pid: null, alive: false };
const DEAD_PID: CollectorPidInfo = { file: 'C:/x/collector.pid', pid: 4224, alive: false };
const LIVE_PID: CollectorPidInfo = { file: 'C:/x/collector.pid', pid: 4224, alive: true };

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }

describe('収集デーモンの死活判定(純関数)', () => {
  it('心拍が新しい & 取引時間内 → ok', () => {
    const w = buildCollectorWatch({ now: IN_SESSION, heartbeatAt: IN_SESSION - 2_000, pid: LIVE_PID });
    expect(w.state).toBe('ok');
    expect(w.inPollWindow).toBe(true);
  });

  it('★心拍が凍結 → dead(取引時間内)', () => {
    const w = buildCollectorWatch({
      now: IN_SESSION, heartbeatAt: IN_SESSION - COLLECTOR_DEAD_MS - 1, pid: DEAD_PID,
    });
    expect(w.state).toBe('dead');
    expect(w.reason).toContain('停止しています');
  });

  it('心拍が1件も無い → missing(dead とは別物)', () => {
    const w = buildCollectorWatch({ now: IN_SESSION, heartbeatAt: null, pid: NO_PID });
    expect(w.state).toBe('missing');
    expect(w.ageMs).toBeNull();
  });

  // ─── ★取り違えないこと(この機構の中心) ───────────────────────────────
  describe('★取引時間外と死亡を取り違えない', () => {
    it('場外でも心拍が新しければ **生存**(idle)= 警告にしない', () => {
      for (const now of [OUT_SESSION, WEEKEND]) {
        const w = buildCollectorWatch({ now, heartbeatAt: now - HEARTBEAT_IDLE_MS, pid: LIVE_PID });
        expect(w.state).toBe('idle');
        expect(w.inPollWindow).toBe(false);
        expect(w.reason).toContain('生存');
      }
    });

    it('★場外でも心拍が凍れば **死亡**(dead)= 時間外を言い訳にしない', () => {
      for (const now of [OUT_SESSION, WEEKEND]) {
        const w = buildCollectorWatch({ now, heartbeatAt: now - COLLECTOR_DEAD_MS - 1, pid: DEAD_PID });
        expect(w.state).toBe('dead');
        // 「なぜ時間外では説明できないのか」を判定文そのものに書く(読み手が推測しないで済むように)。
        expect(w.reason).toContain('取引時間外でも');
      }
    });

    it('★判定材料は心拍だけ: セッションは dead/alive を1ミリも動かさない', () => {
      const stale = COLLECTOR_DEAD_MS + 1;
      const fresh = HEARTBEAT_IDLE_MS;
      for (const now of [IN_SESSION, OUT_SESSION, WEEKEND]) {
        expect(buildCollectorWatch({ now, heartbeatAt: now - stale, pid: DEAD_PID }).state).toBe('dead');
        expect(buildCollectorWatch({ now, heartbeatAt: now - fresh, pid: LIVE_PID }).state)
          .not.toBe('dead');
      }
    });
  });

  it('閾値は場外の心拍周期(30秒)に余裕を持たせてある(1周期では死と判定しない)', () => {
    expect(COLLECTOR_DEAD_MS).toBeGreaterThanOrEqual(3 * HEARTBEAT_IDLE_MS);
    const w = buildCollectorWatch({
      now: OUT_SESSION, heartbeatAt: OUT_SESSION - HEARTBEAT_IDLE_MS * 2, pid: LIVE_PID,
    });
    expect(w.state).toBe('idle');
  });

  it('境界: 閾値ちょうどは生存・1ms 超で死亡', () => {
    const at = IN_SESSION - COLLECTOR_DEAD_MS;
    expect(buildCollectorWatch({ now: IN_SESSION, heartbeatAt: at, pid: LIVE_PID }).state).toBe('ok');
    expect(buildCollectorWatch({ now: IN_SESSION, heartbeatAt: at - 1, pid: DEAD_PID }).state).toBe('dead');
  });

  it('時計のずれ(未来の心拍)で異常判定を出さない', () => {
    const w = buildCollectorWatch({ now: IN_SESSION, heartbeatAt: IN_SESSION + 60_000, pid: LIVE_PID });
    expect(w.state).toBe('ok');
  });

  it('pid ファイル名は collector/lock.ts と同じ(2か所がズレたら気づく)', () => {
    expect(COLLECTOR_PID_FILE).toBe(LOCK_PID_FILE);
  });
});

describe('★判定の出どころ(循環を断つ)', () => {
  it('判定者が monitor であることが JSON にも人が読む行にも出る', () => {
    const w = buildCollectorWatch({
      now: IN_SESSION, heartbeatAt: IN_SESSION - COLLECTOR_DEAD_MS - 1, pid: DEAD_PID,
    });
    expect(w.writtenBy).toBe('monitor');
    expect(formatCollectorWatchStatus(w)).toContain('判定者=monitor');
  });

  it('meta に書くのは **収集デーモンが使っていないキー**(単一書き手を壊さない)', () => {
    // collector が書くのは collector_heartbeat のみ。判定は別キーなので書き手が衝突しない。
    expect(COLLECTOR_WATCH_KEY).not.toBe('collector_heartbeat');
    expect(COLLECTOR_WATCH_STATUS_KEY).not.toBe('collector_heartbeat');
  });
});

describe('共有DB(jp225.db)meta への記録', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); });
  afterEach(() => { db.close(); });

  it('心拍が古ければ dead を書き、読み返せる', () => {
    writeHeartbeat(db, IN_SESSION - COLLECTOR_DEAD_MS - 60_000);
    const w = writeCollectorWatch(db, IN_SESSION);
    expect(w.state).toBe('dead');
    const back = readCollectorWatch(db);
    expect(back?.state).toBe('dead');
    expect(back?.writtenBy).toBe('monitor');
    // 人が読む1行も同じ構造体から作る(2つの表現が食い違わない)。
    expect(getMeta(db, COLLECTOR_WATCH_STATUS_KEY)).toContain('DEAD');
  });

  it('心拍が新しければ ok(場中)', () => {
    writeHeartbeat(db, IN_SESSION - 2_000);
    expect(writeCollectorWatch(db, IN_SESSION).state).toBe('ok');
  });

  it('★収集デーモンの心拍(collector_heartbeat)を書き換えない', () => {
    writeHeartbeat(db, IN_SESSION - 2_000);
    writeCollectorWatch(db, IN_SESSION);
    expect(getMeta(db, 'collector_heartbeat')).toBe(String(IN_SESSION - 2_000));
  });

  it('壊れた値は「無い」扱い(次の判定で上書きされる)', () => {
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(COLLECTOR_WATCH_KEY, '{壊れた');
    expect(readCollectorWatch(db)).toBeNull();
  });
});

describe('★判定そのものが古くなったことを見逃さない', () => {
  it('monitor が止まれば判定は凍る → unwatched として読める', () => {
    const w = buildCollectorWatch({ now: IN_SESSION, heartbeatAt: IN_SESSION - 2_000, pid: LIVE_PID });
    const fresh = describeCollectorWatch(w, IN_SESSION + COLLECTOR_WATCH_FRESH_MS - 1);
    expect(fresh.state).toBe('ok');
    const stale = describeCollectorWatch(w, IN_SESSION + COLLECTOR_WATCH_FRESH_MS + 1);
    expect(stale.state).toBe('unwatched');
    expect(stale.text).toContain('現在の状態ではない');
  });

  it('判定が無ければ missing(「異常なし」と読ませない)', () => {
    expect(describeCollectorWatch(null, IN_SESSION).state).toBe('missing');
  });
});

describe('書き出しフォルダの状態ファイル(別PCから読む)', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'collector-watch-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const dead = (): ReturnType<typeof buildCollectorWatch> => buildCollectorWatch({
    now: IN_SESSION, heartbeatAt: IN_SESSION - COLLECTOR_DEAD_MS - 3_600_000, pid: DEAD_PID,
    spawn: { path: 'C:/x/sidecar-spawn.log', lines: ['1 [collector] spawned pid=4224'] },
    logHint: 'C:/x/collector_host.log',
  });

  it('★死亡がファイルに出る + 「判定者は monitor」と明記される', () => {
    const r = writeCollectorStatusFile(dir, dead(), 'host');
    expect(r.ok).toBe(true);
    const body = readFileSync(join(dir, collectorStatusFileName('host')), 'utf-8');
    expect(body).toContain('状態: DEAD');
    expect(body).toContain('monitor(生きている側)');
    expect(body).toContain('心拍は取引時間外でも打たれます');
    // 「どこを見れば死因が分かるか」も書く。
    expect(body).toContain('collector_host.log');
    expect(body).toContain('spawned pid=4224');
  });

  it('生存中は生存として上書きされる(古い判定が残り続けない)', () => {
    writeCollectorStatusFile(dir, dead(), 'host');
    const alive = buildCollectorWatch({ now: IN_SESSION, heartbeatAt: IN_SESSION - 2_000, pid: LIVE_PID });
    writeCollectorStatusFile(dir, alive, 'host');
    const body = readFileSync(join(dir, collectorStatusFileName('host')), 'utf-8');
    expect(body).toContain('状態: OK');
    expect(body).not.toContain('状態: DEAD');
  });

  it('一時ファイルを残さない(部分書き込みを同期フォルダに流さない)', () => {
    writeCollectorStatusFile(dir, dead(), 'host');
    expect(existsSync(join(dir, `${collectorStatusFileName('host')}.tmp`))).toBe(false);
  });

  it('書出先が未設定なら何もしない(理由を返す)', () => {
    const r = writeCollectorStatusFile('', dead());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未設定');
  });

  it('状態ファイルの中身は判定と同じ構造体から作る', () => {
    expect(formatCollectorStatusFile(dead(), 'host')).toContain('DEAD');
  });
});

describe('共用の1行ログ(sidecar-spawn.log)に書く遷移', () => {
  it('★異常(dead / missing)と、そこからの復帰は必ず書く', () => {
    expect(shouldLogTransition('ok', 'dead')).toBe(true);
    expect(shouldLogTransition('dead', 'ok')).toBe(true);
    expect(shouldLogTransition('idle', 'dead')).toBe(true);
    expect(shouldLogTransition(null, 'dead')).toBe(true);
    expect(shouldLogTransition(null, 'missing')).toBe(true);
  });
  it('monitor を起動しただけ(正常)は書かない = 共用ログを雑音で埋めない', () => {
    expect(shouldLogTransition(null, 'ok')).toBe(false);
    expect(shouldLogTransition(null, 'idle')).toBe(false);
  });
  it('同じ状態が続く間は書かない', () => {
    expect(shouldLogTransition('dead', 'dead')).toBe(false);
    expect(shouldLogTransition('ok', 'ok')).toBe(false);
  });
});

describe('状態ファイルを書く頻度(同期フォルダを毎30秒たたかない)', () => {
  it('状態が変われば即座に書く', () => {
    expect(shouldWriteStatusFile('ok', 'dead', 1_000_000, 1_000_001)).toBe(true);
  });
  it('変わらなければ最低間隔まで待つ', () => {
    expect(shouldWriteStatusFile('ok', 'ok', 1_000_000, 1_000_000 + COLLECTOR_STATUS_FILE_MS - 1)).toBe(false);
    expect(shouldWriteStatusFile('ok', 'ok', 1_000_000, 1_000_000 + COLLECTOR_STATUS_FILE_MS)).toBe(true);
  });
  it('初回(前の状態が無い)は必ず書く', () => {
    expect(shouldWriteStatusFile(null, 'ok', 0, 1_000_000)).toBe(true);
  });
});
