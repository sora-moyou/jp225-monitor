import { describe, it, expect } from 'vitest';
import {
  buildTrendSystemPrompt, buildTrendUserPrompt,
  A_FORBIDDEN_WORDS, A_CONTRACT_WORDS, countDirectiveForms,
} from './trendPrompt.js';
import { buildTrendContext } from './abContext.js';
import { buildTechnicalForTrend } from './scalpPlanRunner.js';
import { formatMomentumLine, formatMomentumLineForTrend, type Regime } from '../signalTrade/regime.js';
import type { AlertRow } from '../db/store.js';
import type { LevelsResult } from '../levels.js';

// ★2026-08-24: 「A に注文の語が1文字も無い」を **実際に送る全文** で数える。
//
// ■ 真因(この検査が生まれた理由)
//   これまでの検査(server/llm/trendPrompt.test.ts の ①)は
//     buildTrendSystemPrompt('【ここにデータが入る】') + buildTrendUserPrompt()
//   つまり **プロンプトのテンプレートだけ** を数えていた。★データ部を数えていなかった。
//   その結果、データ部に注入していた勢い1行(formatMomentumLine)の **行動指針の注記3つ** に
//   入っていた注文・戦略・執行の語を、検査が素通りさせた。実測(修正前):
//     競合   211字 … 新規 順張り 計画 見送り veto direction none
//     判定保留 290字 … 見送り direction none 節目 バックテスト
//     横ばい  221字 … 指値 新規 direction range fade breakout ストラドル 節目 両側
//   ★とくに `direction:"none"` は **A の契約に存在しない**(A の答えは buy/sell/range の3択)。
//     答える場所が無いものを指示していた=委任ノートで起きた事故と同じ型。
//   ★`fade`/`breakout` の使い分けは **コードが BB スクイーズで決める** 設計で、A には説明しない
//     のが分割の芯。それを A に説明していた。
//
// ■ ★この検査が数えるもの
//   buildTrendSystemPrompt(**データ部**) + buildTrendUserPrompt() の全文。
//   データ部は本番と同じ組み立て(buildTechnicalForTrend)= 勢い1行 + A 用の文脈。
//
// ■ ★`direction` / `range` の扱い(切り分け)
//   この2語は **A 自身の契約の語** で、テンプレートに必ず出る:
//     system … `range … 同じ値段の範囲を行き来している(レンジ)` / `range を選ぶのは…`
//     user   … `"direction": "buy" | "sell" | "range"`
//   ★よって全文で 0件 を求めると恒偽になる。**データ部でだけ 0件** を求め、
//     さらに `direction:"…"`(値を指定する形)は **全文のどこにも出ない** ことを別に固定する。
//     ——A に禁じたいのは「答えの選択肢を持つこと」ではなく「答えを **こちらが指定する** こと」。

// ─── 材料(server/llm/trendPrompt.test.ts の ④ と同じ形) ─────────────────────
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

const AB_INPUT = {
  market: {
    bars: bars(120), levels: LEVELS, alerts: ALERTS,
    now: Date.UTC(2026, 7, 20, 5, 0), currentPrice: 39100, indicatorsEnabled: true,
  },
  basedata: { dailyCloses, dailyBars, currentPrice: 39100 },
};

const regimeOf = (o: Partial<Regime>): Regime => ({
  ret10: -30, ret30: -60, ma20Slope: -1.2, swingHigh: 65600, swingLow: 65200, posPct: 40,
  dir: 'flat', strong: false, trendDir: 'flat', longDir: 'flat', trendStrong: false, ret10StaleMin: null,
  ...o,
});

/** ★4場面。実運用で注記3つが出る条件をすべて含む(通常 / 競合 / 判定保留 / 横ばい+レンジ有効)。 */
const SCENARIOS: ReadonlyArray<readonly [string, Regime, boolean]> = [
  ['通常(下降トレンド)', regimeOf({ dir: 'down', strong: true, trendDir: 'down' }), true],
  ['競合(conflict)', regimeOf({ ret10: 120, dir: 'up', strong: true, trendDir: 'conflict', longDir: 'down' }), true],
  ['判定保留(stale)', regimeOf({ ret10: -400, trendDir: 'stale', ret10StaleMin: 900 }), true],
  ['横ばい+レンジ有効', regimeOf({ trendDir: 'flat' }), true],
] as const;

/** ★A の全文(system + データ部 + user)。★データ部の組み立ては本番と同じ関数を通す。 */
const trendCtx = (): string => buildTrendContext(AB_INPUT);
const dataPartOf = (r: Regime): string => buildTechnicalForTrend(39100, r, trendCtx());
const fullTextOf = (r: Regime): string => buildTrendSystemPrompt(dataPartOf(r), true) + buildTrendUserPrompt(true);

const countHits = (text: string, words: readonly string[]): Array<readonly [string, number]> =>
  words.map(w => [w, text.split(w).length - 1] as const).filter(([, n]) => n > 0);

/** ★A に出てはいけない語。★**表は trendPrompt.ts の SSOT**(2026-08-24 第3次)。
 *
 *  ■ ★この検査は、最初この場所に **独自の28語の表** を持っていた。
 *    trendPrompt.test.ts の27語から16語(幅/丸め/刻み/stopEntry/limitEntry/lcWidth/aPrice/iPrice/
 *    アラート/ニュース/ツール/発注/ロット/枚/買い/売り)を落として作ってしまい、
 *    ★A に禁じてある6カテゴリのうち **アラート・ニュース・仮想取引の成績・チャート画像・
 *    データツール・買い/売り の6つを1つも見ていなかった**(エバリュエーターが実文を注入して実証:
 *    先頭に注入=4本ともグリーン / 文脈の中に注入=28本ともグリーン)。
 *    ★「表を持つ設計は項目を足すと無言で漏れる」を、**表を作り直すときに項目を減らして** 再現した。
 *  ■ ★よって表は1つにした。下の ATTACKS が、6カテゴリの実文で毎回この表を殴る。 */
const ORDER_WORDS = A_FORBIDDEN_WORDS;

/** ★A 自身の契約の語。テンプレートには出てよい / **データ部には出てはいけない**。 */
const CONTRACT_WORDS = A_CONTRACT_WORDS;

describe('★A の全文(データ部を含む)に注文・戦略・執行の語が1つも無い', () => {
  for (const [name, r] of SCENARIOS) {
    it(`${name}: 注文の語が0件`, () => {
      const hits = countHits(fullTextOf(r), ORDER_WORDS);
      expect(hits, `A の全文に該当語: ${hits.map(([w, n]) => `${w}×${n}`).join(' ')}`).toEqual([]);
    });

    it(`${name}: 契約の語(direction/range)がデータ部に0件`, () => {
      expect(countHits(dataPartOf(r), CONTRACT_WORDS)).toEqual([]);
    });

    it(`${name}: 答えを指定する形(direction:"…")がデータ部に0件`, () => {
      // ★全文では 0 にできない: user の JSON 雛形 `"direction": "buy" | …` と
      //   `"direction": "none"` は **形が同一** で、違うのは値だけ。★形で禁じ、場所で分ける。
      expect(countDirectiveForms(dataPartOf(r))).toBe(0);
      expect(countDirectiveForms(fullTextOf(r))).toBe(1);   // 雛形のちょうど1回
    });
  }

  it('★検査が恒真に化けていない(語の表が空でない・データ部が実際に入っている)', () => {
    expect(ORDER_WORDS.length).toBeGreaterThan(0);
    const full = fullTextOf(SCENARIOS[0]![1]);
    expect(full).toContain('直近の勢い: ');          // データ部が本当に入っている
    expect(full).toContain('【データ】');             // 差し込み位置も本物
    // ★契約の語は **テンプレート側には出る**(全文で 0件 を求めたら恒偽になることの確認)。
    expect(countHits(full, CONTRACT_WORDS).length).toBeGreaterThan(0);
  });
});

// ─── ★表を攻撃する: 注記3つの実文が混ざったら必ず落ちる ──────────────────────
//
// ■ ★表を読むだけでは穴は見つからない(このプロジェクトの実証)。実際に混ぜて捕まえる。
//   ①〜③ は 2026-08-24 に A から外した注記3つの **実文**(1文字も変えずに写す)。
describe('★★表を攻撃する: 注記3つの実文が A の全文に混ざったら必ず赤', () => {
  const NOTES = [
    // ① conflictNote
    ' ※直近10分と長い時間軸が逆向きです。どちらのトレンドとも断定できません。'
    + 'コード側の見送り判定(veto)は直近10分に逆行する新規=長い時間軸に順張りする側を落とすため、'
    + '長期方向へ乗る計画は通りません。direction:"none"(見送り)が最も整合的です',
    // ② staleGuide
    ' ※「10分」の比較先が古い足(前セッション終値)のため、この値は直近10分の勢いではなく寄り付きギャップです。'
    + '本プロジェクトの9年バックテストでギャップの大小に方向のエッジは無いと確認済みのため、この値を根拠に方向を決めないこと。'
    + '方向は『長い時間軸』の数値・節目・アラートで判断し、それらに明確な根拠が無ければ direction:"none"(見送り)にすること',
    // ③ rangeNote
    ' ※レンジ両面が有効な設定です。上下に反応帯(節目)があるレンジだと判断できるなら direction:"range"(両面ストラドル)を出してよい局面'
    + '(上下幅が広ければ fade=両側指値の組 / 狭い横這いなら breakout=両側ブレイク新規の組。組は混ぜない。幅の基準は上の制約を参照)',
  ] as const;

  it('★3本とも、いまの A の全文には1文字も無い', () => {
    for (const [name, r] of SCENARIOS) {
      const full = fullTextOf(r);
      for (const n of NOTES) expect(full, `${name} に注記が残っている`).not.toContain(n);
    }
  });

  it('★3本とも、混ぜたら検査に捕まる(1本でも素通りしたら赤)', () => {
    const missed = NOTES.filter(n => {
      const injected = buildTrendSystemPrompt(`${dataPartOf(SCENARIOS[0]![1])}${n}`, true) + buildTrendUserPrompt(true);
      return countHits(injected, ORDER_WORDS).length === 0;
    });
    expect(missed).toEqual([]);
  });

  it('★`direction:"…"` の形も、混ぜたら捕まる(A の契約に無い答えを指定させない)', () => {
    for (const n of NOTES.filter(x => x.includes('direction:"'))) {
      expect(countDirectiveForms(`${dataPartOf(SCENARIOS[0]![1])}${n}`)).toBeGreaterThan(0);
    }
    // ★コロンの後に空白がある形(旧 literal 4本の穴)も捕まる。
    expect(countDirectiveForms('… 迷ったら {"direction": "none"} にすること')).toBe(1);
  });

  // ★生きた否定対照: B と旧経路が使う formatMomentumLine(注記あり)を **そのまま** データ部に入れると、
  //   3場面すべてで検査が赤くなる= この検査は「注記が戻ってきたら必ず気づく」。
  it('★否定対照: B/旧経路の勢い行(注記あり)をデータ部に入れると 競合/判定保留/横ばい は必ず捕まる', () => {
    for (const [name, r] of SCENARIOS.filter(([n]) => n !== '通常(下降トレンド)')) {
      const withNotes = `${formatMomentumLine(r, true)}\n\n${trendCtx()}`;
      const full = buildTrendSystemPrompt(withNotes, true) + buildTrendUserPrompt(true);
      expect(countHits(full, ORDER_WORDS).length, `${name} が素通りした`).toBeGreaterThan(0);
    }
  });
});

// ─── ★A の勢い行は「事実だけ」・データの但し書きは残す ────────────────────────
describe('★A に渡す勢いの行は事実だけ(注記3つを落とし、データの但し書きは残す)', () => {
  it('★通常時と同じ形(数値・ラベル・強弱だけ)', () => {
    const line = formatMomentumLineForTrend(regimeOf({ dir: 'down', strong: true, trendDir: 'down' }));
    expect(line).toBe('直近の勢い: 10分-30円 / 30分-60円 / MA20傾き-1.2 / 直近30分高安[65200-65600]内40% → 下降トレンド(弱)');
  });

  it('★競合でもラベルまで(行動指針は付かない)', () => {
    const line = formatMomentumLineForTrend(regimeOf({ ret10: 120, dir: 'up', strong: true, trendDir: 'conflict', longDir: 'down' }));
    expect(line).toContain('→ 戻り(長期は下降)(弱)');
    expect(line).not.toContain('※');
  });

  it('★横ばい+レンジ有効でもレンジの勧めは付かない(rangeEnabled を受け取らない関数)', () => {
    expect(formatMomentumLineForTrend(regimeOf({ trendDir: 'flat' }))).not.toContain('※');
  });

  // ★staleNote は **残す**: 「この数値は何と何を比べたものか」という **データの但し書き** であって
  //   行動指針ではない。外すと A が前セッション終値との差を「直近10分の勢い」と誤読する。
  it('★staleNote(比較先が古い旨)は残る。ただし行動指針(staleGuide)は落ちる', () => {
    const line = formatMomentumLineForTrend(regimeOf({ ret10: -400, trendDir: 'stale', ret10StaleMin: 900 }));
    expect(line).toContain('(※比較先は900分前の足=寄り付きギャップ/欠測)');
    expect(line).toContain('→ 判定保留(寄り付きギャップ)');
    expect(line).not.toContain('バックテスト');
    expect(line).not.toContain('direction');
    // ★但し書き自体に注文・戦略・執行の語が無いことを固定(残す判断の根拠)。
    expect(countHits('(※比較先は900分前の足=寄り付きギャップ/欠測)', ORDER_WORDS)).toEqual([]);
  });

  it('★B と旧経路は1バイトも変わらない(既定は注記あり)', () => {
    for (const [, r] of SCENARIOS) {
      // 既定(factsOnly 未指定)= 従来の実装。第3引数を渡さない呼び出しと明示 false は同一。
      expect(formatMomentumLine(r, true)).toBe(formatMomentumLine(r, true, {}));
      expect(formatMomentumLine(r, false)).toBe(formatMomentumLine(r, false, {}));
    }
    // 注記が出る場面では A 向けと B 向けが **違う**(=A だけを変えたことの確認)。
    const conflict = SCENARIOS[1]![1];
    expect(formatMomentumLine(conflict, true)).not.toBe(formatMomentumLineForTrend(conflict));
  });
});

// ─── ★baseTech(基礎テクニカル)は A に渡らない ────────────────────────────────
//
// ■ ★これは新しい判断ではなく、既に決まっている振り分け表(server/llm/abContext.ts)の履行。
//     節目 … A × / B ○   ・   基礎データ長期高安 … A × / B ○(価格の候補=節目の一種)
//   buildTrendContext が `levels:null` で外した当のものを、baseTech が
//   「上値メド/下値メド/上昇目途候補(節目)」として先頭で渡していた(実測: 節目×2〜4)。
// ■ ★(b)「節目だけ外す」は **技術的には成立する**(scope 方式)。採らなかったのは chatContext.ts に
//   A 専用の第2の整形器を持つことになるため(abContext.ts が警告する「2つ持つとズレる」)。
// ■ ★表に無い項目も巻き添えで落ちている(承知の上): フィボ戻しの転換判断 / ADR(ボラ=表では A ○) /
//   時間帯傾向(方向の事前確率)。実測 8行 / 765字 / −28.5%。詳細は scalpPlanRunner.ts のコメント。
// ■ ★現値の1行だけは付ける(表の「現在価格 ○(呼び出し側が別ブロックで付ける)」)。
describe('★baseTech は A に渡らない(渡す口が無い)/現値の1行だけ付く', () => {
  it('★データ部の先頭は 現値 → 勢い1行 → A 文脈 の順', () => {
    const out = buildTechnicalForTrend(39100, regimeOf({}), 'A文脈');
    expect(out.startsWith('現値 39,100円\n直近の勢い: ')).toBe(true);
    expect(out.endsWith('\n\nA文脈')).toBe(true);
  });

  it('★現値が無い/不正なら現値の行を作らない(嘘の価格を書かない)', () => {
    for (const bad of [undefined, 0, -1, Number.NaN]) {
      expect(buildTechnicalForTrend(bad as number | undefined, regimeOf({}), 'A文脈')
        .startsWith('直近の勢い: ')).toBe(true);
    }
  });

  it('★baseTech を渡す引数が無い(書き戻せない形)', () => {
    // 第1引数は数値(現値)。文字列の基礎テクニカルを渡す口はそもそも無い=型で落ちる。
    expect(buildTechnicalForTrend.length).toBe(3);
    expect(typeof buildTechnicalForTrend(39100, regimeOf({}), 'A文脈')).toBe('string');
  });

  // ★否定対照: baseTech の実文(3経路すべて)をデータ部に混ぜると、検査は必ず `節目` を捕まえる。
  //   ★この3本は 2026-08-24 に実際に生成したもの(buildNikkeiTechnical の3経路)。
  const BASE_TECH_SAMPLES = [
    // ① levels スナップショット有り(本番の通常形)
    '■ 日経225先物 (NIY=F) テクニカル(セッションH/L・フィボ):\n現値 39,100円\n'
    + '上値メド: 39,500円(強)(前日Day高) / 39,750円(節目) / 40,000円(強)(節目500・反応3回【方向転換ライン】)\n'
    + '下値メド: 38,500円(前日Day安) / 38,250円(節目)\n'
    + 'フィボ戻し(下げ脚, スイング 39,800→38,900): 50%=39,350円。現値はこれを下回り、転換目安は未達',
    // ② levels 無し・分足62本以上
    '■ 日経225先物 (NIY=F) テクニカル(15〜60分):\n現値 39,404円\n30分変化率 +0.08% / 60分変化率 +0.15%\n'
    + '中期(15分平均) 39,397円 (現在値 -5円) / 長期(60分平均) 39,375円 (現在値 -30円) → 傾向: 上昇寄り\n'
    + '上昇目途候補: 39,500円(節目, あと+95円)：トレンド加速 / 39,750円(節目, あと+345円)\n'
    + '下落目途候補: 39,345円(1時間安値, あと-60円) / 39,250円(節目, あと-155円)',
    // ③ バー不足(gridOnly)
    '■ 日経225先物 (NIY=F) テクニカル(簡易: 分足を蓄積中):\n現値 39,100円\n'
    + '上昇目途候補(節目): 39,250円 / 39,500円\n下落目途候補(節目): 39,000円 / 38,750円',
  ] as const;

  it('★3経路とも、いまの A の全文には1文字も無い', () => {
    for (const [name, r] of SCENARIOS) {
      const full = fullTextOf(r);
      for (const b of BASE_TECH_SAMPLES) {
        expect(full, `${name} に baseTech が残っている`).not.toContain(b);
      }
      // 見出しそのものも出ない(将来 baseTech の文面が変わっても気づける)。
      expect(full).not.toContain('上値メド');
      expect(full).not.toContain('下値メド');
      expect(full).not.toContain('目途候補');
    }
  });

  it('★3経路とも、混ぜたら検査に捕まる(1本でも素通りしたら赤)', () => {
    const missed = BASE_TECH_SAMPLES.filter(b => {
      const injected = buildTrendSystemPrompt(`${b}\n${dataPartOf(SCENARIOS[0]![1])}`, true) + buildTrendUserPrompt(true);
      return countHits(injected, ORDER_WORDS).length === 0;
    });
    expect(missed).toEqual([]);
  });

  it('★混入したときに捕まえる語は `節目`(3経路に共通する語)', () => {
    for (const b of BASE_TECH_SAMPLES) expect(b.split('節目').length - 1).toBeGreaterThan(0);
  });
});

// ─── ★★破壊テスト: A に禁じてある6カテゴリの実文を、3つの位置に注入して殴る ────────
//
// ■ ★なぜ要るか(この検査自身の欠陥だった)
//   最初の版はこの検査の表を独自に持ち、trendPrompt.test.ts の27語から16語を落としていた。
//   エバリュエーターが下と同じ実文を注入したところ、
//     ・A の **先頭** に アラート+ニュース → 「注文の語0件」4本が **全部グリーン**
//     ・A の **末尾** に それ+仮想取引の成績+ツール → 28本中 **27本グリーン**
//     ・**buildTrendContext の中** に 同じもの → 28本 **すべてグリーン**
//   ★検査が「A に禁じてある6カテゴリ」を1つも見ていなかった。★表を SSOT にしたうえで、
//   ★実文で毎回殴って「1つでも素通りしたら赤」を固定する。
// ■ ★実文の出所(このコードベースの本物の文面)
//   アラート … server/llm/scalpContext.ts の '直近アラートとその後(発火後の実リターン):'
//   ニュース … server/llm/scalpPlan.ts の '■ 関連ニュース:'
//   仮想取引の成績 … server/llm/scalpContext.ts buildScalpTradeHistory の '全体: …勝率…純損益…pt'
//   データツール … server/llm/scalpPlan.ts の '利用可能なデータツール(explain_move / …)'
describe('★★破壊: 6カテゴリの実文を A に混ぜたら必ず落ちる(位置を問わず)', () => {
  const ATTACKS: ReadonlyArray<readonly [string, string]> = [
    ['①アラート',
      '直近アラートとその後(発火後の実リターン):\n14:02 break ▲39,150 → 5分+0.10%/15分+0.22%/30分-0.05%'],
    ['②ニュース',
      '■ 関連ニュース:\n・日経平均、後場に下げ幅拡大(14:10)\n・米CPI 前年比+2.7%(予想+2.6%)'],
    ['③仮想取引の成績',
      '全体: 30件 勝率47% 純損益-820pt\n方向別: buy 18件 勝率50% +120 / sell 12件 勝率42% -940'],
    ['④データツール',
      '利用可能なデータツール(explain_move / query_alerts / price_history / web_search)を必要に応じて使い、'],
    ['⑤チャート画像', 'チャート画像を添付しています。画像も見て判断してください。'],
    ['⑥買い/売り', '買い優勢の地合いです。売りは控えてください。'],
    // ★エバリュエーターが実際に使った合成(先頭・末尾の2ケース)
    ['⑦先頭注入の実物(アラート+ニュース)',
      '直近アラートとその後(発火後の実リターン):\n14:02 break ▲39,150 → 5分+0.10%\n■ 関連ニュース:\n・日経平均、後場に下げ幅拡大'],
    ['⑧末尾注入の実物(＋成績＋ツール)',
      '全体: 30件 勝率47% 純損益-820pt\n使えるツール: query_alerts / price_history'],
  ] as const;

  /** 注入位置3つ: A の先頭 / A の末尾 / buildTrendContext の中(行の間)。 */
  const inject = (payload: string, where: 'head' | 'tail' | 'inside'): string => {
    const r = SCENARIOS[0]![1];
    if (where === 'head') return `${payload}\n${dataPartOf(r)}`;
    if (where === 'tail') return `${dataPartOf(r)}\n${payload}`;
    const lines = trendCtx().split('\n');
    const mid = Math.floor(lines.length / 2);
    const spliced = [...lines.slice(0, mid), payload, ...lines.slice(mid)].join('\n');
    return buildTechnicalForTrend(39100, r, spliced);
  };

  for (const where of ['head', 'tail', 'inside'] as const) {
    it(`★${where} に注入: 8本すべて捕まる(1本でも素通りしたら赤)`, () => {
      const missed = ATTACKS.filter(([, payload]) => {
        const full = buildTrendSystemPrompt(inject(payload, where), true) + buildTrendUserPrompt(true);
        return countHits(full, ORDER_WORDS).length === 0;
      }).map(([name]) => name);
      expect(missed, `${where} で素通りした: ${missed.join(' / ')}`).toEqual([]);
    });
  }

  it('★注入していない素の A は 0件のまま(この破壊テストが恒真でない)', () => {
    for (const [name, r] of SCENARIOS) {
      const hits = countHits(fullTextOf(r), ORDER_WORDS);
      expect(hits, `${name}: ${hits.map(([w, n]) => `${w}×${n}`).join(' ')}`).toEqual([]);
    }
  });

  it('★どの語が捕まえたかを固定する(将来 表から語を落としたら気づける)', () => {
    const catcher = (payload: string): string[] =>
      countHits(payload, ORDER_WORDS).map(([w]) => w);
    expect(catcher(ATTACKS[0]![1])).toContain('アラート');
    expect(catcher(ATTACKS[1]![1])).toContain('ニュース');
    expect(catcher(ATTACKS[2]![1])).toContain('勝率');
    expect(catcher(ATTACKS[3]![1])).toContain('ツール');
    expect(catcher(ATTACKS[4]![1])).toContain('チャート');
    expect(catcher(ATTACKS[5]![1])).toContain('買い');
  });
});
