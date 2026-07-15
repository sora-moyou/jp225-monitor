import { describe, it, expect, afterEach } from 'vitest';
import {
  computeExitStop, computeExitStopSimple, _setExitImpl, type ExitState,
} from './index.js';

afterEach(() => _setExitImpl(null));   // 各テスト後に簡易版へ戻す

describe('computeExitStopSimple (公開・決定論フォールバック)', () => {
  it('含み益に関わらず初期LCを固定で返す(ラチェット無し)', () => {
    const base: ExitState = { direction: 'buy', entryPrice: 38000, initialStop: 37950, peakProfit: 0 };
    expect(computeExitStopSimple(base)).toBe(37950);
    expect(computeExitStopSimple({ ...base, peakProfit: 500 })).toBe(37950);   // 大きな含み益でも動かない
  });

  it('sell でも初期LCをそのまま返す', () => {
    expect(computeExitStopSimple({ direction: 'sell', entryPrice: 38000, initialStop: 38050, peakProfit: 300 })).toBe(38050);
  });

  it('初期LCが非有限なら null', () => {
    expect(computeExitStopSimple({ direction: 'buy', entryPrice: 38000, initialStop: NaN, peakProfit: 0 })).toBeNull();
  });
});

describe('computeExitStop (差し替え可能なディスパッチ)', () => {
  it('既定は簡易版に委譲する', () => {
    expect(computeExitStop({ direction: 'buy', entryPrice: 38000, initialStop: 37950, peakProfit: 999 })).toBe(37950);
  });

  it('_setExitImpl で実装を差し替えられる(private ロードの代替)', () => {
    _setExitImpl(s => s.entryPrice + 100);
    expect(computeExitStop({ direction: 'buy', entryPrice: 38000, initialStop: 37950, peakProfit: 0 })).toBe(38100);
  });
});
