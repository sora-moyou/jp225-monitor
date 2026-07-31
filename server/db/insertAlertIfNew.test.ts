import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, insertAlertIfNew, getRecentAlerts, ALERT_DEDUP_PRICE_YEN, type AlertInsert } from './store.js';
import { LEVELS_TUNING } from '../detect/registry.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }
const base: AlertInsert = {
  symbol: 'NIY=F', triggeredAt: 1_000_000, direction: 'up', detectionKind: 'slope',
  windowSeconds: 60, changePercent: 0.4, price: 30000, sessionDate: '2026-06-02', session: 'Day',
};

describe('insertAlertIfNew', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); });

  it('inserts when no recent duplicate', () => {
    expect(insertAlertIfNew(db, base, 120_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('suppresses a duplicate within the window (same symbol/dir/kind/window)', () => {
    insertAlertIfNew(db, base, 120_000);
    const dup = { ...base, triggeredAt: base.triggeredAt + 90_000 };
    expect(insertAlertIfNew(db, dup, 120_000)).toBe(false);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('allows a distinct direction within the window', () => {
    insertAlertIfNew(db, base, 120_000);
    const opp = { ...base, direction: 'down', triggeredAt: base.triggeredAt + 30_000 };
    expect(insertAlertIfNew(db, opp, 120_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });

  it('allows the same alert again after the window elapses', () => {
    insertAlertIfNew(db, base, 120_000);
    const later = { ...base, triggeredAt: base.triggeredAt + 200_000 };
    expect(insertAlertIfNew(db, later, 120_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });
});

// ═══ 作業G: 近接重複の判定キーに reference_price(基準水準)を含める ═══
//
// 修正前は symbol+direction+detection_kind+window_seconds だけで判定していたため、
// 「60秒以内の 別水準 の同種同方向」(例: 64,200 の上抜けと 64,500 の上抜け)が消えていた。
// これは重複排除ではなくデータ損失。UNIQUE 索引 idx_alerts_identity は元々 reference_price を
// 同一性に含めており(server/db/alertDedup.test.ts)、この関数だけが食い違っていた。
//
// 判定は「完全一致」ではなく検知器と同じ ±ALERT_DEDUP_PRICE_YEN(=40円)ゾーン。理由は store.ts の
// ALERT_DEDUP_PRICE_YEN の注記(検知器は ±40円の水準を1本に畳み、emit クールダウンキーも 40円ゾーン。
// 一方 dailyband/dailyMa の基準価格は現値込みで毎ティック再計算され、writer 間の数秒差で数円ずれる)。
describe('insertAlertIfNew: 基準水準(reference_price)を判定キーに含める', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); });

  const lvl = (price: number | null, over: Partial<AlertInsert> = {}): AlertInsert => ({
    ...base, detectionKind: 'break', windowSeconds: 60,
    referenceKind: price == null ? null : 'level', referencePrice: price, ...over,
  });

  // ★中核(否定対照): 修正前のコードでは 2件目が重複扱いで消え、1行になって赤くなる。
  it('60秒以内の「別水準・同種同方向」は両方残る(データ損失を起こさない)', () => {
    expect(insertAlertIfNew(db, lvl(64_200), 60_000)).toBe(true);
    expect(insertAlertIfNew(db, lvl(64_500, { triggeredAt: base.triggeredAt + 8_000 }), 60_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });

  // ★作業F(collector 8秒化)後の実運用形: 8秒刻みで別水準が連続しても1件も落とさない。
  it('8秒刻みで別水準が続いても全件残る(作業F でこの関数の呼び出しが 7.5倍になる)', () => {
    const prices = [64_100, 64_200, 64_300, 64_400, 64_500];
    prices.forEach((p, i) => expect(insertAlertIfNew(db, lvl(p, { triggeredAt: base.triggeredAt + i * 8_000 }), 60_000)).toBe(true));
    expect(getRecentAlerts(db, 20).length).toBe(prices.length);
  });

  // ★過剰修正の防止: 本来の目的(monitor⇔collector の同一検知の双子つぶし)は維持する。
  it('同一水準の双子(完全一致)は従来どおり1行', () => {
    insertAlertIfNew(db, lvl(64_200), 60_000);
    expect(insertAlertIfNew(db, lvl(64_200, { triggeredAt: base.triggeredAt + 30_000 }), 60_000)).toBe(false);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  // dailyband/dailyMa の基準価格は現値込みの移動平均なので、writer 間の数秒差で数円ずれる。
  // 完全一致キーだとこの種別の双子だけがすり抜ける(dailyband は実測で level 系発火の約1/4)。
  it('数円ずれた双子(MA 系の基準価格)も同一水準として1行', () => {
    insertAlertIfNew(db, lvl(63_812, { detectionKind: 'dailyband', referenceKind: 'ma5' }), 60_000);
    const twin = lvl(63_824, { detectionKind: 'dailyband', referenceKind: 'ma5', triggeredAt: base.triggeredAt + 6_000 });
    expect(insertAlertIfNew(db, twin, 60_000)).toBe(false);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('ゾーン境界: ちょうど 40円差は同一・41円差は別水準', () => {
    insertAlertIfNew(db, lvl(64_200), 60_000);
    expect(insertAlertIfNew(db, lvl(64_240, { triggeredAt: base.triggeredAt + 4_000 }), 60_000)).toBe(false);
    expect(insertAlertIfNew(db, lvl(64_241, { triggeredAt: base.triggeredAt + 4_000 }), 60_000)).toBe(true);
  });

  it('基準価格を持たない種別(両方 NULL)は従来どおり近接1行', () => {
    insertAlertIfNew(db, lvl(null, { detectionKind: 'shock' }), 60_000);
    expect(insertAlertIfNew(db, lvl(null, { detectionKind: 'shock', triggeredAt: base.triggeredAt + 20_000 }), 60_000)).toBe(false);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('片方だけ NULL は別物として残す(取りこぼしより残す側に倒す)', () => {
    insertAlertIfNew(db, lvl(null, { detectionKind: 'shock' }), 60_000);
    expect(insertAlertIfNew(db, lvl(64_200, { detectionKind: 'shock', triggeredAt: base.triggeredAt + 20_000 }), 60_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });

  // ★SSOT: ゾーン幅は検知器の「同じ水準」の定義そのもの。片方だけ変わると、
  //   検知器が別物として出した水準を DB 側が握り潰す(または双子が残る)。
  it('ゾーン幅は検知器の LEVEL_MERGE_YEN と同一', () => {
    expect(ALERT_DEDUP_PRICE_YEN).toBe(LEVELS_TUNING.levelMergeYen);
  });
});
