// 1サイクル(①→①'→②)の組み立てと実行。**取引はしない**。AI にエントリー計画を要求し、
// 提案を全数記録するだけ。約定判定・影の決済模擬は **オフラインの再生** で後から行う(範囲外)。
//
// ■ なぜ【直列】か
//   ①(現行の決済仕様を教える)と②(候補の決済仕様を教える)を別スケジュールにすると、
//   違う時刻・違う相場を見るので、提案の差に **市場変動が混ざる**。直列なら monitor 側の
//   撮影キャッシュ(60秒・分析用プール)を3本で共有でき、①②が同じ画像を見た対応比較になる。
//   generatorGate の busy 衝突も自分同士では起きない。
//
// ■ なぜ ①' が3本目の分析用でないか
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
import { DEFAULT_PROMPT_VARIANT, type PromptVariant } from '../llm/promptVariant.js';
import type { GeneratorConfig } from './config.js';
import type { Fetcher } from './preflight.js';

/** ★候補の腕(v0.9.75 で載せ替え)。
 *
 *  旧: 'candidate-a'(= 決済仕様の候補を教えた腕)。08-10〜08-12 の実測3セッションで
 *      current と **どの指標も差が出なかった**(両レッグ同幅 88.1% vs 87.9% / LC幅中央値 60 vs 60 /
 *      エントリー率 70.2% vs 71.4% / 片レッグ落ち 4.1% vs 3.0%)。「決済の説明を変えても入り方は変わらない」
 *      という答えが出たので、この腕は畳む。
 *  旧2: 'prompt-v2'(= 質問文 v2 を投げた腕)。質問文を **全面的に** 書き換えた系統で、
 *      「距離の記述が無い」ことの効果を見たくても **1変数の対照になっていない**(他も全部違う)。
 *
 *  ★現(2026-08-17): 'prompt-v1d'(= 質問文 v1d を投げた腕)。**送る決済仕様は①と同じ 'current'**。
 *      v1d は v1 から **「指値・ブレイク新規を現在値から最低50円離す」の記述だけ** を外したもの。
 *      設計書(docs/superpowers/specs/2026-08-17-signal-constraints-design.md)§8 の移行順序の1番目
 *      =「層1(執行)を直す」の第一手。
 *      理由(実測): この規則は 89.8% の断面で「節目の5〜10円内側」と両立せず、2,222レッグの
 *      **72.0% が距離を破り**、LC下限を破ったレッグは **0件**(= 例外なく距離のほうが捨てられていた)。
 *      主指標: 現在値からの距離の分布 / LC幅の **相異なる値の種類数**(平均では下限＋一定への移行を
 *      見逃す)/ 両レッグ同幅率(実測 87〜92%)/ none 率。
 *  ★v2 の腕は畳む(候補の枠は1つ=1サイクルの LLM 呼び出し回数を増やさない=課金を動かさない)。 */
const CANDIDATE_ARM: GeneratorArm = 'prompt-v1d';
const CANDIDATE_PROMPT_VARIANT: PromptVariant = 'v1d';

/** 1サイクルの中の1要求。 */
export interface ArmRequest {
  arm: GeneratorArm;
  /** 実際に送る変種。対照も候補も①と同一('current')= 決済仕様はもう動かさない。 */
  exitVariant: ExitVariant;
  /** ★実際に送る質問文。候補の腕だけ 'v2'、他は 'v1'(=従来の質問文)。 */
  promptVariant: PromptVariant;
  /** サイクル内の直列順(0 起点)。 */
  seq: number;
}

/** ★1サイクルの構成(純関数)。
 *  ① 'current'(質問文 v1) → ①' 対照(controlEvery サイクルに1回・①と完全に同じ入力)
 *  → ② 'prompt-v1d'(質問文 v1d・決済仕様は①と同じ)の **この順** で直列。
 *  ★①と②の違いは **質問文だけ**(1変数)。①' は同じ入力へ2回問う LLM のばらつきの基準線。 */
export function planCycleArms(cycleIndex: number, controlEvery: number): ArmRequest[] {
  const out: ArmRequest[] = [
    { arm: DEFAULT_EXIT_VARIANT, exitVariant: DEFAULT_EXIT_VARIANT, promptVariant: DEFAULT_PROMPT_VARIANT, seq: 0 },
  ];
  if (controlEvery > 0 && cycleIndex % controlEvery === 0) {
    out.push({
      arm: CONTROL_ARM, exitVariant: CONTROL_EXIT_VARIANT, promptVariant: DEFAULT_PROMPT_VARIANT, seq: out.length,
    });
  }
  out.push({
    arm: CANDIDATE_ARM, exitVariant: DEFAULT_EXIT_VARIANT, promptVariant: CANDIDATE_PROMPT_VARIANT, seq: out.length,
  });
  return out;
}

/** ★epoch に食わせる「この実験が回す腕の構成」(純関数・cycleIndex に依らない形)。
 *  ここを epoch の入力に入れておかないと、腕を載せ替えても期が変わらず、**別の実験の標本が
 *  同じ期に混ざる**(現に決済変種 → 質問文へ載せ替えた)。epoch.ts の思想どおり「入力が動けば期が動く」。 */
export function describeArmPlan(): Array<{ arm: string; exitVariant: string; promptVariant: string }> {
  return planCycleArms(0, 1).map(r => ({
    arm: r.arm, exitVariant: r.exitVariant, promptVariant: r.promptVariant,
  }));
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
    // 分析用ゲート(busy / budget / default-quota / disabled)と場外(closed)。
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
      // ★caller と2つの変種名だけを送る。決済の実数値も質問文の本文もリクエストに載せない(名前だけ)。
      body: JSON.stringify({
        caller: 'generator', exitVariant: req.exitVariant, promptVariant: req.promptVariant,
      }),
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
  const exitMismatch = echoed !== null && echoed !== req.exitVariant
    ? `variant-mismatch: 送信 ${req.exitVariant} / 応答 ${echoed}`
    : null;
  // ★質問文の変種も同じ作法で突き合わせる。エコーが送った名前と違えば、②は v2 を測っていない
  //   (= 腕名だけが候補で中身は v1 という、いちばん気づけない壊れ方)。
  const echoedPrompt = str(b?.promptVariant);
  const promptMismatch = echoedPrompt !== null && echoedPrompt !== req.promptVariant
    ? `prompt-variant-mismatch: 送信 ${req.promptVariant} / 応答 ${echoedPrompt}`
    : null;
  const mismatch = exitMismatch ?? promptMismatch;
  if (mismatch) console.error(`[generator] ★${mismatch}(この標本は候補を測っていない可能性)`);
  return {
    epoch,
    cycleId,
    arm: req.arm,
    exitVariant: req.exitVariant,
    // ★送った質問文を行そのものに残す(腕名から推測しない)。腕の構成は実験ごとに変わる。
    promptVariant: req.promptVariant,
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
    //   応答に無ければ NULL = 外していない版の monitor と話した = 仮想取引の成績を見せた標本。
    contextOmittedJson: Array.isArray(b?.contextOmitted) ? JSON.stringify(b.contextOmitted) : null,
    // ★monitor が「いつの断面から文脈を組んだか」と「送ったプロンプトの指紋」をそのまま写す(推測しない)。
    //   requested_at/responded_at は分析用の時計の両端でしかない。応答に無ければ NULL
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
