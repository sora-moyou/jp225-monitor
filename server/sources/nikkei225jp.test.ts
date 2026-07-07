import { describe, it, expect } from 'vitest';
import { parseNikkei225jpNews, parseJstDateTime } from './nikkei225jp.js';

// 実フォーマット(News[n]='id__日時__c__c__flag__ソース__URL__見出し__0__0';n++)を模した入力。
const SAMPLE = `var News=[],n=0;
News[n]='1__2026/06/12 06:55__21__2101__1__CoinPost__https://coinpost.jp/?p=1__米銀行団体がクラリティー法案に反対、仮想通貨業界と対立__0__0';n++;
News[n]='4__2026/06/12 06:49__40__404__1__羊飼いの今日の為替はこれで動く__https://min-fx.jp/a__6月12日(金)ドル円相場と米国債利回りの動向__0__0';n++;
News[n]='9__2026/06/12 06:42__9__900__1__Yahoo!__https://news.yahoo.co.jp/sports1__プロ野球 巨人が逆転勝ち 甲子園へ__0__0';n++;
`;

describe('parseJstDateTime', () => {
  it('JST 文字列を epoch ms に変換', () => {
    expect(parseJstDateTime('2026/06/12 06:49')).toBe(Date.parse('2026-06-12T06:49:00+09:00'));
  });
  it('不正形式は NaN', () => {
    expect(Number.isNaN(parseJstDateTime('bad'))).toBe(true);
    expect(Number.isNaN(parseJstDateTime(''))).toBe(true);
  });
});

describe('parseNikkei225jpNews', () => {
  it('金融見出しを NewsItem に変換し、ブラックリスト(スポーツ)を除外', () => {
    const items = parseNikkei225jpNews(SAMPLE);
    expect(items.map(i => i.source)).toEqual(['CoinPost', '羊飼いの今日の為替はこれで動く']);   // Yahoo!スポーツは除外
    const first = items[0]!;
    expect(first.title).toContain('クラリティー法案');
    expect(first.url).toBe('https://coinpost.jp/?p=1');
    expect(first.lang).toBe('ja');
    expect(first.id).toBe('n225jp:https://coinpost.jp/?p=1');
    expect(first.publishedAt).toBe(Date.parse('2026-06-12T06:55:00+09:00'));
  });

  it('同一URLの重複は1件に', () => {
    const dup = SAMPLE + `News[n]='1__2026/06/12 06:55__21__2101__1__CoinPost__https://coinpost.jp/?p=1__米銀行団体がクラリティー法案に反対__0__0';n++;`;
    const items = parseNikkei225jpNews(dup);
    expect(items.filter(i => i.url === 'https://coinpost.jp/?p=1')).toHaveLength(1);
  });

  it('壊れた/空入力は空配列', () => {
    expect(parseNikkei225jpNews('')).toEqual([]);
    expect(parseNikkei225jpNews('garbage without News entries')).toEqual([]);
  });

  it('フィールド不足の行はスキップ', () => {
    expect(parseNikkei225jpNews(`News[n]='1__2026/06/12 06:55__x';n++;`)).toEqual([]);
  });

  // 225225.jp /1jp/(国内・News_6)実サンプル行。
  it('News_6(国内)の行をパースする', () => {
    const sample = `var News=[],n=0;
News[n]='42__2026/07/07 20:01__6__69__2__財経新聞__https://www.zaikei.co.jp/article/20260707/860180.html__欧州為替:ドル・円は小動き、材料難で様子見__18__9';n++;`;
    const items = parseNikkei225jpNews(sample);
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.title).toBe('欧州為替:ドル・円は小動き、材料難で様子見');
    expect(it0.url).toBe('https://www.zaikei.co.jp/article/20260707/860180.html');
    expect(it0.source).toBe('財経新聞');
    expect(it0.lang).toBe('ja');
    expect(it0.id).toBe('n225jp:https://www.zaikei.co.jp/article/20260707/860180.html');
    expect(it0.publishedAt).toBe(Date.parse('2026-07-07T20:01:00+09:00'));
  });

  // 225225.jp /3ny/(米国・News_8)実サンプル行。
  it('News_8(米国)の行をパースする', () => {
    const sample = `var News=[],n=0;
News[n]='7__2026/07/07 22:30__8__801__2__ロイター__https://jp.reuters.com/markets/us/xyz__NY株式市場、主要3指数が上昇して始まる__0__0';n++;`;
    const items = parseNikkei225jpNews(sample);
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.title).toBe('NY株式市場、主要3指数が上昇して始まる');
    expect(it0.url).toBe('https://jp.reuters.com/markets/us/xyz');
    expect(it0.source).toBe('ロイター');
    expect(it0.id).toBe('n225jp:https://jp.reuters.com/markets/us/xyz');
    expect(it0.publishedAt).toBe(Date.parse('2026-07-07T22:30:00+09:00'));
  });
});
