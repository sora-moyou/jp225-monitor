// 計画サイクルの台帳(signal_plans)の行ビルダー。**純関数のみ**(DB もエンジン状態も触らない)。
//
// ■ なぜ要るか(実測)
//   signal_trades は「約定して決済された」ときにしか1行入らない。だから A/B 実験の主要指標である
//     ・見送り率(なぜ入らなかったか)
//     ・レッグが落ちた理由の内訳
//   が DB に **1行も** 残っていなかった。実運用機の書き出しでは、サーバログに
//   plan-suppress が A=212 / B=203 件、plan-legdrop が A=32 / B=16 件あるのに、signal_trades には
//   それに対応する行が存在しない。しかもサーバログはローテートするので、1年の実験では消える。
//   → 計画サイクルのたびに1行、A/B 両方について DB に残す(約定/見送りに関わらず必ず1行)。
//
// ■ ★語彙を増やさない
//   direction / noneReason / vetoFired / regime / confidence / legDrops は
//   すべて ScalpPlanResult(server/llm/scalpPlan.ts)に既に在る値をそのまま写すだけ。
//   leg_drops_json の書き方は生成器の台帳(proposals.leg_drops_json)と同じ = LegDrop[] をそのまま JSON 化する。
//   settings は signal_trades.meta に入れているものと **同じ組み立て**(persist.ts の buildSettingsSnapshot)を
//   呼び出し側から受け取る(この関数は二重に組み立てない)。
//
// ■ RECORD-ONLY
//   ここで作った行は記録にしか使わない。採否・価格・SSE・決済には一切影響しない。

import type { SignalSettingsSnapshot } from '../types.js';
import type { ScalpPlanResult } from '../llm/scalpPlan.js';
import type { SignalPlanInsert } from '../db/store.js';
import type { ArmWaitDecision } from './armWait.js';

/** rationale(AI の判断理由)の上限文字数。
 *
 *  ★この値の根拠(実測 + 容量見積もり):
 *   - 実データ(signals_kabu.db・832件)の rationale は 中央値93文字 / p90 172 / p99 232 / 最長306文字、
 *     UTF-8 では 平均283バイト / 最長746バイト。240文字で切ると影響を受けるのは全体の 0.8%(7/832)だけで、
 *     平均の行サイズはほぼ変わらない(=上限は「裾を止める」ためのもの)。
 *   - 240 は engine が plan-suppress ログで既に使っている上限と同じ。台帳はそのログを置き換えるものなので、
 *     **ログより少ない情報しか残らない** 状態を作らない。
 *   - 容量: 1行あたり ≒ 750バイト(固定列110 + settings_json 約300 + leg_drops 約50 + rationale 約283)。
 *     実測の計画サイクル数(A≒90/日・B≒90/日)× 年間245営業日 ≒ 44,000行/年 ≒ **33MB/年**。
 *     計画間隔3分・取引20時間/日で理論上限まで走った場合(800行/日)でも ≒ 196,000行/年 ≒ 146MB/年。 */
export const PLAN_RATIONALE_MAX_CHARS = 240;

/** 根拠文を1行に均して上限文字数で切る(engine のログと同じ整形)。空/未指定は null。 */
export function trimRationale(s: string | null | undefined, max = PLAN_RATIONALE_MAX_CHARS): string | null {
  if (typeof s !== 'string') return null;
  const one = s.replace(/\s+/g, ' ').trim();
  return one ? one.slice(0, max) : null;
}

export interface SignalPlanRecordInput {
  /** 記録時刻(計画が解決した時刻)。 */
  t: number;
  /** 系統。A も明示的に 'A'(この表は NULL=A の後方互換規約を持たない)。 */
  system: 'A' | 'B';
  /** 計画の結果(ok=false もそのまま渡す=「計画が得られなかったサイクル」も1行残す)。 */
  result: ScalpPlanResult;
  /** ARM した回だけ采番値。見送り/不成立は null/未指定。 */
  signalId?: number | null;
  /** そのサイクルで有効だった実効設定(buildSettingsSnapshot の戻り値をそのまま)。 */
  settings?: SignalSettingsSnapshot | null;
  /** ★ARM した回だけ: 未約定待ち時間(armed-timeout までの猶予)の決定内訳。
   *  「なぜこの待ち時間になったか」を後から読めるようにするための記録(採否には一切影響しない)。 */
  armWait?: ArmWaitDecision | null;
}

/** 1計画サイクルぶんの挿入行を組み立てる(純関数)。
 *  ok=false(画像が撮れない・LLM 失敗など)は direction を NULL にし、error にその理由を残す
 *  = 「見送り(none)」と「そもそも計画が出なかった」を後から必ず区別できるようにする。 */
export function buildSignalPlanInsert(input: SignalPlanRecordInput): SignalPlanInsert {
  const { t, system, result } = input;
  const row: SignalPlanInsert = { t, system };
  // ★凍結再生の突合(RECORD-ONLY): 「いつの断面から文脈を組んだか」と「送ったプロンプトの指紋」。
  //   error 分岐より **前** に載せる: 文脈は組んだが LLM で落ちた回(ok=false)こそ、
  //   「入力は在ったのに計画が出なかった」標本として時刻と指紋が要る(載せ忘れの経路を作らない)。
  //   ★指紋は一方向ハッシュ(`sp1:<16桁hex>`)で、プロンプト本文は台帳に1バイトも入らない。
  if (typeof result.contextAt === 'number') row.contextAt = result.contextAt;
  if (typeof result.promptFp === 'string') row.promptFp = result.promptFp;
  if (input.signalId != null) row.signalId = input.signalId;
  if (input.settings) row.settingsJson = JSON.stringify(input.settings);
  // ★待ち時間の決定内訳(ARM した回のみ)。error 分岐より前に載せる: 「ARM したのに ok=false」は
  //   起こり得ないが、載せ忘れの経路を作らないため分岐の外で1回だけ書く。
  if (input.armWait) {
    row.armWaitMs = input.armWait.waitMs;
    row.armWaitDistance = input.armWait.distanceYen;
    row.armWaitSigma = input.armWait.sigma1m;
    row.armWaitReason = input.armWait.reason;
  }
  if (!result.ok) {
    row.error = result.error;
    return row;
  }
  const plan = result.plan;
  row.direction = plan.direction;
  row.refPrice = plan.refPrice;
  row.rationale = trimRationale(plan.rationale);
  if (plan.regime !== undefined) row.regime = plan.regime;
  if (plan.confidence !== undefined) row.confidence = plan.confidence;
  if (result.vetoFired !== undefined) row.vetoFired = result.vetoFired;
  if (result.noneReason !== undefined) row.noneReason = result.noneReason;
  if (plan.limitEntry !== undefined) row.limitEntry = plan.limitEntry;
  if (plan.stopEntry !== undefined) row.stopEntry = plan.stopEntry;
  if (plan.stopLossForLimit !== undefined) row.stopLossForLimit = plan.stopLossForLimit;
  if (plan.stopLossForStop !== undefined) row.stopLossForStop = plan.stopLossForStop;
  // ★生成器の台帳(proposals.leg_drops_json)と同じ書き方: LegDrop[] をそのまま JSON 配列にする。
  //   1本も落ちなければ列ごと NULL(= 空配列 '[]' は書かない。proposals と同じ規約)。
  if (result.legDrops?.length) row.legDropsJson = JSON.stringify(result.legDrops);
  // ★RECORD-ONLY: 根拠文で AI が申告した LC幅 と 実際に出力した |entry − stopLoss| の突き合わせ。
  //   対象は **AI の生出力の全レッグ**(落ちたレッグも採用レッグも)。leg_drops_json とは別列に置く:
  //   故障は落ちたレッグ側にしか残らないので、採用レッグという対照が同じ台帳に無いと率が読めない。
  //   1件も突き合わせられなければ列ごと NULL(空配列 '[]' は書かない=leg_drops_json と同じ規約)。
  if (result.lcAudit?.length) row.lcAuditJson = JSON.stringify(result.lcAudit);
  return row;
}
