import type { Request, Response } from 'express';
import { getCurrentSignal, getSignalHold, getSignalPhase, type CurrentSignal, type SignalHold, type SignalPhase } from '../signalTrade/engine.js';

// 現在シグナル(trade2 追従用)の公開。表示/連携専用=発注は一切しない。
// late-join した trade2 が初期同期に使う(以降は SSE signalTrade の signal / hold で追従)。

/** CurrentSignal を API シェイプへ整形する純関数。null なら { signalId: null }。 */
export function currentSignalPayload(sig: CurrentSignal | null): Record<string, unknown> {
  if (!sig) return { signalId: null };
  const out: Record<string, unknown> = {
    signalId: sig.signalId,
    at: sig.at,
    direction: sig.direction,
    plan: {
      limitEntry: sig.limitEntry,
      stopEntry: sig.stopEntry,
      stopLossForLimit: sig.stopLossForLimit,
      stopLossForStop: sig.stopLossForStop,
    },
    rationale: sig.rationale,
  };
  // レンジ両面ストラドルは mode/range を露出(trade2 追従用・directional では付与しない=SSE と同形)。
  if (sig.mode === 'range' || sig.range != null) {
    out.mode = 'range';
    out.range = sig.range;
  }
  // ★v0.7.56: 実効設定スナップショットを露出(在るときだけ・trade2 が entry_meta に記録)。
  if (sig.settings) out.settings = sig.settings;
  // ★v0.9.108: 未約定待ち時間[ms](在るときだけ)。**SSE の signal.armWaitMs と必ず同じものを載せる**。
  //   ★ここに載せ忘れると「SSE を取り逃した回だけ静かに 15分(trade2 の既定)へ戻る」= 配線が死んでいる型の
  //     無言の失敗になる。trade2 の late-join 初期同期は **この API しか読まない** ため、
  //     SSE 側だけ直しても半分しか直らない。★この案件は既に1度踏んでいる(lastExitedSignalId が
  //     この API に載っておらず、trade2 の初期同期が常に null を読んでいた)。同じ穴を二度開けない。
  if (sig.armWaitMs !== undefined) out.armWaitMs = sig.armWaitMs;
  return out;
}

/** GET のフルペイロードを組み立てる純関数。現在シグナル整形に hold(保有中の意図・決済逆指値)と
 *  phase(エンジンの現在フェーズ)を付ける。hold は filled の間だけ非 null(それ以外は null)。
 *  phase は signalId=null(未ARM)でも必ず返す(flat 等)=trade2 の late-join 追従判定用。 */
export function currentSignalResponse(
  sig: CurrentSignal | null, hold: SignalHold | null, phase: SignalPhase,
): Record<string, unknown> {
  return { ...currentSignalPayload(sig), hold, phase };
}

/** GET /api/current-signal → 現在シグナル(+ 保有中は hold・現在 phase)or { signalId: null, hold: null, phase }。 */
export function currentSignalHandler(_req: Request, res: Response): void {
  res.json(currentSignalResponse(getCurrentSignal(), getSignalHold(), getSignalPhase()));
}
