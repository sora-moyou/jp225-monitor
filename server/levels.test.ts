import { describe, it, expect } from 'vitest';
import { computeLevels, FIB_SWING_SESSIONS, LEVEL_SHOW_N, DAILY_PIVOT_WINDOW_YEN, type SessionOHLC } from './levels.js';
import { buildDailyPivotCache, updateDailyPivotCache, dailyPivotsOf } from './dailyPivots.js';

function s(sessionDate: string, session: 'Day' | 'Night', high: number, low: number,
           extra: Partial<SessionOHLC> = {}): SessionOHLC {
  return {
    sessionDate, session, high, low,
    open: extra.open ?? low, close: extra.close ?? high,
    highT: extra.highT ?? 0, lowT: extra.lowT ?? 0,
    openT: extra.openT ?? 0,   // 既定0=寄り前→「寄りから揃っている」扱い
  };
}

describe('computeLevels コア（H/L・コンフルエンス・選抜）', () => {
  it('完了セッションの H/L を現値近傍に上下分割して返す', () => {
    const sessions = [
      s('2026-06-01', 'Night', 67300, 66800),
      s('2026-06-01', 'Day',   67500, 66600),
    ];
    const r = computeLevels(sessions, 67000, 0, null);
    const upPrices = r.up.map(l => l.price);
    const downPrices = r.down.map(l => l.price);
    expect(upPrices).toContain(67300);
    expect(upPrices).toContain(67500);
    expect(downPrices).toContain(66800);
    expect(downPrices).toContain(66600);
    expect(r.up.every(l => l.price > 67000)).toBe(true);
    expect(r.up.map(l => l.price)).toEqual([...r.up.map(l => l.price)].sort((a, b) => a - b));
  });

  it('hlLevels はスコア合計・選抜によらず全高安水準を露出する(選抜窓外も含む)', () => {
    const sessions = [
      s('2026-06-01', 'Day', 67100, 66900),
      s('2026-05-31', 'Day', 67300, 66700),
      s('2026-05-30', 'Day', 67600, 66400),
      s('2026-05-29', 'Day', 68000, 66000),
      s('2026-05-28', 'Day', 68900, 65100),   // 現値67000から1900円(選抜窓1500外)
    ];
    const r = computeLevels(sessions, 67000, 0, null);
    const hl = (r.hlLevels ?? []).map(l => l.price);
    // 全セッションの高安が含まれる(選抜窓外の 68900/65100 も漏らさない)
    expect(hl).toContain(68900);
    expect(hl).toContain(65100);
    expect(hl).toContain(67100);
    expect(hl).toContain(66900);
    expect(hl.length).toBeGreaterThanOrEqual(10);   // 5高+5安(価格重複なし)
    // 高安以外(節目/fib/前日終値)は含まれない
    expect(r.hlLevels!.every(l => /高|安/.test(l.label))).toBe(true);
  });

  it('直近高安2: 少し長い期間(既定20S)の高安が直近高2/安2として露出される', () => {
    // 16セッション。突出した高値をインデックス12(直近10の外・直近20の内)に置く。
    const sessions: SessionOHLC[] = [];
    for (let i = 0; i < 16; i++) {
      const d = `2026-06-${String(16 - i).padStart(2, '0')}`;   // 降順(最新が先頭)
      const high = i === 12 ? 70000 : 67000 + i;                // index12 のみ突出
      sessions.push(s(d, 'Day', high, 66000 - i));
    }
    const r = computeLevels(sessions, 68000, 0, null);
    const lbl = (r.hlLevels ?? []).find(l => l.price === 70000)?.label ?? '';
    expect(lbl).toContain('直近高2');   // 直近10外・直近20内の高値が直近高2として拾われる
  });

  it('±30円以内で重なる H/L を強レベル(★)に束ね、ラベルを連結する', () => {
    const sessions = [
      s('2026-06-01', 'Night', 67410, 66000),
      s('2026-05-31', 'Day',   67400, 66010),
    ];
    const r = computeLevels(sessions, 67000, 0, null);
    const strong = r.up.find(l => l.strong);
    expect(strong).toBeDefined();
    // 2本の H/L が同帯で重なり強レベルになる。新ロジックでは前日終値/長期高など
    // 他の構造水準も同価格帯に合流しうるため、ラベルは「2本以上」を確認する。
    expect(strong!.labels.length).toBeGreaterThanOrEqual(2);
    expect(strong!.price).toBeGreaterThanOrEqual(67400);
    expect(strong!.price).toBeLessThanOrEqual(67410);
  });

  it('進行中(当日)セッションは current で識別し、当日H/L/始値を出す', () => {
    const sessions = [
      s('2026-06-02', 'Day', 67200, 66900, { open: 67050 }),
      s('2026-06-01', 'Night', 67400, 66700),
    ];
    const cur = { sessionDate: '2026-06-02', session: 'Day' as const };
    const r = computeLevels(sessions, 67000, 0, cur);
    const labels = [...r.up, ...r.down].flatMap(l => l.labels);
    expect(labels.some(x => x.includes('当日高'))).toBe(true);
    expect(labels.some(x => x.includes('当日安'))).toBe(true);
    expect(labels.some(x => x.includes('当日始'))).toBe(true);
  });

  it('当日が寄り欠け(openT が寄りより大幅後)なら当日高/安/始を出さない', () => {
    const cur = { sessionDate: '2026-06-02', session: 'Day' as const };
    const lateOpenT = Date.UTC(2026, 5, 2, 13 - 9, 32);   // 最初のバーが 13:32 JST (寄り8:45欠け)
    const sessions = [
      s('2026-06-02', 'Day', 66215, 66085, { open: 66100, openT: lateOpenT }),
      s('2026-06-01', 'Night', 67250, 66900),              // 完了(openT=0=揃い扱い)
    ];
    const r = computeLevels(sessions, 66200, 0, cur);
    const labels = [...r.up, ...r.down].flatMap(l => l.labels);
    expect(labels.some(x => x.includes('当日'))).toBe(false);          // 当日高/安/始は出ない
    expect([...r.up, ...r.down].some(l => l.price === 67250 || l.price === 66900)).toBe(true);  // 完了分は出る
  });

  it('当日が寄りから揃っていれば当日高/安を出す', () => {
    const cur = { sessionDate: '2026-06-02', session: 'Day' as const };
    const goodOpenT = Date.UTC(2026, 5, 2, 8 - 9, 46);    // 8:46 JST ≈ 寄り
    const sessions = [s('2026-06-02', 'Day', 66215, 66085, { open: 66100, openT: goodOpenT })];
    const r = computeLevels(sessions, 66200, 0, cur);
    expect([...r.up, ...r.down].flatMap(l => l.labels).some(x => x.includes('当日'))).toBe(true);
  });

  it('up/down はスコア上位 LEVEL_SHOW_N 本(+直近1/最上位1)の範囲に収まる', () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      s(`2026-05-${10 + i}`, 'Day', 67000 + (i + 1) * 100, 67000 - (i + 1) * 100));
    const r = computeLevels(sessions, 67000, 0, null);
    // v0.6.12: 窓内スコア降順 LEVEL_SHOW_N(=5) + 直近1本 + 遠方の重要水準(指値/逆指値用、ボラ連動 farCount+1≦5
    // +保険1本)。遠方は実S/R(スイング/反応/セッション高安)のみで上限はあるが従来より広い。
    expect(r.up.length).toBeLessThanOrEqual(LEVEL_SHOW_N + 8);
    expect(r.down.length).toBeLessThanOrEqual(LEVEL_SHOW_N + 8);
  });

  it('履歴ゼロなら空を返す（クラッシュしない）', () => {
    const r = computeLevels([], 67000, 0, null);
    expect(r.up).toEqual([]);
    expect(r.down).toEqual([]);
    expect(r.swing).toBeNull();
  });
});

describe('computeLevels フィボナッチ', () => {
  function swingSessions(opts: { highT: number; lowT: number }): SessionOHLC[] {
    return [
      s('2026-06-01', 'Night', 67200, 66500, { highT: 10, lowT: 11 }),
      s('2026-05-31', 'Day',   67100, 66400, { highT: 8, lowT: 9 }),
      s('2026-05-30', 'Night', 67000, 66300, { highT: 6, lowT: 7 }),
      s('2026-05-30', 'Day',   68000, 66800, { highT: opts.highT, lowT: 5 }),
      s('2026-05-29', 'Day',   67300, 66000, { highT: 3, lowT: opts.lowT }),
    ];
  }

  it('下げ脚(安値が新しい): 50%戻し=swingLow+0.5*range、現値が上なら転換成立', () => {
    const sessions = swingSessions({ highT: 4, lowT: 20 });
    const r = computeLevels(sessions, 67100, 0, null);
    expect(r.swing).toEqual({ high: 68000, low: 66000, leg: 'down' });
    const fib50 = [...r.up, ...r.down].find(l => l.reversalLine);
    expect(fib50!.price).toBe(67000);
    expect(r.reversalSatisfied).toBe(true);
  });

  it('上げ脚(高値が新しい): 50%戻し=swingHigh-0.5*range、現値が下なら転換成立', () => {
    const sessions = swingSessions({ highT: 20, lowT: 4 });
    const r = computeLevels(sessions, 66800, 0, null);
    expect(r.swing).toEqual({ high: 68000, low: 66000, leg: 'up' });
    const fib50 = [...r.up, ...r.down].find(l => l.reversalLine);
    expect(fib50!.price).toBe(67000);
    expect(r.reversalSatisfied).toBe(true);
  });

  it('fib50(転換ライン)は近傍4に入らなくても必ず含める', () => {
    const sessions = swingSessions({ highT: 4, lowT: 20 });
    const r = computeLevels(sessions, 67100, 0, null);
    expect([...r.up, ...r.down].some(l => l.reversalLine)).toBe(true);
  });

  it('セッションが5本未満ならフィボ省略（swing=null）', () => {
    const sessions = [s('2026-06-01', 'Day', 67500, 66500)];
    const r = computeLevels(sessions, 67000, 0, null);
    expect(r.swing).toBeNull();
    expect([...r.up, ...r.down].some(l => l.fib !== undefined)).toBe(false);
  });
});

describe('computeLevels extraLevels (ADR等の外部レベル)', () => {
  it('extraLevels が候補に混ざり、近傍選抜に乗る', () => {
    const sessions = [
      s('2026-06-01', 'Night', 67300, 66800),
      s('2026-06-01', 'Day',   67500, 66600),
    ];
    const r = computeLevels(sessions, 67000, 0, null, [
      { price: 67400, label: 'ADR上限予測' },
      { price: 66700, label: 'ADR下限予測' },
    ]);
    const labels = [...r.up, ...r.down].flatMap(l => l.labels);
    expect(labels.some(x => x.includes('ADR上限予測'))).toBe(true);
    expect(labels.some(x => x.includes('ADR下限予測'))).toBe(true);
  });

  it('extraLevels 省略時は従来どおり(既存挙動不変)', () => {
    const sessions = [s('2026-06-01', 'Day', 67500, 66600)];
    const r = computeLevels(sessions, 67000, 0, null);
    expect([...r.up, ...r.down].flatMap(l => l.labels).some(x => x.includes('ADR'))).toBe(false);
  });
});

describe('computeLevels N波動レベル (値幅観測論)', () => {
  it('単独の N波動目標が上位帯 weight で tier≥1 に届く(break/level_sr の監視対象になる)', () => {
    // 終値を高安と別価格にし、通常の高安水準(高々 高+長期高=2.6 程度)を作る(人工的な多重合流は避ける)。
    const sessions = [
      s('2026-06-01', 'Night', 67300, 66800, { close: 67000 }),
      s('2026-06-01', 'Day',   67500, 66600, { close: 67100 }),
    ];
    // nwaveLevels は 10 番目の positional 引数(reaction/volume/congestion/trendline の後)。
    const r = computeLevels(sessions, 67000, 0, null, [], [], [], [], [], [
      { price: 67650, label: 'V値(上昇)' },
    ]);
    const lv = [...r.up, ...r.down].find(l => l.labels.some(x => x.includes('V値(上昇)')));
    expect(lv).toBeTruthy();
    expect(lv!.tier).toBeGreaterThanOrEqual(1);   // 単独でも tier≥1(registry の tier>=1 ゲートに乗る)
  });

  it('選抜窓(≈1500円)の外にある N波動目標も far ラダーで残り tier が付く(遠方も落とさない)', () => {
    const sessions = [
      s('2026-06-01', 'Night', 67300, 66800, { close: 67000 }),
      s('2026-06-01', 'Day',   67500, 66600, { close: 67100 }),
    ];
    // E値=69,000 は現値67,000から2,000円=選抜窓(既定1500)の外。isImportant に N/V/E を足したので important-far で拾う。
    const r = computeLevels(sessions, 67000, 0, null, [], [], [], [], [], [
      { price: 69000, label: 'E値(上昇)' },
    ]);
    const lv = r.up.find(l => l.labels.some(x => x.includes('E値(上昇)')));
    expect(lv).toBeTruthy();                       // 遠方でも選抜から漏れない
    expect(Math.abs(lv!.dist)).toBeGreaterThan(1500);   // 実際に窓外
    expect(lv!.tier).toBeGreaterThanOrEqual(1);    // tier 付与=表示/監視対象になる
  });

  it('nwaveLevels 省略時は従来どおり(N波動ラベルは出ない)', () => {
    const sessions = [s('2026-06-01', 'Day', 67500, 66600)];
    const r = computeLevels(sessions, 67000, 0, null);
    expect([...r.up, ...r.down].flatMap(l => l.labels).some(x => /N値|V値|E値/.test(x))).toBe(false);
  });
});

describe('computeLevels 日足/週足ピボット(長期の実スイング)', () => {
  const sessions = [
    s('2026-06-01', 'Night', 67300, 66800, { close: 67000 }),
    s('2026-06-01', 'Day',   67500, 66600, { close: 67100 }),
  ];
  const dLow = { price: 64000, tf: 'D' as const, type: 'low' as const, date: '2026-09-14', role: 'support' as const, flipped: false, t: 0 };

  it('窓内(現値から1400円下)の日足安値は down に必ず出て、tier=2(★★)・hlLevels にも入る', () => {
    // pivotLevels は 11 番目の positional 引数(nwave の後)。
    const d = { ...dLow, price: 65600 };
    const r = computeLevels(sessions, 67000, 0, null, [], [], [], [], [], [], [d]);
    const lv = r.down.find(l => l.price === 65600);
    expect(lv).toBeTruthy();
    expect(lv!.labels).toContain('日足安値(9/14)');
    expect(lv!.labels.some(x => x.includes('★'))).toBe(false);   // ★はラベルではなく強さ欄(tier)
    expect(lv!.kinds).toContain('dailyPivot');
    expect(lv!.tier).toBe(2);   // 日足ピボットは常に ★★(強さ欄)
    expect(lv!.strong).toBe(true);
    expect((r.hlLevels ?? []).some(h => h.price === 65600 && h.label === '日足安値(9/14)')).toBe(true);
  });

  it('★窓外(現値から3000円下)の日足安値は出さない(強制表示もしない)', () => {
    const r = computeLevels(sessions, 67000, 0, null, [], [], [], [], [], [], [dLow]);
    expect([...r.up, ...r.down].some(l => l.labels.includes('日足安値(9/14)'))).toBe(false);
    expect((r.hlLevels ?? []).some(h => h.label === '日足安値(9/14)')).toBe(false);
  });

  it(`±${DAILY_PIVOT_WINDOW_YEN}円の境界: ちょうど${DAILY_PIVOT_WINDOW_YEN}円は入り、それより5円外は入らない`, () => {
    const inP = { ...dLow, price: 67000 - DAILY_PIVOT_WINDOW_YEN, date: '2026-09-10' };
    const outP = { ...dLow, price: 67000 + DAILY_PIVOT_WINDOW_YEN + 5, type: 'high' as const, role: 'resistance' as const, date: '2026-09-11' };
    const r = computeLevels(sessions, 67000, 0, null, [], [], [], [], [], [], [inP, outP]);
    const labels = [...r.up, ...r.down].flatMap(l => l.labels);
    expect(labels).toContain('日足安値(9/10)');
    expect(labels).not.toContain('日足高値(9/11)');
  });

  it('★現値が動いて窓に入った瞬間に出て、窓外へ離れたら消える(62,530 の例)', () => {
    const p = { ...dLow, price: 62530 };
    const at = (cur: number) => computeLevels(sessions, cur, 0, null, [], [], [], [], [], [], [p]);
    const shown = (cur: number) => [...at(cur).up, ...at(cur).down].some(l => l.labels.includes('日足安値(9/14)'));
    expect(shown(64700)).toBe(false);   // 10/15 引けの現値: 2,170円離れている
    expect(shown(64030)).toBe(true);    // 1,500円以内に入った
    expect(shown(64035)).toBe(false);   // 1,505円 = また窓外
  });

  it('窓内の日足ピボットは全部表示する(選抜の上位N本で落とさない)', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...dLow, price: 66900 - i * 150, date: `2026-09-${String(i + 1).padStart(2, '0')}` }));
    const r = computeLevels(sessions, 67000, 0, null, [], [], [], [], [], [], many);
    const labels = [...r.up, ...r.down].flatMap(l => l.labels);
    for (let i = 0; i < 9; i++) expect(labels, String(i)).toContain(`日足安値(9/${i + 1})`);
  });

  it('割れ→抵抗に反転した日足安値は現値の上で up に出る(ラベルに反転を明記)', () => {
    const flipped = { ...dLow, price: 68000, role: 'resistance' as const, flipped: true };
    const r = computeLevels(sessions, 67000, 0, null, [], [], [], [], [], [], [flipped]);
    const lv = r.up.find(l => l.price === 68000);
    expect(lv?.labels).toContain('日足安値(9/14)割れ→抵抗');
    expect(lv!.tier).toBe(2);
  });

  it('週足ピボットも強制表示(上下で最も近い1本)され tier≥1。ラベルは週の月曜日', () => {
    const w = { ...dLow, tf: 'W' as const, type: 'high' as const, price: 70500, role: 'resistance' as const };
    const r = computeLevels(sessions, 67000, 0, null, [], [], [], [], [], [], [w]);
    const lv = r.up.find(l => l.price === 70500);
    expect(lv?.labels).toContain('週足高値(9/14週)');
    expect(lv!.kinds).toContain('weeklyPivot');
    expect(lv!.tier).toBeGreaterThanOrEqual(1);
  });

  it('表示される dailyPivot を含むクラスタは(強制でなくても・スコアに関係なく)常に tier=2', () => {
    // 現値に近い日足安値2本(どちらも窓内=強制表示)。
    const near1 = { ...dLow, price: 66850 };
    const near2 = { ...dLow, price: 66450, date: '2026-09-10' };
    const r = computeLevels(sessions, 67000, 0, null, [], [], [], [], [], [], [near1, near2]);
    for (const l of [...r.up, ...r.down].filter(x => x.kinds?.includes('dailyPivot'))) {
      expect(l.tier).toBe(2);
      expect(l.strong).toBe(true);
    }
    expect([...r.up, ...r.down].some(l => l.labels.includes('日足安値(9/10)'))).toBe(true);
  });

  it('週足ピボットだけの行(日足と合流しない・強制表示でもない)も、表示されれば tier≥1', () => {
    // 現値近くに強い反応帯(反応5回×4本が合流)を置き、近接の最大スコアを大きくする
    // → 単独の週足(重み2.0)はスコアだけだと norm<0.40 = tier0 になる状況を作る。
    const strong = Array.from({ length: 4 }, () => ({ price: 67100, reactions: 5 }));
    // 週足安値2本: 65,000 は下で最も近い=強制表示、64,000 は強制表示ではない(遠方ラダーで表示)。
    const wNear = { ...dLow, tf: 'W' as const, price: 65000 };
    const wFar = { ...dLow, tf: 'W' as const, price: 64000, date: '2026-09-07' };
    const r = computeLevels(sessions, 67000, 0, null, [], strong, [], [], [], [], [wNear, wFar]);
    const lv = r.down.find(l => l.labels.includes('週足安値(9/7週)'));
    expect(lv).toBeTruthy();
    expect(lv!.kinds).not.toContain('dailyPivot');
    expect(lv!.tier).toBeGreaterThanOrEqual(1);
    expect(lv!.strong).toBe(true);
    for (const l of [...r.up, ...r.down].filter(x => x.kinds?.includes('weeklyPivot'))) {
      expect(l.tier).toBeGreaterThanOrEqual(1);
    }
  });

  it('★下げ続けても当日安値は日足ピボット(★★)にならない(dailyPivotsOf 経由・当日安は「当日安」行のみ)', () => {
    // 確定日 9/1〜9/4(高安は現値の遠く上下)+ 当日 9/7。当日の中で現値が下げ続ける。
    const jst = (d: string, hm: string) => Date.parse(`${d}T${hm}:00+09:00`);
    const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
    const bars = days.map((d, i) => ({ t: jst(d, '10:00'), l: 66000 - i * 10, h: 68000 + i * 10 }));
    bars.push({ t: jst('2026-09-07', '10:00'), l: 66950, h: 67050 });
    const now = jst('2026-09-07', '12:00');
    let cache = buildDailyPivotCache(bars, now);
    for (let k = 0; k < 20; k++) {
      const cur = 66940 - k * 20;   // 新安値を刻み続ける
      cache = updateDailyPivotCache(cache, cur, now + k * 60_000);
      const pivots = dailyPivotsOf(cache);
      expect(pivots.some(p => p.date === cache.todayDate || p.price === cache.todayLo)).toBe(false);
      const r = computeLevels(sessions, cur, 0, null, [], [], [], [], [], [], pivots);
      const daily = [...r.up, ...r.down].filter(l => l.kinds?.includes('dailyPivot'));
      expect(daily.some(l => l.price === cache.todayLo), String(cur)).toBe(false);
      expect(daily.some(l => l.labels.includes('日足安値(9/7)')), String(cur)).toBe(false);
      expect((r.hlLevels ?? []).some(h => h.price === cache.todayLo && h.label.startsWith('日足')), String(cur)).toBe(false);
    }
  });

  it('pivotLevels 省略時は従来どおり(日足/週足ラベルは出ない)', () => {
    const r = computeLevels(sessions, 67000, 0, null);
    expect([...r.up, ...r.down].flatMap(l => l.labels).some(x => /日足|週足/.test(x))).toBe(false);
  });
});
