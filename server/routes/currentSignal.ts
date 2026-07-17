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
