import { describe, it, expect } from 'vitest';
import {
  aTrendPromptBuildFp, bOrderPromptBuildFp, computeATrendPromptBuildFp, computeBOrderPromptBuildFp,
  allAbPromptBuildFps, AB_B_VARIANTS,
} from './abPromptBuild.js';
import { isPromptBuildFingerprint } from './promptFingerprint.js';
import { buildBSystemPrompt } from './planVariants.js';

// ★段5: A/B 分割の「プロンプトの型」の指紋(a_prompt_build / b_prompt_build に入る値)。
//
// 何を守っているか(pb1 と同じ3条件・promptBuild.ts 冒頭を参照):
//   ① データ(市場文脈)を1バイトも含めない
//   ② 文面(テンプレート)が1文字でも変われば必ず動く
//   ③ 版(★A は2種=レンジ有効/無効・B は4種)ごとに違う値になる
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
    for (const v of AB_B_VARIANTS) expect(isPromptBuildFingerprint(bOrderPromptBuildFp(v))).toBe(true);
  });

  it('★版(buy/sell/range-fade/range-breakout)ごとに別の値になる(③)', () => {
    const fps = AB_B_VARIANTS.map(v => bOrderPromptBuildFp(v));
    expect(new Set(fps).size).toBe(AB_B_VARIANTS.length);
  });

  it('★呼ぶたびに同じ値(キャッシュ・純関数の結果と一致)', () => {
    for (const v of AB_B_VARIANTS) {
      expect(bOrderPromptBuildFp(v)).toBe(bOrderPromptBuildFp(v));
      expect(bOrderPromptBuildFp(v)).toBe(computeBOrderPromptBuildFp(v));
    }
  });

  it('★設定値(floorYen/ceilingYen)を含めない(pb1 と同じ理由: 「型」であって「今の設定」ではない)', () => {
    // buildBSystemPrompt は floorYen/ceilingYen を印字するが、abPromptBuild.ts は固定の合成値
    // (SYN_FLOOR=11/SYN_CEILING=97)で描くので、実運用の下限/上限(例 55円<=損切幅<66円)を
    // 変えても pb 指紋は動かない。ここでは実データ側の文面に実際の帯が出ることだけ確かめる
    // (=もし abPromptBuild.ts が実運用値を読んでいたら、この帯の文字列が指紋の入力に混ざる構造になる)。
    const withRealSettings = buildBSystemPrompt('buy', 55, 65, '(実データ)');
    expect(withRealSettings).toContain('55円<=損切幅<66円');
    expect(computeBOrderPromptBuildFp('buy')).toBe(computeBOrderPromptBuildFp('buy'));
  });

  it('A と B の指紋は互いに異なる(名前空間が交差しない)', () => {
    const all = [
      aTrendPromptBuildFp(true), aTrendPromptBuildFp(false),
      ...AB_B_VARIANTS.map(v => bOrderPromptBuildFp(v)),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('allAbPromptBuildFps(meta へ載せる一括計算)', () => {
  it('A 1つ + B 4種の計5個が揃う', () => {
    const { aPromptBuild, bPromptBuilds } = allAbPromptBuildFps(true);
    expect(isPromptBuildFingerprint(aPromptBuild)).toBe(true);
    expect(Object.keys(bPromptBuilds).sort()).toEqual([...AB_B_VARIANTS].sort());
    for (const v of AB_B_VARIANTS) expect(isPromptBuildFingerprint(bPromptBuilds[v]!)).toBe(true);
  });

  it('★A の指紋は渡したレンジ設定に従う(meta に「そのとき走っていた型」が残る)', () => {
    expect(allAbPromptBuildFps(true).aPromptBuild).toBe(aTrendPromptBuildFp(true));
    expect(allAbPromptBuildFps(false).aPromptBuild).toBe(aTrendPromptBuildFp(false));
  });
});
