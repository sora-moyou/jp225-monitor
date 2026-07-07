import type { Request, Response } from 'express';
import { buildScalpPlan } from '../llm/openai.js';
import { getPrices, getNews } from '../cache.js';
import { buildNikkeiTechnical } from '../chatContext.js';

// 兄弟アプリ jp225-trade2(AI トレーダー)向け。monitor の LLM を固定のスキャル戦略質問で走らせ、
// buildMonitorContext + データツール + 既存プロバイダ/キーを再利用して構造化プラン(AiPlan)を返す。

const NIKKEI_SYMBOL = 'NIY=F';

interface Body {
  symbol?: string;
}

export async function scalpPlanHandler(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Body;
  const symbol = typeof body.symbol === 'string' && body.symbol ? body.symbol : NIKKEI_SYMBOL;
  try {
    const prices = getPrices();
    const price = prices.find(p => p.symbol === symbol)?.price;
    const result = await buildScalpPlan({
      symbol,
      prices,
      news: getNews(),
      // chat と同じく、バー蓄積中でも節目メドを出せるよう fallbackPrice を渡す。
      technical: buildNikkeiTechnical(undefined, price),
    });
    if (result.ok) {
      res.json({ ok: true, plan: result.plan });
    } else {
      // キー無し/パース失敗/LLM 失敗は 200 + ok:false で返す(キーは決して漏らさない)。
      res.json({ ok: false, error: result.error });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scalp-plan] error:', msg);
    res.status(500).json({ ok: false, error: msg.slice(0, 200) });
  }
}
