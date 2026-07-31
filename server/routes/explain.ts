import type { Request, Response } from 'express';
import type { AlertEventPayload } from '../../core/types.js';
import { explain } from '../llm/openai.js';
import { buildExplainInput } from '../llm/explainInput.js';
import { getNews } from '../cache.js';
import { noteReferencedNews } from '../shockWindow.js';

interface PriceActionBody {
  open: number; high: number; low: number; current: number;
}

// ★暫定対応(第0層で回収): 検知種別リストが core/types.ts の union と手書きで二重化しており、
//   v0.9.36 で追加した nwave / dailyband がここに入っていなかったため、この allowlist が 400 を返し、
//   バナーが常に「説明取得失敗」になっていた(出荷時からの故障)。
//   恒久対策=「検知種別の単一定義化(全リストを1つの定義から導出)」は第0層で行う。ここではその暫定として
//     ① 型は core/types.ts の union をそのまま参照する(手書きコピーを廃止)
//     ② 実行時 allowlist は下の配列 1 箇所に集約し、union に対する漏れを型で検出する(_allKindsListed)
//   としてある。種別を core/types.ts に足してこの配列に足し忘れると `npm run typecheck` が落ちる。
type DetectionKind = AlertEventPayload['detectionKind'];

export const DETECTION_KINDS = [
  'slope', 'magnitude', 'granville', 'shock', 'dtb', 'break', 'ma', 'swingdtb',
  'double', 'ma_sr', 'level_sr', 'pivot', 'trend', 'crash', 'dailyband', 'nwave',
] as const;

// core/types.ts の union に DETECTION_KINDS が追いついていない場合、この代入が型エラーになる。
type _AllKindsListed = Exclude<DetectionKind, (typeof DETECTION_KINDS)[number]> extends never
  ? true
  : ['missing in DETECTION_KINDS:', Exclude<DetectionKind, (typeof DETECTION_KINDS)[number]>];
const _allKindsListed: _AllKindsListed = true;
void _allKindsListed;

function isDetectionKind(v: unknown): v is DetectionKind {
  return typeof v === 'string' && (DETECTION_KINDS as readonly string[]).includes(v);
}

interface ExplainBody {
  symbol?: string;
  symbolLabel?: string;
  changePercent?: number;
  windowSeconds?: number;
  detectionKind?: DetectionKind;
  direction?: 'up' | 'down';
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
      || !isDetectionKind(body.detectionKind)) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  try {
    // 入力組立は buildExplainInput に集約(チャットの explain_move ツールと同一規約)。
    const result = await explain(buildExplainInput({
      symbol: body.symbol,
      symbolLabel: body.symbolLabel,
      changePercent: body.changePercent,
      windowSeconds: body.windowSeconds,
      detectionKind: body.detectionKind,
      direction: body.direction === 'up' || body.direction === 'down' ? body.direction : undefined,
      change15min: typeof body.change15min === 'number' ? body.change15min : null,
      pa15min: body.pa15min ?? null,
      range1h: body.range1h ?? null,
    }));
    // ①: 説明を実生成した時のみ、実提示ニュースの最大 publishedAt でアンカー前進(節約モード/テクニカル固定文では /api/explain 未呼び出し=据置)。
    if (result.newsMaxPublishedAt > 0) noteReferencedNews(result.newsMaxPublishedAt);
    res.json({ explanation: result.text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[explain] error:', msg);
    // 429 等の障害時はテンプレフォールバック（最新ニュース直接表示）
    if (/429|rate[_ ]limit/i.test(msg)) {
      res.json({ explanation: templateFallback(getNews()) });
      return;
    }
    const friendly = translateLLMError(msg);
    res.status(500).json({ explanation: friendly });
  }
}

// LLM呼べない時の苦肉の策: 最新ニュース1件を直接見せる
function templateFallback(news: ReturnType<typeof getNews>): string {
  if (news.length === 0) return '(LLMレート制限・直近ニュースなし)';
  const top = news[0]!;
  const ageMin = Math.max(0, Math.round((Date.now() - top.publishedAt) / 60000));
  return `[LLMレート制限のため簡易表示] ${ageMin}分前 [${top.source}] ${top.title}`;
}

function translateLLMError(msg: string): string {
  if (/insufficient[_ ]quota|exceeded.*quota/i.test(msg)) {
    return '(LLMクレジット不足 — https://platform.openai.com/account/billing で残高補充)';
  }
  if (/401|invalid[_ ]api[_ ]key|incorrect api key/i.test(msg)) {
    return '(APIキー無効 — .env の OPENAI_API_KEY を確認)';
  }
  if (/model.*not.*found|does not have access/i.test(msg)) {
    return '(モデルアクセス不可 — モデル名を確認)';
  }
  if (/ECONNREFUSED|ENOTFOUND|network|timeout/i.test(msg)) {
    return '(LLMネットワークエラー)';
  }
  return `(説明取得失敗: ${msg.slice(0, 100)})`;
}
