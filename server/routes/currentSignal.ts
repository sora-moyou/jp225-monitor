import type { Request, Response } from 'express';
import { getCurrentSignal, type CurrentSignal } from '../signalTrade/engine.js';

// 現在シグナル(trade2 追従用)の公開。表示/連携専用=発注は一切しない。
// late-join した trade2 が初期同期に使う(以降は SSE signalTrade の signal で追従)。

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

/** GET /api/current-signal → 現在シグナル or { signalId: null }。 */
export function currentSignalHandler(_req: Request, res: Response): void {
  res.json(currentSignalPayload(getCurrentSignal()));
}
