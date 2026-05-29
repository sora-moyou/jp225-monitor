// v0.3.13: Yahoo chart API (interval=1m, last 60min) で各銘柄の 1 分足 close を取得し、
// timestamp 同期 paired returns で Pearson 相関を計算する。
// クライアント側の 2 秒ポーリング SSE 蓄積は休場/低活動時に return=0 ノイズを
// 量産し相関が破綻していたので、業界標準の OHLC bars ベースに置換。
// yahoo-finance2 v2.14 は chart() を export していないため、Yahoo chart endpoint を直接叩く。

export interface Bar { t: number; close: number; }

export interface CorrelationResult {
  symbol: string;
  corr: number;
  absCorr: number;
  samples: number;     // 算出に使われた paired return の数
}

export interface PearsonResult { corr: number; samples: number; }

/**
 * Yahoo chart API から symbol の過去 60 分間 1 分足 close を取得。
 * 休場・データ欠損時は短い配列を返す (相関側で samples < MIN_PAIRS なら除外)。
 */
interface YahooChartResponse {
  chart: {
    result: Array<{
      meta?: { symbol?: string };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: (number | null)[] }> };
    }> | null;
    error: { code: string; description: string } | null;
  };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FinanceMonitor/0.3';

export async function fetchMinuteBars(symbol: string): Promise<Bar[]> {
  // v0.3.14: range 1h → 1d。CME 24h 銘柄なら 1380 bars/symbol、ペア後 500+ samples 取れる。
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Yahoo chart ${symbol}: HTTP ${res.status}`);
  const data = await res.json() as YahooChartResponse;
  if (data.chart.error) throw new Error(`Yahoo chart ${symbol}: ${data.chart.error.description}`);
  const result = data.chart.result?.[0];
  if (!result) return [];
  const ts = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    const tsec = ts[i];
    if (typeof close === 'number' && Number.isFinite(close) && typeof tsec === 'number') {
      bars.push({ t: tsec * 1000, close });
    }
  }
  return bars;
}

/**
 * 2 銘柄の bars を timestamp 整合させて return を作り、Pearson 相関を算出。
 * - 共通 timestamp が無いペアは破棄
 * - 連続する共通 timestamp 同士でのみ return を計算 (片方欠落で再起算)
 * - 戻り値の samples = 実際に算出に使われた return ペア数
 */
export function pearsonAlignedReturns(barsA: Bar[], barsB: Bar[]): PearsonResult {
  const mapA = new Map<number, number>();
  for (const b of barsA) mapA.set(b.t, b.close);

  const aligned: { t: number; a: number; b: number }[] = [];
  for (const b of barsB) {
    const a = mapA.get(b.t);
    if (a !== undefined) aligned.push({ t: b.t, a, b: b.close });
  }
  aligned.sort((x, y) => x.t - y.t);

  const retA: number[] = [];
  const retB: number[] = [];
  for (let i = 1; i < aligned.length; i++) {
    const prev = aligned[i - 1]!;
    const cur = aligned[i]!;
    // v0.3.15: 時刻ギャップによる skip を撤去 — 休場跨ぎの return も含めて全 pair を使用 (ユーザ要望)。
    // 正常 close (>0) のみフィルタ。
    if (prev.a > 0 && prev.b > 0) {
      retA.push((cur.a - prev.a) / prev.a);
      retB.push((cur.b - prev.b) / prev.b);
    }
  }
  return { corr: pearson(retA, retB), samples: retA.length };
}

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i] ?? 0, yi = y[i] ?? 0;
    sx += xi; sy += yi; sxy += xi * yi;
    sx2 += xi * xi; sy2 += yi * yi;
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return den === 0 ? 0 : num / den;
}
