import { describe, it, expect } from 'vitest';
import { isAnalysisEnabled } from './analysisGate.js';

// 分析用コードの単一ゲート。判定材料は既存の MONITOR_VARIANT だけ(新しい設定機構は無い)。
// ★未設定は full = 分析あり(dev/テスト/既存経路は今までどおり)。lite だけ止める。
describe('isAnalysisEnabled', () => {
  it('lite だけ false', () => {
    expect(isAnalysisEnabled({ MONITOR_VARIANT: 'lite' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('full / 未設定 / 不明な値 は true(安全側=従来どおり動く)', () => {
    expect(isAnalysisEnabled({ MONITOR_VARIANT: 'full' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isAnalysisEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isAnalysisEnabled({ MONITOR_VARIANT: 'LITE' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isAnalysisEnabled({ MONITOR_VARIANT: '' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('引数を省略すると process.env を読む', () => {
    const saved = process.env.MONITOR_VARIANT;
    try {
      delete process.env.MONITOR_VARIANT;
      expect(isAnalysisEnabled()).toBe(true);
      process.env.MONITOR_VARIANT = 'lite';
      expect(isAnalysisEnabled()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.MONITOR_VARIANT;
      else process.env.MONITOR_VARIANT = saved;
    }
  });
});
