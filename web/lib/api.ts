import type { AlertEvent } from '../types.js';

export async function fetchExplanation(alert: AlertEvent): Promise<string> {
  const res = await fetch('/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbolLabel: alert.symbolLabel,
      changePercent: alert.changePercent,
      windowSeconds: alert.windowSeconds,
      detectionKind: alert.detectionKind,
    }),
  });
  if (!res.ok) throw new Error(`explain ${res.status}`);
  const data = (await res.json()) as { explanation: string };
  return data.explanation;
}
