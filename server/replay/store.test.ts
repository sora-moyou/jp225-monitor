// オフライン再生の記録側(覆域・再開カーソル)の検証。
//
// ★否定対照(この機能を実装する前のコードでの結果):
//   - server/replay/store.ts が無いため import 段で解決できず、このファイルは全部赤。
//   - UNIQUE に時刻(created_at / done_at)を含めた実装、または INSERT OR IGNORE でない実装では
//     『同じ内容を2回書いても増えない』が赤になる(冪等性の否定対照)。
//   - 完了印にラダーの版を含めない実装では『版が変われば同じ日をもう一度再生する』が赤になる。

import { describe, it, expect } from 'vitest';
import { openShadowDb } from '../db/shadowStore.js';
import {
  initReplaySchema, isDayReplayed, recordReplayDay, recordCoverage,
  countReplayDays, countCoverage, coverageTotals, type CoverageRow, type ReplayDayRow,
} from './store.js';

const day: ReplayDayRow = {
  sessionDate: '2026-06-01', ladderEpoch: 'e1',
  windowFrom: 1, windowTo: 2, ticks: 3, proposals: 4, opened: 5, rowsWritten: 6, doneAt: 7,
};
const cov: CoverageRow = {
  sessionDate: '2026-06-01', ladderEpoch: 'e1', epoch: 'g1:x', reason: 'replayed', n: 3, detail: null,
};

describe('再開カーソル(取引日の完了印)', () => {
  it('同じ日を2回書いても増えない(時刻の列は一意キーに入れない)', () => {
    const db = openShadowDb(':memory:');
    initReplaySchema(db);
    expect(recordReplayDay(db, day)).toBe(true);
    expect(recordReplayDay(db, { ...day, doneAt: 999, ticks: 9999 })).toBe(false);
    expect(countReplayDays(db)).toBe(1);
    expect(isDayReplayed(db, '2026-06-01', 'e1')).toBe(true);
    db.close();
  });

  it('影ラダーの版が変われば、同じ日でもまだ再生していない扱いになる', () => {
    const db = openShadowDb(':memory:');
    initReplaySchema(db);
    recordReplayDay(db, day);
    expect(isDayReplayed(db, '2026-06-01', 'e2')).toBe(false);
    expect(recordReplayDay(db, { ...day, ladderEpoch: 'e2' })).toBe(true);
    expect(countReplayDays(db)).toBe(2);
    db.close();
  });
});

describe('覆域(何件・なぜ)', () => {
  it('同じ (日・ラダー版・提案版・理由) は1行だけ(2回書いても増えない)', () => {
    const db = openShadowDb(':memory:');
    initReplaySchema(db);
    expect(recordCoverage(db, [cov], 100)).toEqual({ inserted: 1, skipped: 0 });
    expect(recordCoverage(db, [{ ...cov, n: 99 }], 200)).toEqual({ inserted: 0, skipped: 1 });
    expect(countCoverage(db)).toBe(1);
    db.close();
  });

  it('提案の epoch と 影ラダーの epoch を別々に持つ(別物なので混ぜない)', () => {
    const db = openShadowDb(':memory:');
    initReplaySchema(db);
    recordCoverage(db, [cov, { ...cov, epoch: 'g1:y' }, { ...cov, reason: 'no-ticks', n: 2 }], 100);
    expect(countCoverage(db)).toBe(3);
    expect(coverageTotals(db, 'e1')).toEqual([{ reason: 'replayed', n: 6 }, { reason: 'no-ticks', n: 2 }]);
    expect(coverageTotals(db, 'e2')).toEqual([]);
    db.close();
  });
});
