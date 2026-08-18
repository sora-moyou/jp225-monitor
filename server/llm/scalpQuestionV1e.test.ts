// ─── ★v1e 質問文(= v1 マイナス「指値・ブレイク新規の距離の上限」) ────────────────────────
//
// ■ 何を測る腕か
//   v1d(= v1 マイナス「現在値から最低50円離す」)を1日走らせ、同一 epoch+cycle の対応ペア209件で
//   実測した結果、**主指標(両レッグ同幅率)が悪化**した(current 76.4% → v1d 84.7%。距離<50 の割合も
//   58.4%→66.4%[McNemar p=0.0037]・距離の中央値 40円→30円・LC幅=55固着 36.1%→44.3%)。
//   ⇒「最低距離50円」の記述は、コードの強制(10円)とは別に「置き方の誘導」として効いていた。
//     消すと逆効果=不採用。**この記述は残す**。
//
//   v0.9.83 で「死んだ記述だけ」(range無効時の距離規則・委任時の「自動見送り」の一文)を消したところ、
//   v1 自身が改善した可能性がある観測(距離<50 が 72〜77% → 58.4%、距離の中央値 25円 → 40円)がある
//   が、日をまたいだ比較で交絡しており断定できない。
//   仮説: 競合する距離の**上限**の数値(片レッグ200円/両レッグ幅400円)が、生きている距離規則
//   (節目からの5〜10円)を押しのけていた。
//   ⇒ v1e は「距離の **上限** の記述だけを外したら、AI はどう変わるか」を1変数で測る腕。
//     改善するなら「競合する数値が押しのけていた」を支持/悪化するならその数値も誘導として
//     働いていたことになる=どちらでも情報になる。
//
// ■ このテストが固定する不変条件
//   (1) v1 と v1e の差分は **距離の上限の記述だけ**(行差分で実証する)
//   (2) 最低距離50円(v1d で悪化と決着済み)は v1e でも残る(同時に2つ動かさない)
//   (3) 距離の上限の3箇所(質問文② / system prompt / strategySpec)が **同時に** 消える
//   (4) range 専用の距離規則(上下2本400円/片面200円)は既に rangeEnabled で条件化済みで対象外
//       (触っていない=range が別に持つ規則)
//   (5) 稼働機は v1e を使わない(engine の3経路は promptVariant を1度も渡さない・既存ガードが担保)
//   (6) v1d は変種として今も選べる(過去の台帳を読める)が、候補腕はもう v1d を送らない
//   (7) ★バンドウォーク注記(buildBandwalkNote)の「距離の上限(200/400円)は一切変わらない」という
//       **参照** も、本則(3箇所)が消えると宛先を失うので、omitMaxDistance で同時に整合させる。
//       これは v1d のときの「①の免除文」「も→は」と同型の欠陥(存在しない規則を AI に説明しない)。
//       ★v1 側のバンドウォーク注記は HEAD と byte 一致のまま(200/400円は v1 では生きているため正しい)。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildScalpQuestion, buildScalpSystemPrompt, buildStrategySpec, buildBandwalkNote,
} from './scalpPlan.js';
import {
  PROMPT_VARIANTS, DEFAULT_PROMPT_VARIANT, normalizePromptVariant, generatorArmKey,
} from './promptVariant.js';
import { planCycleArms } from '../generator/cycle.js';
import type { Bandwalk } from '../bandwalk.js';

const BW: Bandwalk = {
  direction: 'up', ratio: 0.8, bars: 12, sinceT: 0, t: 3_600_000, close: 42_000, band: 41_900, rsi: 62.5,
};

const FLOOR = 55;
const CEIL = 159;

/** v1(既定)の質問文。 */
const Q1 = (): string => buildScalpQuestion(FLOOR, CEIL);
/** v1e の質問文(距離の上限の記述だけを落とす)。omitMinDistance は false のまま(最低距離は残す)。 */
const Q1E = (): string => buildScalpQuestion(FLOOR, CEIL, true, 100, undefined, false, true);

const SPEC_IN = (omitMaxDistance: boolean) => ({
  floor: { mode: 'manual' as const, value: FLOOR },
  ceiling: { mode: 'manual' as const, value: CEIL },
  trendVeto: { mode: 'manual' as const, value: 100 },
  cooldown: { mode: 'manual' as const, value: 15 },
  bias: { mode: 'manual' as const, value: 'none' as const },
  range: { mode: 'manual' as const, value: true },
  hardMax: { enabled: false, value: 200 },
  exitDesc: '(決済の説明・この検証では固定文)',
  omitMaxDistance,
});

describe('v1e 質問文 — v1 との差分は「距離の上限の記述」1点だけ', () => {
  it('★行差分: 動くのは1段落だけで、その段落は「距離の上限」の一文に尽きる(空行は増えない)', () => {
    const a = Q1().split('\n');
    const b = Q1E().split('\n');
    const onlyA = a.filter(l => !b.includes(l));
    const onlyB = b.filter(l => !a.includes(l));

    // v1 側にだけ在る行は「距離の上限」の一文だけ(range の距離規則は別文言で残るので巻き込まない)。
    expect(onlyA).toEqual([
      '★【指値・ブレイク新規の距離(必須)】両方を出すときは現在値がその2つの価格の間に入るように置き(上の不等式のとおり)、'
      + '指値とブレイク新規の価格差[両者の幅]は400円以内にする=幅が広すぎる両面は出さない。'
      + '片方だけ[指値のみ/ブレイク新規のみ]を出すときは、その1本を向き通りに置いた上で現在値から200円以内に収める'
      + '[200円超離れた片レッグは出さない=約定不能・古い価格になりやすいため]。',
    ]);
    // v1e 側で新しく増えた行は無い(段落そのものが消えるだけ=文言の置換ではない)。
    expect(onlyB).toEqual([]);
    // 段落の前後の空行は1つに畳まれる(2行減るだけ・トリプル改行は作らない)。
    expect(a.length - b.length).toBe(2);
    expect(Q1E()).not.toMatch(/\n\n\n/);
  });

  it('★v1e に「距離の上限(必須)」ブロックが1文字も残っていない', () => {
    expect(Q1E()).not.toContain('★【指値・ブレイク新規の距離(必須)】');
    expect(Q1E()).not.toContain('価格差[両者の幅]は400円以内にする');
    expect(Q1E()).not.toContain('現在値から200円以内に収める');
    // v1 には在る(=否定対照。テストが常に真になっていない)。
    expect(Q1()).toContain('★【指値・ブレイク新規の距離(必須)】');
  });

  it('★最低距離50円は v1e でも残る(v1d の実測で悪化=効いていると決着済み・同時に2つ動かさない)', () => {
    for (const q of [Q1(), Q1E()]) {
      expect(q).toContain('少なくとも50円以上離すこと');
      expect(q).toContain('最低距離');
    }
  });

  it('★range 専用の距離規則(上下2本400円/片面200円)は触っていない(rangeEnabled で別に条件化済み)', () => {
    for (const q of [Q1(), Q1E()]) {
      expect(q).toContain('上と下の価格差を400円以内にする(幅が広すぎるレンジは出さない)');
      expect(q).toContain('片方だけのレンジは その1本を現在値から200円以内に置く');
    }
  });

  it('★他の規則は1バイトも動いていない(向き・LC下限・自己検算・節目の置き方)', () => {
    const q = Q1E();
    expect(q).toContain('買い: limitEntry < refPrice < stopEntry');
    expect(q).toContain('★【最優先: 損切りの幅(無条件・例外なし)】');
    expect(q).toContain(`${FLOOR}円以上`);
    expect(q).toContain('★【出力前の自己検算(必須)】');
    expect(q).toContain('指値は節目から 5〜10円 内側');
    expect(q).toContain('その引き算をそのまま書くこと');
  });

  it('★既定(引数省略)は v1 と byte 一致 = 稼働機の質問文は動かない', () => {
    expect(buildScalpQuestion(FLOOR, CEIL, true, 100, undefined, false, false)).toBe(Q1());
    expect(buildScalpQuestion(FLOOR, CEIL)).toBe(Q1());
  });
});

describe('v1e — 距離の上限は(range 以外の)2箇所すべてから同時に消える', () => {
  it('system prompt: 【指値・ブレイク新規の距離(必須)】の箇条書きが行ごと消える(空行を作らない)', () => {
    const on = buildScalpSystemPrompt(FLOOR, CEIL, true, 100, false, undefined, false);
    const off = buildScalpSystemPrompt(FLOOR, CEIL, true, 100, false, undefined, true);
    expect(on).toContain('★【指値・ブレイク新規の距離(必須)】');
    expect(off).not.toContain('★【指値・ブレイク新規の距離(必須)】');
    // 落としたのは1行ぶんだけ(bullet 単位。区切りの空行は元から無い箇条書きなので増減しない)。
    expect(on.split('\n').length - off.split('\n').length).toBe(1);
    expect(off).not.toContain('\n\n\n');
    // 最低距離とrangeの距離規則はここでは system prompt に無い(元から buildScalpQuestion / strategySpec の役割)。
    // range 専用の距離規則(rangeLine)は残る。
    for (const s of [on, off]) {
      expect(s).toContain('上と下の価格差を400円以内にする(幅が広すぎるレンジは出さない)');
    }
  });

  it('strategySpec: 距離の上限の箇条書きが行ごと消える(空行を作らない)', () => {
    const on = buildStrategySpec(SPEC_IN(false));
    const off = buildStrategySpec(SPEC_IN(true));
    expect(on).toContain('★指値・ブレイク新規の距離(必須): 両方を出すときは');
    expect(off).not.toContain('★指値・ブレイク新規の距離(必須)');
    // 落としたのは1行ぶんだけ。空行は増えない(join('\n') に '' を混ぜていない)。
    expect(on.split('\n').length - off.split('\n').length).toBe(1);
    expect(off).not.toContain('\n\n');
    // 最低距離の行は残る(v1d の実測により残す)。
    expect(off).toContain('最低 50円 離す');
    // range 専用の距離規則(range.value=true のとき)は残る。
    expect(off).toContain('★レンジの距離: 上下2本');
  });

  it('★既定(引数省略/false)は従来と byte 一致', () => {
    expect(buildScalpSystemPrompt(FLOOR, CEIL, true, 100)).toBe(buildScalpSystemPrompt(FLOOR, CEIL, true, 100, false, undefined, false));
    const { omitMaxDistance: _drop, ...noFlag } = SPEC_IN(false);
    expect(buildStrategySpec(noFlag)).toBe(buildStrategySpec(SPEC_IN(false)));
  });

  it('★range が無効なときは、そもそも range の距離規則を出さない(既に rangeEnabled で条件化済み=対象外の確認)', () => {
    const sysOff = buildScalpSystemPrompt(FLOOR, CEIL, false, 100, false, undefined, true);
    expect(sysOff).not.toContain('★レンジの距離');
    const q = buildScalpQuestion(FLOOR, CEIL, false, 100, undefined, false, true);
    expect(q).not.toContain('★レンジの距離');
    const spec = buildStrategySpec({ ...SPEC_IN(true), range: { mode: 'manual', value: false } });
    expect(spec).not.toContain('★レンジの距離');
  });

  it('★プロンプトの2ビルダーを合わせても「距離の上限(必須)」の掲載は0件になる(range の距離規則は別文言なので巻き込まない)', () => {
    const all = Q1E() + buildScalpSystemPrompt(FLOOR, CEIL, true, 100, false, undefined, true) + buildStrategySpec(SPEC_IN(true));
    expect(all).not.toContain('指値・ブレイク新規の距離(必須)');
    // 否定対照: v1 側では3件とも在る。
    const allV1 = Q1() + buildScalpSystemPrompt(FLOOR, CEIL, true, 100) + buildStrategySpec(SPEC_IN(false));
    expect(allV1.match(/指値・ブレイク新規の距離\(必須\)/g)?.length).toBe(3);
  });
});

describe('v1e — バンドウォーク注記も整合する(距離の上限への「参照」が宛先を失わない)', () => {
  it('★v1(omitMaxDistance=false・既定)は HEAD と byte 一致 = 「距離の上限は変わらない」は正しい記述のまま', () => {
    const on = buildBandwalkNote(BW, false, false);
    expect(on).toContain('★緩むのはこの2点のみ。損切り(LC)幅の下限・上限・安全上限、【最優先: 価格の向き】の不等式と【最優先: 損切りは「幅」だけを出す】の契約、'
      + '距離の上限(片レッグ200円以内/両レッグ幅400円以内)は **一切変わらない**(そのまま厳守すること)。');
    // 既定(引数省略)でも同じ = 従来と byte 一致。
    expect(buildBandwalkNote(BW)).toBe(on);
    expect(buildBandwalkNote(BW, false)).toBe(on);
  });

  it('★v1e(omitMaxDistance=true)は「距離の上限(200/400円)」への言及だけが消え、他の"変わらないもの"は残る', () => {
    const off = buildBandwalkNote(BW, false, true);
    expect(off).not.toContain('距離の上限');
    expect(off).not.toContain('200円以内');
    expect(off).not.toContain('400円以内');
    // 他の"緩まないもの"の列挙は1バイトも変わらない。
    expect(off).toContain('★緩むのはこの2点のみ。損切り(LC)幅の下限・上限・安全上限、【最優先: 価格の向き】の不等式と【最優先: 損切りは「幅」だけを出す】の契約は **一切変わらない**(そのまま厳守すること)。');
  });

  it('★v1d(omitMinDistance)と v1e(omitMaxDistance)は独立に効く(両方 true でも両方 false でも整合)', () => {
    const both = buildBandwalkNote(BW, true, true);
    expect(both).toContain('次の1点だけを緩めてよい');   // omitMinDistance の効果は健在
    expect(both).not.toContain('距離の上限');             // omitMaxDistance の効果も健在
    expect(both).toContain('★緩むのはこの1点のみ。損切り(LC)幅の下限・上限・安全上限、【最優先: 価格の向き】の不等式と【最優先: 損切りは「幅」だけを出す】の契約は **一切変わらない**(そのまま厳守すること)。');
  });

  it('★プロンプトの3ビルダー(質問文+system prompt+strategySpec)にバンドウォーク注記を足しても、'
    + 'v1e では「距離の上限」系の文言が0件になる', () => {
    const all = Q1E()
      + buildScalpSystemPrompt(FLOOR, CEIL, true, 100, false, undefined, true)
      + buildStrategySpec(SPEC_IN(true))
      + buildBandwalkNote(BW, false, true);
    // ★range 専用の距離規則(「上と下の価格差を400円以内にする」)は正しく残るので、'400円以内' 等の
    //   広い部分一致は使わない(誤検出になる)。「距離の上限」という語自体は、外した規則の掲載
    //   (質問文②・system prompt・strategySpec)とバンドウォーク注記の参照にしか出てこない。
    expect(all).not.toContain('距離の上限');
    expect(all).toContain('上と下の価格差を400円以内にする');   // range の距離規則は残る(対象外の確認)
    // 否定対照: v1 側(バンドウォーク注記含む)では在る。
    const allV1 = Q1() + buildScalpSystemPrompt(FLOOR, CEIL, true, 100) + buildStrategySpec(SPEC_IN(false)) + buildBandwalkNote(BW);
    expect(allV1).toContain('距離の上限(片レッグ200円以内/両レッグ幅400円以内)は **一切変わらない**');
  });
});

describe('v1e — 変種の受け口と腕の接続', () => {
  it('normalizePromptVariant が v1e を受理し、未知は 400 用エラー', () => {
    expect(PROMPT_VARIANTS).toEqual(['v1', 'v2', 'v1d', 'v1e']);
    expect(normalizePromptVariant('v1e')).toEqual({ ok: true, variant: 'v1e' });
    expect(normalizePromptVariant('v1f').ok).toBe(false);
  });

  it('★予算の帳簿が v1 と別(先着の腕が取引日の残りを食い切らない)', () => {
    expect(generatorArmKey('current', 'v1e')).toBe('current+v1e');
    expect(generatorArmKey('current', 'v1e')).not.toBe(generatorArmKey('current', 'v1'));
  });

  it('★生成器の候補腕だけが v1e を送る(①①\'は v1)', () => {
    const arms = planCycleArms(0, 1);
    expect(arms.map(a => a.arm)).toEqual(['current', 'control', 'prompt-v1e']);
    expect(arms.map(a => a.promptVariant)).toEqual(['v1', 'v1', 'v1e']);
    // 決済仕様は3本とも同じ = 動かす変数は質問文だけ。
    expect(new Set(arms.map(a => a.exitVariant))).toEqual(new Set(['current']));
  });

  it('★候補の枠は1つのまま(LLM 呼び出し回数=課金を増やしていない)', () => {
    expect(planCycleArms(1, 5)).toHaveLength(2);
    expect(planCycleArms(0, 5)).toHaveLength(3);
  });
});

// ─── ★稼働機(実取引につながる経路)が新変種を使っていないこと ───────────────────────
describe('★稼働機は新変種を使わない(engine の3経路)', () => {
  const engineSrc = readFileSync(fileURLToPath(new URL('../signalTrade/engine.ts', import.meta.url)), 'utf8');

  it('engine のソース全体に promptVariant / exitVariant が1度も現れない', () => {
    expect(engineSrc).not.toContain('promptVariant');
    expect(engineSrc).not.toContain('exitVariant');
  });

  it('★既定は v1 = 稼働機が渡さない限り従来の質問文', () => {
    expect(DEFAULT_PROMPT_VARIANT).toBe('v1');
    expect(normalizePromptVariant(undefined)).toEqual({ ok: true, variant: 'v1' });
  });

  it('★omitMaxDistance を立てる分岐は scalpPlan.ts の1箇所だけ(無条件で立っていない)', () => {
    const src = readFileSync(fileURLToPath(new URL('./scalpPlan.ts', import.meta.url)), 'utf8');
    const lines = src.split('\n')
      .filter(l => l.includes('omitMaxDistance =') && !l.includes('omitMaxDistance = false'));
    expect(lines, 'omitMaxDistance を立てる箇所は1つだけ').toHaveLength(1);
    expect(lines[0]!).toContain(`promptVariant === 'v1e'`);
  });
});
