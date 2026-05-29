import { apiUrl } from './apiBase.js';

// v0.3.13: サーバ側 correlationLoop の結果を 60s ごとに fetch。
// クライアント側で価格スナップショットを蓄積する設計を廃止 (Yahoo の 1m bars を直接相関に使う方が
// サンプル品質が遥かに高い)。

interface ServerResponse {
  ranked: { symbol: string; corr: number; absCorr: number; samples: number }[];
  anchor: string;
  updatedAt: number;
}

interface TopEntry { symbol: string; absCorr: number; samples: number; }

let lastTop: TopEntry[] = [];
let anchor = 'NIY=F';
let lastFetchedAt = 0;

export function getCorrelationTop(n: number): TopEntry[] { return lastTop.slice(0, n); }
export function getAnchorSymbol(): string { return anchor; }
export function getCorrelationFetchedAt(): number { return lastFetchedAt; }
export function getCurrentLeader(): string { return lastTop[0]?.symbol ?? 'JPY=X'; }

export function startCorrelationPolling(onUpdate: () => void, intervalMs = 60_000): void {
  const tick = async () => {
    try {
      const res = await fetch(apiUrl('/api/correlation'));
      if (!res.ok) return;
      const data = await res.json() as ServerResponse;
      anchor = data.anchor;
      lastTop = data.ranked.map(r => ({ symbol: r.symbol, absCorr: r.absCorr, samples: r.samples }));
      lastFetchedAt = Date.now();
      onUpdate();
    } catch { /* ignore — server may be starting */ }
  };
  void tick();
  setInterval(tick, intervalMs);
}
