import { fetchMinuteBars, pearsonAlignedReturns, type Bar, type CorrelationResult } from '../correlation.js';
import { INSTRUMENTS } from '../config.js';
import { getRealtimeBars, isRealtimeBarsReady } from '../feedBars.js';

// v0.3.13: 5 分ごとに 1m bars 取得 → 相関ランキングを更新
// v0.3.32: データ源をリアルタイム feed バー優先に。アンカー(日経)も候補も実時間軸で
// 揃うので、CME遅延混在による相関の歪みが消える。リアルタイムバーが溜まる前(ウォームアップ)
// や feed 非対応銘柄は Yahoo 分足にフォールバック。両者は時刻基準が違うため、片方だけ
// リアルタイムだと共通 timestamp が MIN_SAMPLES に届かず自然に除外される(偽相関は出ない)。
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

// リアルタイムバーが溜まっていればそれを、無ければ Yahoo 分足を返す。
async function barsForCorr(sym: string): Promise<Bar[]> {
  if (isRealtimeBarsReady(sym)) return getRealtimeBars(sym);
  return fetchMinuteBars(sym);
}

async function tick(): Promise<void> {
  try {
    let anchorBars: Bar[];
    try {
      anchorBars = await barsForCorr(ANCHOR);
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
        const bars = await barsForCorr(sym);
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
