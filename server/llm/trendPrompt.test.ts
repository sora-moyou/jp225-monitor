import { describe, it, expect } from 'vitest';
import {
  buildTrendSystemPrompt, buildTrendUserPrompt, parseTrendAnswer, A_ANSWER_HEADING,
  A_FORBIDDEN_WORDS, A_FORBIDDEN_TEMPLATE_ONLY, A_CONTRACT_WORDS, countDirectiveForms,
} from './trendPrompt.js';
import { buildTrendContext, buildOrderContext, TREND_CONTEXT_FORBIDDEN } from './abContext.js';
import type { AlertRow } from '../db/store.js';
import type { LevelsResult } from '../levels.js';

// ★段3(v0.9.99)＋★2026-08-25(v0.9.99・文面をユーザーが全文指定):
//   A(目線だけを尋ねる呼び出し)のプロンプトと、A/B の文脈の振り分け。
//
// 何を守っているか:
//   ① ★A に **注文の語が1文字も無い**(禁止語をテストで固定)
//   ② ★A は必ず答える(見送りが無い)。3語のどれでもなければ null=呼び出し側が aFailed にする
//   ③ ★理由が空でも目線が返れば成立(ユーザー指示)
//   ④ ★A ⊂ B: A に在って B に無いものが1つも無い / 節目・アラート・長期高安は A に出ない
//   ⑤ ★A に「こちらの作業」(丸め・5円ずらし・側の検査)を1文字も書かない
//   ⑥ ★2026-08-25: A は **2版**(レンジ有効=3択 / レンジ無効=2択で range の語ごと消える)

/** レンジ有効の A(system + user)。 */
const PROMPT = (): string => buildTrendSystemPrompt('【ここにデータが入る】', true) + buildTrendUserPrompt(true);
/** ★レンジ無効の A。 */
const PROMPT_NR = (): string => buildTrendSystemPrompt('【ここにデータが入る】', false) + buildTrendUserPrompt(false);

/** ★A に出てはいけない語。★**表は trendPrompt.ts の SSOT を見る**(2026-08-24 第3次)。
 *
 *  ■ なぜ SSOT にしたか(実際にズレた)
 *    aFullTextForbidden.test.ts(実際に送る全文を数える検査)を新設したとき、ここの27語から
 *    16語を落とした表を作ってしまい、アラート・ニュース・仮想取引の成績・ツール・買い/売り の
 *    混入を **全部素通り** させた(エバリュエーターが実文を注入して実証)。
 *    ★表を2つ持つと片方だけ育つ。1つにして両方のテストが同じものを見る。
 *  ■ ここ(テンプレート側)は `A_FORBIDDEN_TEMPLATE_ONLY`(=`5円`)も足して数える。
 *    価格文字列と部分一致する語は全文側では数えられないが、文面が固定のここでは数えられる。 */
const FORBIDDEN = [...A_FORBIDDEN_WORDS, ...A_FORBIDDEN_TEMPLATE_ONLY] as const;

describe('★語の表は SSOT を見る(2つ持たない)', () => {
  it('★旧27語がすべて どちらかの表に残っている(作り直しで項目を落としていない)', () => {
    const LEGACY_27 = [
      '指値', '逆指値', '損切', '幅', 'エントリー', '注文', '丸め', '5円', '刻み',
      'stopEntry', 'limitEntry', 'lcWidth', 'none', 'aPrice', 'iPrice',
      'アラート', 'ニュース', 'ツール', '節目', '建玉', '発注', 'ロット', '枚',
      '買い', '売り', 'buy', 'sell',
    ];
    const covered = [...FORBIDDEN, ...A_CONTRACT_WORDS];
    expect(LEGACY_27.filter(w => !covered.includes(w))).toEqual([]);
  });

  it('★2026-08-25: 「幅」だけが 禁止語 → 契約語 へ移った(それ以外は動かしていない)', () => {
    // ★理由: ユーザー指定の A の文面が range の必要条件として「30分間の値幅」を使う。
    //   ★禁止語のまま残すと検査が恒偽になるので、**テンプレートには出てよい / データ部には出てはいけない**
    //   側(A_CONTRACT_WORDS)へ移した。データ部で0件を求める性質は不変。
    expect(A_CONTRACT_WORDS).toContain('幅');
    expect(A_FORBIDDEN_WORDS).not.toContain('幅');
    // ★損切幅/利幅そのものは依然として禁止(移したのは1語だけ)。
    expect(A_FORBIDDEN_WORDS).toContain('損切');
    expect(A_FORBIDDEN_WORDS).toContain('利幅');
  });

  it('★A/B 振り分け表の禁止語(TREND_CONTEXT_FORBIDDEN)も包含している', () => {
    const notCovered = TREND_CONTEXT_FORBIDDEN.filter(
      w => !FORBIDDEN.some(f => w.includes(f) || f === w));
    expect(notCovered).toEqual([]);
  });

  it('★契約の語は表に入っていない(入れると恒偽になる)', () => {
    for (const w of A_CONTRACT_WORDS) expect(A_FORBIDDEN_WORDS).not.toContain(w);
  });

  it('★表が空でない(検査が恒真に化けていない)', () => {
    expect(A_FORBIDDEN_WORDS.length).toBeGreaterThanOrEqual(26);
  });
});

// ★答えを指定する形: テンプレートは JSON 雛形の **ちょうど1回** だけ(0 にはできない)。
describe('★「答えをこちらが指定する形」の数え方', () => {
  it('テンプレートにはちょうど1回(user の JSON 雛形)', () => {
    expect(countDirectiveForms(PROMPT())).toBe(1);
    expect(countDirectiveForms(PROMPT_NR())).toBe(1);
  });

  it('★コロンの後に空白がある形も数える(旧 literal 4本が取り逃していた穴)', () => {
    expect(countDirectiveForms('{"direction": "none"}')).toBe(1);
    expect(countDirectiveForms('direction:"none"')).toBe(1);
    expect(countDirectiveForms('direction："none"')).toBe(1);
    expect(countDirectiveForms('direction : “none”')).toBe(1);
    expect(countDirectiveForms('方向の話は一切していない')).toBe(0);
  });
});

describe('① ★A のプロンプトに注文の語が1文字も無い', () => {
  it('禁止語がすべて 0 回(レンジ有効/無効の両方)', () => {
    for (const t of [PROMPT(), PROMPT_NR()]) {
      const hits = FORBIDDEN.map(w => [w, t.split(w).length - 1] as const).filter(([, n]) => n > 0);
      expect(hits).toEqual([]);
    }
  });

  it('⑤ ★「こちらの作業」も書かない(価格の調整はコードの仕事なので A は知らなくてよい)', () => {
    for (const t of [PROMPT(), PROMPT_NR()]) {
      for (const w of ['丸め', '刻み', '調整', '検算', '不等式', '現在値より']) expect(t).not.toContain(w);
    }
  });

  it('★★答えの語は buy / sell / range(2026-08-25 にユーザーが文面で指定)', () => {
    const t = PROMPT();
    expect(t).toContain('buy(ブル)');
    expect(t).toContain('sell(ベア)');
    expect(t).toContain('range(レンジ)');
    // ★旧の語(bull/bear)はもう1文字も無い=印字していない語は返ってこない前提が成り立つ。
    expect(t).not.toContain('bull');
    expect(t).not.toContain('bear');
  });

  it('★★buy/sell は「A の答えの語」であって注文の語ではない(日本語の買い/売りは禁止のまま)', () => {
    // ★綴りが注文の side と同じになったが、A に注文の話を持ち込ませない性質は
    //   日本語側('買い'/'売り'/'指値'/'逆指値'…)の禁止で維持している。
    for (const t of [PROMPT(), PROMPT_NR()]) {
      for (const w of ['買い', '売り', '指値', '逆指値', '注文']) expect(t).not.toContain(w);
    }
    expect(A_FORBIDDEN_WORDS).toContain('買い');
    expect(A_FORBIDDEN_WORDS).toContain('売り');
    expect(A_FORBIDDEN_WORDS).not.toContain('buy');
    expect(A_CONTRACT_WORDS).toContain('buy');
    expect(A_CONTRACT_WORDS).toContain('sell');
  });

  it('★見送り(none)の選択肢が無い(A は必ず答える)', () => {
    for (const t of [PROMPT(), PROMPT_NR()]) {
      expect(t).not.toContain('none');
      expect(t).not.toContain('見送');
    }
  });

  it('★データはプレースホルダの位置にそのまま入る(2版とも)', () => {
    expect(buildTrendSystemPrompt('XYZ-DATA', true)).toContain('【データ】\nXYZ-DATA');
    expect(buildTrendSystemPrompt('XYZ-DATA', false)).toContain('【データ】\nXYZ-DATA');
  });
});

// ═══ ★2026-08-25: 文面はユーザーが全文を指定した(SSOT) ══════════════════════
describe('★2026-08-25: A の system がユーザー指定文面と1行ずつ一致する', () => {
  const HEAD = 'あなたは日経225先物(NIY=F)のスキャルピング/デイトレードを専門とするトレーダーです。';
  const ASK = '渡されたデータを使い、現在の相場の方向を判断し、その理由を教えてください。';
  const TAIL = '- 渡されたデータやテクニカル指標と、それから得られる事柄のみを根拠にする。';

  it('(1) レンジ有効: 3択 + range の必要条件の行', () => {
    expect(buildTrendSystemPrompt('<<D>>', true).split('\n')).toEqual([
      HEAD, ASK, '', '制約:',
      '- 返すのは現在の相場の方向 buy(ブル) / sell(ベア) / range(レンジ) のいずれか1語とその理由。',
      '- range判断は、MA20傾きが小さく、30分間の値幅が200円以内であることを必要条件とするが、十分条件ではない。'
        + 'rangeが確定できない場合は buy(ブル) / sell(ベア) を返すこと。',
      TAIL, '', '【データ】', '<<D>>',
    ]);
  });

  it('(2) ★レンジ無効: range という語が1文字も出ない(条件の行ごと消える)', () => {
    const sys = buildTrendSystemPrompt('<<D>>', false);
    expect(sys.split('\n')).toEqual([
      HEAD, ASK, '', '制約:',
      '- 返すのは現在の相場の方向 buy(ブル) / sell(ベア) のいずれか1語とその理由。',
      TAIL, '', '【データ】', '<<D>>',
    ]);
    expect(sys).not.toContain('range');
    expect(sys).not.toContain('レンジ');
    // ★「レンジは禁止」とも書かない(否定文の中でも語は供給される=実測)。
    expect(sys).not.toContain('禁止');
  });

  it('★user の JSON 雛形の enum が system の選択肢と一致する(2択/3択)', () => {
    expect(buildTrendUserPrompt(true)).toContain('"direction": "buy" | "sell" | "range",');
    expect(buildTrendUserPrompt(false)).toContain('"direction": "buy" | "sell",');
    expect(buildTrendUserPrompt(false)).not.toContain('range');
  });

  it('★A_ANSWER_HEADING が本文に必ず現れる(他ファイルの目印がずれない)', () => {
    expect(buildTrendSystemPrompt('D', true)).toContain(A_ANSWER_HEADING);
    expect(buildTrendSystemPrompt('D', false)).toContain(A_ANSWER_HEADING);
    expect(A_ANSWER_HEADING.length).toBeGreaterThan(0);
  });

  it('★1行目は B と同じなので目印に使えない(A_ANSWER_HEADING が2行目である理由)', () => {
    expect(A_ANSWER_HEADING).not.toBe(HEAD);
    expect(A_ANSWER_HEADING).toBe(ASK);
  });

  it('★裸の数字を全部数える(指定文面が持ち込んだ数値だけ)', () => {
    // 225=銘柄名 / 1=「いずれか1語」/ 20=MA20 / 30=30分 / 200=値幅200円。
    // ★★このうち 20/30/200 は **判定のしきい値**。従来の A は「数値を1つも書かない」だったが、
    //   ユーザーが文面で指定したので入っている。効き目(a_why への固着)は **未測定**。
    expect([...new Set(PROMPT().match(/\d+/g) ?? [])].sort())
      .toEqual(['1', '20', '200', '225', '30'].sort());
    // ★レンジ無効版には しきい値が1つも無い(条件の行ごと消えるため)。
    expect([...new Set(PROMPT_NR().match(/\d+/g) ?? [])].sort()).toEqual(['1', '225'].sort());
  });

  it('★「確信度」の自己申告を求めていない(別の固着を作らない)', () => {
    for (const t of [PROMPT(), PROMPT_NR()]) {
      for (const w of ['確信度', '確率', '自信', 'confidence', 'スコア', '%']) expect(t).not.toContain(w);
    }
  });

  it('★指定文面が持ち込んだ否定形は2つだけ(承知の上・こちらで書き換えない)', () => {
    const t = PROMPT();
    expect(t).toContain('十分条件ではない');
    expect(t).toContain('rangeが確定できない場合は');
    // ★レンジ無効版には1つも無い。
    for (const w of ['ではない', '確定できない']) expect(PROMPT_NR()).not.toContain(w);
  });
});

describe('②③ ★A の応答パース', () => {
  it('3語をそれぞれ読める(大文字・前後空白も許す)', () => {
    expect(parseTrendAnswer('{"direction":"buy","why":"高値切り上げ"}')).toEqual({ direction: 'buy', why: '高値切り上げ' });
    expect(parseTrendAnswer('{"direction":" SELL "}')).toEqual({ direction: 'sell' });
    expect(parseTrendAnswer('```json\n{"direction":"range","why":"どちらとも言えない"}\n```'))
      .toEqual({ direction: 'range', why: 'どちらとも言えない' });
  });

  it('③ ★理由が無くても目線が返れば成立(why は付かないだけ)', () => {
    const r = parseTrendAnswer('{"direction":"buy"}');
    expect(r).toEqual({ direction: 'buy' });
    expect(parseTrendAnswer('{"direction":"buy","why":"   "}')).toEqual({ direction: 'buy' });
  });

  it('② ★3語のどれでもなければ null(呼び出し側が aFailed にできる)', () => {
    for (const bad of [
      '{"direction":"none"}', '{"direction":""}',
      '{"direction":123}', '{}', 'こんにちは', '', '{壊れ',
    ]) expect(parseTrendAnswer(bad)).toBeNull();
  });

  it('★契約に無いキーは拾わない(価格や側が紛れ込まない)', () => {
    const r = parseTrendAnswer('{"direction":"buy","why":"x","limitEntry":38000,"side":"sell"}');
    expect(Object.keys(r!).sort()).toEqual(['direction', 'why']);
  });

  it('★レンジ無効でも range を読む口は塞がない(万一返ったら呼び出し側が rangeDisabled にする)', () => {
    // ★プロンプトからは range を消したが、パーサは3語を受ける=防御を二重にしておく。
    expect(parseTrendAnswer('{"direction":"range"}')).toEqual({ direction: 'range' });
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

  it('★★指定文面が持ち込んだ「幅」は データ部には出ない(移した先の契約を守る)', () => {
    // ★A_CONTRACT_WORDS へ移した以上、データ部で0件であることは **必ず** 保たれていなければならない。
    expect(buildTrendContext(INPUT).split('幅').length - 1).toBe(0);
  });
});

// ★段6(2026-08-22): B に足した「足りなかったデータ」の1文/missingData フィールドは、
//   A の system/user プロンプトには一切足していない。
describe('★段6: A には「足りなかったデータ」の文言/missingData を足していない', () => {
  it('A の system/user プロンプトに該当の文言が無い(2版とも)', () => {
    for (const on of [true, false]) {
      const sys = buildTrendSystemPrompt('【データ】ダミー', on);
      const usr = buildTrendUserPrompt(on);
      expect(sys).not.toContain('判断に必要なデータが足りなかった');
      expect(usr).not.toContain('判断に必要なデータが足りなかった');
      expect(usr).not.toContain('missingData');
      expect(sys).not.toContain('不足データ');
    }
  });
});

// ★2026-08-24(第3版)の退行検知は **そのまま残す**。
//
// ■ なぜ残すか
//   ユーザーが指定した新文面は下の表の語を1つも含まない(実測)。表は「range を『無い・弱い・読めない』の
//   受け皿に戻す語」を捕まえるためのもので、文面が変わっても守りたい性質は同じ。
//   ★実データ(a_why 47件)から作った表なので、次に文面を書き直す人が最も再導入しやすい語彙を押さえている。
describe('★range を「無い」の受け皿に戻さない(2026-08-24 の退行検知を維持)', () => {
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

  /** ★表を「攻撃する」ための退行候補。★**表を読むだけでは穴は見つからない**(実証済み)。 */
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

  it('★有無の二分に戻す語が1つも無い(system + user 全文・2版とも)', () => {
    for (const t of [PROMPT(), PROMPT_NR()]) {
      const hits = BINARY_FRAMING.map(w => [w, t.split(w).length - 1] as const).filter(([, n]) => n > 0);
      expect(hits).toEqual([]);
    }
  });

  it('★★表を攻撃する: 退行候補が1本残らず捕まる(この検査が穴を見つけた)', () => {
    const missed = REGRESSION_CANDIDATES.filter(c => !BINARY_FRAMING.some(w => c.includes(w)));
    expect(missed).toEqual([]);
  });

  it('★検査が恒真に化けていない(表が空でない・候補が空でない)', () => {
    expect(BINARY_FRAMING.length).toBeGreaterThan(0);
    expect(REGRESSION_CANDIDATES.length).toBeGreaterThan(0);
    const t = PROMPT();
    for (const c of REGRESSION_CANDIDATES) expect(t).not.toContain(c);
  });

  it('★肯定的な状態の記述は禁じていない(range を書き直す余地を残す)', () => {
    for (const w of ['横ばい', 'レンジ', '行き来', '範囲']) {
      expect(BINARY_FRAMING.some(b => w.includes(b) || b.includes(w)), `「${w}」を禁じている`).toBe(false);
    }
  });

  it('★range の条件は **肯定形の必要条件** で書かれている(「無いから range」ではない)', () => {
    const sys = buildTrendSystemPrompt('D', true);
    expect(sys).toContain('必要条件とするが、十分条件ではない');
    expect(sys).toContain('MA20傾きが小さく、30分間の値幅が200円以内');
    // ★迷ったら range へ戻る道が無い(確定できないときは bull/bear へ倒す)。
    expect(sys).toContain('rangeが確定できない場合は buy(ブル) / sell(ベア) を返すこと。');
    expect(sys).not.toContain('確信が持てないとき');
  });
});

// ═══ ★★否定対照: 旧の語(bull/bear)が返ってきたらどうなるか ══════════════════
//
// ■ ★判断: **読めずに落とす**(parseTrendAnswer が null → 呼び出し側が none_reason='aFailed')。
//   ① A のプロンプトに `bull`/`bear` は **1文字も無い**。印字していない語が返るのは
//      「モデルの先祖返り/取り違え」= **こちらの契約から外れた応答** であって相場の判断ではない。
//   ② 救済して `buy` に読み替えると、台帳 a_direction に `buy` と記録されるのに
//      実際は `bull` と答えていた回が混ざる。★語彙を版で切る(app_version / a_prompt_build)という
//      分析の前提そのものが壊れる。「旧フィールドをコードが黙って救済し続ける」は
//      v0.9.70 で問題として記録済みの型(lcAudit の widthSource='legacy-price')。
//   ③ 落とせば `none_reason='aFailed'` として **件数で数えられる**(無言にならない)し、
//      B を投げないので課金も増えない。★気づけて、かつ安い。
//   ★代償(承知の上): モデルが bull を返し続ける版が来たら全件見送りになる。
//     ただし aFailed の件数と console.warn で必ず見えるので、無言では壊れない。
describe('★★否定対照: 旧の語(bull/bear)は読まずに落とす', () => {
  it('bull / bear / BULL は null(=aFailed)', () => {
    for (const old of ['{"direction":"bull"}', '{"direction":"bear"}',
      '{"direction":"BULL","why":"高値切り上げ"}', '{"direction":" bear "}']) {
      expect(parseTrendAnswer(old), old).toBeNull();
    }
  });

  it('★新しい3語は読める(この否定対照が恒真でない)', () => {
    expect(parseTrendAnswer('{"direction":"buy"}')).toEqual({ direction: 'buy' });
    expect(parseTrendAnswer('{"direction":"sell"}')).toEqual({ direction: 'sell' });
    expect(parseTrendAnswer('{"direction":"range"}')).toEqual({ direction: 'range' });
  });

  it('★切り詰められた応答の救済経路でも旧の語は拾わない(裏口を作らない)', () => {
    // max_tokens で切れた応答からでも direction は拾える救済がある。そこも新3語だけ。
    expect(parseTrendAnswer('{"direction":"bull","why":"高値切り上げが続き')).toBeNull();
    expect(parseTrendAnswer('{"direction":"buy","why":"高値切り上げが続き')).toEqual({ direction: 'buy' });
  });
});
