// オフライン再生の **入力側**(提案の台帳・保管ティック)。
//
// ■ ★入力DBは必ず readOnly で開く
//   生成器(提案の台帳)と価格ループ(ティック保管)は **書いている最中** かもしれない。
//   再生は分析であって、原本を1バイトも変えてよい理由がない。読み書きで開くと
//   スキーマ初期化・WAL チェックポイント・うっかりの UPDATE で原本に触れる余地が残る。
//   → 開き方の側で不可能にする(規律ではなく機構で担保する)。
//   ★readOnly で開けなかったら **読み書きに落とさない**。落とすくらいなら止まる方がよい。
//
// ■ 何を再実装しないか
//   ティックの読み出しは db/tickArchive.ts の getArchiveTicks を **そのまま呼ぶ**(SELECT を書き写さない)。
//   セッション日 ↔ 実時刻の対応も同ファイルの sessionDateRange / isSessionDateFinalized を使う。

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import type { AiPlan } from '../llm/scalpPlan.js';

/** DB を **読み取り専用** で開く。開けなければ throw(黙って読み書きに落とさない)。
 *  readOnly は node 24 ランタイムにあるが @types/node@20 の型に無いためキャストで通す
 *  (db/mergeDb.ts / db/generatorStore.ts と同じ作法)。 */
export function openReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`入力DBが見つかりません(readOnly): ${path}`);
  const opts = { readOnly: true } as unknown as ConstructorParameters<typeof DatabaseSync>[1];
  return new DatabaseSync(path, opts);
}

/** 再生の入力になる提案1件(台帳 proposals の1行 + 派生値)。 */
export interface ReplayProposal {
  /** ★提案の epoch(生成器の版)。影の epoch(決済ラダーの版)とは **別物**。 */
  epoch: string;
  cycleId: string;
  arm: string;
  /** 影の proposalId。台帳の一意キー(epoch, cycle_id, arm)をそのまま連結したもの=
   *  影の行から提案の行へ必ず結合できる(影の行には提案の epoch を入れる列が無いため、ここに載せる)。 */
  id: string;
  /** 武装時刻。A は「AI の応答が解決した瞬間」に ARM するので responded_at(無ければ requested_at)。 */
  armedT: number;
  direction: string;
  /** 台帳に載っている AiPlan。壊れた JSON は null(理由つきで数える)。 */
  plan: AiPlan | null;
  /** plan_json が壊れていた等の理由(null=正常)。 */
  planError: string | null;
  /** トレンド veto の発火(A が planToArmed に渡す extra と同じもの)。台帳に無ければ undefined。 */
  vetoFired: boolean | undefined;
  sessionDate: string | null;
}

/** 台帳の1行 → 再生の入力(純関数・テスト対象)。 */
export function toReplayProposal(r: {
  epoch: string; cycle_id: string; arm: string; direction: string;
  plan_json: string | null; veto_fired: number | null; session_date: string | null;
  armed_t: number;
}): ReplayProposal {
  let plan: AiPlan | null = null;
  let planError: string | null = null;
  if (r.plan_json == null) {
    planError = 'plan_json が無い';
  } else {
    try {
      const parsed = JSON.parse(r.plan_json) as unknown;
      if (parsed && typeof parsed === 'object') plan = parsed as AiPlan;
      else planError = 'plan_json がオブジェクトでない';
    } catch (e) {
      planError = `plan_json を解釈できない: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return {
    epoch: r.epoch,
    cycleId: r.cycle_id,
    arm: r.arm,
    id: `${r.epoch}/${r.cycle_id}/${r.arm}`,
    armedT: r.armed_t,
    direction: r.direction,
    plan,
    planError,
    vetoFired: r.veto_fired == null ? undefined : r.veto_fired === 1,
    sessionDate: r.session_date,
  };
}

/** 影を作りうる提案の direction(見送り none とエラー行は最初から対象外)。
 *  range も **数えるために** 拾う(対象外にした件数を無音にしないため)。 */
const REPLAYABLE_DIRECTIONS = "('buy','sell','range')";

/** 武装時刻の式(responded_at 無しは requested_at)。SQL とテストで1か所に持つ。 */
const ARMED_T_SQL = 'COALESCE(responded_at, requested_at)';

/** 武装時刻が [fromT, toT) に入る提案を、**武装時刻の昇順**(同時刻は id 昇順)で読む。
 *  ★順序を完全に決めるのは再生の決定性のため(同じ入力なら常に同じ順で開く)。 */
export function readProposals(db: DatabaseSync, fromT: number, toT: number): ReplayProposal[] {
  const rows = db.prepare(
    `SELECT epoch, cycle_id, arm, direction, plan_json, veto_fired, session_date,
            ${ARMED_T_SQL} AS armed_t
       FROM proposals
      WHERE direction IN ${REPLAYABLE_DIRECTIONS}
        AND ${ARMED_T_SQL} >= ? AND ${ARMED_T_SQL} < ?`,
  ).all(fromT, toT) as unknown as Array<Parameters<typeof toReplayProposal>[0]>;
  return rows.map(toReplayProposal).sort((a, b) => (a.armedT - b.armedT) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 影を作りうる提案が在る取引日の一覧(古い順)。 */
export function readCandidateDays(db: DatabaseSync): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT session_date AS d FROM proposals
      WHERE direction IN ${REPLAYABLE_DIRECTIONS} AND session_date IS NOT NULL
      ORDER BY d ASC`,
  ).all() as unknown as Array<{ d: string }>;
  return rows.map(r => r.d);
}

/** 台帳の全提案を direction 別に数える(見送り none / エラー行も含む)。
 *  ★再生の入口で出す「母数」。「影が少ない」の答え合わせは、まず母数から始まる。 */
export function countProposalsByDirection(db: DatabaseSync): Array<{ direction: string; n: number }> {
  return db.prepare(
    `SELECT COALESCE(direction, '(なし)') AS direction, COUNT(*) AS n FROM proposals
      GROUP BY direction ORDER BY n DESC, direction`,
  ).all() as unknown as Array<{ direction: string; n: number }>;
}

/** 取引日が付いていない(=場外に記録された)提案の件数。**0 でないなら覆えない標本が在る**ので数える。 */
export function countProposalsWithoutSessionDate(db: DatabaseSync): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM proposals WHERE direction IN ${REPLAYABLE_DIRECTIONS} AND session_date IS NULL`,
  ).get() as { n: number }).n;
}
