import type { Bar } from './correlation.js';

// v0.3.30: 日経225先物(NIY=F)の 1 分足をリアルタイム feed から自前で積み上げる。
// v0.3.31: 横断確認(cross-confirmation)の時間軸を日経のリアルタイムに揃えるため、
//          NQ=F / YM=F / JPY=X 等もリアルタイム足を持てるよう銘柄ごとに一般化。
//
// リアルタイム源の 1 分足「履歴」は外部取得できない (nikkei225jp の履歴は robots Disallow)
// ため、priceLoop が毎ポーリング流すリアルタイム価格を銘柄ごとに 1 分 OHLC(close) に畳む。
// alertLoop は溜まれば z-score / 横断確認に使い、ウォームアップ中(起動〜約65分)は
// Yahoo 分足にフォールバックする。系列は混ぜない (全リアルタイム or 全 Yahoo) ので
// 跨ぎ return が生まれず偽スパイクは出ない。

// v0.3.32: 相関(MIN_SAMPLES=100, 場中ぶんの深さを志向)も賄えるよう保持本数を拡大。
// 検知は末尾60〜65本しか見ないので増やしても影響なし。
const MAX_BARS = 520;            // 60分 baseline + 相関用の深さ(約8.7時間)。古いバーは捨てる。
const MIN_BARS_READY = 65;       // alertLoop の発火/確認要件 (これ未満は Yahoo フォールバック)

interface Series { closed: Bar[]; curMinute: number; curBar: Bar | null; }
const series = new Map<string, Series>();

function getSeries(symbol: string): Series {
  let s = series.get(symbol);
  if (!s) { s = { closed: [], curMinute: -1, curBar: null }; series.set(symbol, s); }
  return s;
}

/** priceLoop からリアルタイム価格を投入。timestamp(ms) で分足を切る。 */
export function feedRealtimePrice(symbol: string, price: number, timestamp: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
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

// テスト用
export function _reset(): void { series.clear(); }
