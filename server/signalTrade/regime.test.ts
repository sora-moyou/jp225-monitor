import { describe, it, expect } from 'vitest';
import { computeRegime, formatMomentumLine, type RegimeBar } from './regime.js';

const MIN = 60_000;
const NOW = 1_700_000_000_000;   // 固定 now(純関数=時計非依存)

// t分前(now 基準)の 1 分足を生成。o/h/l/c=close(リアルタイム足の写像に合わせる)。
function bar(minAgo: number, close: number): RegimeBar {
  const t = NOW - minAgo * MIN;
  return { t, o: close, h: close, l: close, c: close };
}

// 30本の連番バー(now-29分 … now)。closeFn(minAgo) で価格を与える。
function series(closeFn: (minAgo: number) => number, count = 30): RegimeBar[] {
  const out: RegimeBar[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(bar(i, closeFn(i)));
  return out;
}

describe('computeRegime — ret10/ret30', () => {
  it('ret10 = close(now) − close(now−10分)、ret30 も同様', () => {
    // フラットなベース + now で 38200、now−10 で 38050、now−30 で 38000。now−30分のバーを含めるため 31 本。
    const bars = series(minAgo => {
      if (minAgo === 0) return 38200;
      if (minAgo === 10) return 38050;
      if (minAgo === 30) return 38000;
      return 38000;
    }, 31);
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret10).toBe(38200 - 38050);   // +150
    expect(r.ret30).toBe(38200 - 38000);   // +200
  });

  it('now−10分にバーが無ければ ret10=null(足不足)', () => {
    // now から now−5分までしか無い → now−10分 の close 取得不可。
    const bars = [bar(5, 38000), bar(3, 38050), bar(0, 38100)];
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret10).toBeNull();
    expect(r.dir).toBe('flat');
    expect(r.strong).toBe(false);
  });

  it('空配列は全フィールド null / flat', () => {
    const r = computeRegime([], NOW, 100);
    expect(r.ret10).toBeNull();
    expect(r.ret30).toBeNull();
    expect(r.ma20Slope).toBeNull();
    expect(r.swingHigh).toBeNull();
    expect(r.swingLow).toBeNull();
    expect(r.posPct).toBeNull();
    expect(r.dir).toBe('flat');
    expect(r.strong).toBe(false);
  });
});

describe('computeRegime — dir/strong(閾値)', () => {
  const up = series(minAgo => (minAgo === 10 ? 38000 : minAgo === 0 ? 38200 : 38000));
  const down = series(minAgo => (minAgo === 10 ? 38200 : minAgo === 0 ? 38000 : 38200));

  it('ret10 ≥ +閾値 → up / strong', () => {
    const r = computeRegime(up, NOW, 100);   // +200 ≥ 100
    expect(r.dir).toBe('up');
    expect(r.strong).toBe(true);
  });

  it('ret10 ≤ −閾値 → down / strong', () => {
    const r = computeRegime(down, NOW, 100);   // −200 ≤ −100
    expect(r.dir).toBe('down');
    expect(r.strong).toBe(true);
  });

  it('閾値未満は flat(strong=false)', () => {
    const r = computeRegime(up, NOW, 300);   // +200 < 300
    expect(r.dir).toBe('flat');
    expect(r.strong).toBe(false);
  });

  it('境界(ちょうど閾値)は up 扱い', () => {
    const r = computeRegime(up, NOW, 200);   // +200 ≥ 200
    expect(r.dir).toBe('up');
  });
});

describe('computeRegime — ma20Slope', () => {
  it('20本以上あれば MA20(now)−MA20(now−5分) を返す', () => {
    // now 付近だけ上げる: 直近を高くすると MA20(now) > MA20(now−5分) → slope>0。
    const bars = series(minAgo => 38000 + Math.max(0, 10 - minAgo) * 10, 30);
    const r = computeRegime(bars, NOW, 100);
    expect(r.ma20Slope).not.toBeNull();
    expect(r.ma20Slope! > 0).toBe(true);
  });

  it('20本未満は ma20Slope=null', () => {
    const bars = series(minAgo => 38000, 10);   // 10本のみ
    const r = computeRegime(bars, NOW, 100);
    expect(r.ma20Slope).toBeNull();
  });
});

describe('computeRegime — swing/posPct', () => {
  it('直近30分の高安と posPct(レンジ内位置)', () => {
    // low=38000(minAgo15) / high=38300(minAgo5) / now close=38150 → pos=50%。
    const bars = series(minAgo => {
      if (minAgo === 15) return 38000;
      if (minAgo === 5) return 38300;
      if (minAgo === 0) return 38150;
      return 38150;
    });
    const r = computeRegime(bars, NOW, 100);
    expect(r.swingHigh).toBe(38300);
    expect(r.swingLow).toBe(38000);
    expect(r.posPct).toBeCloseTo(50, 5);
  });

  it('レンジ幅0(全て同値)は posPct=null', () => {
    const bars = series(() => 38000, 30);
    const r = computeRegime(bars, NOW, 100);
    expect(r.swingHigh).toBe(38000);
    expect(r.swingLow).toBe(38000);
    expect(r.posPct).toBeNull();
  });
});

describe('formatMomentumLine', () => {
  it('全フィールドありの整形(符号付き・ラベル・強弱)', () => {
    const line = formatMomentumLine({
      ret10: 200, ret30: 350, ma20Slope: 12.34,
      swingHigh: 38300, swingLow: 38000, posPct: 66.6,
      dir: 'up', strong: true,
    });
    expect(line).toBe('直近の勢い: 10分+200円 / 30分+350円 / MA20傾き+12.3 / 直近30分高安[38000-38300]内67% → 上昇トレンド(強)');
  });

  it('負値の符号 & 下降ラベル', () => {
    const line = formatMomentumLine({
      ret10: -180, ret30: -50, ma20Slope: -3,
      swingHigh: 38300, swingLow: 38000, posPct: 10,
      dir: 'down', strong: true,
    });
    expect(line).toContain('10分-180円');
    expect(line).toContain('MA20傾き-3.0');
    expect(line).toContain('下降トレンド(強)');
  });

  it('null フィールドは「—」/ flat は 横ばい(弱)', () => {
    const line = formatMomentumLine({
      ret10: null, ret30: null, ma20Slope: null,
      swingHigh: null, swingLow: null, posPct: null,
      dir: 'flat', strong: false,
    });
    expect(line).toBe('直近の勢い: 10分— / 30分— / MA20傾き— / 直近30分高安[—-—]内—% → 横ばい(レンジ可)(弱)');
  });
});
