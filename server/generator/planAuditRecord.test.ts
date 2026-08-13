import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── ★分析用の台帳にも、本線と同じ「根拠文の突き合わせ」を残す ────────────────────
//
// 何を守っているか:
//   monitor の signal_plans には lc_audit_json(申告 LC幅 vs 実出力)が入るのに、分析用の
//   proposals には無かった。同じ故障は分析用側にも出るので、**母集団が揃わないと腕どうしで
//   比べられない**(A/B の主指標が片側にしか無い状態だった)。
//   配管は contextAt / promptFp と同じ経路(応答をそのまま写す・推測しない)。
//   omission_audit_json(「出さない」表明 vs 実際に発注されるレッグ)も同じ経路で足す。
//
// ★否定対照: git show HEAD:server/db/generatorStore.ts に lc_audit_json / omission_audit_json 列は無く、
//   git show HEAD:server/generator/cycle.ts はこの2つをどこにも書かない(=このファイルは全件赤)。

import { toProposalRow, type ArmOutcome } from './cycle.js';
import { openGeneratorDb, insertProposal, initGeneratorSchema } from '../db/generatorStore.js';

const req = { arm: 'candidate-a' as const, exitVariant: 'candidate-a' as const, promptVariant: 'v1' as const, seq: 1 };
const LC_AUDIT = [
  { leg: 'limit', entry: 38300, stopLoss: 38355, actualYen: 55, declaredYen: 55, status: 'match', source: 'width' },
  { leg: 'stop', entry: 38200, stopLoss: 38205, actualYen: 5, declaredYen: 55, status: 'mismatch', source: 'width' },
];
const OMISSION = [{ leg: 'limit', word: '省略', present: true, status: 'contradiction' }];

function outcome(body: Record<string, unknown>): ArmOutcome {
  return {
    attempt: { status: 'plan', httpStatus: 200, skipReason: null, error: null, body },
    requestedAt: 1_767_000_000_000, respondedAt: 1_767_000_005_000, retryCount: 0, preRetryReason: null,
  };
}

const dirs: string[] = [];
/** ★実ファイルの SQLite(:memory: ではなく、実運用と同じ経路で開く)。 */
function fileDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'genaudit-'));
  dirs.push(dir);
  return openGeneratorDb(join(dir, 'generator_proposals.db'));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('分析用の台帳: 根拠文の突き合わせ2種を行に写す', () => {
  it('★応答の lcAudit / omissionAudit をそのまま JSON にして行に写す', () => {
    const row = toProposalRow('g1:x', 'c1', req, outcome({
      ok: true, plan: { direction: 'sell' }, lcAudit: LC_AUDIT, omissionAudit: OMISSION,
    }));
    expect(JSON.parse(row.lcAuditJson!)).toEqual(LC_AUDIT);
    expect(JSON.parse(row.omissionAuditJson!)).toEqual(OMISSION);
  });

  it('★応答に無ければ NULL(=この列を返さない版の monitor と話した or 観測0件)', () => {
    const row = toProposalRow('g1:x', 'c1', req, outcome({ ok: true, plan: { direction: 'buy' } }));
    expect(row.lcAuditJson).toBeNull();
    expect(row.omissionAuditJson).toBeNull();
  });

  it('★実ファイルの台帳に列として落ちて、後から SQL で読める', () => {
    const db = fileDb();
    const row = toProposalRow('g1:x', 'c1', req, outcome({
      ok: true, plan: { direction: 'sell' }, lcAudit: LC_AUDIT, omissionAudit: OMISSION,
    }));
    expect(insertProposal(db, row)).toBe(true);
    const got = db.prepare('SELECT lc_audit_json AS lc, omission_audit_json AS om FROM proposals')
      .get() as { lc: string | null; om: string | null };
    expect(JSON.parse(got.lc!)).toEqual(LC_AUDIT);
    expect(JSON.parse(got.om!)).toEqual(OMISSION);
    // ★本線(signal_plans)と同じ SQL で「食い違った回」を数えられる(母集団が揃う)。
    const n = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE lc_audit_json LIKE '%mismatch%'")
      .get() as { n: number };
    expect(n.n).toBe(1);
    db.close();
  });

  it('★既に走っている台帳(列が無い旧版)に冪等で列を足す=記録が止まらない', () => {
    const db = fileDb();
    db.exec('ALTER TABLE proposals DROP COLUMN lc_audit_json');
    db.exec('ALTER TABLE proposals DROP COLUMN omission_audit_json');
    db.prepare(`INSERT INTO proposals (epoch, cycle_id, arm, exit_variant, seq, requested_at, status, retried, retry_count, created_at)
                VALUES ('g1:x','c0','current','current',0,1,'plan',0,0,1)`).run();

    initGeneratorSchema(db);
    initGeneratorSchema(db);   // 2回呼んでも壊れない(冪等)
    const cols = (db.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('lc_audit_json');
    expect(cols).toContain('omission_audit_json');

    // 旧行は残り、新しい2列は NULL のまま(=「この列を持たない版で記録された」)。
    const old = db.prepare("SELECT lc_audit_json AS lc, omission_audit_json AS om FROM proposals WHERE cycle_id='c0'")
      .get() as { lc: string | null; om: string | null };
    expect(old.lc).toBeNull();
    expect(old.om).toBeNull();

    // 列が足されたので、新しい版の INSERT がそのまま通る(=記録が丸ごと止まらない)。
    const row = toProposalRow('g1:x', 'c9', req, outcome({
      ok: true, plan: { direction: 'sell' }, lcAudit: LC_AUDIT, omissionAudit: OMISSION,
    }));
    expect(insertProposal(db, row)).toBe(true);
    const got = db.prepare("SELECT lc_audit_json AS lc FROM proposals WHERE cycle_id='c9'").get() as { lc: string | null };
    expect(JSON.parse(got.lc!)).toEqual(LC_AUDIT);
    db.close();
  });
});
