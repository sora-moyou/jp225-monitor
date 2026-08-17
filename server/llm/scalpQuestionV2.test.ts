// server/llm/scalpQuestionV2.test.ts
//
// ─── ★v2 質問文(全面簡素化・実験中) ───────────────────────────────────────────
//
// 経緯: 現行 buildScalpQuestion は 5,475文字・★24個・「必ず/厳禁/絶対/無条件/例外なし」15個。
//   その大半は 6版にわたる「規則を足す」修正の瘢痕で、実測ではそのたびに失敗が **移動** した:
//     下限55固着 → (幅を出させる契約へ) → 中間60固着 62%
//     売りを名指しで直す → 買いへ移動
//     式を書かせる → 式は正しくなり符号だけ誤りが残る
//   唯一 完全に効いたのは v0.9.70 の「書けなくする」(損切りの符号をコードが決める)だけ。
//
// ★このテストが守るもの:
//   (1) v2 は **promptVariant:'v2' を明示した時だけ** 使われる(既定は v1 = 稼働機・実取引経路は不変)
//   (2) v2 が「システムの分担」を明示し、コードが検証する規則を **繰り返さない**
//   (3) 上限を **ハードコードしていない**(設定を変えたらプロンプトも追随する)
//   (4) 案A(範囲を見せる) と 案B(見せない) が **その1点しか違わない**(1変数ずつ動かす)
//   (5) 台帳の列が候補の腕だけ欠測にならない(regime / confidence / refPrice を返させる)
//
// ★接続先(2026-08-13・v0.9.75): 分析用の②の腕 'prompt-v2' だけが promptVariant:'v2' を送っていた。
//   ★2026-08-17: 候補の枠は 'prompt-v1d'(質問文 v1d = v1 マイナス最低距離)へ載せ替えた。
//     **v2 のビルダーは残す**(この関数と、それを守るここまでの不変条件は将来もう一度回す時に使える)が、
//     いま生成器が送っているのは v1d で、v2 は **どの腕も送らない**。この事実をテストで固定する
//     (腕の構成を書いたテストが1つも無いと、載せ替えが無音になる)。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildScalpQuestionV2, buildScalpQuestion } from './scalpPlan.js';
import { planCycleArms } from '../generator/cycle.js';

const A = () => buildScalpQuestionV2({ floorYen: 55, ceilYen: 159 });
const B = () => buildScalpQuestionV2({ floorYen: 55, ceilYen: 159, showRange: false });

describe('v2 質問文', () => {
  it('★既定は v1(v2 は promptVariant を明示した時だけ選ばれる)', () => {
    // 本体で v2 を呼ぶ行は「promptVariant === 'v2' のときだけ」の分岐の中にしか無いこと。
    // 無条件で呼ぶ行が1つでもあれば、実取引につながる既定経路の質問文が変わってしまう。
    const src = readFileSync(fileURLToPath(new URL('./scalpPlan.ts', import.meta.url)), 'utf8');
    const lines = src.split('\n');
    const callers = lines
      .map((l, i) => ({ l, i }))
      .filter(x => x.l.includes('buildScalpQuestionV2(') && !x.l.includes('export function'));
    expect(callers.length, 'v2 を呼ぶ箇所は1つだけ').toBe(1);
    // 直前3行のどこかに v2 の判定がある(= 条件付きで選ばれている)。
    const near = lines.slice(Math.max(0, callers[0]!.i - 3), callers[0]!.i + 1).join('\n');
    expect(near, 'v2 が無条件に選ばれている').toContain(`promptVariant === 'v2'`);
  });

  it('★v2 は現在どの腕も送っていない(候補の枠は v1d へ載せ替え済み)', () => {
    const arms = planCycleArms(0, 1);   // 対照を必ず含むサイクル
    expect(arms.map(a => a.arm)).toEqual(['current', 'control', 'prompt-v1d']);
    // 決済仕様は3本とも同じ = 動かす変数は質問文だけ。
    expect(new Set(arms.map(a => a.exitVariant))).toEqual(new Set(['current']));
    expect(arms.map(a => a.promptVariant)).toEqual(['v1', 'v1', 'v1d']);
    expect(arms.some(a => a.promptVariant === 'v2'), 'v2 を送る腕が復活している').toBe(false);
  });

  it('★台帳の列が候補の腕だけ欠測にならない(記録の3フィールドを返させる)', () => {
    for (const q of [A(), B()]) {
      for (const k of ['regime', 'confidence', 'refPrice']) {
        expect(q, `${k} を返させていない = 台帳のその列が候補の腕だけ空になる`).toContain(k);
      }
    }
    // refPrice を渡したらその数値が出る(v1 の scalpJsonInstruction と同じ契約)。
    expect(buildScalpQuestionV2({ floorYen: 55, ceilYen: 159, refPrice: 68520 })).toContain('68520');
  });

  it('現行より大幅に短い(瘢痕を落とせている)', () => {
    expect(A().length).toBeLessThan(buildScalpQuestion(55, 65).length / 2);
  });

  it('AI が出すのは 方向/価格/幅/根拠 の4つ', () => {
    const q = A();
    for (const k of ['direction', 'limitEntry', 'stopEntry', 'lcWidthForLimit', 'lcWidthForStop', 'rationale']) {
      expect(q, `${k} が出力の説明に無い`).toContain(k);
    }
  });

  it('★損切りの価格を出させない(符号を選ばせない=v0.9.70 の契約を守る)', () => {
    for (const q of [A(), B()]) {
      expect(q).not.toContain('stopLossForLimit');
      expect(q).not.toContain('stopLossForStop');
      expect(q).toContain('あなたが出すのは幅(正の数)だけ');
    }
  });

  it('★コードが検証する規則を繰り返さず、分担として書く', () => {
    const q = A();
    expect(q).toContain('システムが自動で行うこと');
    expect(q).toContain('システムが検証');
    // 現行にあった「禁止の連呼」を持ち込んでいないこと
    const bans = (q.match(/厳禁|絶対に|例外なし|無条件/g) ?? []).length;
    expect(bans, '禁止の連呼が復活している').toBeLessThanOrEqual(1);
  });

  it('節目ちょうどには置かない(ユーザー指示で追加)', () => {
    expect(A()).toContain('節目ちょうどには置かないこと');
  });

  it('★上限をハードコードしていない(渡した値がそのまま出る)', () => {
    expect(buildScalpQuestionV2({ floorYen: 55, ceilYen: 159 })).toContain('159円以下');
    expect(buildScalpQuestionV2({ floorYen: 45, ceilYen: 300 })).toContain('300円以下');
    expect(buildScalpQuestionV2({ floorYen: 45, ceilYen: 300 })).toContain('45円以上');
    // 稼働機の実効上限(159)が焼き付いていないこと
    expect(buildScalpQuestionV2({ floorYen: 55, ceilYen: 200 })).not.toContain('159');
  });

  it('★案A と案B は「範囲を見せるか」の1点しか違わない', () => {
    const a = A().split('\n');
    const b = B().split('\n');
    const onlyA = a.filter(l => !b.includes(l));
    const onlyB = b.filter(l => !a.includes(l));
    expect(onlyA, '案Aにだけ在る行').toEqual(['**【厳格ルール】幅は 55円以上 159円以下。範囲外は不可。**']);
    expect(onlyB.join('\n')).toContain('節目までの距離から決めて');
    expect(onlyB.join('\n')).toContain('範囲は非公開');
    // ★案B は数値を1つも見せない
    expect(B()).not.toContain('55円');
    expect(B()).not.toContain('159');
  });

  it('ドテン・レンジは許可時だけ入る', () => {
    expect(A()).not.toContain('ドテン');
    expect(A()).not.toContain('direction:"range"');
    expect(buildScalpQuestionV2({ floorYen: 55, ceilYen: 159, dotenEnabled: true })).toContain('ドテン');
    const r = buildScalpQuestionV2({ floorYen: 55, ceilYen: 159, rangeEnabled: true });
    expect(r).toContain('direction:"range"');
    expect(r).toContain('自由に');   // 組の縛りを外した(ユーザー指示)
  });
});
