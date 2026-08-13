import { describe, it, expect } from 'vitest';
import type { NewsItem } from './types.js';
import { canonicalArticleUrl, normalizeHeadline, dedupeSameArticle } from './newsDedup.js';

// ─── ★同じ記事が別ソース名で二重に出るのを畳む(2026-08-14 の不具合) ──────────────
//
// 症状: 同じ東洋経済の記事が「東洋経済オンライン」と「東洋経済」で2枚並んだ。
// 原因: id が「ソース名 + そのソース内の識別子」なので、**同じ記事を別フィードが運ぶと
//       別 id になる**。重複排除は id でしか見ていなかった。
// 実測(稼働機DB 5,789件): 同じ記事URLが複数 id で入っている組 **43組**
//       (別ソース名 32組 / 同一ソース内 11組)。うち1組は「裏取り成立」と誤記録されていた。
//
// ★畳むのは **同じ記事URL** のときだけ。別URLの他社記事(同じ通信社ネタの配信)は
//   別ソースの報道なので畳まない(裏取りの判定材料でもある)。

const item = (over: Partial<NewsItem>): NewsItem => ({
  id: 'x', title: 't', source: 's', lang: 'ja', url: 'https://example.com/a', publishedAt: 1, ...over,
});

describe('canonicalArticleUrl', () => {
  it('★トラッキングのクエリ・www・末尾スラッシュ・フラグメントを外す(実データの形)', () => {
    const a = canonicalArticleUrl('https://toyokeizai.net/articles/-/954784?utm_source=rss&utm_medium=http&utm_campaign=link_back');
    const b = canonicalArticleUrl('https://toyokeizai.net/articles/-/954784');
    expect(a).toBe(b);
    expect(canonicalArticleUrl('https://www.bbc.co.uk/news/articles/cx2rgzyplg2o?at_medium=RSS&at_campaign=rss'))
      .toBe(canonicalArticleUrl('https://www.bbc.co.uk/news/articles/cx2rgzyplg2o#1'));
  });

  it('★記事を特定するクエリは残す(別記事を同一視しない)', () => {
    expect(canonicalArticleUrl('https://moneyworld.jp/news/detail?id=216803'))
      .not.toBe(canonicalArticleUrl('https://moneyworld.jp/news/detail?id=216804'));
  });

  it('URL として読めないものは空(その場合は畳まない)', () => {
    expect(canonicalArticleUrl('')).toBe('');
    expect(canonicalArticleUrl('not a url')).toBe('');
  });
});

describe('normalizeHeadline', () => {
  it('★全角/半角の違いを吸収する(実データ: ？ vs ? / ％ vs %)', () => {
    expect(normalizeHeadline('｢エルニーニョ現象｣って何？／最大20％の食料インフレ'))
      .toBe(normalizeHeadline('｢エルニーニョ現象｣って何?/最大20%の食料インフレ'));
  });
  it('末尾のサイト名(| ビジネス | 東洋経済オンライン)を落とす', () => {
    expect(normalizeHeadline('記事の見出し | ビジネス | 東洋経済オンライン')).toBe(normalizeHeadline('記事の見出し'));
  });
});

describe('dedupeSameArticle', () => {
  const TOYO_A = item({
    id: '東洋経済:954784@toyokeizai.net', source: '東洋経済',
    url: 'https://toyokeizai.net/articles/-/954784',
    title: '【円安の是正に“奇策”なし】“実弾”での協調介入に透ける米国の「焦り」／過去の為替介入にも「限界」が | ビジネス | 東洋経済オンライン',
  });
  const TOYO_B = item({
    id: 'n225jp:https://toyokeizai.net/articles/-/954784?utm_source=rss&utm_medium=http&utm_campaign=link_back',
    source: '東洋経済オンライン',
    url: 'https://toyokeizai.net/articles/-/954784?utm_source=rss&utm_medium=http&utm_campaign=link_back',
    title: '【円安の是正に“奇策”なし】“実弾”での協調介入に透ける米国の「焦り」/過去の為替介入にも「限界」が',
  });

  it('★同じ記事URL・別ソース名の2件が1件になる(報告された事象)', () => {
    const out = dedupeSameArticle([TOYO_A, TOYO_B]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(TOYO_A.id);   // 先に来た方(専用フィード)を残す
  });

  it('★切り詰められた見出し(…)より、完全な見出しの方を残す', () => {
    const full = item({ id: '財経新聞:1', source: '財経新聞', url: 'https://www.zaikei.co.jp/article/20260813/865510.html',
      title: '12日の米国市場ダイジェスト:米国株式市場はまちまち、ハイテク企業決算やCPI好感も原油高を嫌気' });
    const cut = item({ id: 'bing:1', source: 'bing', url: 'https://www.zaikei.co.jp/article/20260813/865510.html',
      title: '12日の米国市場ダイジェスト:米国株式市場はまちまち、ハイテク ...' });
    expect(dedupeSameArticle([cut, full])).toHaveLength(1);
    expect(dedupeSameArticle([cut, full])[0]!.id).toBe(full.id);
    expect(dedupeSameArticle([full, cut])[0]!.id).toBe(full.id);
  });

  it('★同じ一覧ページURLでも、別の中身なら畳まない(米指標カードが消えない)', () => {
    const cpi = item({ id: 'econ:CPI:1', source: '米経済指標', url: 'https://fx.minkabu.jp/indicators', title: '📊 米指標 消費者物価指数（CPI）: 前年比 3.4%' });
    const home = item({ id: 'econ:中古住宅:1', source: '米経済指標', url: 'https://fx.minkabu.jp/indicators', title: '📊 米指標 中古住宅販売件数: 結果 406万件' });
    expect(dedupeSameArticle([cpi, home])).toHaveLength(2);
  });

  it('★別URLの他社記事は畳まない(裏取りの材料を壊さない)', () => {
    const a = item({ id: 'A:1', source: '財経新聞', url: 'https://a.example/1', title: '同じ内容の見出し' });
    const b = item({ id: 'B:1', source: '日本インタビュ新聞', url: 'https://b.example/1', title: '同じ内容の見出し' });
    expect(dedupeSameArticle([a, b])).toHaveLength(2);
  });

  it('URL が無い/読めない項目は畳まない(まとめて消えたりしない)', () => {
    const a = item({ id: 'A:1', url: '', title: 'あ' });
    const b = item({ id: 'B:1', url: '', title: 'い' });
    expect(dedupeSameArticle([a, b])).toHaveLength(2);
  });

  it('重複が無ければ入力をそのまま返す(順序も保つ)', () => {
    const a = item({ id: 'A:1', url: 'https://a.example/1' });
    const b = item({ id: 'B:1', url: 'https://b.example/2' });
    expect(dedupeSameArticle([a, b]).map(x => x.id)).toEqual(['A:1', 'B:1']);
  });
});
