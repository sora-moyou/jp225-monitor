// server/newsPersist.ts — ニュースを DB(jp225.db)へ落とす層。
//
// ★なぜ必要か: これまでニュースは cache.ts のメモリ配列にしか無く、プロセスが落ちれば消えた。
//   結果として「その時刻に何を見ていたか」が一切残らず、
//     (a) インパクト推定の妥当性を後から検証できない
//     (b) 計画サイクルのオフライン再生でニュース欄を再現できない(既知の穴)
//   という 2 つの穴の共通原因になっていた。ここで塞ぐ。
//
// ★書き込みは best-effort。DB が開けない/壊れている場合でも **ニュース表示は止めない**
//   (表示はメモリ経路で従来どおり動く)。記録の失敗が機能の停止に化けないようにする。

import type { DatabaseSync } from 'node:sqlite';
import type { NewsItem } from '../core/types.js';
import {
  openDb, resolveDbPath, upsertNewsBatch, pruneNews, NEWS_RETENTION_MS, type NewsInsert,
} from './db/store.js';

let db: DatabaseSync | null = null;
let lastPruneAt = 0;
/** 掃除の間隔。毎回 DELETE を撃つ必要はない(30日の保持に対して1時間の粒度で十分)。 */
export const NEWS_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** テスト用: 内部状態を捨てて次回に開き直させる。 */
export function resetNewsPersistForTest(): void {
  db = null;
  lastPruneAt = 0;
}

/** NewsItem → DB 行。impact が無い(旧経路)ときは採点列を NULL にする。 */
export function toNewsInsert(n: NewsItem): NewsInsert {
  return {
    id: n.id,
    title: n.title,
    source: n.source,
    lang: n.lang,
    url: n.url,
    publishedAt: n.publishedAt,
    impactScore: n.impact ? n.impact.score : null,
    category: n.impact ? n.impact.category : null,
    impactJson: n.impact ? JSON.stringify(n.impact) : null,
    // ★確度はインパクトとは別列。スコアには一切混ぜない(表示と検証にだけ使う)。
    confidence: n.confidence ? n.confidence.level : null,
    confidenceBasis: n.confidence ? n.confidence.basis : null,
  };
}

/**
 * 取得したニュースを upsert し、頻度を絞って古い行を掃除する。
 * 戻り値は記録件数(失敗時 0)。例外は投げない(呼び出し元の取得ループを止めないため)。
 */
export function persistNews(items: readonly NewsItem[], now = Date.now()): number {
  if (items.length === 0) return 0;
  try {
    if (!db) db = openDb(resolveDbPath());
    const n = upsertNewsBatch(db, items.map(toNewsInsert), now);
    if (now - lastPruneAt >= NEWS_PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      const removed = pruneNews(db, now - NEWS_RETENTION_MS);
      if (removed > 0) console.log(`[newsPersist] pruned ${removed} rows older than ${NEWS_RETENTION_MS / 86_400_000}d`);
    }
    return n;
  } catch (err) {
    console.warn('[newsPersist] failed:', err instanceof Error ? err.message : err);
    db = null;   // 次回開き直す(一時的なロック/ファイル差し替えから自力回復させる)
    return 0;
  }
}
