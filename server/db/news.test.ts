import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openDb, initSchema, upsertNews, upsertNewsBatch, getRecentNews, pruneNews,
  NEWS_RETENTION_MS, type NewsInsert,
} from './store.js';

const NOW = 1_800_000_000_000;

function tmpDb(): { db: ReturnType<typeof openDb>; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'news-')), 'jp225.db');
  return { db: openDb(path), path };
}

function row(id: string, over: Partial<NewsInsert> = {}): NewsInsert {
  return {
    id, title: `見出し ${id}`, source: 'NHK ビジネス', lang: 'ja',
    url: `https://example.com/${id}`, publishedAt: NOW - 60_000,
    impactScore: 12.5, category: 'economy', impactJson: '{"score":12.5}',
    confidence: 'confirmed', confidenceBasis: 'wire',
    ...over,
  };
}

describe('news テーブル — 永続化', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => { db = tmpDb().db; });

  it('書いたものが読める', () => {
    upsertNews(db, row('a'), NOW);
    const got = getRecentNews(db, 0);
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe('a');
    expect(got[0]!.impact_score).toBe(12.5);
    expect(got[0]!.category).toBe('economy');
    expect(got[0]!.confidence).toBe('confirmed');
  });

  it('★同じ id を何度取得しても 1 行のまま(重複しない)', () => {
    for (let i = 0; i < 5; i++) upsertNews(db, row('a'), NOW + i);
    expect(getRecentNews(db, 0)).toHaveLength(1);
  });

  it('★first_seen_at は最初の 1 回だけ書かれ、以後は保持される', () => {
    upsertNews(db, row('a'), NOW);
    upsertNews(db, row('a'), NOW + 999_999);
    expect(getRecentNews(db, 0)[0]!.first_seen_at).toBe(NOW);
  });

  it('★確度は毎回上書きされる(第一報 → 裏取り済みへ変わる)', () => {
    upsertNews(db, row('a', { confidence: 'unconfirmed', confidenceBasis: 'single' }), NOW);
    expect(getRecentNews(db, 0)[0]!.confidence).toBe('unconfirmed');
    upsertNews(db, row('a', { confidence: 'confirmed', confidenceBasis: 'corroborated' }), NOW + 1);
    const after = getRecentNews(db, 0)[0]!;
    expect(after.confidence).toBe('confirmed');
    expect(after.confidence_basis).toBe('corroborated');
  });

  it('新しい順に返る', () => {
    upsertNews(db, row('old', { publishedAt: NOW - 3600_000 }), NOW);
    upsertNews(db, row('new', { publishedAt: NOW - 60_000 }), NOW);
    expect(getRecentNews(db, 0).map(r => r.id)).toEqual(['new', 'old']);
  });

  it('since で絞れる', () => {
    upsertNews(db, row('old', { publishedAt: NOW - 3600_000 }), NOW);
    upsertNews(db, row('new', { publishedAt: NOW - 60_000 }), NOW);
    expect(getRecentNews(db, NOW - 600_000).map(r => r.id)).toEqual(['new']);
  });

  it('batch は 1 件も落とさない', () => {
    expect(upsertNewsBatch(db, [row('a'), row('b'), row('c')], NOW)).toBe(3);
    expect(getRecentNews(db, 0)).toHaveLength(3);
  });

  it('空配列は何もしない', () => {
    expect(upsertNewsBatch(db, [], NOW)).toBe(0);
  });
});

describe('保持期間の制御', () => {
  it('★cutoff より古い行だけが消える', () => {
    const { db } = tmpDb();
    upsertNews(db, row('keep', { publishedAt: NOW - NEWS_RETENTION_MS + 60_000 }), NOW);
    upsertNews(db, row('drop', { publishedAt: NOW - NEWS_RETENTION_MS - 60_000 }), NOW);
    expect(pruneNews(db, NOW - NEWS_RETENTION_MS)).toBe(1);
    expect(getRecentNews(db, 0).map(r => r.id)).toEqual(['keep']);
  });

  it('保持期間は 30 日', () => {
    expect(NEWS_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('★冪等な後付け(既存 DB へのマイグレーション)', () => {
  it('initSchema を何度呼んでも壊れない', () => {
    const { db } = tmpDb();
    upsertNews(db, row('a'), NOW);
    initSchema(db);
    initSchema(db);
    expect(getRecentNews(db, 0)).toHaveLength(1);
  });

  it('★confidence 列を持たない旧 news 表に、後から列が足される(データは残る)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'news-old-')), 'jp225.db');
    // 「確度が無かった世代」の DB を手で作る。
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE news (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, lang TEXT NOT NULL,
        url TEXT NOT NULL, published_at INTEGER NOT NULL, first_seen_at INTEGER NOT NULL,
        impact_score REAL, category TEXT, impact_json TEXT
      );
    `);
    old.prepare('INSERT INTO news VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('legacy', '旧世代の見出し', 'NHK', 'ja', 'https://x/1', NOW - 60_000, NOW, 1.0, 'economy', '{}');
    old.close();

    // 新しい版で開くと、列が後付けされ、既存行はそのまま残る。
    const db = openDb(path);
    const cols = (db.prepare('PRAGMA table_info(news)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('confidence');
    expect(cols).toContain('confidence_basis');
    const rows = getRecentNews(db, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('legacy');
    expect(rows[0]!.confidence).toBeNull();   // 旧行は NULL のまま

    // その後の upsert で確度が入る。
    upsertNews(db, row('legacy', { title: '旧世代の見出し', confidence: 'unconfirmed', confidenceBasis: 'single' }), NOW + 1);
    expect(getRecentNews(db, 0)[0]!.confidence).toBe('unconfirmed');
  });
});
