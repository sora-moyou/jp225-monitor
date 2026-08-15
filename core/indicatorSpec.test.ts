import { describe, it, expect } from 'vitest';
import {
  BB_SIGMA, BB_BAND_LABEL,
  SQUEEZE_BB_PERIOD, SQUEEZE_BB_SIGMA, SQUEEZE_BW_LOOKBACK,
} from './indicatorSpec.js';

// ─── ★2種類のバンドが同居する(2026-08-15) ───────────────────────────────────
//
// この案件のバンドは2つある。混ぜると、片方を直したときにもう片方が黙って動く。
//   ・バンドウォーク用(既存): 14本 / 0.7σ … **AI のプロンプト文言と判定が共有**している。
//   ・スクイーズ用(新設):     20本 / 2σ  … パネル表示と スクイーズ/バルジ の判定だけに使う。
//
// ★既存σを変えると、実走中の質問文 A/B(v1 vs v2)のプロンプトが変わって標本が割れる。
//   だからこのテストは「新しい定数が正しいこと」と同じ強さで
//   「**既存σが 0.7 のまま**であること」を固定する。

describe('バンドの定数', () => {
  it('スクイーズ用は 20本 / 2σ / 参照72本', () => {
    expect(SQUEEZE_BB_PERIOD).toBe(20);
    expect(SQUEEZE_BB_SIGMA).toBe(2);
    expect(SQUEEZE_BW_LOOKBACK).toBe(72);
  });

  it('★既存のバンドウォーク用σは変えない(AI プロンプトが共有している)', () => {
    expect(BB_SIGMA).toBe(0.7);
    expect(BB_BAND_LABEL).toBe('±0.7σ');
  });

  it('2つは別物である(同じ値に寄せない)', () => {
    expect(SQUEEZE_BB_SIGMA).not.toBe(BB_SIGMA);
  });
});
