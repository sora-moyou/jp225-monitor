import { describe, it, expect } from 'vitest';

// ─── ★「紙成績を外した」事実が台帳に残ること(D1 の記録側) ────────────────────────
//
// 何を守っているか:
//   生成器のプロンプトから A の紙成績を外した(母集団の独立性)。**1年後の分析者はそれを知る必要がある**。
//   monitor が応答に載せた contextOmitted を、生成器が推測せずそのまま台帳へ写す。
//   ★NULL は「外していない版で記録された標本」= 紙成績を見せていたことを意味する(混同しない)。
//
// ★否定対照: git show HEAD:server/generator/cycle.ts / server/db/generatorStore.ts に戻すと
//   「台帳に残る」「列がある」が赤(旧版はこの値をどこにも書かない)。

import { toProposalRow, type ArmOutcome } from './cycle.js';
import { openGeneratorDb, insertProposal, initGeneratorSchema } from '../db/generatorStore.js';

const req = { arm: 'candidate-a' as const, exitVariant: 'candidate-a' as const, promptVariant: 'v1' as const, seq: 1 };

function outcome(body: Record<string, unknown>): ArmOutcome {
  return {
    attempt: { status: 'plan', httpStatus: 200, skipReason: null, error: null, body },
    requestedAt: 1_767_000_000_000, respondedAt: 1_767_000_005_000, retryCount: 0, preRetryReason: null,
  };
}

describe('外した文脈ブロックを台帳に写す', () => {
  it('★応答の contextOmitted をそのまま行に写す', () => {
    const row = toProposalRow('g1:x', 'c1', req, outcome({
      ok: true, plan: { direction: 'buy' }, contextOmitted: ['paper-trade-history'],
    }));
    expect(row.contextOmittedJson).toBe('["paper-trade-history"]');
  });

  it('★応答に無ければ NULL(=外していない版の monitor と話した標本)', () => {
    const row = toProposalRow('g1:x', 'c1', req, outcome({ ok: true, plan: { direction: 'buy' } }));
    expect(row.contextOmittedJson).toBeNull();
  });

  it('台帳の列に落ちて、後から SQL で読める', () => {
    const db = openGeneratorDb(':memory:');
    const row = toProposalRow('g1:x', 'c1', req, outcome({
      ok: true, plan: { direction: 'sell' }, contextOmitted: ['paper-trade-history'],
    }));
    expect(insertProposal(db, row)).toBe(true);
    const got = db.prepare('SELECT context_omitted AS c FROM proposals').get() as { c: string | null };
    expect(got.c).toBe('["paper-trade-history"]');
    db.close();
  });

  it('★既に走っている台帳(列が無い旧版)に冪等で列を足す=記録が止まらない', () => {
    const db = openGeneratorDb(':memory:');
    // 旧版の形に戻す(実売買PCには数日ぶんの行が入った旧スキーマの台帳が既にある)。
    db.exec('ALTER TABLE proposals DROP COLUMN context_omitted');
    expect((db.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>).map(c => c.name))
      .not.toContain('context_omitted');

    // 新しい版で開き直したときに走るのと同じ関数。
    initGeneratorSchema(db);
    initGeneratorSchema(db);   // 2回呼んでも壊れない(冪等)
    expect((db.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>).map(c => c.name))
      .toContain('context_omitted');

    // 列が足されたので、新しい版の INSERT がそのまま通る(=記録が丸ごと止まらない)。
    const row = toProposalRow('g1:x', 'c9', req, outcome({
      ok: true, plan: { direction: 'buy' }, contextOmitted: ['paper-trade-history'],
    }));
    expect(insertProposal(db, row)).toBe(true);
    db.close();
  });
});
