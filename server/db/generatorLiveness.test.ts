import { describe, it, expect } from 'vitest';
import { openGeneratorDb, insertProposal, readGeneratorLedgerStatus, type ProposalRow } from './generatorStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── ★B1(死活): 指標を「プロセスが生きているか」から「標本が溜まっているか」へ ──────
//
// 何が壊れていたか:
//   死活表示は SELECT MAX(requested_at) を見ていた。ところが生成器はゲートに弾かれている間も
//   2分ごとに status='skipped' を書き続ける。だから **止まっている間も「最終記録」は新しいまま**で、
//   実売買PCの実ログでセッションの 91〜100% が停止していたのに表示は一度も警告に変わらなかった。
//   溜めたいのは提案(標本)であって行数ではない。→ 直近1時間の status='plan' の件数で判定する。
//
// ★否定対照(修正前 = git show HEAD:server/db/generatorStore.ts):
//   planLastHour / inSessionLastHour が存在しないので、下の3件が全部 **赤**。

const NOW = Date.UTC(2026, 5, 1, 1, 0);   // 2026-06-01 10:00 JST(Day セッション)

const row = (over: Partial<ProposalRow> = {}): ProposalRow => ({
  epoch: 'g1:abc', cycleId: 'c-1', arm: 'current', exitVariant: 'current', seq: 0,
  sessionDate: '2026-06-01', requestedAt: NOW - 60_000, respondedAt: NOW, latencyMs: 1,
  status: 'plan', skipReason: null, httpStatus: 200, error: null,
  retried: 0, retryCount: 0, preRetryReason: null,
  direction: 'none', planJson: '{}', refPrice: 1, regime: null, confidence: null,
  noneReason: 'ai', noneLegsJson: null, vetoFired: 0, rangeAnomalyJson: null,
  shotId: null, shotAgeMs: null, shotOrigin: null, createdAt: NOW,
  ...over,
});

function withDb(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'jp225-genlive2-'));
  try { fn(join(dir, 'generator_proposals.db')); }
  finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

describe('★死活は「標本が溜まっているか」で測る', () => {
  it('停止中(skipped を書き続けている)は「最終記録」は新しいのに標本は 0 と読める', () => {
    withDb((path) => {
      const db = openGeneratorDb(path);
      // 従属停止中の生成器がやること: 2分ごとに status='skipped' を書く。
      for (let i = 0; i < 30; i++) {
        insertProposal(db, row({
          cycleId: `halt-${i}`, requestedAt: NOW - i * 120_000,
          status: 'skipped', skipReason: 'default-quota', httpStatus: 429, planJson: null, direction: null,
        }));
      }
      db.close();
      const led = readGeneratorLedgerStatus(path, NOW);
      expect(led.available).toBe(true);
      expect(led.ageMin).toBe(0);              // ← 旧指標は「今も生きている」と言う
      expect(led.planLastHour).toBe(0);        // ★新指標は「標本は1件も取れていない」と言う
      expect(led.inSessionLastHour).toBeGreaterThan(0);   // 取引時間内なのに 0 件 = 異常
    });
  });

  it('正常に回っていれば直近1時間の標本が数えられる', () => {
    withDb((path) => {
      const db = openGeneratorDb(path);
      for (let i = 0; i < 30; i++) {
        insertProposal(db, row({ cycleId: `ok-${i}`, requestedAt: NOW - i * 120_000 }));
      }
      // 1時間より前の行は数えない(窓の外)。
      insertProposal(db, row({ cycleId: 'old', requestedAt: NOW - 3 * 3_600_000 }));
      db.close();
      const led = readGeneratorLedgerStatus(path, NOW);
      expect(led.planLastHour).toBe(30);       // 0分前〜58分前 = 30本(2分刻み)
      expect(led.total).toBe(30 + 1);
    });
  });

  it('取引時間外は inSessionLastHour が 0(標本 0 が異常ではないことが読める)', () => {
    withDb((path) => {
      const db = openGeneratorDb(path);
      for (let i = 0; i < 10; i++) {
        insertProposal(db, row({
          cycleId: `closed-${i}`, requestedAt: NOW - i * 120_000, sessionDate: null,
          status: 'skipped', skipReason: 'closed', httpStatus: 429, planJson: null, direction: null,
        }));
      }
      db.close();
      const led = readGeneratorLedgerStatus(path, NOW);
      expect(led.planLastHour).toBe(0);
      expect(led.inSessionLastHour).toBe(0);
    });
  });

  it('台帳が無い環境では **フィールドごと無い**(「0件」と「観測できない」を混同しない)', () => {
    const led = readGeneratorLedgerStatus(join(tmpdir(), 'jp225-does-not-exist', 'x.db'), NOW);
    expect(led.available).toBe(false);
    expect(led.planLastHour).toBeUndefined();
    expect(led.inSessionLastHour).toBeUndefined();
  });
});
