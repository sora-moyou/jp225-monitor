// ─── ★pb1: 「その版が持っているプロンプトの型」の指紋 ────────────────────────────────
//
// ■ なぜ要るか(実際に解析が誤った)
//   書き出しから「どの版のシグナルか」が分からず、collector_status_<host>.txt の起動ログの時刻や
//   「機能列がいつ初めて埋まったか」からの **間接推定** に頼るしかなかった。
//   切り分けの定数を2時間ずらして誤った結論を出しかけている。
//
// ■ このテストが固定する不変条件
//   ① データ(現在値・時刻・足)が変わっても動かない = 合成コンテキストに市場文脈が入っていない
//   ② 文面が1文字でも変われば必ず動く(空白1つでも動く=境界の曖昧さを消してある)
//   ③ 腕(質問文の変種)ごとに違う値になる ← これが無いと候補腕を識別できない
//   ④ 決定的(同じ版・同じ腕なら何度計算しても同じ)
//   ⑤ ★本文も非公開の決済数値も入らない(合成では固定プレースホルダに差し替えている)
//   ⑥ sp1 とは **別物**(形も値も混ざらない)
//   ⑦ 葉(server/buildIdentity.ts)へ登録され、記録層が LLM スタック抜きで読める

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computePromptBuildFingerprint, promptBuildFp, allPromptBuildFps,
  renderPromptShape, PROMPT_SHAPE_SLICES,
} from './promptBuild.js';
import { promptBuildFingerprint, isPromptBuildFingerprint, promptFingerprint, isPromptFingerprint } from './promptFingerprint.js';
import { PROMPT_VARIANTS } from './promptVariant.js';
import {
  currentBuildIdentity, promptBuildFor, resetPromptBuildForTest, allPublishedPromptBuilds,
} from '../buildIdentity.js';
import { APP_VERSION } from '../appVersion.js';
import { buildScalpQuestion, buildScalpSystemPrompt, scalpJsonInstruction, buildVisionNote } from './scalpPlan.js';

/** pb1 の入力(=固定合成で描いた全スライス)。1文字だけ変えて比較するために取り出す。 */
function partsOf(variant: 'v1' | 'v1f'): string[] {
  const parts: string[] = [variant];
  for (const s of PROMPT_SHAPE_SLICES) {
    const { system, user } = renderPromptShape(variant, s);
    parts.push(system, user);
  }
  return parts;
}

describe('pb1: プロンプトの型の指紋', () => {
  it('④ 決定的: 同じ腕なら何度計算しても同じ', () => {
    const v = Array.from({ length: 5 }, () => computePromptBuildFingerprint('v1'));
    expect(new Set(v).size).toBe(1);
    expect(isPromptBuildFingerprint(v[0])).toBe(true);
  });

  it('③ ★腕ごとに違う値になる(候補腕の識別ができる)', () => {
    const fps = PROMPT_VARIANTS.map(v => computePromptBuildFingerprint(v));
    expect(new Set(fps).size, `重複がある: ${fps.join(',')}`).toBe(PROMPT_VARIANTS.length);
    // ★いま走っている2本(current=v1 と候補=v1f)は必ず別。
    expect(computePromptBuildFingerprint('v1f')).not.toBe(computePromptBuildFingerprint('v1'));
  });

  it('② 文面を1文字変えると必ず動く(空白1つでも)', () => {
    const parts = partsOf('v1');
    const base = promptBuildFingerprint(parts);
    const head = [...parts]; head[1] = 'X' + (head[1] as string).slice(1);
    const tail = [...parts]; tail[2] = (tail[2] as string).slice(0, -1) + 'X';
    const space = [...parts]; space[1] = (space[1] as string) + ' ';
    for (const [name, m] of [['先頭', head], ['末尾', tail], ['末尾に空白1つ', space]] as const) {
      expect(promptBuildFingerprint(m), `${name}を変えても動かない`).not.toBe(base);
    }
  });

  it('② 断片の境界がずれただけの入力を同じ指紋にしない(長さ前置きの実証)', () => {
    // ['ab','c'] と ['a','bc'] は連結すると同じ 'abc' だが、指紋は別でなければならない。
    expect(promptBuildFingerprint(['ab', 'c'])).not.toBe(promptBuildFingerprint(['a', 'bc']));
  });

  it('① ★データ(現在値・時刻)が変わっても動かない = 合成に市場文脈が入っていない', () => {
    // pb1 はそもそもデータを受け取らない。実際に送るプロンプト(sp1)は動くことを対照で示す。
    const real = (refPrice: number, now: number) => {
      const sys = buildScalpSystemPrompt(55, 160, false, 100, true)
        + `\n\n【市場の現状 ${new Date(now).toISOString()}】\n\n■ 現在価格:\nNIY=F ${refPrice}`;
      const usr = `${buildScalpQuestion(55, 160, false, 100)}\n\n${buildVisionNote(false)}`
        + scalpJsonInstruction(refPrice, 55, 160, false);
      return promptFingerprint(sys, usr);
    };
    expect(real(38250, 1), 'sp1 はデータで動く(=層別キーには使えない)')
      .not.toBe(real(41990, 2));
    expect(computePromptBuildFingerprint('v1')).toBe(computePromptBuildFingerprint('v1'));
    // 合成プロンプトに市場文脈の見出しが1つも無いこと(データを入れていないことの直接確認)。
    for (const s of PROMPT_SHAPE_SLICES) {
      const { system, user } = renderPromptShape('v1', s);
      // ★見出しは「【市場の現状 <時刻>】」= 空白つきで始まる(規則の本文には空白なしの
      //   「手元の【市場の現状】(現在価格・…)」という **参照** があるので、そちらと取り違えない)。
      expect(system).not.toContain('【市場の現状 ');
      expect(system).not.toContain('■ 現在価格:');
      expect(system).not.toContain('■ 関連ニュース:');
      expect(user).not.toContain('【市場の現状 ');
    }
  });

  it('⑤ ★非公開の決済説明は固定プレースホルダに差し替えてから食わせる(私的な数値が入力に入らない)', () => {
    for (const s of PROMPT_SHAPE_SLICES) {
      const { system } = renderPromptShape('v1', s);
      expect(system).toContain('決済仕様の説明はここでは固定のプレースホルダにする');
    }
    // 出力は hex 16桁だけ(本文の断片が漏れる形をしていない)。
    expect(computePromptBuildFingerprint('v1')).toMatch(/^pb1:[0-9a-f]{16}$/);
  });

  it('⑥ sp1 とは別物(形も値も混ざらない)', () => {
    const pb = computePromptBuildFingerprint('v1');
    const sp = promptFingerprint('a', 'b');
    expect(isPromptBuildFingerprint(pb)).toBe(true);
    expect(isPromptFingerprint(pb), 'pb1 が sp1 として通ってはいけない').toBe(false);
    expect(isPromptBuildFingerprint(sp), 'sp1 が pb1 として通ってはいけない').toBe(false);
  });

  it('★スライス表が「1つだけ変えた」派生になっている(分岐を踏み残していない)', () => {
    // 基準(先頭)と各派生の差が1項目だけ = 新しい分岐を足したときに気づける形を保つ。
    const base = PROMPT_SHAPE_SLICES[0]!;
    for (const s of PROMPT_SHAPE_SLICES.slice(1)) {
      const diff = (Object.keys(base) as Array<keyof typeof base>)
        .filter(k => JSON.stringify(base[k]) !== JSON.stringify(s[k]));
      expect(diff.length, `派生が2項目以上違う: ${diff.join(',')}`).toBe(1);
    }
    // 全スライスの描画が空でない(条件分岐で本文が消えていない)。
    for (const s of PROMPT_SHAPE_SLICES) {
      const { system, user } = renderPromptShape('v1', s);
      expect(system.length).toBeGreaterThan(1000);
      expect(user.length).toBeGreaterThan(1000);
    }
  });
});

describe('buildIdentity(葉): 記録層が LLM スタック抜きで読める', () => {
  beforeEach(() => resetPromptBuildForTest());

  it('⑦ 未登録なら promptBuild は null(0 や空文字を捏造しない)', () => {
    expect(currentBuildIdentity()).toEqual({ appVersion: APP_VERSION, promptBuild: null });
    expect(promptBuildFor('v1')).toBeNull();
    expect(allPublishedPromptBuilds()).toEqual({});
  });

  it('⑦ allPromptBuildFps() が全変種を葉へ登録し、既定(v1)が台帳の既定値になる', () => {
    const map = allPromptBuildFps();
    expect(Object.keys(map).sort()).toEqual([...PROMPT_VARIANTS].sort());
    expect(currentBuildIdentity().promptBuild).toBe(map.v1);
    expect(promptBuildFor('v1f')).toBe(map.v1f);
    // 未知の変種は null(存在しない値を作らない)。
    expect(promptBuildFor('v9')).toBeNull();
  });

  it('★app_version は常に読める(registry を経由しない)', () => {
    expect(typeof currentBuildIdentity().appVersion).toBe('string');
    expect(currentBuildIdentity().appVersion.length).toBeGreaterThan(0);
  });

  it('promptBuildFp はキャッシュしても値が変わらない', () => {
    expect(promptBuildFp('v1')).toBe(computePromptBuildFingerprint('v1'));
    expect(promptBuildFp()).toBe(promptBuildFp('v1'));   // 既定は v1
  });
});
