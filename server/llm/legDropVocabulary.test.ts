// ★脱落理由の日本語は「方向レッグ」と「レンジ脚」で **同一** であることの実証(v0.9.66)。
//
// ■ 何を守っているか(実測の欠陥)
//   同じ reason(stopSide / lcFloor / lc / geometry / missing / trend / bias)に対して、
//   方向レッグは LEG_DROP_REASON_TEXT の文言、レンジ脚は rangeDropNote 内の別系統の短縮語
//   (SL向き不正 / LC下限未満 / LC上限超 / 現在値との上下関係が不正 / AIが提示しなかった /
//    トレンド逆行 / バイアス(売り優先))を出しており、**6種すべてが不一致** だった。
//   同じ原因が画面で2つの言葉に見えるため、台帳(leg_drops_json.reason)から画面へ辿れない。
//   → 理由の文字列は1本(legDropReasonText)に統一する。位置(上部/下部)と side は前置きで表す。
//
// ■ ★undefined を画面に出さない(防御)
//   rangeDropNote は switch に default が無く、union 外の reason(stale / rangeDisabled / ai)を
//   渡すと `※上部(売り指値)はundefinedのため除外` を返していた。型で塞がれてはいたが、
//   「型の外から来た値」で画面に undefined が出る経路そのものを残さない。
//
// ■ ★否定対照
//   git show HEAD:server/llm/scalpPlan.ts の rangeDropNote は別系統の短縮語を返すので
//   「理由部分が一致する」テストは全件赤。union 外を渡すテストは 'undefined' を含んで赤。

import { describe, it, expect } from 'vitest';
import { buildLegNote, rangeDropNote, legDropReasonText, type NoneReason } from './scalpPlan.js';

/** 方向レッグ側の注記から **理由の部分だけ** を取り出す(`（指値は不採用: X）` / `（指値なし: X）`)。 */
function directionalReason(note: string): string {
  const m = /^（[^:：]+[:：]\s*(.+)）$/.exec(note);
  return m?.[1] ?? `__PARSE_FAILED__(${note})`;
}

/** レンジ脚側の注記から **理由の部分だけ** を取り出す(`※上部(売り指値)は不採用: X` / `※上部のレッグなし: X`)。 */
function rangeReason(note: string): string {
  const m = /^※[^:：]+[:：]\s*(.+)$/.exec(note);
  return m?.[1] ?? `__PARSE_FAILED__(${note})`;
}

/** 方向レッグ(指値が落ちた場合)の実際の出力文字列。 */
function directionalNote(reason: NoneReason): string {
  return buildLegNote({ hasLimit: false, hasStop: true, drops: [{ name: 'limit', reason }] });
}

/** ★要件が名指しした6種(方向レッグと range 脚で文言が割れていたもの)。 */
const SIX: NoneReason[] = ['stopSide', 'lcFloor', 'lc', 'geometry', 'missing', 'trend'];

describe('脱落理由の語彙: 方向レッグと range 脚が同じ日本語を使う', () => {
  it.each([...SIX, 'bias' as NoneReason])('reason=%s の理由部分が方向レッグと range 脚で同一', (reason) => {
    const dir = directionalNote(reason);
    const rng = rangeDropNote('上部', 'sell', reason);
    expect(directionalReason(dir)).toBe(legDropReasonText(reason));
    expect(rangeReason(rng)).toBe(legDropReasonText(reason));
    // ★本題: 同じ reason は同じ文字列(台帳の reason から画面の言葉へ辿れる)。
    expect(rangeReason(rng)).toBe(directionalReason(dir));
  });

  it('range 脚は位置と side を **前置き** に持つ(理由の部分は汚さない)', () => {
    expect(rangeDropNote('上部', 'sell', 'lc')).toBe('※上部(売り指値)は不採用: 損切り幅が設定の上限より広い');
    expect(rangeDropNote('下部', 'buy', 'bias')).toBe('※下部(買い指値)は不採用: バイアス設定と逆');
    // side 不明(AI が壊れた形で出した)は中立ラベル。
    expect(rangeDropNote('下部', undefined, 'trend')).toBe('※下部(指値)は不採用: トレンドに逆行');
  });

  it("AI が出さなかった脚は『なし』・出したが落ちた脚は『不採用』と書き分ける(方向レッグと同じ規約)", () => {
    expect(rangeDropNote('上部', undefined, 'missing')).toBe('※上部のレッグなし: AIが提案せず');
    expect(directionalNote('missing')).toBe('（指値なし: AIが提案せず）');
  });
});

describe('★union 外の reason を渡しても undefined を画面に出さない', () => {
  // rangeDropNote の引数は NoneReason 全体を受けるので、この3つは型としても通る(=switch の穴が塞がった)。
  it.each(['stale', 'rangeDisabled', 'ai'] as NoneReason[])('reason=%s でも理由が1語で出る', (reason) => {
    const note = rangeDropNote('上部', 'sell', reason);
    expect(note).not.toContain('undefined');
    expect(rangeReason(note)).toBe(legDropReasonText(reason));
    expect(rangeReason(note).length).toBeGreaterThan(0);
  });

  it('★型の外から来た未知の値(将来の理由・壊れた台帳)でも undefined にならない', () => {
    const unknown = 'brandNewReasonFromTheFuture' as NoneReason;
    expect(rangeDropNote('下部', 'buy', unknown)).toBe('※下部(買い指値)は不採用: 理由不明');
    expect(directionalNote(unknown)).toBe('（指値は不採用: 理由不明）');
    expect(legDropReasonText(unknown)).toBe('理由不明');
  });
});
