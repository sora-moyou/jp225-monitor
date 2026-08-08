// 1サイクル(①→①'→②)の組み立てと実行。**取引はしない**。AI にエントリー計画を要求し、
// 提案を全数記録するだけ。約定判定・影の決済模擬は **オフラインの再生** で後から行う(範囲外)。
//
// ■ なぜ【直列】か
//   ①(現行の決済仕様を教える)と②(候補の決済仕様を教える)を別スケジュールにすると、
//   違う時刻・違う相場を見るので、提案の差に **市場変動が混ざる**。直列なら monitor 側の
//   撮影キャッシュ(60秒・生成器プール)を3本で共有でき、①②が同じ画像を見た対応比較になる。
//   generatorGate の busy 衝突も自分同士では起きない。
//
// ■ なぜ ①' が3本目の生成器でないか
//   別に走らせると違う時刻を見るので、LLM のばらつきに市場変動が混ざる。
//   **同じ入力に2回問う** のが定義どおりの対照。だから同じサイクルの中で、同じ exitVariant を送る。
//
// ■ ★429-busy の再試行(欠測をランダムにするため)
//   busy は「A がプラン生成中」に立つ。A が要求を出すのは「flat かつ間隔経過かつ抑止アンカーが無い」
//   = **まさに入る可能性がある瞬間**。無策だと台帳は A が行動する瞬間を系統的に取りこぼし、
//   欠測がランダムでなくなる。だから 15〜20秒後に1回だけ再試行し、再試行の有無と1回目の理由を残す
//   (後から欠測の性質そのものを検定できるように)。

import { classifySession } from '../../core/session.js';
import { DEFAULT_EXIT_VARIANT, type ExitVariant } from '../signalTrade/exit/index.js';
import type { AiPlan } from '../llm/scalpPlan.js';
import {
  CONTROL_ARM, CONTROL_EXIT_VARIANT,
  type GeneratorArm, type ProposalRow, type ProposalStatus,
} from '../db/generatorStore.js';
import type { GeneratorConfig } from './config.js';
import type { Fetcher } from './preflight.js';

/** 候補の腕。★変種の一覧そのものではなく「この実験が回す腕」を明示する。 */
const CANDIDATE_EXIT_VARIANT: ExitVariant = 'candidate-a';

/** 1サイクルの中の1要求。 */
export interface ArmRequest {
  arm: GeneratorArm;
  /** 実際に送る変種。対照は①と同一('current')。 */
  exitVariant: ExitVariant;
  /** サイクル内の直列順(0 起点)。 */
  seq: number;
}

/** ★1サイクルの構成(純関数)。
 *  ① 'current' → ①' 対照(controlEvery サイクルに1回) → ② 'candidate-a' の **この順** で直列。 */
export function planCycleArms(cycleIndex: number, controlEvery: number): ArmRequest[] {
  const out: ArmRequest[] = [
    { arm: DEFAULT_EXIT_VARIANT, exitVariant: DEFAULT_EXIT_VARIANT, seq: 0 },
  ];
  if (controlEvery > 0 && cycleIndex % controlEvery === 0) {
    out.push({ arm: CONTROL_ARM, exitVariant: CONTROL_EXIT_VARIANT, seq: out.length });
  }
  out.push({ arm: CANDIDATE_EXIT_VARIANT, exitVariant: CANDIDATE_EXIT_VARIANT, seq: out.length });
  return out;
}

/** 1回の要求の結末(記録に落とす前の生の分類)。 */
export interface Attempt {
  status: ProposalStatus;
  httpStatus: number | null;
  skipReason: string | null;
  error: string | null;
  /** 200 応答の本体(記録の抽出元)。それ以外は null。 */
  body: Record<string, unknown> | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** ★HTTP の結末を「理由別」に分類する純関数。黙って1種類にまとめない。 */
export function classifyAttempt(httpStatus: number, bodyJson: unknown): Attempt {
  const body = bodyJson && typeof bodyJson === 'object' ? bodyJson as Record<string, unknown> : null;
  if (httpStatus === 200) {
    if (body && body.ok === true) return { status: 'plan', httpStatus, skipReason: null, error: null, body };
    // 200 + ok:false = チャート未生成 / LLM 失敗 / キー無し。見送りも1標本なので理由ごと残す。
    return {
      status: 'plan-error', httpStatus,
      skipReason: null, error: str(body?.error) ?? 'unknown', body,
    };
  }
  if (httpStatus === 429) {
    // 生成器ゲート(busy / budget / default-quota / disabled)と場外(closed)。
    return { status: 'skipped', httpStatus, skipReason: str(body?.error) ?? 'unknown', error: str(body?.detail), body: null };
  }
  return {
    status: 'http-error', httpStatus,
    skipReason: httpStatus === 400 ? 'bad-request' : `http-${httpStatus}`,
    error: str(body?.error), body: null,
  };
}

export interface CycleDeps {
  fetcher: Fetcher;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 再試行待ちのゆらぎ用(0..1)。テストでは固定値を注入する。 */
  random: () => number;
}

/** 1回だけ HTTP を投げる。到達不能/タイムアウトも **理由つきの結末** にする(例外を外へ出さない)。 */
async function attemptOnce(cfg: GeneratorConfig, dep: CycleDeps, req: ArmRequest): Promise<Attempt> {
  try {
    const res = await dep.fetcher(`${cfg.monitorUrl}/api/scalp-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // ★caller と exitVariant だけを送る。決済の実数値はリクエストに載せない(名前だけ)。
      body: JSON.stringify({ caller: 'generator', exitVariant: req.exitVariant }),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return classifyAttempt(res.status, json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|aborted/i.test(msg);
    return {
      status: timedOut ? 'timeout' : 'network-error',
      httpStatus: null, skipReason: null, error: msg.slice(0, 200), body: null,
    };
  }
}

export interface ArmOutcome {
  attempt: Attempt;
  requestedAt: number;
  respondedAt: number;
  retryCount: number;
  preRetryReason: string | null;
}

/** 1腕ぶんを実行する。**429-busy のときだけ** 15〜20秒後に1回だけ再試行する。 */
export async function runArm(cfg: GeneratorConfig, dep: CycleDeps, req: ArmRequest): Promise<ArmOutcome> {
  const requestedAt = dep.now();
  let attempt = await attemptOnce(cfg, dep, req);
  let retryCount = 0;
  let preRetryReason: string | null = null;
  if (attempt.status === 'skipped' && attempt.skipReason === 'busy') {
    preRetryReason = 'busy';
    const wait = cfg.retryMinMs + Math.floor(dep.random() * Math.max(1, cfg.retryMaxMs - cfg.retryMinMs + 1));
    console.log(`[generator] 429 busy(腕 ${req.arm}) — ${Math.round(wait / 1000)}秒後に1回だけ再試行`);
    await dep.sleep(wait);
    attempt = await attemptOnce(cfg, dep, req);
    retryCount = 1;
  }
  return { attempt, requestedAt, respondedAt: dep.now(), retryCount, preRetryReason };
}

function jsonOrNull(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

/** 結末を台帳の1行にする純関数(**提案そのもの・見送り理由・撮影の同一性を漏れなく写す**)。 */
export function toProposalRow(
  epoch: string, cycleId: string, req: ArmRequest, outcome: ArmOutcome,
): ProposalRow {
  const b = outcome.attempt.body;
  const plan = (b?.plan ?? null) as AiPlan | null;
  const shot = (b?.chartShot ?? null) as { shotId?: unknown; ageMs?: unknown; origin?: unknown } | null;
  const session = classifySession(outcome.requestedAt);
  // ★変種のエコーが送った名前と違えば、実験は測っているつもりのものを測っていない。無音にしない。
  const echoed = str(b?.exitVariant);
  const mismatch = echoed !== null && echoed !== req.exitVariant
    ? `variant-mismatch: 送信 ${req.exitVariant} / 応答 ${echoed}`
    : null;
  if (mismatch) console.error(`[generator] ★${mismatch}(この標本は候補仕様を測っていない可能性)`);
  return {
    epoch,
    cycleId,
    arm: req.arm,
    exitVariant: req.exitVariant,
    seq: req.seq,
    sessionDate: session?.sessionDate ?? null,
    requestedAt: outcome.requestedAt,
    respondedAt: outcome.respondedAt,
    latencyMs: outcome.respondedAt - outcome.requestedAt,
    status: outcome.attempt.status,
    skipReason: outcome.attempt.skipReason,
    httpStatus: outcome.attempt.httpStatus,
    error: mismatch ?? outcome.attempt.error,
    retried: outcome.retryCount > 0 ? 1 : 0,
    retryCount: outcome.retryCount,
    preRetryReason: outcome.preRetryReason,
    direction: str(plan?.direction),
    planJson: jsonOrNull(plan),
    refPrice: typeof plan?.refPrice === 'number' ? plan.refPrice : null,
    regime: str(plan?.regime),
    confidence: typeof plan?.confidence === 'number' ? plan.confidence : null,
    noneReason: str(b?.noneReason),
    noneLegsJson: jsonOrNull(b?.noneLegs),
    // ★レッグ1本ごとの脱落理由(片レッグだけ落ちた回を含む)。応答に無ければ NULL
    //   = この列を返さない版の monitor と話した or 1本も落ちなかった。
    legDropsJson: Array.isArray(b?.legDrops) ? JSON.stringify(b.legDrops) : null,
    vetoFired: typeof b?.vetoFired === 'boolean' ? (b.vetoFired ? 1 : 0) : null,
    rangeAnomalyJson: jsonOrNull(b?.rangeAnomaly),
    shotId: str(shot?.shotId),
    shotAgeMs: typeof shot?.ageMs === 'number' ? shot.ageMs : null,
    shotOrigin: str(shot?.origin),
    // ★monitor が「プロンプトから外した文脈ブロック」をそのまま台帳へ写す(推測しない)。
    //   応答に無ければ NULL = 外していない版の monitor と話した = 紙成績を見せた標本。
    contextOmittedJson: Array.isArray(b?.contextOmitted) ? JSON.stringify(b.contextOmitted) : null,
    // ★monitor が「いつの断面から文脈を組んだか」と「送ったプロンプトの指紋」をそのまま写す(推測しない)。
    //   requested_at/responded_at は生成器の時計の両端でしかない。応答に無ければ NULL
    //   = この2つを返さない版の monitor と話した(= 突合できない標本)。
    contextAt: typeof b?.contextAt === 'number' ? b.contextAt : null,
    promptFp: str(b?.promptFp),
    // ★根拠文の突き合わせ2種を **本線の台帳(signal_plans)と同じ形のまま** 写す(推測も再計算もしない)。
    //   lcAudit=申告 LC幅 vs 実出力 / omissionAudit=「出さない」表明 vs 実際に発注されるレッグ。
    //   応答に無ければ NULL = この列を返さない版の monitor と話した or 観測0件。
    lcAuditJson: Array.isArray(b?.lcAudit) ? JSON.stringify(b.lcAudit) : null,
    omissionAuditJson: Array.isArray(b?.omissionAudit) ? JSON.stringify(b.omissionAudit) : null,
    createdAt: outcome.respondedAt,
  };
}

/** サイクルの識別子(①①'②を結ぶ結合キー)。時刻 + プロセス固有の接頭辞で、再起動をまたいで衝突しない。 */
export function makeCycleId(prefix: string, cycleStart: number, cycleIndex: number): string {
  return `${prefix}-${cycleStart.toString(36)}-${cycleIndex}`;
}

/** 1サイクルを **直列** に実行し、腕ごとの行を返す(DB への書き込みは呼び出し側)。 */
export async function runCycle(
  cfg: GeneratorConfig, dep: CycleDeps,
  ctx: { epoch: string; cycleId: string; cycleIndex: number },
): Promise<ProposalRow[]> {
  const rows: ProposalRow[] = [];
  for (const req of planCycleArms(ctx.cycleIndex, cfg.controlEvery)) {
    const outcome = await runArm(cfg, dep, req);
    rows.push(toProposalRow(ctx.epoch, ctx.cycleId, req, outcome));
  }
  return rows;
}
