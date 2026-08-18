import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── ★v0.9.84: 戦略ラベルが「AI の生応答 → AiPlan → HTTP → 台帳の plan_json」まで届くか ──────
//
// 何を守っているか:
//   このプロジェクトの本体は ④AI が理由と共に提示 →⑤結果を正確に記録 →⑥それを AI に返す のループ。
//   ⑥が「押し目 12件 勝率33%」を返せるのは、⑤の台帳に **狙い(strategy)** が残っているときだけである。
//   plan_json は AiPlan を丸ごと JSON.stringify しているので「足せば自動で乗るはず」だが、
//   ★"はず" は測っていない。この配管は途中に **HTTP のシリアライズ** を挟むので、
//   実際に往復させて plan_json の中身を SELECT するところまでを1本のテストで固定する。
//
// ★否定対照: git show HEAD:server/llm/scalpPlan.ts に strategy / strategyWhy は無く、
//   parseScalpPlan はこの2つをどこにも載せない(=このファイルは全件赤になる)。
//
// ★signal_trades.meta(本線の決済台帳)には **流れない**。あちらは PlanMeta
//   (server/signalTrade/decisions.ts の regime / confidence / vetoFired の3つだけ)を経由するため、
//   AiPlan に足しただけでは載らない。★そこには足さない: PlanMeta は armed→position→decisions と
//   決済経路を貫いて持ち回る型で、触ると記録専用の範囲を超える。
//   代わりに **signal_plans.strategy / strategy_why**(server/db/signalPlanStrategy.test.ts)に置き、
//   pnl を持つ signal_trades とは (system, signal_id) で結合して戦略別の成績を作る。

import { parseScalpPlan } from '../llm/scalpPlan.js';
import { buildPlanMeta } from '../signalTrade/decisions.js';
import { toProposalRow, type ArmOutcome } from './cycle.js';
import { openGeneratorDb, insertProposal } from '../db/generatorStore.js';

const REF = 38250;
const req = { arm: 'prompt-v1e' as const, exitVariant: 'current' as const, promptVariant: 'v1e' as const, seq: 1 };

/** LLM が返した生テキスト(strategy / strategyWhy を含む JSON)。 */
const RAW = JSON.stringify({
  regime: 'trend_up', confidence: 70,
  strategy: 'トレンド押し目・戻り',
  strategyWhy: '上昇トレンド中、S1まで引きつけて反発を取る',
  direction: 'buy', limitEntry: 38200, stopEntry: 38350,
  lcWidthForLimit: 55, lcWidthForStop: 60,
  rationale: '押し目。指値レッグ: 38200-38145=55円。ブレイク新規レッグ: 38350-38290=60円。',
  refPrice: REF,
});

function outcome(body: Record<string, unknown>): ArmOutcome {
  return {
    attempt: { status: 'plan', httpStatus: 200, skipReason: null, error: null, body },
    requestedAt: 1_767_000_000_000, respondedAt: 1_767_000_005_000, retryCount: 0, preRetryReason: null,
  };
}

const dirs: string[] = [];
/** ★実ファイルの SQLite(:memory: ではなく、実運用と同じ経路で開く)。 */
function fileDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'genstrategy-'));
  dirs.push(dir);
  return openGeneratorDb(join(dir, 'generator_proposals.db'));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('戦略ラベル: 生応答 → AiPlan → HTTP → proposals.plan_json', () => {
  it('★実ファイル SQLite の plan_json に strategy / strategyWhy がそのまま入る', () => {
    // ① AI の生応答をパース(monitor 側)。
    const parsed = parseScalpPlan(RAW, REF);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.strategy).toBe('トレンド押し目・戻り');

    // ② /api/scalp-plan の応答と同じ形にして **実際に JSON を往復させる**(型ではなく配線を見る)。
    const body = JSON.parse(JSON.stringify({ ok: true, plan: parsed.plan })) as Record<string, unknown>;

    // ③ 分析用サイドカーが行にする → ④ 実ファイルの台帳へ書く → ⑤ SELECT で読み戻す。
    const row = toProposalRow('g1:x', 'c1', req, outcome(body));
    const db = fileDb();
    expect(insertProposal(db, row)).toBe(true);
    const got = db.prepare('SELECT plan_json, regime, confidence FROM proposals').get() as
      { plan_json: string; regime: string | null; confidence: number | null };
    const plan = JSON.parse(got.plan_json) as Record<string, unknown>;
    expect(plan.strategy).toBe('トレンド押し目・戻り');
    expect(plan.strategyWhy).toBe('上昇トレンド中、S1まで引きつけて反発を取る');
    // 既存の列は不変(記録専用の追加が既存の写しを壊していない)。
    expect(got.regime).toBe('trend_up');
    expect(got.confidence).toBe(70);
    expect(plan.direction).toBe('buy');
    expect(plan.limitEntry).toBe(38200);
    db.close();
  });

  it('ラベルが無い応答でも台帳は今までどおり書ける(欠測は欠測として残る)', () => {
    const parsed = parseScalpPlan(JSON.stringify({
      direction: 'none', rationale: '見送り', refPrice: REF,
    }), REF);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const body = JSON.parse(JSON.stringify({ ok: true, plan: parsed.plan, noneReason: parsed.noneReason }));
    const db = fileDb();
    expect(insertProposal(db, toProposalRow('g1:x', 'c2', req, outcome(body)))).toBe(true);
    const got = db.prepare('SELECT plan_json, none_reason FROM proposals').get() as
      { plan_json: string; none_reason: string | null };
    const plan = JSON.parse(got.plan_json) as Record<string, unknown>;
    expect('strategy' in plan).toBe(false);
    expect(got.none_reason).toBe('ai');
    db.close();
  });

  it('★signal_trades.meta には流れない(PlanMeta 経由=regime/confidence/vetoFired の3つだけ)', () => {
    // ★ここには足さない(決済経路を貫く型なので記録専用の範囲を超える)。狙いは signal_plans 側に置き、
    //   pnl を持つ signal_trades とは (system, signal_id) で結合する(signalPlanStrategy.test.ts が実証)。
    const meta = buildPlanMeta('trend_up', 70, false);
    expect(Object.keys(meta ?? {}).sort()).toEqual(['confidence', 'regime', 'vetoFired']);
    expect(meta).not.toHaveProperty('strategy');
  });
});
