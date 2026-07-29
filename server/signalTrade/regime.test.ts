import { describe, it, expect } from 'vitest';
import { computeRegime, formatMomentumLine, type Regime, type RegimeBar } from './regime.js';

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

/** 表示テスト用の Regime。省略フィールドは「新鮮・競合なし」の既定で埋める。 */
function reg(over: Partial<Regime>): Regime {
  return {
    ret10: 0, ret30: 0, ma20Slope: 0,
    swingHigh: 38100, swingLow: 38000, posPct: 50,
    dir: 'flat', strong: false, trendDir: 'flat', longDir: 'flat', trendStrong: false,
    ret10StaleMin: null, ...over,
  };
}

describe('formatMomentumLine', () => {
  it('全フィールドありの整形(符号付き・ラベル・強弱)', () => {
    const line = formatMomentumLine(reg({
      ret10: 200, ret30: 350, ma20Slope: 12.34,
      swingHigh: 38300, swingLow: 38000, posPct: 66.6,
      dir: 'up', strong: true, trendDir: 'up', longDir: 'up', trendStrong: true,
    }));
    expect(line).toBe('直近の勢い: 10分+200円 / 30分+350円 / MA20傾き+12.3 / 直近30分高安[38000-38300]内67% → 上昇トレンド(強)');
  });

  it('負値の符号 & 下降ラベル', () => {
    const line = formatMomentumLine(reg({
      ret10: -180, ret30: -50, ma20Slope: -3,
      swingHigh: 38300, swingLow: 38000, posPct: 10,
      dir: 'down', strong: true, trendDir: 'down', longDir: 'flat', trendStrong: true,
    }));
    expect(line).toContain('10分-180円');
    expect(line).toContain('MA20傾き-3.0');
    expect(line).toContain('下降トレンド(強)');
  });

  it('null フィールドは「—」/ flat は 横ばい(弱)', () => {
    const line = formatMomentumLine(reg({
      ret10: null, ret30: null, ma20Slope: null,
      swingHigh: null, swingLow: null, posPct: null,
    }));
    expect(line).toBe('直近の勢い: 10分— / 30分— / MA20傾き— / 直近30分高安[—-—]内—% → 横ばい(弱)');
  });

  it('ラベルは trendDir/trendStrong を使う(dir/strong ではない=表示専用の合議ラベル)', () => {
    // dir=flat(=veto しない) のまま、長い時間軸の合議だけで「下降トレンド」と表示する。
    const line = formatMomentumLine(reg({
      ret10: -95, ret30: -1205, ma20Slope: -134, posPct: 5,
      trendDir: 'down', longDir: 'down', trendStrong: true,
    }));
    expect(line).toContain('下降トレンド(強)');
    expect(line).not.toContain('横ばい');
  });

  it('レンジ両面OFF(既定/引数省略)ではレンジへ誘導しない', () => {
    const line = formatMomentumLine(reg({}));
    expect(line).toContain('横ばい');
    expect(line).not.toContain('レンジ');
  });

  it('レンジ両面ON + 横ばい なら direction:"range" を出してよい旨を添える', () => {
    const line = formatMomentumLine(reg({}), true);
    expect(line).toContain('横ばい(弱)');
    expect(line).toContain('レンジ両面が有効な設定');
    expect(line).toContain('direction:"range"');
    // ★v0.9.44: 2択(fade=両側指値の組 / breakout=両側ブレイク新規の組)の両方が選べることを伝える。
    //   語彙は system prompt の rangeLine と揃える(SSOT)。組を混ぜないことも明示する。
    expect(line).toContain('fade=両側指値の組');
    expect(line).toContain('breakout=両側ブレイク新規の組');
    expect(line).toContain('組は混ぜない');
  });

  it('レンジ両面ON でもトレンド判定のときはレンジを勧めない', () => {
    const line = formatMomentumLine(reg({
      ret10: -95, ret30: -1205, ma20Slope: -134, posPct: 5,
      trendDir: 'down', longDir: 'down', trendStrong: true,
    }), true);
    expect(line).toContain('下降トレンド(強)');
    expect(line).not.toContain('レンジ');
    expect(line).not.toContain('range');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★競合(短期↔長期が逆)の表示。断定しない=「戻り/押し目」+ 弱 + 見送りが整合的である旨。
// ─────────────────────────────────────────────────────────────────────────────
describe('formatMomentumLine — 競合(conflict)の表示', () => {
  it('短期↑・長期↓ は「戻り(長期は下降)(弱)」で、上昇トレンドとは断定しない', () => {
    const line = formatMomentumLine(reg({
      ret10: 225, ret30: -490, ma20Slope: -47, posPct: 30,
      dir: 'up', strong: true, trendDir: 'conflict', longDir: 'down', trendStrong: false,
    }));
    expect(line).toContain('戻り(長期は下降)(弱)');
    expect(line).not.toContain('上昇トレンド');
    expect(line).not.toContain('下降トレンド');
  });

  it('長期合議は flat の弱い競合では「長期は下降」と言い切らず「30分は逆向き」と書く', () => {
    const line = formatMomentumLine(reg({
      ret10: 120, ret30: -150, ma20Slope: -5,
      dir: 'up', strong: true, trendDir: 'conflict', longDir: 'flat', trendStrong: false,
    }));
    expect(line).toContain('戻り(30分は逆向き)(弱)');
    expect(line).not.toContain('長期は下降');
  });

  it('短期↓・長期↑ は「押し目(長期は上昇)(弱)」', () => {
    const line = formatMomentumLine(reg({
      ret10: -200, ret30: 1200, ma20Slope: 40, posPct: 70,
      dir: 'down', strong: true, trendDir: 'conflict', longDir: 'up', trendStrong: false,
    }));
    expect(line).toContain('押し目(長期は上昇)(弱)');
    expect(line).not.toContain('上昇トレンド');
  });

  it('競合では「veto が長期方向の順張りを落とすので none が整合的」と添える', () => {
    const line = formatMomentumLine(reg({
      ret10: 225, ret30: -490, ma20Slope: -47,
      dir: 'up', strong: true, trendDir: 'conflict', longDir: 'down', trendStrong: false,
    }));
    expect(line).toContain('direction:"none"');
  });

  it('競合ではレンジ両面ONでもレンジを勧めない(横ばいではないため)', () => {
    const line = formatMomentumLine(reg({
      ret10: 225, ret30: -490, ma20Slope: -47,
      dir: 'up', strong: true, trendDir: 'conflict', longDir: 'down', trendStrong: false,
    }), true);
    expect(line).not.toContain('レンジ両面が有効な設定');
    expect(line).not.toContain('direction:"range"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★寄り付きギャップ注記。ret10 の比較先が古い足のとき、その旨を表示に足す(値は据え置き=ゲート不変)。
// ─────────────────────────────────────────────────────────────────────────────
describe('formatMomentumLine — 寄り付きギャップ注記', () => {
  it('ret10 の比較先が古いときは遅れ[分]つきで「10分前ではない」と注記する', () => {
    const line = formatMomentumLine(reg({
      ret10: -400, ret30: null, ma20Slope: null, ret10StaleMin: 75,
      dir: 'down', strong: true, trendDir: 'stale', longDir: 'flat', trendStrong: false,
    }));
    expect(line).toContain('10分-400円(※比較先は75分前の足=寄り付きギャップ/欠測)');
  });

  it('比較先が新鮮なら注記しない(従来と同じ表示)', () => {
    const line = formatMomentumLine(reg({ ret10: -400, dir: 'down', strong: true, trendDir: 'down', trendStrong: true }));
    expect(line).toContain('10分-400円 /');
    expect(line).not.toContain('寄り付きギャップ');
  });

  it('ギャップ由来のときはラベルを断定しない(「トレンド(強)」と言わない)', () => {
    const line = formatMomentumLine(reg({
      ret10: -205, ret30: null, ma20Slope: null, ret10StaleMin: 162,
      dir: 'down', strong: true, trendDir: 'stale', longDir: 'flat', trendStrong: false,
    }));
    expect(line).toContain('→ 判定保留(寄り付きギャップ)');
    expect(line).not.toContain('下降トレンド');
    expect(line).not.toContain('(強)');
  });

  it('ギャップ由来では「9年検証でギャップに方向エッジ無し・根拠にするな」と添える', () => {
    const line = formatMomentumLine(reg({
      ret10: -205, ret10StaleMin: 162, dir: 'down', strong: true,
      trendDir: 'stale', trendStrong: false,
    }));
    expect(line).toContain('寄り付きギャップ');
    expect(line).toContain('9年');
    expect(line).toContain('方向のエッジは無い');
    expect(line).toContain('direction:"none"');
  });

  it('ギャップ由来ではレンジ両面ONでもレンジを勧めない(横ばいと断定していないため)', () => {
    const line = formatMomentumLine(reg({
      ret10: -205, ret10StaleMin: 162, dir: 'down', strong: true,
      trendDir: 'stale', trendStrong: false,
    }), true);
    expect(line).not.toContain('レンジ両面が有効な設定');
    expect(line).not.toContain('direction:"range"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★表示専用の合議ラベル(trendDir/trendStrong)。dir/strong(=trend veto の入力)は不変。
// ─────────────────────────────────────────────────────────────────────────────
describe('computeRegime — trendDir(表示専用の合議ラベル)', () => {
  it('ret10 が閾値未満でも 30分が閾値×2 以上下げていれば trendDir=down(dir は flat のまま)', () => {
    // now−30分=38000 → now−10分=37960 → now=37700。ret10=−260? ではなく ret10 を小さくする。
    const bars = series(minAgo => {
      if (minAgo >= 30) return 39300;
      if (minAgo >= 10) return 38150;   // now−10分 の close=38150
      return 38100;                     // now の close=38100 → ret10=−50(閾値未満)
    }, 31);
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret10).toBe(-50);
    expect(r.ret30).toBe(38100 - 39300);   // −1200 ≤ −200
    // ゲート(veto)入力は不変。
    expect(r.dir).toBe('flat');
    expect(r.strong).toBe(false);
    // 表示ラベルだけが下降になる。
    expect(r.trendDir).toBe('down');
  });

  it('対称: 30分が +閾値×2 以上なら trendDir=up(dir は flat)', () => {
    const bars = series(minAgo => {
      if (minAgo >= 30) return 37000;
      if (minAgo >= 10) return 38150;
      return 38200;                     // ret10=+50
    }, 31);
    const r = computeRegime(bars, NOW, 100);
    expect(r.dir).toBe('flat');
    expect(r.trendDir).toBe('up');
  });

  it('MA20傾き ≤ −20 かつ 30分 ≤ −閾値 なら trendDir=down(30分だけでは足りない領域を拾う)', () => {
    // 一定ペースで下げ続ける(1分あたり −15円)。ret30=−450 は −200 以下なので、
    // 傾き条件を単独で確かめるため 30分の下げ幅が −100〜−200 に収まる −5円/分 を使う。
    const bars = series(minAgo => 38000 + minAgo * 5, 60);   // now が最安・過去ほど高い
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret10).toBe(-50);            // 閾値未満 → dir=flat
    expect(r.ret30).toBe(-150);           // −200 超えず(=2×閾値の条件では拾えない)
    expect(r.ma20Slope).not.toBeNull();
    expect(r.ma20Slope!).toBeLessThanOrEqual(-20);
    expect(r.dir).toBe('flat');
    expect(r.trendDir).toBe('down');
  });

  it('どの条件にも当たらなければ trendDir=flat', () => {
    const bars = series(() => 38000, 60);
    const r = computeRegime(bars, NOW, 100);
    expect(r.trendDir).toBe('flat');
    expect(r.trendStrong).toBe(false);
  });

  it('競合が無く dir が flat でなければ trendDir は dir と一致(ラベルがゲートと矛盾しない)', () => {
    const up = series(minAgo => (minAgo === 10 ? 38000 : minAgo === 0 ? 38200 : 38000), 31);
    expect(computeRegime(up, NOW, 100).trendDir).toBe('up');
    const down = series(minAgo => (minAgo === 10 ? 38200 : minAgo === 0 ? 38000 : 38200), 31);
    expect(computeRegime(down, NOW, 100).trendDir).toBe('down');
  });

  // ★短期と長期が逆向きのとき、どちらかに断定すると必ず嘘になる(実データ検証: 競合点で
  //   ラベル方向の的中率は15分48.2%/30分50.0%=情報量ゼロ、しかも表示と逆に動く)。
  //   ゆえに断定せず 'conflict'(戻り/押し目)という第3の状態として明示する。
  it('短期↑・長期↓ は断定せず conflict(戻り)にする。dir は down にならず up のまま(ゲート不変)', () => {
    // 30分では −490 の下落だが、直近10分で +225 の戻し。
    const bars = series(minAgo => {
      if (minAgo >= 30) return 38490;
      if (minAgo >= 10) return 37775;
      return 38000;
    }, 31);
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret10).toBe(225);
    expect(r.ret30).toBe(-490);
    expect(r.dir).toBe('up');            // ゲート入力は不変(ret10 のみ)
    expect(r.trendDir).toBe('conflict');
    expect(r.longDir).toBe('down');
    expect(r.trendStrong).toBe(false);   // 断定しない=弱
  });

  it('短期↓・長期↑ も conflict(押し目)。dir は down のまま', () => {
    const bars = series(minAgo => {
      if (minAgo >= 30) return 37000;
      if (minAgo >= 10) return 38400;
      return 38200;
    }, 31);
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret10).toBe(-200);
    expect(r.ret30).toBe(1200);
    expect(r.dir).toBe('down');
    expect(r.trendDir).toBe('conflict');
    expect(r.longDir).toBe('up');
    expect(r.trendStrong).toBe(false);
  });

  it('長期合議が flat でも、30分が閾値以上 逆向きなら競合扱い(弱い矛盾も断定しない)', () => {
    // ret10=+120(dir=up) だが ret30=−150(閾値100以上の逆向き)。長期合議(±200/傾き)は成立しない。
    const bars = series(minAgo => {
      if (minAgo >= 30) return 38150;
      if (minAgo >= 10) return 37880;
      return 38000;
    }, 31);
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret10).toBe(120);
    expect(r.ret30).toBe(-150);
    expect(r.dir).toBe('up');          // ゲート不変
    expect(r.longDir).toBe('flat');    // 長期合議(2倍閾値/傾き)は成立していない
    expect(r.trendDir).toBe('conflict');
    expect(r.trendStrong).toBe(false);
  });

  it('30分の逆向きが閾値未満なら競合ではない(短期トレンドとして断定してよい)', () => {
    // ret10=+120(dir=up) / ret30=−50(閾値未満)。
    const bars = series(minAgo => {
      if (minAgo >= 30) return 38050;
      if (minAgo >= 10) return 37880;
      return 38000;
    }, 31);
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret30).toBe(-50);
    expect(r.trendDir).toBe('up');
    expect(r.trendStrong).toBe(true);
  });

  it('30分が欠測(鮮度切れ)なら競合判定できない=短期トレンドのまま', () => {
    const bars: RegimeBar[] = [bar(300, 39000)];
    for (let i = 12; i >= 0; i--) bars.push(bar(i, 38000 + (i <= 9 ? (10 - i) * 20 : 0)));
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret30).toBeNull();
    expect(r.trendDir).toBe(r.dir);
  });
});

describe('computeRegime — trendStrong(表示専用の強弱)', () => {
  it('ret10 が閾値超え(=veto 発火)なら強', () => {
    const up = series(minAgo => (minAgo === 10 ? 38000 : minAgo === 0 ? 38200 : 38000), 31);
    const r = computeRegime(up, NOW, 100);
    expect(r.strong).toBe(true);
    expect(r.trendStrong).toBe(true);
  });

  it('根拠が長期1つだけ(30分のみ)なら弱', () => {
    // 30分 −1200(条件成立)。MA20傾きは 0 付近になるよう now−30分より前で一段下げるだけにする。
    const bars = series(minAgo => (minAgo >= 30 ? 39300 : 38100), 31);
    const r = computeRegime(bars, NOW, 100);
    expect(r.trendDir).toBe('down');
    expect(r.trendStrong).toBe(false);
  });

  it('根拠が2つ以上一致(30分×2倍 かつ MA20傾き)なら強', () => {
    // 直近9分は横ばい(ret10 は閾値未満=dir は flat)だが、その手前は −15円/分 で下げ続けた形。
    const bars = series(minAgo => (minAgo <= 8 ? 38000 : 38000 + (minAgo - 8) * 15), 60);
    const r = computeRegime(bars, NOW, 100);
    expect(r.dir).toBe('flat');
    expect(r.ret30).toBeLessThanOrEqual(-200);
    expect(r.ma20Slope!).toBeLessThanOrEqual(-20);
    expect(r.trendDir).toBe('down');
    expect(r.trendStrong).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★鮮度上限。ret30/ma20Slope は目標時刻から離れすぎた足しか無ければ null(=「—」)。
//   ret10/dir/strong は意図的に鮮度上限なし(=ゲート不変)。
// ─────────────────────────────────────────────────────────────────────────────
describe('computeRegime — 鮮度上限(偽の数値の撲滅)', () => {
  it('now−30分に近い足が無い(セッション跨ぎ)と ret30=null。ret10 は従来どおり算出する', () => {
    // 直近12分ぶんの足 + 5時間前の足だけ。now−30分の代わりに 5時間前と比較する状況。
    const bars: RegimeBar[] = [bar(300, 39000)];
    for (let i = 12; i >= 0; i--) bars.push(bar(i, 38000 - i));
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret30).toBeNull();               // 5時間前の足とは比べない(偽の「30分−1000円」を出さない)
    expect(r.ret10).toBe(38000 - (38000 - 10));   // ret10 は鮮度上限なし=従来と同じ +10
  });

  it('ret10 の参照足が古くても ret10/dir/strong は据え置き(ゲート不変のための意図的な非対称)', () => {
    // now−10分 付近に足が無く、5時間前の足しか無い。従来同様その足と比較する。
    const bars: RegimeBar[] = [bar(300, 39000), bar(1, 38000), bar(0, 38000)];
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret10).toBe(38000 - 39000);   // −1000(鮮度上限を課さない)
    expect(r.dir).toBe('down');
    expect(r.strong).toBe(true);
    // ★値は据え置きだが「古い足と比べた」ことは表示用に露出する(注記で嘘だと分かるように)。
    expect(r.ret10StaleMin).toBe(290);     // 目標(now−10分)より さらに 290分 古い足
    // ★表示ラベルは断定しない(信頼できない数値からトレンドを名乗らない)。
    expect(r.trendDir).toBe('stale');
    expect(r.trendStrong).toBe(false);
  });

  it('ギャップ由来のときは長期(ret30)が生きていても断定しない=判定保留が最優先', () => {
    // now−30分 付近には足があり ret30 は算出できるが、now−10分 付近の足が無いケース。
    const bars: RegimeBar[] = [];
    for (let i = 33; i >= 28; i--) bars.push(bar(i, 38600));   // now−33〜28分
    for (let i = 2; i >= 0; i--) bars.push(bar(i, 38000));     // now−2〜0分(間は大穴)
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret30).toBe(-600);            // 30分は新鮮=算出できる
    expect(r.ret10StaleMin).not.toBeNull();  // 10分の比較先は古い
    expect(r.trendDir).toBe('stale');      // それでも断定しない
    expect(r.trendStrong).toBe(false);
  });

  it('参照足が新鮮なら ret10StaleMin=null(注記しない)', () => {
    const bars = series(minAgo => 38000 + minAgo, 31);
    const r = computeRegime(bars, NOW, 100);
    expect(r.ret10StaleMin).toBeNull();
  });

  it('ret10 が算出できない(足不足)なら ret10StaleMin=null', () => {
    const r = computeRegime([], NOW, 100);
    expect(r.ret10StaleMin).toBeNull();
  });

  it('MA20 の20本が長時間に散らばっている(窓が飛んでいる)と ma20Slope=null', () => {
    // 直近25本は連続だが、その手前に大穴があるケースではなく、20本自体が数時間に散らばる例。
    const bars: RegimeBar[] = [];
    for (let i = 24; i >= 0; i--) bars.push(bar(i * 20, 38000 + i));   // 20分間隔=20本で 380分に散らばる
    const r = computeRegime(bars, NOW, 100);
    expect(r.ma20Slope).toBeNull();
  });

  it('連続した1分足なら ma20Slope は従来どおり算出される(鮮度上限で潰さない)', () => {
    const bars = series(minAgo => 38000 + Math.max(0, 10 - minAgo) * 10, 40);
    const r = computeRegime(bars, NOW, 100);
    expect(r.ma20Slope).not.toBeNull();
  });
});
