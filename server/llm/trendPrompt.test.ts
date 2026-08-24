import { describe, it, expect } from 'vitest';
import { buildTrendSystemPrompt, buildTrendUserPrompt, parseTrendAnswer, A_ANSWER_HEADING } from './trendPrompt.js';
import { buildTrendContext, buildOrderContext, TREND_CONTEXT_FORBIDDEN } from './abContext.js';
import type { AlertRow } from '../db/store.js';
import type { LevelsResult } from '../levels.js';

// ★段3(v0.9.99): A(目線だけを尋ねる呼び出し)のプロンプトと、A/B の文脈の振り分け。
//
// 何を守っているか:
//   ① ★A に **注文の語が1文字も無い**(禁止語をテストで固定)
//   ② ★A は必ず答える(見送りが無い)。3語のどれでもなければ null=呼び出し側が aFailed にする
//   ③ ★理由が空でも目線が返れば成立(ユーザー指示)
//   ④ ★A ⊂ B: A に在って B に無いものが1つも無い / 節目・アラート・長期高安は A に出ない
//   ⑤ ★A に「こちらの作業」(丸め・5円ずらし・側の検査)を1文字も書かない

const PROMPT = (): string => buildTrendSystemPrompt('【ここにデータが入る】') + buildTrendUserPrompt();

/** ★A に出てはいけない語(注文・価格・こちらの作業)。 */
const FORBIDDEN = [
  '指値', '逆指値', '損切', '幅', 'エントリー', '注文', '丸め', '5円', '刻み',
  'stopEntry', 'limitEntry', 'lcWidth', 'none', 'aPrice', 'iPrice',
  'アラート', 'ニュース', 'ツール', '節目', '建玉', '発注', 'ロット', '枚',
  // ★v0.9.90(ユーザー指示): A では 買い/売り の用語を用いない
  '買い', '売り', 'buy', 'sell',
] as const;

describe('① ★A のプロンプトに注文の語が1文字も無い', () => {
  it('禁止語がすべて 0 回', () => {
    const t = PROMPT();
    const hits = FORBIDDEN.map(w => [w, t.split(w).length - 1] as const).filter(([, n]) => n > 0);
    expect(hits).toEqual([]);
  });

  it('⑤ ★「こちらの作業」も書かない(価格の調整はコードの仕事なので A は知らなくてよい)', () => {
    const t = PROMPT();
    for (const w of ['丸め', '刻み', '調整', '検算', '不等式', '現在値より']) expect(t).not.toContain(w);
  });

  it('★答えの語は bull / bear / range(注文の side の語を使わない)', () => {
    const t = PROMPT();
    expect(t).toContain('bull');
    expect(t).toContain('bear');
    expect(t).toContain('range');
    expect(t).toContain('ブル');
    expect(t).toContain('ベア');
    expect(t).toContain('レンジ');
  });

  it('★見送り(none)の選択肢が無い(A は必ず答える)', () => {
    expect(PROMPT()).not.toContain('none');
    expect(PROMPT()).not.toContain('見送');
  });

  it('★裸の数字を全部数える(判定のしきい値は1つも無い)', () => {
    // 225 = 銘柄名 / 3 = 選択肢の数 / 1 = 「3つから1つ選びます」の1。
    // ★どれも相場の規則ではない=A に新しい閾値を1つも書いていない。
    const nums = new Set((PROMPT().match(/\d+/g) ?? []));
    expect([...nums].sort()).toEqual(['1', '225', '3'].sort());
  });

  it('★データはプレースホルダの位置にそのまま入る', () => {
    expect(buildTrendSystemPrompt('XYZ-DATA')).toContain('【データ】\nXYZ-DATA');
  });
});

describe('②③ ★A の応答パース', () => {
  it('3語をそれぞれ読める(大文字・前後空白も許す)', () => {
    expect(parseTrendAnswer('{"direction":"bull","why":"高値切り上げ"}')).toEqual({ direction: 'bull', why: '高値切り上げ' });
    expect(parseTrendAnswer('{"direction":" BEAR "}')).toEqual({ direction: 'bear' });
    expect(parseTrendAnswer('```json\n{"direction":"range","why":"どちらとも言えない"}\n```'))
      .toEqual({ direction: 'range', why: 'どちらとも言えない' });
  });

  it('③ ★理由が無くても目線が返れば成立(why は付かないだけ)', () => {
    const r = parseTrendAnswer('{"direction":"bull"}');
    expect(r).toEqual({ direction: 'bull' });
    expect(parseTrendAnswer('{"direction":"bull","why":"   "}')).toEqual({ direction: 'bull' });
  });

  it('② ★3語のどれでもなければ null(呼び出し側が aFailed にできる)', () => {
    for (const bad of [
      '{"direction":"buy"}', '{"direction":"none"}', '{"direction":""}',
      '{"direction":123}', '{}', 'こんにちは', '', '{壊れ',
    ]) expect(parseTrendAnswer(bad)).toBeNull();
  });

  it('★契約に無いキーは拾わない(価格や側が紛れ込まない)', () => {
    const r = parseTrendAnswer('{"direction":"bull","why":"x","limitEntry":38000,"side":"buy"}');
    expect(Object.keys(r!).sort()).toEqual(['direction', 'why']);
  });
});

// ─── ④ A ⊂ B の文脈振り分け ────────────────────────────────────────────────
const MIN = 60_000;
const bars = (n: number, t0 = Date.UTC(2026, 7, 20, 3, 0)): Array<{ t: number; o: number; h: number; l: number; c: number }> =>
  Array.from({ length: n }, (_, i) => ({ t: t0 + i * MIN, o: 39000 + i, h: 39010 + i, l: 38990 + i, c: 39005 + i }));

const LEVELS = {
  up: [{ price: 39500, score: 3.2, tier: 2, kinds: ['sessHL'], labels: ['前日高値'] }],
  down: [{ price: 38500, score: 2.8, tier: 2, kinds: ['sessHL'], labels: ['前日安値'] }],
  asOf: Date.UTC(2026, 7, 20, 3, 0),
} as unknown as LevelsResult;

const ALERTS = [{
  id: 1, triggered_at: Date.UTC(2026, 7, 20, 2, 55), symbol: 'NIY=F', detection_kind: 'break',
  window_seconds: 300, price: 39100, direction: 'up', ret5: 0.1, ret15: 0.2, ret30: 0.3,
}] as unknown as AlertRow[];

const dailyCloses = Array.from({ length: 80 }, (_, i) => 39000 + i * 10);
const dailyBars = Array.from({ length: 80 }, (_, i) => ({
  sessionDate: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
  open: 39000 + i * 10, high: 39050 + i * 10, low: 38950 + i * 10, close: 39005 + i * 10,
}));

const INPUT = {
  market: {
    bars: bars(120), levels: LEVELS, alerts: ALERTS,
    now: Date.UTC(2026, 7, 20, 5, 0), currentPrice: 39100, indicatorsEnabled: true,
  },
  basedata: { dailyCloses, dailyBars, currentPrice: 39100 },
};

describe('④ ★A ⊂ B(文脈の振り分け)', () => {
  it('★節目・アラート・長期高安 は A に1文字も出ない', () => {
    const a = buildTrendContext(INPUT);
    for (const w of TREND_CONTEXT_FORBIDDEN) expect(a).not.toContain(w);
    expect(a).not.toContain('前日高値');   // 節目のラベルそのもの
  });

  it('★同じものは B には出る(消したのではなく「A に渡していない」)', () => {
    const b = buildOrderContext(INPUT);
    for (const w of TREND_CONTEXT_FORBIDDEN) expect(b).toContain(w);
    expect(b).toContain('前日高値');
  });

  it('★A に在って B に無い行は1つも無い(A ⊂ B)', () => {
    const aLines = buildTrendContext(INPUT).split('\n').filter(l => l.trim().length > 0);
    const bText = buildOrderContext(INPUT);
    const notInB = aLines.filter(l => !bText.includes(l));
    expect(notInB).toEqual([]);
  });

  it('★A にもトレンド判断の材料は全部ある(削りすぎていない)', () => {
    const a = buildTrendContext(INPUT);
    for (const w of ['直近の足', 'ボラ/レンジ', '直近スイング', 'セッション/時刻',
      'テクニカル指標', '長い時間軸', '基礎データ', '日足MA', '日足バンド', '日足OHLC']) {
      expect(a).toContain(w);
    }
  });

  it('★A のほうが必ず短い(渡す材料が少ない)', () => {
    expect(buildTrendContext(INPUT).length).toBeLessThan(buildOrderContext(INPUT).length);
  });

  it('★材料が空でも壊れない(取引時間外・DB無しでも A/B とも文字列を返す)', () => {
    const empty = {
      market: { bars: [], levels: null, alerts: [], now: INPUT.market.now, currentPrice: 39100 },
      basedata: { dailyCloses: [], dailyBars: [], currentPrice: 39100 },
    };
    expect(buildTrendContext(empty)).toContain('取得できず');
    expect(buildOrderContext(empty)).toContain('取得できず');
  });
});

// ★段6(2026-08-22): B に足した「足りなかったデータ」の1文/missingData フィールドは、
//   A の system/user プロンプト(buildTrendSystemPrompt/buildTrendUserPrompt)には一切足していない
//   (A は別ファイル/別関数で、変更対象にしていない=構造的に混ざりようがないことをここで固定する)。
describe('★段6: A には「足りなかったデータ」の文言/missingData を足していない', () => {
  it('A の system/user プロンプトに該当の文言が無い', () => {
    const sys = buildTrendSystemPrompt('【データ】ダミー');
    const usr = buildTrendUserPrompt();
    expect(sys).not.toContain('判断に必要なデータが足りなかった');
    expect(usr).not.toContain('判断に必要なデータが足りなかった');
    expect(usr).not.toContain('missingData');
  });
});

// ★エバリュエーター指摘E(2026-08-22): 「下」の位置語が「下降トレンド」の「下」と衝突していた
//   (「外側」の事故と同じ型)。位置語を「次に」へ変えて衝突を解消したことを固定する。
describe('★エバリュエーター指摘E: 位置語と方向語の衝突を解消', () => {
  it('system プロンプトの1行目に位置語「下」が使われていない(「下降トレンド」とは別の語)', () => {
    const sys = buildTrendSystemPrompt('【データ】ダミー');
    const firstTwoLines = sys.split('\n').slice(0, 2).join('\n');
    expect(firstTwoLines).not.toContain('下に');
    expect(firstTwoLines).toContain('次に与えたデータ');
  });

  it('「下降トレンド」という語自体は残っている(3択の説明として必要)', () => {
    const sys = buildTrendSystemPrompt('【データ】ダミー');
    expect(sys).toContain('下降トレンド');
  });
});

// ★2026-08-24(ユーザー指示): range の扱いを **反転** した。
//   旧「トレンドに確信が持てないときは range としてください」= 迷ったら range。
//   新「range は…形がはっきり見えているときに選びます / それ以外は bull か bear」。
//   ■ 反転の理由(実測): v0.9.96 で分割が実走した21件は **A が21件すべて range**(100%)で、
//     レンジ不許可の運用なので B を1度も呼ばず全件見送りになっていた。
//   ■ ★このブロックが守るのは「書き方の規約」であって、AI の答えの分布ではない
//     (分布は実運用でしか測れない=いまは未測定)。
describe('★2026-08-24: range を「確信できるとき限定」へ反転', () => {
  const sys = (): string => buildTrendSystemPrompt('【データ】ダミー');

  it('★「迷ったら range」の文が消えている(反転が実際に入っている)', () => {
    expect(sys()).not.toContain('確信が持てないとき');
  });

  it('★range を選ぶ条件が **肯定形で1つだけ** 書かれている', () => {
    expect(sys()).toContain('range を選ぶのは、同じ値段の範囲を行き来する形がはっきり見えているときだけです。');
    // 「レンジにしすぎるな」のような否定形の指示は書かない(否定文の中の語を AI が拾う実測がある)。
    expect(sys()).not.toContain('しすぎ');
    expect(sys()).not.toContain('range にしないで');
  });

  it('★それ以外は必ず bull か bear を出させる(A は見送れない性質は不変)', () => {
    expect(sys()).toContain('それ以外は、直近の値動きが向かっているほうを bull か bear で答えてください。');
    expect(sys()).not.toContain('none');
    expect(sys()).not.toContain('見送');
  });

  it('★「確信度」の自己申告を求めていない(別の固着を作らない)', () => {
    const t = PROMPT();
    for (const w of ['確信度', '確率', '自信', 'confidence', 'スコア', '%']) expect(t).not.toContain(w);
  });

  it('★新しい数値(しきい値)を1つも足していない(裸の数字は反転前と同じ3つだけ)', () => {
    const nums = new Set((PROMPT().match(/\d+/g) ?? []));
    expect([...nums].sort()).toEqual(['1', '225', '3'].sort());
  });

  it('★「幅」は A の禁止語なので使っていない(語彙の衝突を作らない)', () => {
    expect(sys()).not.toContain('幅');
    expect(sys()).toContain('範囲');
  });
});

// ★2026-08-24(第2版・エバリュエーター指摘): **選択肢の語釈が旧の定義のまま残っていた。**
//   実運用の a_why 41件は例外なく「トレンドが明確ではない → range」の形で、
//   `トレンドが無いと判断した` という **語釈そのままの文字列** が繰り返し現れていた(実例3件)。
//   モデルは語釈を逐語で反復するので、条件文だけ直しても反転は効かない。
describe('★2026-08-24(第2版): 選択肢の語釈も反転させる', () => {
  const sys = (): string => buildTrendSystemPrompt('【データ】ダミー');

  it('★range の語釈から「トレンドが無い」が消えている(旧の逃げ道を残さない)', () => {
    expect(sys()).not.toContain('トレンドが無い');
    expect(sys()).toContain('range … 同じ値段の範囲を行き来している(レンジ)');
  });

  it('★条件文が排他形(「〜ときだけです」)である(許可形では慎重寄りのモデルが range を選び続けられる)', () => {
    expect(sys()).toContain('だけです。');
    expect(sys()).not.toContain('ときに選びます。');
  });

  it('★bull / bear の語釈は変えていない(直したのは range の側だけ)', () => {
    expect(sys()).toContain('bull  … 上昇トレンド(ブル)がある');
    expect(sys()).toContain('bear  … 下降トレンド(ベア)がある');
  });

  it('★第2版でも 裸の数字は 225 / 3 / 1 のまま・注文の語0件・確信を測らせる語0件', () => {
    const t = PROMPT();
    expect([...new Set(t.match(/\d+/g) ?? [])].sort()).toEqual(['1', '225', '3'].sort());
    for (const w of FORBIDDEN) expect(t.split(w).length - 1, `禁止語「${w}」が出ている`).toBe(0);
    for (const w of ['確信', '確率', '自信', 'confidence', 'スコア', '%']) expect(t).not.toContain(w);
  });
});

// ★2026-08-24(第3版): **問いの立て方** も反転させる。
//
// ■ なぜ(語釈と同じ根)
//   語釈を `range … 同じ値段の範囲を行き来している(レンジ)` に直しても、問いが
//   「トレンドが **あるか・無いか**」の二分のままなら、モデルは「無い → range」という
//   旧い経路に戻れる。★実データの a_why 41件は例外なくその形だった
//   (「トレンドが明確ではない → よって range」)。
//   逃げ道を1つ塞いで隣にもう1つ開けたままにしない。
//
// ■ ★表を持つ設計は項目を足すと無言で漏れる(この案件で繰り返し出ている型)
//   ここは **逆向き** に使う: 「有無の二分に戻す語」を表(BINARY_FRAMING)に列挙し、
//   1語でも本文に現れたら赤くする。問いが旧に戻れば必ず気づける。
//   ★語を足すのは1行なので、将来の言い回しにも追随しやすい。
describe('★2026-08-24(第3版): 問いを「有無の二分」から「どう動いているか」へ', () => {
  /** ★range を「無い・弱い・読めない」の受け皿にする語の表。1語でも本文に現れたら赤。
   *
   *  ■ ★表の作り方(2026-08-24・エバリュエーター指摘②)
   *    最初の表は「私が消したばかりの文字列」だけを並べており、**1字違いが素通りした**
   *    (`トレンドなし` / `明確なトレンドが見られない` / `不明瞭` / `確認できなければ` /
   *     `トレンドが弱い` / `方向感が乏しい` の6本)。
   *    ★とくに深刻なのは、素通りした語彙が **モデル自身が書いた語彙** だという点:
   *      次に文面を書き直す人は a_why を読んでから書くので、最も再導入されやすい。
   *    ★よって表は **実運用の a_why を読んで作る**。
   *
   *  ■ 実測(2026-08-24・prices_kabu.db の複製 / signal_plans 2,511件 / a_why 47件)
   *      明確ではない 8件 / 見られな 8件 / 確認できな 7件 / トレンドが無い 7件 /
   *      明確なトレンド 6件 / 不明瞭 5件 / トレンドがない 3件 / 明確な方向 3件 /
   *      方向感 2件 / 明確でない 1件 / トレンドが形成され 1件
   *      「トレンドを否定して消去する形」を含む a_why … 37件 / 47件
   *    ★`レンジ`(33件)・`横ばい`(25件)は **肯定的な状態の記述** なので表に入れない
   *      (`横ばい` は range を肯定形で書くときに使える語=禁じると直しようがなくなる)。 */
  const BINARY_FRAMING = [
    // ① 旧の問い(2026-08-24 に消した形)
    'トレンドがあるか', 'トレンドはありますか', 'トレンドはあるか', 'あるならどちら',
    'トレンドの有無', 'あるかないか', 'あるか無いか',
    // ② 旧の語釈と、その1字違い
    'トレンドが無い', 'トレンドがない', 'トレンドなし', 'トレンドは無い', 'トレンドはない',
    // ③ ★モデルが実際に使った「消去」の語彙(a_why 47件から)
    '明確ではない', '明確でない', '明確な方向', '見られな', '見当たらな', '確認できな',
    '不明瞭', '方向感', '乏しい', 'トレンドが弱い', 'トレンドは弱い',
    '形成されていない', '形成されな',
    // ④ 同じ型の言い回し(未出現だが再導入されやすい)
    '判断できな', '定まらな', 'はっきりしない', 'はっきりせず', '読み取れな',
    'どちらとも言えな', '中立', '決め手に欠け',
  ] as const;

  /** ★表を「攻撃する」ための退行候補。★**表を読むだけでは穴は見つからない**(実証済み)。
   *  ①〜⑥ は実際に素通りした6本、⑦⑧ は 2026-08-24 に消した旧の2行。 */
  const REGRESSION_CANDIDATES = [
    'range … トレンドなし(レンジ)',
    '明確なトレンドが見られない場合は range としてください。',
    'トレンドが不明瞭なら range を選んでください。',
    'トレンドが確認できなければ range。',
    'トレンドが弱い場合は range です。',
    'range … 方向感が乏しい(レンジ)',
    '次に与えたデータだけを見て、いまトレンドがあるか、あるならどちらかを答えてください。',
    'いまトレンドはありますか。あるならどちらですか。理由も教えてください。',
  ] as const;

  it('★有無の二分に戻す語が1つも無い(system + user 全文)', () => {
    const t = PROMPT();
    const hits = BINARY_FRAMING.map(w => [w, t.split(w).length - 1] as const).filter(([, n]) => n > 0);
    expect(hits).toEqual([]);
  });

  it('★★表を攻撃する: 退行候補が1本残らず捕まる(この検査が穴を見つけた)', () => {
    const missed = REGRESSION_CANDIDATES.filter(c => !BINARY_FRAMING.some(w => c.includes(w)));
    expect(missed).toEqual([]);
  });

  it('★検査が恒真に化けていない(表が空でない・候補が空でない)', () => {
    expect(BINARY_FRAMING.length).toBeGreaterThan(0);
    expect(REGRESSION_CANDIDATES.length).toBeGreaterThan(0);
    // ★いまの本文は候補のどれとも一致しない=候補が「常に捕まる無害な文字列」ではないことの確認。
    const t = PROMPT();
    for (const c of REGRESSION_CANDIDATES) expect(t).not.toContain(c);
  });

  it('★肯定的な状態の記述は禁じていない(range を書き直す余地を残す)', () => {
    for (const w of ['横ばい', 'レンジ', '行き来', '範囲']) {
      expect(BINARY_FRAMING.some(b => w.includes(b) || b.includes(w)), `「${w}」を禁じている`).toBe(false);
    }
  });

  it('★新しい問いの形になっている(system / user の両方)', () => {
    expect(buildTrendSystemPrompt('【データ】ダミー')).toContain('いまの相場がどう動いているかを答えてください。');
    expect(buildTrendUserPrompt()).toContain('いまの相場はどう動いていますか。');
  });

  it('★第3版でも 裸の数字は 225 / 3 / 1 のまま・注文の語0件・確信を測らせる語0件・否定文ゼロ', () => {
    const t = PROMPT();
    expect([...new Set(t.match(/\d+/g) ?? [])].sort()).toEqual(['1', '225', '3'].sort());
    for (const w of FORBIDDEN) expect(t.split(w).length - 1, `禁止語「${w}」が出ている`).toBe(0);
    for (const w of ['確信', '確率', '自信', 'confidence', 'スコア', '%']) expect(t).not.toContain(w);
    for (const w of ['ないとき', 'ないなら', 'しないで', 'ではない']) expect(t).not.toContain(w);
  });

  it('★選択肢(bull/bear)の語釈は触っていない(直したのは range 側と問いだけ)', () => {
    const sys = buildTrendSystemPrompt('【データ】ダミー');
    expect(sys).toContain('bull  … 上昇トレンド(ブル)がある');
    expect(sys).toContain('bear  … 下降トレンド(ベア)がある');
    expect(sys).toContain('range … 同じ値段の範囲を行き来している(レンジ)');
  });

  // ★④(エバリュエーター指摘): A のプロンプトの目印は SSOT 側で固定する。
  it('★A_ANSWER_HEADING が本文に必ず現れる(他ファイルの目印がずれない)', () => {
    expect(buildTrendSystemPrompt('【データ】ダミー')).toContain(A_ANSWER_HEADING);
    expect(A_ANSWER_HEADING.length).toBeGreaterThan(0);
  });
});
