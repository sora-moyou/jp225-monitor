import { describe, it, expect } from 'vitest';
import { applyPivotNudge, enforcePlanConstraintsReport } from './scalpPlan.js';
import { planToArmed } from '../signalTrade/decisions.js';
import { rewriteLcWidthForLeg } from './rationaleLcRewrite.js';
import type { AiPlan } from './scalpPlan.js';

// ★2026-08-26: 5円ずらしを **AiPlan に当てる層** と、そこから実際に武装される値までの配線。
//
// ■ ★この検査が守るもの
//   ① 4脚すべて(方向プランの指値/逆指値 + レンジ両面の上下)が対象
//   ② ★**損切りは動かさない**(ユーザー確定 2026-08-26:「節目ずらしによってLC幅が変わっても
//      制限内なら可とします。」)。幅は5円広がる。帯の検査は直後の enforce がやる。
//   ③ ★元の plan を書き換えない(後段の lcAudit / rangeAnomaly は AI の生出力に対して測るため)
//   ④ ★ずらし → 丸め の順で二重にずれない(ピボットは5円刻みに乗っているので丸めは no-op)
//   ⑤ 発火件数が数えられる(★何件効いているかを知らないまま運用しない)

const REF = 65_700;
const P = (price: number, ...kinds: string[]) => ({ price, kinds });
const LEVELS = [P(65_800, 'sessHL'), P(65_600, 'todayHL'), P(66_000, 'grid500')];

// ★LC の帯(applyPivotNudge の第4引数)。★2026-08-30 に **必須** になった:
//   「ずらすと上限を超える脚は ずらしを諦める」を判定するため。上限の解決は lcEffectiveCeiling。
//   band(65) = 手動設定・実効上限65(v0.9.102 の実値) / bandAi(159) = AI委任・実効上限159。
const band = (ceilingYen: number) => ({ ceilingYen, lcHardMax: { enabled: true, value: ceilingYen } });
const bandAi = (backstop: number) =>
  ({ ceilingYen: 65, ceilingMode: 'ai' as const, lcHardMax: { enabled: true, value: backstop } });
/** 既存の検査が想定していた「上限を意識しない」帯(=実効上限159)。 */
const WIDE = band(159);

const BUY: AiPlan = {
  direction: 'buy', rationale: '', refPrice: REF,
  limitEntry: 65_600, stopLossForLimit: 65_540,
  stopEntry: 65_800, stopLossForStop: 65_740,
};

describe('★① 4脚すべてが対象 / ★② 損切りは動かさない(幅は広がる)', () => {
  it('方向プラン: 両脚の **建値だけ** ずれ、損切りは不動・幅は60→65', () => {
    const r = applyPivotNudge(BUY, REF, LEVELS, WIDE);
    expect(r.plan.limitEntry).toBe(65_605);                       // 下のピボット × 指値 → 近づく(上)
    expect(r.plan.stopEntry).toBe(65_805);                        // 上のピボット × 逆指値 → 遠ざかる(上)
    expect(r.plan.stopLossForLimit).toBe(65_540);                 // ★動かさない
    expect(r.plan.stopLossForStop).toBe(65_740);                  // ★動かさない
    expect(r.plan.limitEntry! - r.plan.stopLossForLimit!).toBe(65);
    expect(r.plan.stopEntry! - r.plan.stopLossForStop!).toBe(65);
    expect(r.count).toBe(2);
  });

  it('★★幅は必ず **広がる** 方向にしか動かない(4脚とも)=下限割れは起こらない', () => {
    const cases = [
      { dir: 'buy' as const, key: 'limit' as const, e: 65_600, sl: 65_540 },
      { dir: 'buy' as const, key: 'stop' as const, e: 65_800, sl: 65_740 },
      { dir: 'sell' as const, key: 'limit' as const, e: 65_800, sl: 65_860 },
      { dir: 'sell' as const, key: 'stop' as const, e: 65_600, sl: 65_660 },
    ];
    for (const c of cases) {
      const plan = (c.key === 'limit'
        ? { direction: c.dir, rationale: '', refPrice: REF, limitEntry: c.e, stopLossForLimit: c.sl }
        : { direction: c.dir, rationale: '', refPrice: REF, stopEntry: c.e, stopLossForStop: c.sl }) as AiPlan;
      const p = applyPivotNudge(plan, REF, LEVELS, WIDE).plan;
      const ne = (p.limitEntry ?? p.stopEntry)!;
      const ns = (p.stopLossForLimit ?? p.stopLossForStop)!;
      expect(Math.abs(ne - ns), `${c.dir}/${c.key}`).toBe(Math.abs(c.e - c.sl) + 5);
    }
  });

  it('レンジ両面: upper/lower とも対象で、幅も保たれる', () => {
    const range: AiPlan = {
      direction: 'range', rationale: '', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 65_800, stopLoss: 65_860 },
        lower: { side: 'buy', type: 'limit', entry: 65_600, stopLoss: 65_540 },
      },
    };
    const r = applyPivotNudge(range, REF, LEVELS, WIDE);
    expect(r.plan.range!.upper!.entry).toBe(65_795);              // 上 × 指値 → 近づく(下)
    expect(r.plan.range!.lower!.entry).toBe(65_605);              // 下 × 指値 → 近づく(上)
    expect(r.plan.range!.upper!.stopLoss).toBe(65_860);           // ★動かさない
    expect(r.plan.range!.lower!.stopLoss).toBe(65_540);           // ★動かさない
    expect(r.plan.range!.upper!.stopLoss! - r.plan.range!.upper!.entry).toBe(65);
    expect(r.plan.range!.lower!.entry - r.plan.range!.lower!.stopLoss!).toBe(65);
    expect(r.count).toBe(2);
  });

  it('計算値(キリ番)にだけ一致する脚は動かない', () => {
    const p: AiPlan = { direction: 'buy', rationale: '', refPrice: REF, stopEntry: 66_000, stopLossForStop: 65_940 };
    const r = applyPivotNudge(p, REF, LEVELS, WIDE);
    expect(r.plan.stopEntry).toBe(66_000);
    expect(r.count).toBe(0);
  });
});

describe('★③ 元の plan を書き換えない(生出力に対する記録を壊さない)', () => {
  it('入力オブジェクトは1バイトも変わらない', () => {
    const before = JSON.stringify(BUY);
    applyPivotNudge(BUY, REF, LEVELS, WIDE);
    expect(JSON.stringify(BUY)).toBe(before);
  });

  it('見送り(none)と材料なしは そのまま返す(同一参照)', () => {
    const none: AiPlan = { direction: 'none', rationale: '', refPrice: REF };
    expect(applyPivotNudge(none, REF, LEVELS, WIDE).plan).toBe(none);
    expect(applyPivotNudge(BUY, REF, null, WIDE).plan).toBe(BUY);
    expect(applyPivotNudge(BUY, REF, [], WIDE).plan).toBe(BUY);
  });
});

describe('★④ ずらし → 丸め で二重にずれない(実際に武装される値まで)', () => {
  it('ずらした後の値は5円刻みなので、planToArmed の丸めは no-op', () => {
    const r = applyPivotNudge(BUY, REF, LEVELS, WIDE);
    const armed = planToArmed(r.plan, Date.now());
    expect(armed!.limitEntry).toBe(65_605);       // ★ずらした値がそのまま発注値
    expect(armed!.stopEntry).toBe(65_805);
    expect(armed!.limitEntry! - armed!.stopLossForLimit!).toBe(65);
    expect(armed!.stopEntry! - armed!.stopLossForStop!).toBe(65);
  });

  it('★恒真でない: 中間を狙った回は丸めが働く(ずらしは効かない)', () => {
    const odd: AiPlan = { direction: 'buy', rationale: '', refPrice: REF, limitEntry: 65_652, stopLossForLimit: 65_592 };
    const r = applyPivotNudge(odd, REF, LEVELS, WIDE);
    expect(r.count).toBe(0);                                  // ピボットに一致しない = ずらさない
    expect(planToArmed(r.plan, Date.now())!.limitEntry).toBe(65_650);   // 丸めだけが働く
  });
});

describe('★⑤ 発火件数が数えられる', () => {
  it('件数と、どの脚がどこからどこへ動いたかが返る', () => {
    const r = applyPivotNudge(BUY, REF, LEVELS, WIDE);
    expect(r.count).toBe(2);
    expect(r.notes).toEqual(['指値65600→65605(幅60→65)', '逆指値65800→65805(幅60→65)']);
  });

  it('1件も動かない回は 0 と空配列(0 と「数えていない」を混ぜない)', () => {
    expect(applyPivotNudge(BUY, REF, [P(66_000, 'grid500')], WIDE)).toMatchObject({ count: 0, notes: [] });
  });
});

// ═══ ★上限を超えるずらしは **諦める**(2026-08-30・実測で方針転換) ═══════════════
//
// ■ 旧: 「幅が5円広がるのは許容。帯の外に出たら **その脚を落とす**」(2026-08-26)。
// ■ ★撤回した理由(アナリスト実測・signal_plans 3,008件[08-04〜08-28]から発火脚866本を再構成):
//     手動設定の実効上限は 65円 で帯は 55〜65 の11円しかなく、+5円が上限を跨いで
//     **2脚→1脚 が 37.5%(60/160)** ・見送り率 3.4%→6.2% になっていた。
//     ずらしは執行の都合であって相場の判断ではないので、**諦めるほうが害が小さい**
//     (「ずらし」の意図が「脚を消す」に化けるのが害)。crossesRef と同じ判断。
// ■ ★ずらしは引き続き enforce の **前**(検査した値と発注する値を一致させるため)。
describe('★上限を超えるなら ずらしを諦める / 帯の検査は ずらした後の幅に効く', () => {
  const CEIL = 159, FLOOR = 55;
  const enforce = (plan: AiPlan) => enforcePlanConstraintsReport(plan, {
    ceilingYen: CEIL, bias: 'none', floorYen: FLOOR, lcHardMax: { enabled: true, value: CEIL },
  });
  const stopLegWithWidth = (w: number): AiPlan => ({
    direction: 'buy', rationale: '', refPrice: REF, stopEntry: 65_800, stopLossForStop: 65_800 - w,
  });

  // ★2026-08-30 に **期待を書き換えた** 検査(旧: 「ずらして160 → enforce が 'lc' で落とす」)。
  //   いまは ずらしを諦めるので、脚は 155 のまま **落ちない**。これが方針転換の本体。
  it('★幅155 → ずらすと160で上限159超え → ずらしを諦める(脚は落ちない)', () => {
    const r = applyPivotNudge(stopLegWithWidth(155), REF, LEVELS, WIDE);
    expect(r.plan.stopEntry).toBe(65_800);                                  // ★建値は動かない
    expect(r.plan.stopEntry! - r.plan.stopLossForStop!).toBe(155);          // ★幅も動かない
    expect(r.count).toBe(0);
    expect(r.notes).toEqual(['逆指値65800はずらすと幅160円で上限159円を超えるため据え置き']);
    const e = enforce(r.plan);
    expect(e.plan.stopEntry).toBe(65_800);                                  // ★落ちない(旧: undefined)
    expect(e.legDrops ?? []).toEqual([]);
  });

  it('★幅154 → ずらして159 = 上限ちょうど → 通る(境界=ちょうどは許可)', () => {
    const r = applyPivotNudge(stopLegWithWidth(154), REF, LEVELS, WIDE);
    expect(r.plan.stopEntry! - r.plan.stopLossForStop!).toBe(159);
    expect(enforce(r.plan).plan.stopEntry).toBe(65_805);
  });

  it('★下限は割れない(幅は広がる方向にしか動かないため)', () => {
    const r = applyPivotNudge(stopLegWithWidth(FLOOR), REF, LEVELS, WIDE);   // ちょうど下限
    expect(r.plan.stopEntry! - r.plan.stopLossForStop!).toBe(FLOOR + 5);
    expect(enforce(r.plan).plan.stopEntry).toBe(65_805);
  });

  // ★2026-08-30 に **期待を書き換えた** 検査(旧: 「enforce の後ろに置くと上限超えが素通りする」)。
  //   上限をずらし自身が見るようになったので、順序を逆にしても素通りは起きない。
  //   ★順序が要らなくなったわけではない: 諦めなかった回(帯の中)の値を enforce に見せるために
  //     前に置く必要は残る。ここでは「上限超えが素通りしない」ことだけを固定する。
  it('★上限超えは順序に関わらず素通りしない(ずらし自身が諦めるため)', () => {
    const e = enforce(stopLegWithWidth(155));                 // 155 は帯の中なので通る
    expect(e.plan.stopEntry).toBe(65_800);
    const after = applyPivotNudge(e.plan, REF, LEVELS, WIDE);  // 後ろに置いても諦める
    expect(after.plan.stopEntry! - after.plan.stopLossForStop!).toBe(155);
    expect(after.count).toBe(0);
  });
});

// ═══ ★レンジ両面の「連鎖書き換え」を止める(2026-08-26・実測で判明) ═══════════════════
//
// ■ 壊れ方: レンジ両面は上下とも type='limit' なので、見出し(注文タイプしか区別しない)では
//   **同じ区間** を共有する。旧判定は「同じ幅を申告した *ずれていない* 同種の脚」しか見ておらず、
//   幅が違うと ambiguous が false になって、両方の書き換えが同じ区間に **順に** 当たった。
//   正解「上65 / 下70」が **両方70** になる(上が 60→65→70 と2回動く)。
// ■ 直し方: 同じ注文タイプの脚が他にも居るなら、共有の根拠文は **触らない**。
//   台帳から「AI が何と言ったか」を消すより、据え置いて notes に残すほうが良い。
describe('★レンジ両面: 共有の根拠文は連鎖書き換えしない', () => {
  const RANGE: AiPlan = {
    direction: 'range', refPrice: REF,
    rationale: '上部は指値売り65800（LC幅60円）。下部は指値買い65600（LC幅65円）。',
    range: {
      upper: { side: 'sell', type: 'limit', entry: 65_800, stopLoss: 65_860 },   // 幅60 → ずらすと65
      lower: { side: 'buy', type: 'limit', entry: 65_600, stopLoss: 65_535 },    // 幅65 → ずらすと70
    },
  };

  it('★★否定対照: 旧判定なら 上の申告が 60→65→70 と2回動いて **両方70** になる', () => {
    // 旧実装の順序(upper→lower)を その場で再現する。ambiguous は幅が違うので効かなかった。
    let t = RANGE.rationale;
    t = rewriteLcWidthForLeg(t, 'limit', 60, 65).text;   // upper の書き換え
    t = rewriteLcWidthForLeg(t, 'limit', 65, 70).text;   // lower の書き換え(上の 65 まで巻き込む)
    expect(t).toBe('上部は指値売り65800（LC幅70円）。下部は指値買い65600（LC幅70円）。');
  });

  it('★建値は両方ずれる(箱は正しい): 上65795 / 下65605、幅は 65 と 70', () => {
    const r = applyPivotNudge(RANGE, REF, LEVELS, WIDE);
    expect(r.plan.range!.upper!.entry).toBe(65_795);
    expect(r.plan.range!.lower!.entry).toBe(65_605);
    expect(r.plan.range!.upper!.stopLoss! - r.plan.range!.upper!.entry).toBe(65);
    expect(r.plan.range!.lower!.entry - r.plan.range!.lower!.stopLoss!).toBe(70);
    expect(r.count).toBe(2);
  });

  it('★根拠文は **1文字も動かない**(両方70にならない)', () => {
    const r = applyPivotNudge(RANGE, REF, LEVELS, WIDE);
    expect(r.plan.rationale).toBe(RANGE.rationale);
    expect(r.plan.rationale).toContain('LC幅60円');
    expect(r.plan.rationale).toContain('LC幅65円');
    expect(r.plan.rationale).not.toContain('LC幅70円');
  });

  it('★据え置いたことは notes に残る(無言で捨てない)', () => {
    const r = applyPivotNudge(RANGE, REF, LEVELS, WIDE);
    const held = r.notes.filter(n => n.includes('据え置き'));
    expect(held).toEqual([
      '根拠文の幅は据え置き(同じ指値の脚が他にもあり どちらの申告か区別できない)',
      '根拠文の幅は据え置き(同じ指値の脚が他にもあり どちらの申告か区別できない)',
    ]);
  });

  it('★方向プラン(指値+逆指値)は注文タイプが違うので従来どおり直る(=回帰しない)', () => {
    const plan: AiPlan = {
      ...BUY,
      rationale: '押し目買い指値65600（LC幅60円）。ブレイク新規65800（LC幅60円）',
    };
    const r = applyPivotNudge(plan, REF, LEVELS, WIDE);
    expect(r.plan.rationale).toBe('押し目買い指値65600（LC幅65円）。ブレイク新規65800（LC幅65円）');
  });
});

// ═══ ★「ずらせなかった」を無言にしない(2026-08-26) ═══════════════════════════════
//
//   nudgeEntryOnPivot は blocked:'crossesRef' を返していたのに applyPivotNudge が読み捨てていた。
//   「ピボットに当たっていない(count 0)」と「当たったが ずらせなかった(count 0)」が区別できず、
//   頻度を数えられなかった。★count は 0 のままでよいが notes には残す。
describe('★ずらせなかった回も数えられる(blocked:crossesRef)', () => {
  const HELD: AiPlan = {
    direction: 'buy', rationale: '', refPrice: 61_652,
    limitEntry: 61_650, stopLossForLimit: 61_590,
  };
  const PIV = [{ price: 61_650, kinds: ['reaction'] }];

  it('count は 0 のまま / notes に据え置きの1行が残る', () => {
    const r = applyPivotNudge(HELD, 61_652, PIV, WIDE);
    expect(r.count).toBe(0);
    expect(r.notes).toEqual(['指値61650はずらすと現在値をまたぐため据え置き']);
    expect(r.plan).toBe(HELD);                      // ★何も変えていないので同一参照のまま
  });

  it('★恒真でない: ピボットに当たっていない回は notes も空(0 と「数えていない」を混ぜない)', () => {
    expect(applyPivotNudge(HELD, 61_652, [P(66_000, 'grid500')], WIDE)).toMatchObject({ count: 0, notes: [] });
  });
});

// ═══ ★境界(実測の中身に合わせた値・2026-08-30) ═══════════════════════════════════
//
// ■ 出所: アナリストが computeLevels を実走して再構成した発火脚 866本
//   (複製 prices.db / signal_plans 3,008件 / 2026-08-04〜08-28)。
//   ・866脚すべてで newW − oldW = **+5**(例外0件)= 下限割れは起きない → 下限の検査は足さない。
//   ・v0.9.102 手動設定の実効上限は **65円**(帯は 55〜65 の11円)。
//   ・上限で落ちていた104脚の内訳: 61→66 が51件 / 65→70 が45件 / 63→68 が5件 / 62→67 が1件(手動)。
//   ・★60→65 は **落ちない**(lcLegExceeds は `w > 上限`。境界=ちょうどは許可)。
//   ・AI委任(実効上限159)は 2脚→1脚 0.7% = ほぼ無傷 → 委任側の挙動は変えない。
describe('★境界: 上限を超えるずらしだけを諦める', () => {
  const MANUAL65 = band(65);
  const stopLegWithWidth = (w: number, rationale = ''): AiPlan => ({
    direction: 'buy', rationale, refPrice: REF, stopEntry: 65_800, stopLossForStop: 65_800 - w,
  });

  it('★手動・上限65: 幅60 → 65 に **ずらす**(境界ちょうどは許可)', () => {
    const r = applyPivotNudge(stopLegWithWidth(60), REF, LEVELS, MANUAL65);
    expect(r.plan.stopEntry).toBe(65_805);
    expect(r.plan.stopEntry! - r.plan.stopLossForStop!).toBe(65);
    expect(r.count).toBe(1);
    expect(r.notes).toEqual(['逆指値65800→65805(幅60→65)']);
  });

  it('★手動・上限65: 幅65 → 70 になるので **諦める**(建値も根拠文も1文字も変わらない)', () => {
    const plan = stopLegWithWidth(65, 'ブレイク新規65800を狙う（LC幅65円）');
    const r = applyPivotNudge(plan, REF, LEVELS, MANUAL65);
    expect(r.plan.stopEntry).toBe(65_800);                                   // 建値そのまま
    expect(r.plan.stopEntry! - r.plan.stopLossForStop!).toBe(65);            // 幅そのまま
    expect(r.plan.rationale).toBe('ブレイク新規65800を狙う（LC幅65円）');     // ★根拠文そのまま
    expect(r.plan).toBe(plan);                                               // ★同一参照=何も作り直していない
    expect(r.count).toBe(0);                                                 // ★諦めた脚は数に入れない
    expect(r.notes).toEqual(['逆指値65800はずらすと幅70円で上限65円を超えるため据え置き']);
  });

  it('★手動・上限65: 幅61 → 66 で諦める(落ちていた104脚の半数=51件がこの形)', () => {
    const r = applyPivotNudge(stopLegWithWidth(61), REF, LEVELS, MANUAL65);
    expect(r.plan.stopEntry).toBe(65_800);
    expect(r.count).toBe(0);
    expect(r.notes).toEqual(['逆指値65800はずらすと幅66円で上限65円を超えるため据え置き']);
  });

  it('★AI委任・実効上限159: 幅130 → 135 に **ずらす**(委任側は無傷)', () => {
    const r = applyPivotNudge(stopLegWithWidth(130), REF, LEVELS, bandAi(159));
    expect(r.plan.stopEntry).toBe(65_805);
    expect(r.plan.stopEntry! - r.plan.stopLossForStop!).toBe(135);
    expect(r.count).toBe(1);
  });

  it('★上限の解決は lcEffectiveCeiling と同じ(委任なら設定65は外れ、背骨159が残る)', () => {
    // 同じ幅130でも、手動(上限65)なら諦め、委任(159)ならずらす=帯の出所が1つであることの証拠。
    expect(applyPivotNudge(stopLegWithWidth(130), REF, LEVELS, MANUAL65).count).toBe(0);
    expect(applyPivotNudge(stopLegWithWidth(130), REF, LEVELS, bandAi(159)).count).toBe(1);
  });

  it('★count===0 でも notes が空でない=呼び出し側のログ経路を通る(無言で捨てない)', () => {
    // buildScalpPlan 側は `nudged.count > 0 || nudged.notes.length > 0` でログする。
    const r = applyPivotNudge(stopLegWithWidth(65), REF, LEVELS, MANUAL65);
    expect(r.count).toBe(0);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it('★恒真でない: 上限を上げれば同じ脚がずれる(帯だけが効いている)', () => {
    expect(applyPivotNudge(stopLegWithWidth(65), REF, LEVELS, band(70)).plan.stopEntry).toBe(65_805);
  });

  it('★レンジ両面: 片方だけ上限を超えるなら、超えた脚だけ諦める', () => {
    const range: AiPlan = {
      direction: 'range', rationale: '', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 65_800, stopLoss: 65_865 },   // 幅65 → 70 で諦める
        lower: { side: 'buy', type: 'limit', entry: 65_600, stopLoss: 65_540 },    // 幅60 → 65 で通る
      },
    };
    const r = applyPivotNudge(range, REF, LEVELS, MANUAL65);
    expect(r.plan.range!.upper!.entry).toBe(65_800);      // ★諦めた
    expect(r.plan.range!.lower!.entry).toBe(65_605);      // ★ずらした
    expect(r.count).toBe(1);
    expect(r.notes).toContain('指値65800はずらすと幅70円で上限65円を超えるため据え置き');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ★2026-08-30(追記): TP(利確幅)と5円ずらしの関係。★リーダー裁定 §9。
//
//   ・AI委任の TP幅は **5円 詰める**(= TP の **絶対価格** は動かさない)。
//     建値は4脚とも「その脚が儲かる向き」へ動くので、TP価格を保つには幅を同じだけ縮める。
//     ★LC は逆に5円 **広がる**(建値が損切りから遠ざかる)。この非対称は仕様であって欠陥ではない
//     —— 規則は1つ「AI がその **価格** を根拠に選んだものは、執行の都合で動かさない」。
//   ・★詰めた結果が 0以下 になるなら **ずらしを諦める**(crossesRef / lcCeiling と同じ作法)。
//   ・★手動TP は対象外: 手動の幅は計画に焼かれない(毎tick 設定を引き直す契約)ので、
//     tpWidthFor* が undefined = このコードは1行も走らない。
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('★TP幅と5円ずらし(AI委任のみ・TP の絶対価格は動かさない)', () => {
  /** 手動設定・実効上限65(v0.9.102 の実値)。★上の describe のものと同じ値を局所に置く。 */
  const MANUAL_65 = band(65);
  const withTp = (tpLimit?: number, tpStop?: number): AiPlan => ({
    ...BUY,
    ...(tpLimit !== undefined ? { tpWidthForLimit: tpLimit } : {}),
    ...(tpStop !== undefined ? { tpWidthForStop: tpStop } : {}),
  });

  it('ずらした脚の TP幅が5円 詰まる(TP の絶対価格は不変)', () => {
    const r = applyPivotNudge(withTp(120, 90), REF, LEVELS, WIDE);
    expect(r.count).toBe(2);
    expect(r.plan.limitEntry).toBe(65_605);
    expect(r.plan.stopEntry).toBe(65_805);
    expect(r.plan.tpWidthForLimit).toBe(115);
    expect(r.plan.tpWidthForStop).toBe(85);
    // ★TP の **価格** は動いていない: 買い → 建値 + 幅。
    expect(65_605 + 115).toBe(65_600 + 120);
    expect(65_805 + 85).toBe(65_800 + 90);
  });

  it('★LC は広がり TP は縮む(同じずらしで符号が逆・これが仕様)', () => {
    const r = applyPivotNudge(withTp(120, 90), REF, LEVELS, WIDE);
    expect(Math.abs(r.plan.limitEntry! - r.plan.stopLossForLimit!)).toBe(65);   // LC 60 → 65
    expect(r.plan.tpWidthForLimit).toBe(115);                                   // TP 120 → 115
  });

  it('★★詰めると 0以下 になる脚は ずらしを諦める(blocked=tpCollapse)', () => {
    const r = applyPivotNudge(withTp(5, 90), REF, LEVELS, WIDE);
    expect(r.plan.limitEntry).toBe(65_600);            // ★据え置き(建値も動かない)
    expect(r.plan.tpWidthForLimit).toBe(5);            // ★TP幅も動かない
    expect(r.plan.stopEntry).toBe(65_805);             // ★もう一方は通る
    expect(r.plan.tpWidthForStop).toBe(85);
    expect(r.count).toBe(1);
    expect(r.notes).toContain('指値65600はずらすとTP幅が0円(0以下)になるため据え置き');
  });

  it('★TP幅3円(詰めると −2円)も諦める=境界だけの検査になっていない', () => {
    const r = applyPivotNudge(withTp(3), REF, LEVELS, WIDE);
    expect(r.plan.limitEntry).toBe(65_600);
    expect(r.notes).toContain('指値65600はずらすとTP幅が-2円(0以下)になるため据え置き');
  });

  it('★恒真でない: TP幅6円なら 1円 残るので ずらす', () => {
    const r = applyPivotNudge(withTp(6), REF, LEVELS, WIDE);
    expect(r.plan.limitEntry).toBe(65_605);
    expect(r.plan.tpWidthForLimit).toBe(1);
  });

  it('★手動TP / TP無効(tpWidthFor* が無い計画)は TP 追加前と1バイト同じ結果', () => {
    const r = applyPivotNudge(BUY, REF, LEVELS, WIDE);
    expect(r.count).toBe(2);
    expect(r.plan.tpWidthForLimit).toBeUndefined();
    expect(r.plan.tpWidthForStop).toBeUndefined();
    // ★notes に TP の語が1文字も出ない(TP を持たない脚の記録は従来のまま)。
    expect(r.notes).toEqual(['指値65600→65605(幅60→65)', '逆指値65800→65805(幅60→65)']);
  });

  it('★上限で諦めた脚(lcCeiling)の TP幅は元のまま(二重に詰めない)', () => {
    // 幅65 の逆指値は +5 で 70 → 手動上限65 を超えるので lcCeiling で諦める。
    const plan: AiPlan = {
      direction: 'buy', rationale: '', refPrice: REF,
      stopEntry: 65_800, stopLossForStop: 65_735, tpWidthForStop: 90,
    };
    const r = applyPivotNudge(plan, REF, LEVELS, MANUAL_65);
    expect(r.count).toBe(0);
    expect(r.plan.stopEntry).toBe(65_800);
    expect(r.plan.tpWidthForStop).toBe(90);
  });

  it('★元の plan を書き換えない(TP幅も含めて)', () => {
    const src = withTp(120, 90);
    applyPivotNudge(src, REF, LEVELS, WIDE);
    expect(src.tpWidthForLimit).toBe(120);
    expect(src.tpWidthForStop).toBe(90);
    expect(src.limitEntry).toBe(65_600);
  });

  it('★enforce が落とすレッグの TP幅も一緒に落ちる(価格の無い箱に幅だけ残さない)', () => {
    // 幅60 の指値を上限55 の帯に通す → 'lc' で落ちる。
    const r = enforcePlanConstraintsReport(withTp(120, 90), { ceilingYen: 55, bias: 'none' as const });
    expect(r.plan.limitEntry).toBeUndefined();
    expect(r.plan.tpWidthForLimit).toBeUndefined();
    expect(r.plan.stopEntry).toBeUndefined();
    expect(r.plan.tpWidthForStop).toBeUndefined();
  });
});
