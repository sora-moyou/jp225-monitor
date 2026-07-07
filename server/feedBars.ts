import type { Bar } from './correlation.js';

// v0.3.30: 日経225先物(NIY=F)の 1 分足をリアルタイム feed から自前で積み上げる。
// v0.3.31: 横断確認(cross-confirmation)の時間軸を日経のリアルタイムに揃えるため、
//          NQ=F / YM=F / JPY=X 等もリアルタイム足を持てるよう銘柄ごとに一般化。
//
// リアルタイム源の 1 分足「履歴」は外部取得できない (nikkei225jp の履歴は robots Disallow)
// ため、priceLoop が毎ポーリング流すリアルタイム価格(225225.jp HTTP フィード)を銘柄ごとに 1 分
// OHLC(close) に畳む。alertLoop は溜まれば z-score / 横断確認に、correlationLoop は相関に使う。
// v0.7.20(no-Yahoo): Yahoo 分足フォールバックは全廃。ウォームアップ中(起動〜約65分)は warmFromDb の
// DB 種付けとリアルタイム蓄積で満たし、溜まるまでは単にスキップ(浅い足で評価/相関しない)。

// v0.3.32: 相関(MIN_SAMPLES=100, 場中ぶんの深さを志向)も賄えるよう保持本数を拡大。
// 検知は末尾60〜65本しか見ないので増やしても影響なし。
const MAX_BARS = 520;            // 60分 baseline + 相関用の深さ(約8.7時間)。古いバーは捨てる。
const MIN_BARS_READY = 65;       // alertLoop の発火/確認要件 (これ未満は評価をスキップ)

interface Series { closed: Bar[]; curMinute: number; curBar: Bar | null; }
const series = new Map<string, Series>();

// v0.3.33: 短期検知/相関のリアルタイム化用に、生サンプル(サブ分解能)も保持する。
// 1分足は分境界でしか動かないため、~2秒ごとのローリング窓(60秒/5分)には生サンプルが要る。
const SAMPLE_RETENTION_MS = 6 * 60_000;   // 6分 (短期60秒 + トレンド5分のローリング窓)
interface Sample { t: number; price: number; }
const samples = new Map<string, Sample[]>();

function pushSample(symbol: string, price: number, t: number): void {
  let arr = samples.get(symbol);
  if (!arr) { arr = []; samples.set(symbol, arr); }
  if (arr.length && t < arr[arr.length - 1]!.t) return;   // 時刻逆行は無視
  arr.push({ t, price });
  const cutoff = t - SAMPLE_RETENTION_MS;
  let drop = 0;
  while (drop < arr.length && arr[drop]!.t < cutoff) drop++;
  if (drop > 0) arr.splice(0, drop);
}

// 指定窓(ms)のローリング変化率(比)を返す。十分なサンプルが無ければ null。
// alertLoop が分足の確定を待たず ~2秒ごとにローリング窓で z 評価できるようにする。
export function getRollingReturn(windowMs: number, symbol: string = 'NIY=F'): number | null {
  const arr = samples.get(symbol);
  if (!arr || arr.length < 2) return null;
  const last = arr[arr.length - 1]!;
  // last.t - windowMs 以下で最大の t を持つサンプル (≒ windowMs 前)
  let base: Sample | null = null;
  for (const s of arr) { if (s.t <= last.t - windowMs) base = s; else break; }
  if (!base || base.price <= 0 || base.t === last.t) return null;
  return (last.price - base.price) / base.price;
}

function getSeries(symbol: string): Series {
  let s = series.get(symbol);
  if (!s) { s = { closed: [], curMinute: -1, curBar: null }; series.set(symbol, s); }
  return s;
}

/** priceLoop からリアルタイム価格を投入。timestamp(ms) で分足を切る。 */
export function feedRealtimePrice(symbol: string, price: number, timestamp: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  pushSample(symbol, price, timestamp);   // 生サンプル(ローリング窓用)
  const s = getSeries(symbol);
  const minute = Math.floor(timestamp / 60_000);
  if (minute < s.curMinute) return;            // 時刻逆行は無視 (順序保証)
  if (minute !== s.curMinute) {
    if (s.curBar) {
      s.closed.push(s.curBar);
      if (s.closed.length > MAX_BARS) s.closed = s.closed.slice(-MAX_BARS);
    }
    s.curMinute = minute;
    s.curBar = { t: minute * 60_000, close: price };
  } else if (s.curBar) {
    s.curBar.close = price;                     // 同一分内は最新値で close 更新
  }
}

/** 確定済み + 進行中バーを純リアルタイム配列で返す (末尾が現在足)。未投入銘柄は空配列。 */
export function getRealtimeBars(symbol: string): Bar[] {
  const s = series.get(symbol);
  if (!s) return [];
  return s.curBar ? [...s.closed, s.curBar] : [...s.closed];
}

/** alertLoop の発火/確認要件を満たすだけバーが溜まっているか。 */
export function isRealtimeBarsReady(symbol: string): boolean {
  const s = series.get(symbol);
  if (!s) return false;
  return s.closed.length + (s.curBar ? 1 : 0) >= MIN_BARS_READY;
}

/** DB ウォームアップ用。1分足を closed[] に、最後の足を進行中(curBar)として種付け。
 *  既にライブデータがある銘柄は上書きしない。 */
export function seedBars(symbol: string, bars: Bar[]): void {
  if (bars.length === 0) return;
  const existing = series.get(symbol);
  if (existing && (existing.closed.length > 0 || existing.curBar)) return;
  const trimmed = bars.slice(-MAX_BARS);
  const last = trimmed[trimmed.length - 1]!;
  series.set(symbol, {
    closed: trimmed.slice(0, -1).map(b => ({ t: b.t, close: b.close })),
    curMinute: Math.floor(last.t / 60_000),
    curBar: { t: last.t, close: last.close },
  });
}

/** DB ウォームアップ用。生サンプル(ローリング窓用)を種付け。既存があれば上書きしない。 */
export function seedSamples(symbol: string, seeded: Sample[]): void {
  if (seeded.length === 0) return;
  if ((samples.get(symbol)?.length ?? 0) > 0) return;
  samples.set(symbol, seeded.map(s => ({ t: s.t, price: s.price })).slice(-1000));
}

// テスト用
export function _reset(): void { series.clear(); samples.clear(); }
