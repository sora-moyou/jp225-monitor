import type { Price, Symbol, InstrumentMeta } from '../types.js';
import type { AlertEvent, DetectionKind, PriceAction } from '../types.js';

interface Sample { t: number; price: number; }

const BUFFER_WINDOW_MS = 60 * 60 * 1000;   // 1時間保持（PA1h用）
const MAGNITUDE_WINDOW_MS = 5 * 60 * 1000; // 発火: 変動幅判定窓
const SLOPE_WINDOW_MS = 30 * 1000;          // 発火: 傾き判定窓
const CONTEXT_WINDOW_MS = 15 * 60 * 1000;   // バナー表示用 + 15分OHLC窓
const RANGE_1H_WINDOW_MS = 60 * 60 * 1000;  // 1時間レンジ
const DEFAULT_COOLDOWN_MS = 60 * 1000;

interface State {
  meta: InstrumentMeta;
  buffer: Sample[];          // 時系列順、最大15分（発火窓は5分、コンテキストは15分）
  lastAlertAt: number;       // -Infinity means no alert has ever fired
}

export interface DetectorOptions {
  cooldownMs?: number;
}

export class ChangeDetector {
  private states: Map<Symbol, State>;
  private cooldownMs: number;

  constructor(instruments: InstrumentMeta[], opts: DetectorOptions = {}) {
    this.states = new Map(
      instruments.map(meta => [meta.symbol, { meta, buffer: [], lastAlertAt: -Infinity }])
    );
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  feed(price: Price): AlertEvent[] {
    const state = this.states.get(price.symbol);
    if (!state) return [];

    // 防御: 直前サンプルと比較して | %変化 | > 50% は data 異常 → バッファリセット
    // (現実の市場では 30 秒で 50% 動くことはあり得ない)
    const last = state.buffer[state.buffer.length - 1];
    if (last) {
      const jumpPct = pctChange(last.price, price.price);
      if (Math.abs(jumpPct) > 50) {
        console.warn(`[detector] ${price.symbol}: implausible jump ${jumpPct.toFixed(1)}% (${last.price} → ${price.price}), resetting buffer`);
        state.buffer = [];
      }
    }

    state.buffer.push({ t: price.timestamp, price: price.price });

    // バッファ保持: BUFFER_WINDOW_MS まで残す（コンテキスト計算用）
    const cutoff = price.timestamp - BUFFER_WINDOW_MS;
    while (state.buffer.length > 0 && (state.buffer[0]?.t ?? 0) < cutoff) {
      state.buffer.shift();
    }
    if (state.buffer.length < 2) return [];

    // クールダウン中は判定スキップ
    if (price.timestamp - state.lastAlertAt < this.cooldownMs) return [];

    // 傾き判定（30秒窓の最古値と比較）
    const slopeCutoff = price.timestamp - SLOPE_WINDOW_MS;
    const slopeBase = state.buffer.find(s => s.t >= slopeCutoff);
    if (slopeBase && slopeBase !== state.buffer[state.buffer.length - 1]) {
      const pct = pctChange(slopeBase.price, price.price);
      const window = (price.timestamp - slopeBase.t) / 1000;
      if (Math.abs(pct) >= state.meta.slopeThreshold) {
        return [this.fireAlert(state, price, pct, window, 'slope')];
      }
    }

    // 変動幅判定（5分窓の最古値と比較）
    const magCutoff = price.timestamp - MAGNITUDE_WINDOW_MS;
    const magBase = state.buffer.find(s => s.t >= magCutoff);
    if (magBase && magBase !== state.buffer[state.buffer.length - 1]) {
      const pct = pctChange(magBase.price, price.price);
      const window = (price.timestamp - magBase.t) / 1000;
      if (Math.abs(pct) >= state.meta.magnitudeThreshold) {
        return [this.fireAlert(state, price, pct, window, 'magnitude')];
      }
    }

    return [];
  }

  private fireAlert(
    state: State, price: Price, pct: number, windowSec: number, kind: DetectionKind
  ): AlertEvent {
    state.lastAlertAt = price.timestamp;
    // 直近15分のOHLC（テクニカル分析用）
    const ctxCutoff = price.timestamp - CONTEXT_WINDOW_MS;
    const ctx15 = state.buffer.filter(s => s.t >= ctxCutoff);
    const pa15min: PriceAction | null = ctx15.length >= 2 ? {
      open: ctx15[0]!.price,
      high: Math.max(...ctx15.map(s => s.price)),
      low: Math.min(...ctx15.map(s => s.price)),
      current: price.price,
    } : null;
    const change15min = pa15min ? pctChange(pa15min.open, pa15min.current) : null;

    // 直近1時間レンジ（サポレジ参考）
    const range1hCutoff = price.timestamp - RANGE_1H_WINDOW_MS;
    const range1hSamples = state.buffer.filter(s => s.t >= range1hCutoff);
    const range1h = range1hSamples.length >= 2 ? {
      high: Math.max(...range1hSamples.map(s => s.price)),
      low: Math.min(...range1hSamples.map(s => s.price)),
    } : null;

    return {
      symbol: state.meta.symbol,
      symbolLabel: state.meta.labelJa,
      changePercent: pct,
      windowSeconds: Math.round(windowSec),
      detectionKind: kind,
      direction: pct >= 0 ? 'up' : 'down',
      triggeredAt: price.timestamp,
      change15min,
      pa15min,
      range1h,
    };
  }
}

function pctChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}
