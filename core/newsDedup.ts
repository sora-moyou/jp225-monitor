// core/newsDedup.ts — 「同じ記事」を1件に畳む純関数(依存ゼロ)。
//
// ■ なぜ要るか(2026-08-14 の実測)
//   NewsItem の id は「ソース名 + そのソース内の識別子」で作る。つまり **同じ記事でも、
//   運んできたフィードが違えば別 id** になる。集約の重複排除は id しか見ていなかったので、
//   同じ記事が2枚並んだ(報告: 東洋経済オンライン / 東洋経済 の2枚)。
//   稼働機DB 5,789件で数えると、同じ記事URLが複数 id で入っている組は **43組**
//   (別ソース名 32組 / 同一ソース内 11組)。うち1組は確度の「裏取り成立」にも誤って効いていた。
//
// ■ 何を同じ記事とみなすか(狭く取る)
//   **記事URLが同じ** ものだけ。別URLの他社記事(同じ通信社ネタを各社が配信)は畳まない
//   = 別ソースの報道であり、確度(裏取り)の材料でもあるため。
//   同じURLの中でさらに見出しで確かめるのは、**一覧ページを URL に持つソース**があるから
//   (米経済指標は全件が https://fx.minkabu.jp/indicators を指す)。URLだけで畳むと
//   別々の指標カードが1枚に潰れる。

import type { NewsItem } from './types.js';

/** 追跡用のクエリ(接頭辞)。記事の同一性には関与しない。 */
const TRACKING_PREFIX = /^(utm_|at_)/i;
/** 追跡用のクエリ(完全一致)。★記事を特定する id / article などは **絶対に入れない**。 */
const TRACKING_KEYS = new Set([
  'source', 'ref', 'ref_src', 'fbclid', 'gclid', 'yclid', 'spm',
  'cmpid', 'ncid', 'icid', 'mc_cid', 'mc_eid', 'cmp', 'campaign', 'medium',
]);

/** 記事URLの実体(host+path+記事を特定するクエリ)。読めない/空なら ''(= 畳まない)。
 *  ★落とすのは追跡用のクエリ・フラグメント・www・末尾スラッシュ・大文字小文字だけ。 */
export function canonicalArticleUrl(url: string | null | undefined): string {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  let u: URL;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PREFIX.test(k) || TRACKING_KEYS.has(k.toLowerCase())) u.searchParams.delete(k);
  }
  const path = (u.host.replace(/^www\./, '') + u.pathname).replace(/\/+$/, '');
  return (path + (u.search || '')).toLowerCase();
}

/** 見出しの比較用の形。
 *  ★NFKC で全角/半角を揃える(実データ: ？vs ? / ％vs % / ｢｣vs「」 が同じ記事で食い違う)。
 *  ★末尾の「| ビジネス | 東洋経済オンライン」のようなサイト名は落とす(片方だけ付く)。 */
export function normalizeHeadline(title: string | null | undefined): string {
  let s = String(title ?? '').normalize('NFKC');
  // 末尾のサイト名/カテゴリ(区切りは | ｜ 一 のいずれか)を最大2つまで落とす。
  for (let i = 0; i < 2; i++) s = s.replace(/\s*[|｜][^|｜]{1,24}\s*$/u, '');
  return s
    .replace(/["'`｢｣「」『』“”‘’]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 切り詰められた見出しか(末尾が … / ...)。 */
function isTruncated(norm: string): boolean {
  return /(?:…|\.\.\.)$/.test(norm);
}

/** 2つの見出しが同じ記事のものか。完全一致、または **片方が切り詰められた前方一致**。 */
function sameHeadline(a: string, b: string): boolean {
  if (a === b) return true;
  const cut = (s: string) => s.replace(/(?:…|\.\.\.)$/, '');
  if (isTruncated(a) && b.startsWith(cut(a)) && cut(a).length >= 8) return true;
  if (isTruncated(b) && a.startsWith(cut(b)) && cut(b).length >= 8) return true;
  return false;
}

/**
 * 同じ記事(同じ記事URL × 同じ見出し)を1件に畳む純関数。**順序は保つ**。
 *
 * 残すのは「見出しがいちばん完全なもの」。同点なら **先に来た方**(集約のタスク順 =
 * 専用フィードが先)。切り詰められた見出し(「…」)を残すと画面でも記録でも情報が減るため。
 *
 * ★URL が空/読めない項目は畳まない(まとめて1件に消えるのを防ぐ)。
 */
export function dedupeSameArticle(items: readonly NewsItem[]): NewsItem[] {
  /** 出力位置 → 採用中の項目。 */
  const out: Array<{ item: NewsItem; norm: string; url: string }> = [];
  /** canonical URL → out の添字リスト(同じURLの中だけを見比べる)。 */
  const byUrl = new Map<string, number[]>();

  for (const it of items) {
    const url = canonicalArticleUrl(it.url);
    const norm = normalizeHeadline(it.title);
    if (!url) { out.push({ item: it, norm, url }); continue; }
    const idxs = byUrl.get(url);
    const hit = idxs?.find(i => sameHeadline(out[i]!.norm, norm));
    if (hit === undefined) {
      byUrl.set(url, [...(idxs ?? []), out.length]);
      out.push({ item: it, norm, url });
      continue;
    }
    // 既に同じ記事がある: 見出しがより完全な方を残す(位置は最初のまま)。
    const cur = out[hit]!;
    const better = norm.length > cur.norm.length && isTruncated(cur.norm);
    if (better) out[hit] = { item: it, norm, url };
  }
  return out.map(o => o.item);
}
