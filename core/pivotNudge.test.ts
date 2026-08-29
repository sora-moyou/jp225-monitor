import { describe, it, expect } from 'vitest';
import {
  nudgeEntryOnPivot, isPivotLevel, PIVOT_NUDGE_YEN, PIVOT_KINDS, CALCULATED_KINDS,
} from './pivotNudge.js';

// ★2026-08-26(ユーザー承認済みの仕様): ピボット節目に **完全一致** した建値を5円ずらす。
//
// ■ 仕様(原文・server/llm/scalpPlan.ts の設計コメント)
//   ── ずらす向き(機械的に一意。★AI は関与しない) ──
//     指値(引きつける)    : 現在価格に 近づく側 へ5円
//     逆指値(抜けたら乗る): 現在価格から 遠ざかる側 へ5円
//   ── 対象 ──
//     ずらす(ピボット)   : スイング高安 / セッション高安・本日高安・長期高安 / 前日終値・寄付 /
//                          反応価格・もみ合い帯・出来高集中
//     ずらさない(計算値) : フィボ戻し / N値・V値・E値 / キリ番 / ADR予測レンジ / トレンドライン
//     ★重なったらピボット優先
//   ── 一致は完全一致(±の許容は作らない) ──
//
// ■ ★この検査が守るもの
//   ① 4通りの向きが仕様どおり  ② 計算値は動かさない  ③ 重なりはピボット優先
//   ④ 完全一致だけ(1円ずれたらそのまま)  ⑤ 材料が無い回は動かさない(安全側)

const REF = 65_700;
const P = (price: number, ...kinds: string[]) => ({ price, kinds });

describe('★① ずらす向き(機械的に一意・AI は関与しない)', () => {
  const L = [P(65_800, 'sessHL'), P(65_600, 'todayHL')];

  it('上のピボット: 指値は **近づく側(下)** / 逆指値は **遠ざかる側(上)**', () => {
    expect(nudgeEntryOnPivot(65_800, 'limit', REF, L)).toMatchObject({ price: 65_795, nudged: true, pivot: 65_800 });
    expect(nudgeEntryOnPivot(65_800, 'stop', REF, L)).toMatchObject({ price: 65_805, nudged: true });
  });

  it('下のピボット: 指値は **近づく側(上)** / 逆指値は **遠ざかる側(下)**', () => {
    expect(nudgeEntryOnPivot(65_600, 'limit', REF, L)).toMatchObject({ price: 65_605, nudged: true });
    expect(nudgeEntryOnPivot(65_600, 'stop', REF, L)).toMatchObject({ price: 65_595, nudged: true });
  });

  it('★ずらす量は定数(5円)ひとつ。向き以外に分岐が無い', () => {
    expect(PIVOT_NUDGE_YEN).toBe(5);
    for (const [entry, kind] of [[65_800, 'limit'], [65_800, 'stop'], [65_600, 'limit'], [65_600, 'stop']] as const) {
      const r = nudgeEntryOnPivot(entry, kind, REF, L);
      expect(Math.abs(r.price - entry)).toBe(PIVOT_NUDGE_YEN);
    }
  });
});

describe('★② 計算値はずらさない / ★③ 重なったらピボット優先', () => {
  it('キリ番・フィボ・N値・ADR・トレンドラインは動かさない', () => {
    for (const k of CALCULATED_KINDS) {
      const r = nudgeEntryOnPivot(66_000, 'stop', REF, [P(66_000, k)]);
      expect(r, `kind=${k}`).toEqual({ price: 66_000, nudged: false });
    }
  });

  it('★キリ番70,000が同時に本日高値なら **ピボット扱いでずらす**(仕様の逐語例)', () => {
    const r = nudgeEntryOnPivot(70_000, 'stop', REF, [P(70_000, 'grid1000', 'todayHL')]);
    expect(r).toMatchObject({ price: 70_005, nudged: true });
  });

  it('ピボット種別は1つでも含めば true(isPivotLevel)', () => {
    for (const k of PIVOT_KINDS) expect(isPivotLevel(P(1, k)), k).toBe(true);
    for (const k of CALCULATED_KINDS) expect(isPivotLevel(P(1, k)), k).toBe(false);
    expect(isPivotLevel({ price: 1 })).toBe(false);          // kinds が無い = ピボットと確認できない
    expect(isPivotLevel(P(1))).toBe(false);                  // 空配列も同じ
  });

  it('★新しい種別が増えたら「ずらさない」に倒れる(安全側)', () => {
    expect(nudgeEntryOnPivot(66_000, 'stop', REF, [P(66_000, 'brandNewKind')]).nudged).toBe(false);
  });
});

describe('★④ 完全一致だけ(許容は作らない)', () => {
  const L = [P(70_000, 'sessHL')];
  it('1円でもずれていたら そのまま通す(=仕様。欠陥ではない)', () => {
    for (const p of [69_999, 70_001, 70_003, 69_995, 70_005]) {
      expect(nudgeEntryOnPivot(p, 'stop', REF, L), String(p)).toEqual({ price: p, nudged: false });
    }
    expect(nudgeEntryOnPivot(70_000, 'stop', REF, L).nudged).toBe(true);   // 恒真でない
  });
});

describe('★⑤ 材料が無い/決められない回は動かさない(安全側)', () => {
  it('節目が無い・null・空配列 → そのまま', () => {
    for (const lv of [null, undefined, []]) {
      expect(nudgeEntryOnPivot(65_800, 'stop', REF, lv).nudged, String(lv)).toBe(false);
    }
  });

  it('★建値が現在価格ちょうど → 向きが決まらないので動かさない', () => {
    expect(nudgeEntryOnPivot(REF, 'stop', REF, [P(REF, 'sessHL')])).toEqual({ price: REF, nudged: false });
  });

  it('非有限は動かさない', () => {
    const L = [P(65_800, 'sessHL')];
    expect(nudgeEntryOnPivot(Number.NaN, 'stop', REF, L).nudged).toBe(false);
    expect(nudgeEntryOnPivot(65_800, 'stop', Number.NaN, L).nudged).toBe(false);
  });
});

// ─── ★★否定対照: 向きを逆にすると仕様と食い違う ─────────────────────────────
describe('★★否定対照: 向きの規則が逆だったら捕まる', () => {
  it('「指値も遠ざかる側」にした実装は、この検査を通らない', () => {
    // ★その場で逆向きの実装を再現して、期待値と食い違うことを示す。
    const wrong = (price: number, kind: 'limit' | 'stop', ref: number): number => {
      const above = price > ref;
      return price + (above ? 1 : -1) * PIVOT_NUDGE_YEN;   // ← 常に遠ざかる(指値の向きが誤り)
    };
    expect(wrong(65_800, 'limit', REF)).toBe(65_805);                       // 誤った実装の答え
    expect(nudgeEntryOnPivot(65_800, 'limit', REF, [P(65_800, 'sessHL')]).price).toBe(65_795);   // 正しい答え
  });
});

// ═══ ★現在値をまたぐずらしはしない(2026-08-26・エバリュエーター実測で判明) ═══════════
//
// ■ 実際に起きていたこと(エバリュエーターの実走・ref=61,652 / ピボット61,650 / 買い指値)
//     nudge後   : 61650 → 61655 = **現在値の上**(買い指値として不正)
//     enforce後 : 落ちない(★enforce は側を見ない。stopSideOk しか無い)
//     checkSanity: ok:false 「buy: 指値(61655)が現在値(61652)の下にない」
//   ★checkSanity は **プラン全体** を拒否するので、健全だった逆指値61,705 まで巻き添えで消え、
//     gate='sanity' で丸ごと見送りになっていた。**5円のずらしが計画を1本消す。**
describe('★ずらすと現在値をまたぐときは ずらさない', () => {
  const PIV = (p: number) => [{ price: p, kinds: ['reaction'] }];

  it('★エバリュエーターの実例: ref61652 / ピボット61650 / 買い指値 → ずらさない', () => {
    const r = nudgeEntryOnPivot(61_650, 'limit', 61_652, PIV(61_650));
    expect(r).toEqual({ price: 61_650, nudged: false, pivot: 61_650, blocked: 'crossesRef' });
  });

  it('★現在値に **ちょうど重なる** のも止める(同値は側が決まらない)', () => {
    const r = nudgeEntryOnPivot(61_650, 'limit', 61_655, PIV(61_650));
    expect(r.nudged).toBe(false);
    expect(r.blocked).toBe('crossesRef');
  });

  it('★下側の指値でも同じ(ref の下2円のピボット)', () => {
    const r = nudgeEntryOnPivot(61_650, 'limit', 61_648, PIV(61_650));
    expect(r.nudged).toBe(false);
  });

  it('★逆指値は現在値から **遠ざかる** ので、近くても止まらない', () => {
    // 逆指値は「抜けたら乗る」= 現在値から離れる向き。またぎようがない。
    expect(nudgeEntryOnPivot(61_650, 'stop', 61_652, PIV(61_650))).toEqual(
      { price: 61_645, nudged: true, pivot: 61_650 });
    expect(nudgeEntryOnPivot(61_654, 'stop', 61_652, PIV(61_654))).toEqual(
      { price: 61_659, nudged: true, pivot: 61_654 });
  });

  it('6円以上離れていれば指値もずらす(境界: またがない)', () => {
    expect(nudgeEntryOnPivot(61_650, 'limit', 61_656, PIV(61_650)).price).toBe(61_655);
  });

  it('★止めた回も pivot は入る(「一致はしたが ずらせなかった」を数えられる)', () => {
    expect(nudgeEntryOnPivot(61_650, 'limit', 61_652, PIV(61_650)).pivot).toBe(61_650);
  });

  it('★★否定対照: 止めなければ 61655 = 現在値の逆側になる', () => {
    // ガードを外した場合の値を その場で計算して示す(= 何を防いでいるかの証拠)。
    const naive = 61_650 + (61_650 > 61_652 ? 1 : -1) * -1 * PIVOT_NUDGE_YEN;
    expect(naive).toBe(61_655);
    expect(naive > 61_652).toBe(true);              // 買い指値なのに現在値の上 = 不正
    expect(nudgeEntryOnPivot(61_650, 'limit', 61_652, PIV(61_650)).price).toBe(61_650);
  });
});

// ═══ ★'lcCeiling' は **この純関数が決めない**(2026-08-30) ═══════════════════════
//   core は LC の帯(ceilingYen / ceilingMode / 安全上限)を知らないし、知るべきでもない。
//   上限の唯一の権威は server/llm/scalpPlan.ts の lcEffectiveCeiling / lcLegExceeds で、
//   applyPivotNudge が「ずらす」と決めた脚を後から 'lcCeiling' に倒す。
//   ★この検査が守るもの: 語彙(型)はここに在るが、**判定はここに無い**こと。
describe("★blocked の語彙は持つが 'lcCeiling' の判定はしない", () => {
  it('どんな幅でも nudgeEntryOnPivot は lcCeiling を返さない(幅を知らない)', () => {
    const L = [P(65_800, 'sessHL'), P(65_600, 'todayHL')];
    for (const [entry, kind] of [[65_800, 'limit'], [65_800, 'stop'], [65_600, 'limit'], [65_600, 'stop']] as const) {
      expect(nudgeEntryOnPivot(entry, kind, REF, L).blocked).not.toBe('lcCeiling');
    }
    // 引数に損切りも上限も無い=幅を知りようがない(シグネチャがそれを保証している)。
    expect(nudgeEntryOnPivot.length).toBe(4);
  });
});
