import type { AlertEvent } from '../types.js';
import { apiUrl } from './apiBase.js';

export async function fetchExplanation(alert: AlertEvent): Promise<string> {
  const res = await fetch(apiUrl('/api/explain'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: alert.symbol,
      symbolLabel: alert.symbolLabel,
      changePercent: alert.changePercent,
      windowSeconds: alert.windowSeconds,
      detectionKind: alert.detectionKind,
      change15min: alert.change15min,
      pa15min: alert.pa15min,
      range1h: alert.range1h,
    }),
  });
  // 500でも body の explanation を採用（実エラーメッセージが入っている）
  const data = (await res.json().catch(() => ({} as { explanation?: string }))) as { explanation?: string };
  if (data.explanation) return data.explanation;
  throw new Error(`explain ${res.status}`);
}
