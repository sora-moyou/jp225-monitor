import type { Request, Response } from 'express';
import { buildScalpPlan, firstAvailableVisionProvider } from '../llm/openai.js';
import { getPrices, getNews } from '../cache.js';
import { buildNikkeiTechnical } from '../chatContext.js';
import { captureChartPng } from '../chart/chartShot.js';
import { resolvePort } from '../configStore.js';

// 兄弟アプリ jp225-trade2(AI トレーダー)向け。monitor の LLM を固定のスキャル戦略質問で走らせ、
// buildMonitorContext + データツール + 既存プロバイダ/キーを再利用して構造化プラン(AiPlan)を返す。
// v0.7.22: ビジョン対応プロバイダ(Gemini/OpenAI)時は当日チャートのスクリーンショットを添付し、
// AI が「実際にチャートを見て」方向・指値/逆指値を決められるようにする。撮影失敗/非対応/Chrome 不在は
// 従来どおりのテキストのみ判断へフォールバックする(既存エンドポイントを決して壊さない)。

const NIKKEI_SYMBOL = 'NIY=F';

interface Body {
  symbol?: string;
}

/** チャートビジョンを無効化する env(既定は有効)。SCALP_CHART_VISION=0/false でオフ。 */
function chartVisionEnabled(): boolean {
  const v = process.env.SCALP_CHART_VISION;
  if (v === undefined) return true;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

export async function scalpPlanHandler(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Body;
  const symbol = typeof body.symbol === 'string' && body.symbol ? body.symbol : NIKKEI_SYMBOL;
  try {
    const prices = getPrices();
    const price = prices.find(p => p.symbol === symbol)?.price;

    // ── チャートビジョン: 有効 かつ 現在の(利用可能な)先頭プロバイダがビジョン対応の時だけ撮影する。
    let chartImageDataUrl: string | null = null;
    if (chartVisionEnabled()) {
      const vision = firstAvailableVisionProvider();
      if (!vision) {
        console.log('[scalp-plan] vision: skip (no vision-capable provider available) → text-only');
      } else {
        const shot = await captureChartPng(resolvePort());
        if (shot.buffer) {
          chartImageDataUrl = `data:image/png;base64,${shot.buffer.toString('base64')}`;
          console.log(`[scalp-plan] vision: image attached (${(shot.buffer.length / 1024).toFixed(0)}KB) `
            + `provider=${vision.name} chrome="${shot.chromeVersion ?? '?'}"`);
        } else {
          console.log(`[scalp-plan] vision: capture failed (${shot.reason ?? 'unknown'}) `
            + `chrome=${shot.chromePath ? 'found' : 'not-found'} → text-only`);
        }
      }
    } else {
      console.log('[scalp-plan] vision: disabled (SCALP_CHART_VISION=0) → text-only');
    }

    const result = await buildScalpPlan({
      symbol,
      prices,
      news: getNews(),
      // chat と同じく、バー蓄積中でも節目メドを出せるよう fallbackPrice を渡す。
      technical: buildNikkeiTechnical(undefined, price),
      chartImageDataUrl,
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
