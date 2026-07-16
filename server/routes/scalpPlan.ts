import type { Request, Response } from 'express';
import { runScalpPlanWithChart } from '../llm/scalpPlanRunner.js';

// 兄弟アプリ jp225-trade2(AI トレーダー)向け。monitor の LLM を固定のスキャル戦略質問で走らせ、
// buildMonitorContext + データツール + 既存プロバイダ/キーを再利用して構造化プラン(AiPlan)を返す。
// v0.7.22: ビジョン対応プロバイダ(Gemini/OpenAI)時は当日チャートのスクリーンショットを添付し、
// AI が「実際にチャートを見て」方向・指値/逆指値を決められるようにする。
//
// 「チャート撮影→(無ければ chart-not-generated 見送り)→buildScalpPlan(画像込み)」のコアは
// runScalpPlanWithChart(共通関数・server/llm/scalpPlanRunner.ts)に集約。この route は
// req の LC override を解釈して共通関数へ渡し、結果をそのまま返す薄いラッパ。
// シグナルエンジン(server/signalTrade/engine.ts)も同じ共通関数を呼ぶ＝両経路で提案が一致する。

interface Body {
  symbol?: string;
  /** 初期 LC(損切り)幅の下限[円]。未指定は buildScalpPlan 側の既定(45)。数値化して optional で受理する。 */
  lcFloorYen?: number;
  /** 初期 LC(損切り)幅の上限[円]。未指定は buildScalpPlan 側の既定(65)。これを超える損切りは出さない。 */
  lcCeilingYen?: number;
}

/** body/query から数値を optional に受理する(文字列でも数値化)。非有限は undefined を返し、既定に委ねる。
 *  範囲/floor<=ceiling のクランプは buildScalpPlan 側 resolveLcRange が担う(単一責務)。 */
function optionalNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export async function scalpPlanHandler(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Body;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const symbol = typeof body.symbol === 'string' && body.symbol ? body.symbol : undefined;
  // 初期 LC 幅の下限/上限を optional で受理(body 優先・なければ query)。範囲/整合クランプは buildScalpPlan 側。
  const lcFloorYen = optionalNumber(body.lcFloorYen ?? query.lcFloorYen);
  const lcCeilingYen = optionalNumber(body.lcCeilingYen ?? query.lcCeilingYen);
  try {
    const result = await runScalpPlanWithChart({ symbol, lcFloorYen, lcCeilingYen });
    if (result.ok) {
      res.json({ ok: true, plan: result.plan });
    } else {
      // キー無し/パース失敗/LLM 失敗/チャート未生成は 200 + ok:false で返す(キーは決して漏らさない)。
      res.json({ ok: false, error: result.error });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scalp-plan] error:', msg);
    res.status(500).json({ ok: false, error: msg.slice(0, 200) });
  }
}
