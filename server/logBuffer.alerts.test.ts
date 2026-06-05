// ③ アラート検証ログが正しくアラートを拾うか の検証。
// logBuffer は全 console.* をグローバルに捕捉して /api/logs で配信する「検証ログ」の実体。
// アラート発火時に各検出器が emit 直前に出す console.log 行が、確実にバッファへ入ることを
// エンドツーエンドで確認する(検出 → console.log → logBuffer 捕捉 → getLogs で取得)。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installLogCapture, getLogs, resetLogBuffer } from './logBuffer.js';
import { evaluateBarsNiy, _resetShockCooldown, _resetGranvilleDedup } from './alertEngine.js';
import { DEFAULT_PARAMS } from './alertDetector.js';
import { INSTRUMENTS } from './config.js';
import { _reset as resetCooldown } from './alertCooldown.js';
import type { Bar } from './correlation.js';
import type { AlertEventPayload } from './types.js';

const META = INSTRUMENTS.find(i => i.symbol === 'NIY=F')!;

// 静かなジグザグ → 完成足で急騰。急変(shock)が発火する系列(alertEngine.test.ts と同条件)。
function quietThenJump(): Bar[] {
  const bars: Bar[] = [];
  let price = 30000;
  for (let i = 0; i < 64; i++) { price += (i % 2 === 0 ? 1 : -1); bars.push({ t: i * 60_000, close: price }); }
  bars.push({ t: 64 * 60_000, close: price + 50 });
  bars.push({ t: 65 * 60_000, close: price + 50 });
  return bars;
}

// 緩やかな下降→上昇でクロス。グランビル転換が発火する系列。
function gradualReversalUp(): Bar[] {
  const bars: Bar[] = [];
  let i = 0;
  for (; i < 90; i++) bars.push({ t: i * 60_000, close: 67500 - 1500 * (i / 89) });
  const b = bars[bars.length - 1]!.close;
  for (let k = 1; k <= 10; k++, i++) bars.push({ t: i * 60_000, close: b + 60 * k });
  return bars;
}

describe('アラート検証ログ (logBuffer) がアラートを拾う', () => {
  beforeEach(() => { resetLogBuffer(); resetCooldown(); _resetShockCooldown(); _resetGranvilleDedup(); });
  afterEach(() => { resetLogBuffer(); });

  it('急変(shock)発火時の [alertEngine] 行がバッファに入る', () => {
    installLogCapture();
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(quietThenJump(), META, DEFAULT_PARAMS, 65 * 60_000, e => fired.push(e));
    // 前提: 実際に発火している(emit と検証ログの整合)。
    expect(fired.some(e => e.detectionKind === 'shock')).toBe(true);
    const captured = getLogs().filter(l => l.msg.includes('[alertEngine]') && l.msg.includes('shock'));
    expect(captured.length).toBe(1);
    expect(captured[0]!.level).toBe('log');
  });

  it('グランビル発火時の [alertEngine] 行がバッファに入る', () => {
    installLogCapture();
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(gradualReversalUp(), META, DEFAULT_PARAMS, 95 * 60_000, e => fired.push(e));
    expect(fired.some(e => e.detectionKind === 'trend')).toBe(true);   // 転換→trend(内部ログは「グランビル…」)
    const captured = getLogs().filter(l => l.msg.includes('[alertEngine]') && l.msg.includes('グランビル'));
    expect(captured.length).toBe(1);
  });

  it('発火が無ければアラート行も記録されない(過剰記録しない)', () => {
    installLogCapture();
    const flat: Bar[] = Array.from({ length: 70 }, (_, i) => ({ t: i * 60_000, close: 30000 }));
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(flat, META, DEFAULT_PARAMS, 70 * 60_000, e => fired.push(e));
    expect(fired.length).toBe(0);
    expect(getLogs().filter(l => l.msg.includes('[alertEngine]')).length).toBe(0);
  });
});
