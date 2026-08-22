import { describe, it, expect } from 'vitest';
import { buildTrendSystemPrompt, buildTrendUserPrompt, parseTrendAnswer } from './trendPrompt.js';
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
