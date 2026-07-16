import type { Request, Response } from 'express';
import { getCurrentSignal, getSignalHold, type CurrentSignal, type SignalHold } from '../signalTrade/engine.js';

// 現在シグナル(trade2 追従用)の公開。表示/連携専用=発注は一切しない。
// late-join した trade2 が初期同期に使う(以降は SSE signalTrade の signal / hold で追従)。

/** CurrentSignal を API シェイプへ整形する純関数。null なら { signalId: null }。 */
export function currentSignalPayload(sig: CurrentSignal | null): Record<string, unknown> {
  if (!sig) return { signalId: null };
  return {
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
}

/** GET のフルペイロードを組み立てる純関数。現在シグナル整形に hold(保有中の意図・決済逆指値)を付ける。
 *  hold は filled の間だけ非 null(それ以外は null)。trade2 の late-join 初期同期用。 */
export function currentSignalResponse(
  sig: CurrentSignal | null, hold: SignalHold | null,
): Record<string, unknown> {
  return { ...currentSignalPayload(sig), hold };
}

/** GET /api/current-signal → 現在シグナル(+ 保有中は hold)or { signalId: null, hold: null }。 */
export function currentSignalHandler(_req: Request, res: Response): void {
  res.json(currentSignalResponse(getCurrentSignal(), getSignalHold()));
}
