import { describe, it, expect } from 'vitest';
import {
  aTrendPromptBuildFp, bOrderPromptBuildFp, computeATrendPromptBuildFp, computeBOrderPromptBuildFp,
  allAbPromptBuildFps, AB_B_VARIANTS, AB_TP_ASKS, AB_B_PROMPT_COMBOS, bOrderPromptBuildKey,
} from './abPromptBuild.js';
import { isPromptBuildFingerprint } from './promptFingerprint.js';
import { buildBSystemPrompt } from './planVariants.js';

// ★段5: A/B 分割の「プロンプトの型」の指紋(a_prompt_build / b_prompt_build に入る値)。
//
// 何を守っているか(pb1 と同じ3条件・promptBuild.ts 冒頭を参照):
//   ① データ(市場文脈)を1バイトも含めない
//   ② 文面(テンプレート)が1文字でも変われば必ず動く
//   ③ 版(★A は2種=レンジ有効/無効・★B は6種)ごとに違う値になる
//      ★B が 8種でなく **6種** なのは、レンジ2版が TP を尋ねないため(リーダー裁定1・
//        TP幅の列名 tpWidthForLimit/ForStop がレンジの upper/lower を表せないので、
//        尋ねても置き場所が無い。★「尋ねて捨てる」が最悪の形なので問いごと出さない)。
//   ④ 形式は pb1(既存の promptFingerprint.ts)と同じ(`pb1:<16桁hex>`)
//   ⑤ 起動時キャッシュ(呼ぶたびに同じ値・純関数と同じ結果)

describe('★A(目線)のプロンプトの型の指紋', () => {
  it('形式は pb1(既存の promptFingerprint.ts と同じ検証関数で通る)', () => {
    for (const on of [true, false]) expect(isPromptBuildFingerprint(aTrendPromptBuildFp(on))).toBe(true);
  });

  it('★呼ぶたびに同じ値(キャッシュ・純関数の結果と一致)', () => {
    for (const on of [true, false]) {
      expect(aTrendPromptBuildFp(on)).toBe(aTrendPromptBuildFp(on));
      expect(aTrendPromptBuildFp(on)).toBe(computeATrendPromptBuildFp(on));
    }
  });

  it('★★2026-08-25: レンジ有効/無効で **別の値** になる(文面が変わるのに指紋が動かない事故を防ぐ)', () => {
    expect(aTrendPromptBuildFp(true)).not.toBe(aTrendPromptBuildFp(false));
  });

  it('★市場文脈を受け取る引数が無い=呼び出し側がデータを渡す余地が無い(①の構造的保証)', () => {
    // computeATrendPromptBuildFp(rangeEnabled) は **設定の真偽値だけ** を受け取り、
    // 市場文脈は固定プレースホルダで描く。引数が boolean 1つであること自体が
    // 「データを含めようがない」ことの証明になる。
    expect(computeATrendPromptBuildFp.length).toBe(1);
    expect(computeATrendPromptBuildFp(true)).toBe(computeATrendPromptBuildFp(true));
  });
});

describe('★B(価格と損切幅)のプロンプトの型の指紋', () => {
  it('形式は pb1', () => {
    for (const { variant, askTp } of AB_B_PROMPT_COMBOS) {
      expect(isPromptBuildFingerprint(bOrderPromptBuildFp(variant, askTp))).toBe(true);
    }
  });

  it('★版(buy/sell/range-fade/range-breakout)ごとに別の値になる(③)', () => {
    const fps = AB_B_VARIANTS.map(v => bOrderPromptBuildFp(v, false));
    expect(new Set(fps).size).toBe(AB_B_VARIANTS.length);
  });

  // ★2026-08-30: TP(利確幅)を尋ねる版が加わり、B は 4版 → **8版** になった。
  //   ★これが割れていないと「TP を尋ね始めたのに b_prompt_build が同じ値」になり、
  //     層別キーとして使えない(A が rangeEnabled で2版に割れたのと同じ話)。
  it('★★TPを尋ねる/尋ねない で別の値になる = 合計6版すべてが相異なる', () => {
    const fps = AB_B_PROMPT_COMBOS.map(c => bOrderPromptBuildFp(c.variant, c.askTp));
    expect(fps.length).toBe(6);
    expect(new Set(fps).size).toBe(6);
    expect(AB_B_PROMPT_COMBOS.map(c => bOrderPromptBuildKey(c.variant, c.askTp)).sort())
      .toEqual(['buy', 'buy+tp', 'range-breakout', 'range-fade', 'sell', 'sell+tp']);
  });

  // ★裁定1: レンジ2版は TP を尋ねない。askTp=true を渡しても **TP 無しに正規化** される。
  //   ★これが割れると「レンジでも TP を尋ねる文面がある」と meta を読んだ人が誤読する。
  it('★★レンジ2版は askTp=true を渡しても TP 導入前と同じ指紋になる(尋ねる文面が存在しない)', () => {
    for (const v of ['range-fade', 'range-breakout'] as const) {
      expect(bOrderPromptBuildFp(v, true)).toBe(bOrderPromptBuildFp(v, false));
      expect(bOrderPromptBuildKey(v, true)).toBe(v);
      expect(buildBSystemPrompt(v, 11, 97, 'x', true)).not.toContain('TP');
    }
    // ★恒真でない対照: directional 2版では askTp=true が必ず別の指紋になる。
    for (const v of ['buy', 'sell'] as const) {
      expect(bOrderPromptBuildFp(v, true)).not.toBe(bOrderPromptBuildFp(v, false));
    }
  });

  // ★否定対照: TP を尋ねない側の指紋は「TP 導入前の文面」の指紋そのもの=
  //   設定が手動のあいだ b_prompt_build は1文字も動かない(層別が過去と地続きになる)。
  it('★askTp=false の指紋は、TP の行を1文字も含まない文面から作られている', () => {
    const sys = buildBSystemPrompt('buy', 11, 97, '(固定プレースホルダ: データはプロンプトの型の指紋に含めない)', false);
    expect(sys).not.toContain('TP');
    expect(buildBSystemPrompt('buy', 11, 97, 'x', true)).toContain('TP幅');
  });

  it('★呼ぶたびに同じ値(キャッシュ・純関数の結果と一致)', () => {
    for (const { variant, askTp } of AB_B_PROMPT_COMBOS) {
      expect(bOrderPromptBuildFp(variant, askTp)).toBe(bOrderPromptBuildFp(variant, askTp));
      expect(bOrderPromptBuildFp(variant, askTp)).toBe(computeBOrderPromptBuildFp(variant, askTp));
    }
  });

  it('★設定値(floorYen/ceilingYen)を含めない(pb1 と同じ理由: 「型」であって「今の設定」ではない)', () => {
    // buildBSystemPrompt は floorYen/ceilingYen を印字するが、abPromptBuild.ts は固定の合成値
    // (SYN_FLOOR=11/SYN_CEILING=97)で描くので、実運用の下限/上限(例 55円<=損切幅<66円)を
    // 変えても pb 指紋は動かない。ここでは実データ側の文面に実際の帯が出ることだけ確かめる
    // (=もし abPromptBuild.ts が実運用値を読んでいたら、この帯の文字列が指紋の入力に混ざる構造になる)。
    const withRealSettings = buildBSystemPrompt('buy', 55, 65, '(実データ)', false);
    expect(withRealSettings).toContain('55円<=損切幅<66円');
    expect(computeBOrderPromptBuildFp('buy', false)).toBe(computeBOrderPromptBuildFp('buy', false));
  });

  it('A と B の指紋は互いに異なる(名前空間が交差しない)', () => {
    const all = [aTrendPromptBuildFp(true), aTrendPromptBuildFp(false)];
    for (const c of AB_B_PROMPT_COMBOS) all.push(bOrderPromptBuildFp(c.variant, c.askTp));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('allAbPromptBuildFps(meta へ載せる一括計算)', () => {
  it('★A 1つ + B 6種の計7個が揃う(★レンジの +tp は存在しないので載せない)', () => {
    const { aPromptBuild, bPromptBuilds } = allAbPromptBuildFps(true);
    expect(isPromptBuildFingerprint(aPromptBuild)).toBe(true);
    const want = AB_B_PROMPT_COMBOS.map(c => bOrderPromptBuildKey(c.variant, c.askTp));
    expect(want.length).toBe(6);
    expect(Object.keys(bPromptBuilds).sort()).toEqual([...want].sort());
    for (const k of want) expect(isPromptBuildFingerprint(bPromptBuilds[k]!)).toBe(true);
    // ★存在しない組み合わせを meta に載せない(読んだ人が誤読する)。
    expect(Object.keys(bPromptBuilds)).not.toContain('range-fade+tp');
    expect(Object.keys(bPromptBuilds)).not.toContain('range-breakout+tp');
  });

  it('★A の指紋は渡したレンジ設定に従う(meta に「そのとき走っていた型」が残る)', () => {
    expect(allAbPromptBuildFps(true).aPromptBuild).toBe(aTrendPromptBuildFp(true));
    expect(allAbPromptBuildFps(false).aPromptBuild).toBe(aTrendPromptBuildFp(false));
  });
});
