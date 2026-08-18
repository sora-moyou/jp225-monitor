// ─── ★v1d 質問文(= v1 マイナス「現在値から最低50円離す」) ────────────────────────────
//
// ■ 何を測る腕か(設計書 docs/superpowers/specs/2026-08-17-signal-constraints-design.md §5/§8)
//   制約を3層(執行/戦略/助言)に分ける移行の **1番目=層1**。最低距離はラグの緩衝=執行の都合であって
//   戦略の指示ではなかった。実測:
//     ・89.8% の断面で「節目の5〜10円内側」と最低距離50円は **両立しない**(合法解が無い)
//     ・2,222レッグの **72.0% が距離を破り**、LC下限を破ったレッグは **0件**
//     ・v2(距離ルール無し)と比べても距離の中央値は 25円 で同一 = 書いても出力が変わっていない疑い
//   ただし v2 は質問文を全面的に書き換えているので **1変数の対照ではない**。
//   ⇒ v1d は「距離の記述 **だけ** を外したら AI は節目に素直に置くか」を1変数で測る。
//
// ■ このテストが固定する不変条件
//   (1) v1 と v1d の差分は **最低距離の記述だけ**(行差分で実証する)
//   (2) 距離の **上限**(片レッグ200円 / 両レッグ幅400円)は v1d でも残る(同時に2つ動かさない)
//   (3) 最低距離の3箇所(質問文② / strategySpec / バンドウォーク注記の免除文①)が **同時に** 消える
//   (4) バンドウォークの免除文は本則が消えたら整合する(存在しない規則の例外を説明しない)
//   (5) 稼働機は v1d を使わない(engine の3経路は promptVariant を1度も渡さない)
//
// ★否定対照の作り方: omitMinDistance を無条件 true にすると (1)(2) 以外の多くが赤になり、
//   逆に候補腕の promptVariant を 'v1' に戻すと (6) の腕テストが赤になる。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildScalpQuestion, buildStrategySpec, buildBandwalkNote,
} from './scalpPlan.js';
import {
  PROMPT_VARIANTS, DEFAULT_PROMPT_VARIANT, normalizePromptVariant, generatorArmKey,
} from './promptVariant.js';
import { planCycleArms } from '../generator/cycle.js';
import type { Bandwalk } from '../bandwalk.js';

const FLOOR = 55;
const CEIL = 159;

/** v1(既定)の質問文。 */
const Q1 = (): string => buildScalpQuestion(FLOOR, CEIL);
/** v1d の質問文(最低距離の記述だけを落とす)。 */
const Q1D = (): string => buildScalpQuestion(FLOOR, CEIL, true, 100, undefined, true);

const SPEC_IN = (omitMinDistance: boolean) => ({
  floor: { mode: 'manual' as const, value: FLOOR },
  ceiling: { mode: 'manual' as const, value: CEIL },
  trendVeto: { mode: 'manual' as const, value: 100 },
  cooldown: { mode: 'manual' as const, value: 15 },
  bias: { mode: 'manual' as const, value: 'none' as const },
  range: { mode: 'manual' as const, value: true },
  hardMax: { enabled: false, value: 200 },
  exitDesc: '(決済の説明・この検証では固定文)',
  omitMinDistance,
});

const BW: Bandwalk = {
  direction: 'up', ratio: 0.8, bars: 12, sinceT: 0, t: 3_600_000, close: 42_000, band: 41_900, rsi: 62.5,
};

describe('v1d 質問文 — v1 との差分は「最低距離の記述」1点だけ', () => {
  it('★行差分: 動くのは②の1行だけで、その差は「最低距離の括弧」の削除に尽きる', () => {
    const a = Q1().split('\n');
    const b = Q1D().split('\n');
    const onlyA = a.filter(l => !b.includes(l));
    const onlyB = b.filter(l => !a.includes(l));

    // 動く行は 前後とも1行だけ(=②)。他の行は1つも入れ替わっていない。
    expect(onlyA, `v1 側で消えた行: ${JSON.stringify(onlyA)}`).toHaveLength(1);
    expect(onlyB, `v1d 側で増えた行: ${JSON.stringify(onlyB)}`).toHaveLength(1);

    // ★その1行の差は「最低距離の括弧」ちょうど1つ。文字列の引き算で実証する
    //   (v1d の行に、消したはずの括弧を戻すと v1 の行に **byte 一致** で復元できる)。
    const REMOVED = '(指値とブレイク新規は、現在値からそれぞれ少なくとも50円以上離すこと。'
      + 'この最低距離は buy/sell のみで、range の各レッグには適用しない=レンジは上下の反応帯の位置で決める)';
    expect(onlyB[0]! + REMOVED).toBe(onlyA[0]!);
    // 行数そのものは変わらない(空行を作っていない)。
    expect(b).toHaveLength(a.length);
  });

  it('★v1d に「50円」の最低距離が1文字も残っていない', () => {
    expect(Q1D()).not.toContain('50円以上離す');
    expect(Q1D()).not.toContain('最低距離');
    // v1 には在る(=否定対照。テストが常に真になっていない)。
    expect(Q1()).toContain('少なくとも50円以上離すこと');
  });

  it('★距離の **上限**(200/400)は v1d でも残る(1コミット1変数=同時に2つ動かさない)', () => {
    for (const q of [Q1(), Q1D()]) {
      expect(q).toContain('400円以内');
      expect(q).toContain('200円以内');
    }
  });

  it('★他の規則は1バイトも動いていない(向き・LC下限・自己検算・節目の置き方)', () => {
    const q = Q1D();
    expect(q).toContain('買い: limitEntry < refPrice < stopEntry');
    expect(q).toContain('★【最優先: 損切りの幅(無条件・例外なし)】');
    expect(q).toContain(`${FLOOR}円以上`);
    expect(q).toContain('★【出力前の自己検算(必須)】');
    expect(q).toContain('指値は節目から 5〜10円 内側');
    expect(q).toContain('その引き算をそのまま書くこと');
  });

  it('★既定(引数省略)は v1 と byte 一致 = 稼働機の質問文は動かない', () => {
    expect(buildScalpQuestion(FLOOR, CEIL, true, 100, undefined, false)).toBe(Q1());
    expect(buildScalpQuestion(FLOOR, CEIL)).toBe(Q1());
  });
});

describe('v1d — 最低距離は3箇所すべてから同時に消える', () => {
  it('②strategySpec: 最低距離の箇条書きが行ごと消える(空行を作らない)', () => {
    const on = buildStrategySpec(SPEC_IN(false));
    const off = buildStrategySpec(SPEC_IN(true));
    expect(on).toContain('最低 50円 離す');
    expect(off).not.toContain('最低 50円 離す');
    // 落としたのは1行ぶんだけ。空行は増えない(join('\n') に '' を混ぜていない)。
    expect(on.split('\n').length - off.split('\n').length).toBe(1);
    expect(off).not.toContain('\n\n');
    // 距離の上限の行は残る。
    expect(off).toContain('現在値から200円以内に収める');
  });

  it('③バンドウォーク注記: 免除文①が消え、②が①へ繰り上がり、「2点」→「1点」も整合する', () => {
    const on = buildBandwalkNote(BW, false);
    const off = buildBandwalkNote(BW, true);
    // v1(従来)は「2点」を緩め、①が最低距離の免除。
    expect(on).toContain('次の2点だけを緩めてよい');
    expect(on).toContain('①指値・ブレイク新規を現在値から最低50円離す、という最低距離は課さない');
    expect(on).toContain('②エントリーを節目');
    expect(on).toContain('★緩むのはこの2点のみ');
    // v1d は本則が無いので免除も無い=「1点」。
    expect(off).not.toContain('最低距離');
    expect(off).not.toContain('50円');
    expect(off).toContain('次の1点だけを緩めてよい');
    expect(off).toContain('①エントリーを節目');
    expect(off).toContain('★緩むのはこの1点のみ');
    // ★助詞: 前項が消えたので「も」は使わない(参照先を失った表現を残さない)。
    expect(on).toContain('から導く要求も課さない');
    expect(off).toContain('から導く要求は課さない');
    expect(off).not.toContain('から導く要求も課さない');
    // ★緩めないものの列挙は1バイトも変えない(距離の上限もここに残る)。
    for (const s of [on, off]) {
      expect(s).toContain('損切り(LC)幅の下限・上限・安全上限');
      expect(s).toContain('距離の上限(片レッグ200円以内/両レッグ幅400円以内)は **一切変わらない**');
    }
  });

  it('★既定(引数省略)は従来と byte 一致', () => {
    expect(buildBandwalkNote(BW)).toBe(buildBandwalkNote(BW, false));
    const { omitMinDistance: _drop, ...noFlag } = SPEC_IN(false);
    expect(buildStrategySpec(noFlag)).toBe(buildStrategySpec(SPEC_IN(false)));
  });

  it('★プロンプトの3ビルダーを合わせても「最低距離」の掲載は0件になる', () => {
    const all = Q1D() + buildStrategySpec(SPEC_IN(true)) + buildBandwalkNote(BW, true);
    expect(all).not.toContain('最低距離');
    expect(all).not.toMatch(/最低\s*50\s*円/);
    expect(all).not.toContain('50円以上離す');
    // 否定対照: v1 側では 3件とも在る。
    const allV1 = Q1() + buildStrategySpec(SPEC_IN(false)) + buildBandwalkNote(BW, false);
    expect(allV1.match(/最低距離|最低 50円 離す|50円以上離す/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('v1d — 変種の受け口(腕からは降りたが、変種としては生きている)', () => {
  // ★2026-08-18: 209件の実測で主指標が悪化(不採用)し、候補腕は 'prompt-v1e' へ載せ替えた
  //   (server/generator/cycle.ts)。過去の台帳(proposals に残る prompt-v1d 行)を読めるように、
  //   'v1d' は PROMPT_VARIANTS の語彙・normalizePromptVariant・omitMinDistance フラグとしては残す。
  //   腕接続のテスト(planCycleArms が v1e を送ること)は scalpQuestionV1e.test.ts へ移した。
  it('normalizePromptVariant が v1d を受理し、未知は 400 用エラー(v1e も語彙に追加済み)', () => {
    expect(PROMPT_VARIANTS).toEqual(['v1', 'v2', 'v1d', 'v1e']);
    expect(normalizePromptVariant('v1d')).toEqual({ ok: true, variant: 'v1d' });
    expect(normalizePromptVariant('v1c').ok).toBe(false);
  });

  it('★予算の帳簿が v1 と別(先着の腕が取引日の残りを食い切らない)', () => {
    expect(generatorArmKey('current', 'v1d')).toBe('current+v1d');
    expect(generatorArmKey('current', 'v1d')).not.toBe(generatorArmKey('current', 'v1'));
  });

  it('★生成器の候補腕はもう v1d を送らない(v1e に載せ替え済み・v1d は選べるが使われていない)', () => {
    const arms = planCycleArms(0, 1);
    expect(arms.some(a => a.promptVariant === 'v1d'), 'v1d を送る腕が復活している').toBe(false);
    expect(arms.map(a => a.arm)).not.toContain('prompt-v1d');
    // それでも buildScalpQuestion 等は omitMinDistance:true で v1d の質問文を組める(過去台帳の再現用)。
    expect(buildScalpQuestion(55, 159, true, 100, undefined, true)).not.toBe(buildScalpQuestion(55, 159));
  });

  it('★候補の枠は1つのまま(LLM 呼び出し回数=課金を増やしていない)', () => {
    expect(planCycleArms(1, 5)).toHaveLength(2);
    expect(planCycleArms(0, 5)).toHaveLength(3);
  });
});

// ─── ★稼働機(実取引につながる経路)が新変種を使っていないこと ───────────────────────
//
// ★既存のガード(scalpQuestionV2.test.ts)は scalpPlan.ts のソースしか見ておらず、
//   **engine.ts が promptVariant を渡し始めた** 場合を検出できなかった。そこを塞ぐ。
describe('★稼働機は新変種を使わない(engine の3経路)', () => {
  const engineSrc = readFileSync(fileURLToPath(new URL('../signalTrade/engine.ts', import.meta.url)), 'utf8');

  /** `runScalpPlanWithChart(` の **呼び出し** を、括弧の対応を数えて丸ごと切り出す。
   *  ★正規表現の `\{[^}]*\}` では引数に入れ子の `{}`(heldPosition 等)があると途中で切れる。 */
  function callSites(src: string): string[] {
    const out: string[] = [];
    const needle = 'runScalpPlanWithChart(';
    for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
      let depth = 0;
      let j = i + needle.length - 1;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') { depth--; if (depth === 0) break; }
      }
      out.push(src.slice(i, j + 1));
    }
    return out;
  }

  it('engine は runScalpPlanWithChart を3回呼び、どれも promptVariant を渡さない', () => {
    const calls = callSites(engineSrc);
    expect(calls, 'engine の呼び出し数が変わった(3=flat-plan / held-eval / range-reeval)').toHaveLength(3);
    for (const c of calls) {
      expect(c, `稼働機が質問文の変種を渡している: ${c}`).not.toContain('promptVariant');
      expect(c, `稼働機が決済仕様の変種を渡している: ${c}`).not.toContain('exitVariant');
    }
  });

  it('engine のソース全体に promptVariant / exitVariant が1度も現れない', () => {
    expect(engineSrc).not.toContain('promptVariant');
    expect(engineSrc).not.toContain('exitVariant');
  });

  it('★既定は v1 = 稼働機が渡さない限り従来の質問文', () => {
    expect(DEFAULT_PROMPT_VARIANT).toBe('v1');
    expect(normalizePromptVariant(undefined)).toEqual({ ok: true, variant: 'v1' });
  });

  it('★omitMinDistance を立てる分岐は scalpPlan.ts の1箇所だけ(無条件で立っていない)', () => {
    const src = readFileSync(fileURLToPath(new URL('./scalpPlan.ts', import.meta.url)), 'utf8');
    const lines = src.split('\n')
      .filter(l => l.includes('omitMinDistance =') && !l.includes('omitMinDistance = false'));
    expect(lines, 'omitMinDistance を立てる箇所は1つだけ').toHaveLength(1);
    expect(lines[0]!).toContain(`promptVariant === 'v1d'`);
  });
});
