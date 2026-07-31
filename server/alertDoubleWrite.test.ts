// アラートの二重記録(collector × monitor)の回帰テスト。
//
// 背景(実測): server/alertHistory.ts の MONITOR_ONLY_KINDS が
// {slope, break, double, level_sr, pivot, dtb, swingdtb, dailyband, nwave} だった頃、
// collector も STEP6 以降 runLevelDetectors で break/level_sr/pivot/double/dailyband/nwave を
// 書いていたため、同じ検知が2行になっていた。UNIQUE 索引 idx_alerts_identity は triggered_at を
// 含むので、壁時計の違う2プロセス(monitor=8秒周期 / collector=分境界)の行は衝突しない。
// alerts_kabu.db(2026-06-19〜07-31)の level 系 4,181 行のうち ≈1,120 行(26.8%)が超過分だった。
//
// ここでは「2つの writer が同じ検知を書きに来る」状況を DB レベルで再現し、行が1つだけになることを
// 確かめる。純関数の判定(monitorPersistMode)だけでなく、実際に alerts テーブルへ書いて数える。

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getRecentAlerts, insertAlertIfNew, type AlertInsert } from './db/store.js';
import { writeHeartbeat, isCollectorAlive } from './collectorHeartbeat.js';
import {
  monitorPersistMode, recordAlert, nearDuplicateWindowMs, MONITOR_ONLY_KINDS,
} from './alertHistory.js';
import { setCooldownMs, COOLDOWN_MS } from './alertCooldown.js';
import type { AlertEventPayload } from './types.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }

const T0 = Date.UTC(2026, 6, 15, 3, 0, 0);   // 2026-07-15 12:00 JST = 日中セッション中盤

function payload(over: Partial<AlertEventPayload> = {}): AlertEventPayload {
  return {
    symbol: 'NIY=F', symbolLabel: '日経225先物', changePercent: 0, windowSeconds: 60,
    detectionKind: 'break', direction: 'up', triggeredAt: T0,
    change15min: null, pa15min: null, range1h: null, zscore: 0,
    referenceKind: 'level', referencePrice: 67_600,
    ...over,
  } as AlertEventPayload;
}

/** collector 側の書き込み(collector/alertCollector.ts の sink と同じ形)。 */
function collectorWrite(db: DatabaseSync, p: AlertEventPayload, price: number): void {
  const row: AlertInsert = {
    symbol: p.symbol, triggeredAt: p.triggeredAt, direction: p.direction,
    detectionKind: p.detectionKind, windowSeconds: p.windowSeconds, changePercent: p.changePercent,
    price, sessionDate: '2026-07-15', session: 'Day',
    referenceKind: p.referenceKind ?? null, referencePrice: p.referencePrice ?? null,
  };
  insertAlertIfNew(db, row, nearDuplicateWindowMs());
}

/** monitor 側の書き込み(server/alertHistory.ts emitAlert の記録部分と同じ判定)。 */
function monitorWrite(db: DatabaseSync, p: AlertEventPayload, price: number, now: number): void {
  const mode = monitorPersistMode(p.detectionKind, isCollectorAlive(db, now));
  if (mode === 'skip') return;
  recordAlert(db, p, price, mode);
}

describe('アラートの二重記録(collector × monitor)', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); setCooldownMs(COOLDOWN_MS); });

  // ── 中核: collector 稼働中に両者が同じ level 検知を書きに来ても1行 ──
  // collector は毎分1回・monitor は8秒周期なので triggered_at がずれ、UNIQUE 索引では衝突しない。
  // ★否定対照: MONITOR_ONLY_KINDS に 'break' が入っていた修正前コードでは 2 行になり赤くなる。
  for (const kind of ['break', 'level_sr', 'pivot', 'double', 'dailyband', 'nwave'] as const) {
    it(`collector 稼働中: ${kind} を両者が書きに来ても alerts は1行`, () => {
      writeHeartbeat(db, T0);                       // collector 生存
      collectorWrite(db, payload({ detectionKind: kind }), 67_610);              // 分境界
      monitorWrite(db, payload({ detectionKind: kind, triggeredAt: T0 + 34_000 }), 67_615, T0 + 34_000);
      expect(getRecentAlerts(db, 10).length).toBe(1);
    });
  }

  it('collector 稼働中: bar 検知(shock)も従来どおり1行(退行していない)', () => {
    writeHeartbeat(db, T0);
    collectorWrite(db, payload({ detectionKind: 'shock' }), 67_610);
    monitorWrite(db, payload({ detectionKind: 'shock', triggeredAt: T0 + 12_000 }), 67_615, T0 + 12_000);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  // ── ハートビート陳腐化の隙間(collector 停止直後/再起動中)──
  // monitor が素の insertAlert を使っていた頃は、collector が書いた直後の行と重複していた。
  // ★否定対照: 修正前(recordAlert が常に insertAlert)では 2 行になり赤くなる。
  it('collector 停止中のフォールバックでも、collector が直前に書いた行と重複しない', () => {
    // heartbeat 無し = collector 停止扱い。だが collector プロセスは終了直前に1行書けている。
    collectorWrite(db, payload(), 67_610);
    monitorWrite(db, payload({ triggeredAt: T0 + 30_000 }), 67_615, T0 + 30_000);
    expect(isCollectorAlive(db, T0 + 30_000)).toBe(false);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('collector 停止中: 近接していない再発火はちゃんと2行残る(過剰抑制していない)', () => {
    collectorWrite(db, payload(), 67_610);
    const later = T0 + 20 * 60_000;   // 近接重複窓(≤60s)よりずっと後
    monitorWrite(db, payload({ triggeredAt: later }), 67_800, later);
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });

  // ── 過剰修正の防止 ──
  // slope(超短期)はクールダウンを完全無視して連発するのが仕様(server/tickDetector.ts)。
  // ここに近接重複ガードを掛けると実データの 55% が消える。monitor 専用種別は素で書き続ける。
  it('slope は collector 稼働中でも monitor が書き、近接でも抑制されない', () => {
    writeHeartbeat(db, T0);
    for (const dt of [0, 8_000, 16_000]) {
      monitorWrite(db, payload({ detectionKind: 'slope', windowSeconds: 5, referenceKind: undefined, referencePrice: undefined, triggeredAt: T0 + dt }), 67_600 + dt / 100, T0 + dt);
    }
    expect(getRecentAlerts(db, 10).length).toBe(3);
  });

  it('近接重複窓は設定クールダウンより必ず短い(正当な再発火を消さない)', () => {
    setCooldownMs(15 * 60_000);
    expect(nearDuplicateWindowMs()).toBe(60_000);
    expect(nearDuplicateWindowMs()).toBeLessThan(15 * 60_000);
    setCooldownMs(COOLDOWN_MS);
  });

  it('MONITOR_ONLY_KINDS は slope だけ(collector が書く種別を含んではならない)', () => {
    expect([...MONITOR_ONLY_KINDS].sort()).toEqual(['slope']);
  });
});
