import type { Price, Symbol, InstrumentMeta } from '../types.js';
import type { AlertEvent, DetectionKind } from '../types.js';

interface Sample { t: number; price: number; }

const MAGNITUDE_WINDOW_MS = 5 * 60 * 1000;
const SLOPE_WINDOW_MS = 30 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;

interface State {
  meta: InstrumentMeta;
  buffer: Sample[];          // 時系列順、最大5分
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

    state.buffer.push({ t: price.timestamp, price: price.price });

    // 古いサンプルを破棄
    const cutoff = price.timestamp - MAGNITUDE_WINDOW_MS;
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
    const magBase = state.buffer[0];
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
    return {
      symbol: state.meta.symbol,
      symbolLabel: state.meta.labelJa,
      changePercent: pct,
      windowSeconds: Math.round(windowSec),
      detectionKind: kind,
      direction: pct >= 0 ? 'up' : 'down',
      triggeredAt: price.timestamp,
    };
  }
}

function pctChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}
