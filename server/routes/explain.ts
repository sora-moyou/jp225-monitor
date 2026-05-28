import type { Request, Response } from 'express';
import { explain } from '../llm/openai.js';
import { getNews } from '../cache.js';

interface PriceActionBody {
  open: number; high: number; low: number; current: number;
}

interface ExplainBody {
  symbol?: string;
  symbolLabel?: string;
  changePercent?: number;
  windowSeconds?: number;
  detectionKind?: 'magnitude' | 'slope';
  change15min?: number | null;
  pa15min?: PriceActionBody | null;
  range1h?: { high: number; low: number } | null;
}

export async function explainHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as ExplainBody;
  if (typeof body.symbol !== 'string'
      || typeof body.symbolLabel !== 'string'
      || typeof body.changePercent !== 'number'
      || typeof body.windowSeconds !== 'number'
      || (body.detectionKind !== 'magnitude' && body.detectionKind !== 'slope')) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  try {
    const text = await explain({
      symbol: body.symbol,
      symbolLabel: body.symbolLabel,
      changePercent: body.changePercent,
      windowSeconds: body.windowSeconds,
      detectionKind: body.detectionKind,
      change15min: typeof body.change15min === 'number' ? body.change15min : null,
      pa15min: body.pa15min ?? null,
      range1h: body.range1h ?? null,
      news: getNews(),
    });
    res.json({ explanation: text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[explain] error:', msg);
    const friendly = translateLLMError(msg);
    res.status(500).json({ explanation: friendly });
  }
}

function translateLLMError(msg: string): string {
  if (/insufficient[_ ]quota|exceeded.*quota/i.test(msg)) {
    return '(LLMクレジット不足 — https://platform.openai.com/account/billing で残高補充)';
  }
  if (/401|invalid[_ ]api[_ ]key|incorrect api key/i.test(msg)) {
    return '(APIキー無効 — .env の OPENAI_API_KEY を確認)';
  }
  if (/429/i.test(msg)) {
    return '(LLMレート制限 — 少し待ってから再試行)';
  }
  if (/model.*not.*found|does not have access/i.test(msg)) {
    return '(モデルアクセス不可 — gpt-4o-miniへのアクセス権を確認)';
  }
  if (/ECONNREFUSED|ENOTFOUND|network|timeout/i.test(msg)) {
    return '(LLMネットワークエラー)';
  }
  return `(説明取得失敗: ${msg.slice(0, 100)})`;
}
