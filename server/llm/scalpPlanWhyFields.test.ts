// ★v0.9.88: **レッグごとの理由の箱** を JSON 契約へ足したことの固定。
//
// なぜこの追加をしたか(実測): 同じ断面・同じデータで JSON の理由フィールドの数だけを変えると、
// 1脚あたりの理由は 散文211字 / 箱1つ59字 / 箱2つ107字(+81%) だった。パース失敗0・欠損0・
// 型違反0・位置/種別/SLの向き 24/24 で整合は崩れていない。つまり理由の量を決めているのは
// 文言ではなく **箱の数** だという読み。★本番データでは未検証。
//
// このファイルが守るもの:
//   (a) 5つの箱が JSON 契約に在る(名前・置き場所)
//   (b) **すべての生きた腕(v1 / v1d / v1e)に同時に入る**(片腕だけに入れると A/B が壊れる)
//   (c) ★**長さの指示を書かない**(「1行」は実測で理由を 47% 削っていた。下の it を参照)
//   (c2) それ以外の新しい制約・数値・禁止も足していない(足したのはフィールドだけ)
//   (d) rationale の契約(LC検算の要求)を1文字も変えていない
//   (e) parse が拾い、欠落しても計画を落とさない(後方互換)
import { describe, it, expect } from 'vitest';
import { scalpJsonInstruction, buildScalpQuestion, parseScalpPlan, LC_CEIL_MANUAL } from './scalpPlan.js';

const REF = 68_700;

/** ★v0.9.88 で足した5つの箱。名前は本番の既存語彙に揃えてある:
 *  「なぜ」= `...Why`(既存 strategyWhy) / レッグ別 = `...ForLimit` / `...ForStop`
 *  (既存 lcWidthForLimit / stopLossForStop)。 */
const WHY_FIELDS = [
  'directionWhy', 'entryWhyForLimit', 'entryWhyForStop', 'lcWhyForLimit', 'lcWhyForStop',
] as const;

/** 契約文からそのフィールドの注記(`//` 以降)だけを取り出す。
 *  ★indexOf の戻りを必ず検査する: slice は負の引数を **末尾からのオフセット** として扱うので、
 *    `//` が無いと slice(-1) = 末尾1文字になり、下の not.toContain 検査が全部素通りする(fail-open)。 */
const noteOf = (prompt: string, field: string): string => {
  const line = prompt.split('\n').find(l => l.includes(`"${field}"`));
  expect(line, `契約文に "${field}" の行が無い`).toBeDefined();
  const at = line!.indexOf('//');
  expect(at, `"${field}" の行に注記(//)が無い`).toBeGreaterThanOrEqual(0);
  return line!.slice(at);
};

// buildScalpPlan の非 v2 分岐と同じ組み立て(質問文 + JSON 出力指示)を再現する。
const userPromptFor = (variant: 'v1' | 'v1d' | 'v1e'): string =>
  buildScalpQuestion(55, 65, true, 100, LC_CEIL_MANUAL, variant === 'v1d', variant === 'v1e')
  + '\n\n' + scalpJsonInstruction(REF, 55, 65, true, LC_CEIL_MANUAL);

describe('★v0.9.88: 理由の箱を JSON 契約へ足す(全腕に同時に)', () => {
  for (const variant of ['v1', 'v1d', 'v1e'] as const) {
    it(`★${variant} の user プロンプトに5つの箱がすべて入る(片腕だけに入れない)`, () => {
      const p = userPromptFor(variant);
      for (const f of WHY_FIELDS) expect(p, `${variant} に "${f}" が無い`).toContain(`"${f}"`);
    });
  }

  it('★v1 と v1e で契約の該当部分は完全に同一(距離の上限の A/B を汚さない)', () => {
    // JSON 出力指示は共通の土台(scalpJsonInstruction)なので、両腕は同じ文字列を受け取る。
    const a = scalpJsonInstruction(REF, 55, 65, true, LC_CEIL_MANUAL);
    expect(userPromptFor('v1')).toContain(a);
    expect(userPromptFor('v1e')).toContain(a);
  });

  it('★箱は「それが説明するフィールドの隣」に置く(離すと何を説明しているのか読めない)', () => {
    const p = scalpJsonInstruction(REF, 55, 65, true, LC_CEIL_MANUAL);
    const at = (name: string): number => p.indexOf(`"${name}"`);
    // direction → directionWhy → limitEntry → entryWhyForLimit → stopEntry → entryWhyForStop
    // → lcWidthForLimit → lcWhyForLimit → lcWidthForStop → lcWhyForStop
    const order = [
      'direction', 'directionWhy', 'limitEntry', 'entryWhyForLimit', 'stopEntry', 'entryWhyForStop',
      'lcWidthForLimit', 'lcWhyForLimit', 'lcWidthForStop', 'lcWhyForStop',
    ];
    for (const name of order) expect(at(name), `"${name}" が契約に無い`).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i++) {
      expect(at(order[i]!), `${order[i]} は ${order[i - 1]} の後ろに置く`).toBeGreaterThan(at(order[i - 1]!));
    }
  });

  // ★★★ 「1行」を書かない(戻さないための固定) ★★★
  //   最初の版は既存 strategyWhy に倣って `(1行・日本語)` と書いていた。検証台で
  //   **`1行・` の3文字だけ** を変えた対照を取ると、5フィールドすべてで理由が伸びた:
  //     directionWhy 50→76 / entryWhyForLimit 33→47 / entryWhyForStop 35→50 /
  //     lcWhyForLimit 37→55 / lcWhyForStop 37→50 [文字] … 平均 38→56字 = ★+47%(例外なし)。
  //   そして ★**改行の混入は両パスとも0件(全72フィールド)** = 「1行」が防ぐはずのものは
  //   書かなくても起きなかった。改行への防御は表示側(paintPanel の splitRationaleLines)で持つ。
  it('★長さの指示を書かない(「1行」は理由を 47% 削っていた)', () => {
    const p = scalpJsonInstruction(REF, 55, 65, true, LC_CEIL_MANUAL);
    for (const f of WHY_FIELDS) {
      const note = noteOf(p, f);
      expect(note, `${f} に長さの指示が復活している`).not.toContain('1行');
      expect(note, `${f} の注記が既存の語句から外れている`).toContain('(日本語)');
    }
  });

  it('★足したのはフィールドだけ: 制約語・数値を1つも書いていない', () => {
    const p = scalpJsonInstruction(REF, 55, 65, true, LC_CEIL_MANUAL);
    for (const f of WHY_FIELDS) {
      const note = noteOf(p, f);
      for (const banned of ['必ず', '禁止', '以内', '以上', '文字', '行']) {
        expect(note, `${f} の注記に制約語「${banned}」が入っている`).not.toContain(banned);
      }
      // ★数値は1つも書かない(数値はアンカーとして効く=このプロジェクトの実測)。
      expect(note, `${f} の注記に数値が入っている`).not.toMatch(/\d/);
    }
  });

  it('★「…と対で省略」は残す(省略の規約は必要・レッグ落ちと欠測を区別するため)', () => {
    const p = scalpJsonInstruction(REF, 55, 65, true, LC_CEIL_MANUAL);
    expect(noteOf(p, 'entryWhyForLimit')).toContain('limitEntry と対で省略');
    expect(noteOf(p, 'entryWhyForStop')).toContain('stopEntry と対で省略');
    expect(noteOf(p, 'lcWhyForLimit')).toContain('lcWidthForLimit と対で省略');
    expect(noteOf(p, 'lcWhyForStop')).toContain('lcWidthForStop と対で省略');
  });

  it('★rationale の契約(LC検算の要求)を1文字も変えていない', () => {
    const p = scalpJsonInstruction(REF, 55, 65, true, LC_CEIL_MANUAL);
    const line = p.split('\n').find(l => l.includes('"rationale"'))!;
    // 監査(server/llm/rationaleLc.ts)が生の rationale を読む。式の要求を外すと符号ミスが3倍になる実測がある。
    expect(line).toContain('幅を出した引き算');
    expect(line).toContain('上の lcWidthFor… と一致させる');
  });
});

describe('★v0.9.88: parse が理由の箱を拾う(欠落しても計画は落とさない)', () => {
  const plan = (extra: Record<string, unknown>): ReturnType<typeof parseScalpPlan> =>
    parseScalpPlan(JSON.stringify({
      direction: 'buy',
      limitEntry: 68_675, lcWidthForLimit: 60,
      stopEntry: 68_780, lcWidthForStop: 60,
      rationale: '押し目を拾う', refPrice: REF, ...extra,
    }), REF);

  it('5つとも拾って AiPlan に載る', () => {
    const r = plan({
      directionWhy: '上昇継続と判断', entryWhyForLimit: '支持帯まで待つ', entryWhyForStop: '節目抜けに追随',
      lcWhyForLimit: '直近安値の外側', lcWhyForStop: '節目の内側に戻る幅',
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.plan).toMatchObject({
      directionWhy: '上昇継続と判断', entryWhyForLimit: '支持帯まで待つ', entryWhyForStop: '節目抜けに追随',
      lcWhyForLimit: '直近安値の外側', lcWhyForStop: '節目の内側に戻る幅',
    });
  });

  it('★不変の実証: 1つも書かれていない応答から作った plan にキーが1つも生えない(旧応答=従来と同じ形)', () => {
    const r = plan({});
    expect(r.ok).toBe(true);
    const p = r.ok ? r.plan as unknown as Record<string, unknown> : {};
    for (const f of WHY_FIELDS) expect(Object.prototype.hasOwnProperty.call(p, f), `${f} が生えている`).toBe(false);
  });

  it('★不正な型・空文字は undefined(計画は落とさない=strategyWhy と同じ後方互換)', () => {
    const r = plan({ directionWhy: 123, entryWhyForLimit: '   ', lcWhyForStop: null });
    expect(r.ok).toBe(true);
    const p = r.ok ? r.plan as unknown as Record<string, unknown> : {};
    for (const f of ['directionWhy', 'entryWhyForLimit', 'lcWhyForStop']) {
      expect(Object.prototype.hasOwnProperty.call(p, f), `${f} に不正値が入った`).toBe(false);
    }
    // 価格・採否は1ミリも変わらない。
    expect(r.ok && r.plan.limitEntry).toBe(68_675);
    expect(r.ok && r.plan.stopEntry).toBe(68_780);
  });

  it('★parse は切り詰めない(上限は台帳側の責務。ここで削ると発生源で材料を失う)', () => {
    // rationale と同じ層の分担: parse は trim(前後の空白)だけ、長さの安全弁は planLedger。
    // ★台帳では trimRationale(上限2000字+印)が掛かる(server/db/signalPlanWhy.test.ts が固定)。
    const long = 'あ'.repeat(1_500);
    const r = plan({ entryWhyForLimit: long });
    expect(r.ok && r.plan.entryWhyForLimit).toBe(long);
    expect(r.ok && r.plan.entryWhyForLimit!.length).toBe(1_500);
  });

  it('見送り(none)でも目線の理由は残る(なぜ見送ったかが読める)', () => {
    const r = parseScalpPlan(JSON.stringify({
      direction: 'none', rationale: '良い場面が無い', refPrice: REF, directionWhy: 'レンジで方向感が無い',
    }), REF);
    expect(r.ok && r.plan.direction).toBe('none');
    expect(r.ok && r.plan.directionWhy).toBe('レンジで方向感が無い');
  });
});
