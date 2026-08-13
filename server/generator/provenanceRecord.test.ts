import { describe, it, expect } from 'vitest';

// ─── ★分析用の台帳にも「文脈を組み立てた時刻」と「プロンプトの指紋」を残す ────────────
//
// 何を守っているか:
//   台帳が持つ requested_at / responded_at は **分析用プロセスの時計** の両端でしかなく、
//   その間には撮影と LLM の待ち(実測で秒オーダー)が入る。「monitor がどの断面から文脈を組んだか」は
//   monitor 側にしか無い値なので、応答で受け取ってそのまま写す(推測しない)。
//   指紋は一方向ハッシュで、プロンプト本文も非公開の決済仕様の数値も一切含まない。
//   ★NULL は「この2つを返さない版の monitor と話した標本」= 突合できない標本を意味する。
//
// ★否定対照: git show HEAD:server/generator/cycle.ts / server/db/generatorStore.ts に戻すと
//   「行に写る」「列がある」が赤(旧版はこの値をどこにも書かない)。

import { toProposalRow, type ArmOutcome } from './cycle.js';
import { openGeneratorDb, insertProposal, initGeneratorSchema } from '../db/generatorStore.js';

const req = { arm: 'candidate-a' as const, exitVariant: 'candidate-a' as const, promptVariant: 'v1' as const, seq: 1 };
const CONTEXT_AT = 1_767_000_002_500;
const FP = 'sp1:0123456789abcdef';

function outcome(body: Record<string, unknown>): ArmOutcome {
  return {
    attempt: { status: 'plan', httpStatus: 200, skipReason: null, error: null, body },
    requestedAt: 1_767_000_000_000, respondedAt: 1_767_000_005_000, retryCount: 0, preRetryReason: null,
  };
}

describe('計画の出所(文脈の時刻・プロンプトの指紋)を台帳に写す', () => {
  it('★応答の contextAt / promptFp をそのまま行に写す', () => {
    const row = toProposalRow('g1:x', 'c1', req, outcome({
      ok: true, plan: { direction: 'buy' }, contextAt: CONTEXT_AT, promptFp: FP,
    }));
    expect(row.contextAt).toBe(CONTEXT_AT);
    expect(row.promptFp).toBe(FP);
    // ★分析用の時計の両端とは別物(要求より後・応答より前に文脈が組まれている)。
    expect(row.contextAt).toBeGreaterThan(row.requestedAt);
    expect(row.contextAt).toBeLessThan(row.respondedAt!);
  });

  it('★応答に無ければ NULL(=この2つを返さない版の monitor と話した標本)', () => {
    const row = toProposalRow('g1:x', 'c1', req, outcome({ ok: true, plan: { direction: 'buy' } }));
    expect(row.contextAt).toBeNull();
    expect(row.promptFp).toBeNull();
  });

  it('台帳の列に落ちて、後から SQL で読める', () => {
    const db = openGeneratorDb(':memory:');
    const row = toProposalRow('g1:x', 'c1', req, outcome({
      ok: true, plan: { direction: 'sell' }, contextAt: CONTEXT_AT, promptFp: FP,
    }));
    expect(insertProposal(db, row)).toBe(true);
    const got = db.prepare('SELECT context_at AS a, prompt_fp AS f FROM proposals').get() as { a: number | null; f: string | null };
    expect(got.a).toBe(CONTEXT_AT);
    expect(got.f).toBe(FP);
    db.close();
  });

  it('★既に走っている台帳(列が無い旧版)に冪等で列を足す=記録が止まらない', () => {
    const db = openGeneratorDb(':memory:');
    db.exec('ALTER TABLE proposals DROP COLUMN context_at');
    db.exec('ALTER TABLE proposals DROP COLUMN prompt_fp');
    db.prepare(`INSERT INTO proposals (epoch, cycle_id, arm, exit_variant, seq, requested_at, status, retried, retry_count, created_at)
                VALUES ('g1:x','c0','current','current',0,1,'plan',0,0,1)`).run();

    initGeneratorSchema(db);
    initGeneratorSchema(db);   // 2回呼んでも壊れない(冪等)
    const cols = (db.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('context_at');
    expect(cols).toContain('prompt_fp');

    // 旧行は残り、新しい2列は NULL のまま。
    const old = db.prepare("SELECT context_at AS a, prompt_fp AS f FROM proposals WHERE cycle_id='c0'").get() as { a: number | null; f: string | null };
    expect(old.a).toBeNull();
    expect(old.f).toBeNull();

    // 列が足されたので、新しい版の INSERT がそのまま通る(=記録が丸ごと止まらない)。
    const row = toProposalRow('g1:x', 'c9', req, outcome({
      ok: true, plan: { direction: 'buy' }, contextAt: CONTEXT_AT, promptFp: FP,
    }));
    expect(insertProposal(db, row)).toBe(true);
    db.close();
  });
});
