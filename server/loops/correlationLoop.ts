import { fetchMinuteBars, pearsonAlignedReturns, type Bar, type CorrelationResult } from '../correlation.js';
import { INSTRUMENTS } from '../config.js';

// v0.3.13: 5 分ごとに Yahoo chart API を叩いて全銘柄の 1m bars 取得 → 相関ランキングを更新
const ANCHOR = 'NIY=F';
const POLL_MS = 5 * 60 * 1000;
const MIN_SAMPLES = 100;     // v0.3.14: 100 ペア未満は信頼性低として候補から除外
                             // (range=1d で目標 500+ samples、ユーザ要望)

const CANDIDATES = INSTRUMENTS
  .filter(i => i.category !== 'heavyweight' && i.symbol !== ANCHOR)
  .map(i => i.symbol as string);

let lastRanked: CorrelationResult[] = [];
let lastUpdate = 0;
let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  try {
    let anchorBars: Bar[];
    try {
      anchorBars = await fetchMinuteBars(ANCHOR);
    } catch (err) {
      console.warn(`[correlationLoop] anchor ${ANCHOR} fetch failed:`, err instanceof Error ? err.message : err);
      return;
    }
    if (anchorBars.length < MIN_SAMPLES + 1) {
      console.log(`[correlationLoop] anchor bars too few (${anchorBars.length}), market likely closed/quiet`);
      lastRanked = [];
      lastUpdate = Date.now();
      return;
    }

    const results: CorrelationResult[] = [];
    for (const sym of CANDIDATES) {
      try {
        const bars = await fetchMinuteBars(sym);
        const { corr, samples } = pearsonAlignedReturns(anchorBars, bars);
        if (samples >= MIN_SAMPLES) {
          results.push({ symbol: sym, corr, absCorr: Math.abs(corr), samples });
        }
      } catch (err) {
        console.warn(`[correlationLoop] ${sym} failed:`, err instanceof Error ? err.message : err);
      }
    }

    results.sort((a, b) => b.absCorr - a.absCorr);
    lastRanked = results;
    lastUpdate = Date.now();
    const top3 = results.slice(0, 3).map(r => `${r.symbol}=${r.absCorr.toFixed(2)}(n=${r.samples})`).join(' ');
    console.log(`[correlationLoop] updated, top: ${top3 || '(no candidates met MIN_SAMPLES)'}`);
  } catch (err) {
    console.error('[correlationLoop] tick error:', err instanceof Error ? err.message : err);
  }
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(async () => {
    await tick();
    schedule();
  }, POLL_MS);
}

export function startCorrelationLoop(): void {
  if (running) return;
  running = true;
  void tick();        // 起動直後に 1 回 (ユーザが ~60s 待たずに済むように)
  schedule();
}

export function stopCorrelationLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

export function getCorrelationSnapshot(): { ranked: CorrelationResult[]; anchor: string; updatedAt: number } {
  return { ranked: lastRanked, anchor: ANCHOR, updatedAt: lastUpdate };
}
