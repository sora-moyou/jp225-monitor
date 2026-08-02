import type { Request, Response } from 'express';
import { runScalpPlanWithChart } from '../llm/scalpPlanRunner.js';
import { normalizeCaller, DEFAULT_CALLER } from '../llm/caller.js';
import { checkGeneratorGate } from '../llm/generatorGate.js';

// ★実際の呼び出し元(2026-08-02 に実確認):
//   - **trade2 は叩いていない**。trade2 は monitor のシグナルを SSE / `/api/current-signal` で追従するだけで、
//     コード上のヒットは全てコメント(`src/strategy/levelBracket.ts:525`・`src/backtest/run.ts:10`)だった。
//     かつては trade2 が自前で AI 要求(planner.ts)を持っていた名残の記述で、現在は事実と異なる。
//   - monitor 自身のシグナルエンジン(server/signalTrade/engine.ts)は HTTP を経由せず
//     共通関数 runScalpPlanWithChart を **直呼び**する(この route は通らない)。
//   - よって現状この route を叩くのは **手動診断**と、これから追加する **提案生成器(caller='generator')** のみ。
//
// 兄弟アプリ jp225-trade2(AI トレーダー)向けとして作られた route。monitor の LLM を固定のスキャル戦略質問で走らせ、
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
  /** 初期 LC(損切り)幅の下限[円]。未指定は monitor 設定(既定45)。数値化して optional で受理する。
   *  ★これは「より厳しくする」要求としてのみ効く: buildScalpPlan(clampRequestedLcFloor)が設定値で床止めするので、
   *    設定より小さい値を送っても下限は緩まない(下限は AI にも外部にも委任しない唯一の制約)。 */
  lcFloorYen?: number;
  /** 初期 LC(損切り)幅の上限[円]。未指定は buildScalpPlan 側の既定(65)。これを超える損切りは出さない。 */
  lcCeilingYen?: number;
  /** ★呼び出し元の識別子。**省略時は 'default'**(既存の呼び出しは完全に従来どおり)。
   *  'generator' を指定した時だけ、プロバイダ・プール / backpressure / 日次予算 が分離される。 */
  caller?: unknown;
}

/** body/query から数値を optional に受理する(文字列でも数値化)。非有限は undefined を返し、既定に委ねる。
 *  範囲/floor<=ceiling のクランプは buildScalpPlan 側 resolveLcRange が、
 *  「設定値の下限を下回らせない」床止めは同 clampRequestedLcFloor が担う(単一責務)。 */
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

  // ── ★呼び出し元の識別(作業1)。この1つの値がプール選択・backpressure・予算計上を駆動する。
  const callerResult = normalizeCaller(body.caller ?? query.caller);
  if (!callerResult.ok) {
    // 未知の caller を黙って default に倒すと、実験系が実弾のプール/予算をそのまま使ってしまう。
    // だから受理せず 400 で落とす(誤設定を無音にしない)。
    res.status(400).json({ ok: false, error: callerResult.error });
    return;
  }
  const caller = callerResult.caller;

  // ── ★生成器だけの関門(作業3 backpressure + 作業4 予算/従属)。
  //    caller 省略/'default' はこのブロックを **一切通らない**(既存の呼び出し元に影響ゼロ)。
  if (caller !== DEFAULT_CALLER) {
    const gate = checkGeneratorGate();
    if (!gate.allowed) {
      // 429 = 「今は投げるな」。生成器は reason で busy / budget / default-quota / disabled を区別できる。
      // 見送りは checkGeneratorGate 側で必ず1行ログ+カウンタに記録される(無音にしない)。
      res.status(429).json({ ok: false, error: gate.reason, detail: gate.detail });
      return;
    }
  }

  try {
    const result = await runScalpPlanWithChart({ symbol, lcFloorYen, lcCeilingYen, caller });
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
