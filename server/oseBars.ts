import type { Bar } from './correlation.js';

// v0.3.30: 日経225先物(NIY=F)の 1 分足をリアルタイム OSE feed から自前で積み上げる。
//
// OSE の 1 分足「履歴」は外部から取得できない (nikkei225jp の履歴データは robots.txt の
// /_data/ Disallow 配下)。そこで priceLoop が毎ポーリング流す OSE リアルタイム価格を
// 1 分 OHLC(close のみ) に畳む。alertLoop はこのバーが十分溜まれば z-score 検知に使い、
// ウォームアップ中(起動〜約65分)は Yahoo(CME) 分足にフォールバックする。
//
// 偽スパイク回避の要: 系列を CME と連結しない。alertLoop は「全 OSE」か「全 CME」の
// 同質配列を丸ごと使い、跨ぎ return を一切作らない (getOseBars はこの純 OSE 配列を返す)。

const MAX_BARS = 130;            // 60分 baseline + 余裕。古いバーは捨てる。
const MIN_BARS_READY = 65;       // alertLoop の発火要件 (これ未満は CME フォールバック)

let closed: Bar[] = [];          // 確定済み 1 分足
let curMinute = -1;              // 進行中バーの分 (epoch 分)
let curBar: Bar | null = null;   // 進行中バー (close は最新値で逐次更新)

/** priceLoop から OSE リアルタイム価格を投入。timestamp(ms) で分足を切る。 */
export function feedOsePrice(price: number, timestamp: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const minute = Math.floor(timestamp / 60_000);
  if (minute < curMinute) return;            // 時刻逆行は無視 (順序保証)
  if (minute !== curMinute) {
    if (curBar) {
      closed.push(curBar);
      if (closed.length > MAX_BARS) closed = closed.slice(-MAX_BARS);
    }
    curMinute = minute;
    curBar = { t: minute * 60_000, close: price };
  } else if (curBar) {
    curBar.close = price;                     // 同一分内は最新値で close 更新
  }
}

/** 確定済み + 進行中バーを純 OSE 配列で返す (末尾が現在足)。 */
export function getOseBars(): Bar[] {
  return curBar ? [...closed, curBar] : [...closed];
}

/** alertLoop の発火要件を満たすだけ OSE バーが溜まっているか。 */
export function isOseBarsReady(): boolean {
  return closed.length + (curBar ? 1 : 0) >= MIN_BARS_READY;
}

// テスト用
export function _reset(): void { closed = []; curMinute = -1; curBar = null; }
