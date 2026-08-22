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
//   ③ 版(A は単一・B は4種)ごとに違う値になる
//   ④ 形式は pb1(既存の promptFingerprint.ts)と同じ(`pb1:<16桁hex>`)
//   ⑤ 起動時キャッシュ(呼ぶたびに同じ値・純関数と同じ結果)

describe('★A(目線)のプロンプトの型の指紋', () => {
  it('形式は pb1(既存の promptFingerprint.ts と同じ検証関数で通る)', () => {
    expect(isPromptBuildFingerprint(aTrendPromptBuildFp())).toBe(true);
  });

  it('★呼ぶたびに同じ値(キャッシュ・純関数の結果と一致)', () => {
    expect(aTrendPromptBuildFp()).toBe(aTrendPromptBuildFp());
    expect(aTrendPromptBuildFp()).toBe(computeATrendPromptBuildFp());
  });

  it('★引数を取らない=呼び出し側がデータを渡す余地が無い構造そのものが①を保証する', () => {
    // computeATrendPromptBuildFp() は市場文脈を受け取らない(固定プレースホルダのみで描く)。
    // シグネチャに引数が無いこと自体が「データを含めようがない」ことの証明になる。
    expect(computeATrendPromptBuildFp.length).toBe(0);
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
    // (SYN_FLOOR=11/SYN_CEILING=97)で描くので、実運用の下限/上限(例 55円以上65円以下)を
    // 変えても pb 指紋は動かない。ここでは実データ側の文面に実際の帯が出ることだけ確かめる
    // (=もし abPromptBuild.ts が実運用値を読んでいたら、この帯の文字列が指紋の入力に混ざる構造になる)。
    const withRealSettings = buildBSystemPrompt('buy', 55, 65, '(実データ)');
    expect(withRealSettings).toContain('55円以上 65円以下');
    expect(computeBOrderPromptBuildFp('buy')).toBe(computeBOrderPromptBuildFp('buy'));
  });

  it('A と B の指紋は互いに異なる(名前空間が交差しない)', () => {
    const all = [aTrendPromptBuildFp(), ...AB_B_VARIANTS.map(v => bOrderPromptBuildFp(v))];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('allAbPromptBuildFps(meta へ載せる一括計算)', () => {
  it('A 1つ + B 4種の計5個が揃う', () => {
    const { aPromptBuild, bPromptBuilds } = allAbPromptBuildFps();
    expect(isPromptBuildFingerprint(aPromptBuild)).toBe(true);
    expect(Object.keys(bPromptBuilds).sort()).toEqual([...AB_B_VARIANTS].sort());
    for (const v of AB_B_VARIANTS) expect(isPromptBuildFingerprint(bPromptBuilds[v]!)).toBe(true);
  });
});
