import { pearsonAlignedReturns, type Bar, type CorrelationResult } from '../correlation.js';
import { inPollWindow } from '../../collector/session.js';
import { INSTRUMENTS } from '../config.js';
import { getRealtimeBars, getRollingReturn } from '../feedBars.js';

// v0.3.13: 5 分ごとに 1m bars 取得 → 相関ランキングを更新
// v0.7.20(no-Yahoo): データ源はリアルタイム feed バーのみ。アンカー(日経)も候補も同じ実時間軸で
// 揃うので相関の歪みが無い。Yahoo 分足フォールバックは全廃(全 4 銘柄が HTTP フィード→feedBars に蓄積)。
// ウォームアップ中(バーが浅い)は共通 timestamp が MIN_SAMPLES に届かず自然に除外され、溜まり次第
// 自己回復する(偽相関は出ない)。
const ANCHOR = 'NIY=F';
const POLL_MS = 5 * 60 * 1000;
const MIN_SAMPLES = 100;     // v0.3.14: 100 ペア未満は信頼性低として候補から除外
                             // (range=1d で目標 500+ samples、ユーザ要望)

// v0.7.20: 相関バスケットは INSTRUMENTS の main 4 銘柄からアンカー(NIY=F)を除いた 3 銘柄
// = { NQ=F, YM=F, JPY=X }(^HSI/CL=F/^TNX は銘柄削減で自然に脱落)。
const CANDIDATES = INSTRUMENTS
  .filter(i => i.category !== 'heavyweight' && i.symbol !== ANCHOR)
  .map(i => i.symbol as string);

let lastRanked: CorrelationResult[] = [];
let lastUpdate = 0;
// v0.7.20: 最も相関の高い(|corr| 最大)銘柄の直近1分変化率(%)。急落率の可視化用。取れなければ null。
let topSymbol: string | null = null;
let topChange1mPct: number | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;

// v0.7.20: リアルタイム足のみ(Yahoo フォールバック撤去)。未蓄積銘柄は [] を返す。
function barsForCorr(sym: string): Bar[] {
  return getRealtimeBars(sym);
}

async function tick(): Promise<void> {
  if (!inPollWindow(Date.now())) return;   // 取引時間外は何もしない(軽量化)
  try {
    // v0.7.20(no-Yahoo): アンカー/候補ともリアルタイム足のみ(getRealtimeBars は throw しない)。
    const anchorBars = barsForCorr(ANCHOR);
    if (anchorBars.length < MIN_SAMPLES + 1) {
      console.log(`[correlationLoop] anchor bars too few (${anchorBars.length}), market likely closed/quiet`);
      lastRanked = [];
      topSymbol = null;
      topChange1mPct = null;
      lastUpdate = Date.now();
      return;
    }

    const results: CorrelationResult[] = [];
    for (const sym of CANDIDATES) {
      const bars = barsForCorr(sym);
      if (bars.length < MIN_SAMPLES + 1) continue;   // 未蓄積/浅い銘柄はスキップ(ウォームアップ中)
      const { corr, samples } = pearsonAlignedReturns(anchorBars, bars);
      if (samples >= MIN_SAMPLES) {
        results.push({ symbol: sym, corr, absCorr: Math.abs(corr), samples });
      }
    }

    results.sort((a, b) => b.absCorr - a.absCorr);
    lastRanked = results;
    lastUpdate = Date.now();
    // v0.7.20: 最も相関の高い銘柄の直近1分変化率(%)を算出(realtime 生サンプルから)。
    const top = results[0];
    topSymbol = top?.symbol ?? null;
    const ret = topSymbol ? getRollingReturn(60_000, topSymbol) : null;
    topChange1mPct = ret === null ? null : ret * 100;
    const top3 = results.slice(0, 3).map(r => `${r.symbol}=${r.absCorr.toFixed(2)}(n=${r.samples})`).join(' ');
    const chgStr = topChange1mPct === null ? '' : ` [top1分 ${topChange1mPct >= 0 ? '+' : ''}${topChange1mPct.toFixed(2)}%]`;
    console.log(`[correlationLoop] updated, top: ${top3 || '(no candidates met MIN_SAMPLES)'}${chgStr}`);
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

export function getCorrelationSnapshot(): {
  ranked: CorrelationResult[];
  anchor: string;
  updatedAt: number;
  topSymbol: string | null;      // v0.7.20: 最も相関の高い銘柄
  topChange1mPct: number | null; // v0.7.20: その銘柄の直近1分変化率(%)
} {
  return { ranked: lastRanked, anchor: ANCHOR, updatedAt: lastUpdate, topSymbol, topChange1mPct };
}
