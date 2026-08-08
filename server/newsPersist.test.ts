import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewsItem } from '../core/types.js';
import { withConfidence } from '../core/newsConfidence.js';
import { openDb, resolveDbPath, getRecentNews } from './db/store.js';
import { persistNews, attachStoredConfidence, resetNewsPersistForTest } from './newsPersist.js';

const NOW = 1_800_000_000_000;

function item(id: string, title: string, source: string): NewsItem {
  return { id, title, source, lang: 'ja', url: `https://x/${id}`, publishedAt: NOW - 60_000 };
}

/** 実ファイルの SQLite を使う(隔離先。appDataDir がテスト中は必ず tmp へ寄せる)。 */
function freshDb() {
  process.env.APPDATA = mkdtempSync(join(tmpdir(), 'np-'));
  resetNewsPersistForTest();
  return openDb(resolveDbPath());
}

describe('★確度の逆行(確認済み → 未確認)を実 SQLite で塞ぐ', () => {
  beforeEach(() => { freshDb(); });

  it('裏取り相手が窓から落ちても、DB も配信payload も確認済みのまま', () => {
    const first = item('a', '日銀が政策金利を0.75%へ引き上げ', 'ZeroHedge');
    const other = item('b', '日銀が政策金利を0.75%へ引き上げると発表', 'ForexLive');

    // T: 2社が同じ出来事を報じている → a は裏取り成立
    const t0 = withConfidence([first, other]);
    expect(t0.find(x => x.id === 'a')!.confidence!.basis).toBe('corroborated');
    expect(persistNews(t0, NOW)).toBe(2);

    // T+n: b が 200 件の窓から押し出された。その時点の判定だけを見ると a は single に戻る。
    const t1raw = withConfidence([first]);
    expect(t1raw[0]!.confidence!.basis).toBe('single');       // ← 逆行が実在することの否定対照

    // 保存済みを載せ直すと確認済みのまま(= 画面に配信される payload が降格しない)
    const t1 = attachStoredConfidence(t1raw);
    expect(t1[0]!.confidence!.level).toBe('confirmed');
    expect(t1[0]!.confidence!.basis).toBe('corroborated');

    // 万一 single のまま upsert されても、DB 側でも降格しない(二重の歯止め)
    persistNews(t1raw, NOW + 1);
    const rowA = getRecentNews(openDb(resolveDbPath()), 0).find(r => r.id === 'a')!;
    expect(rowA.confidence).toBe('confirmed');
    expect(rowA.confidence_basis).toBe('corroborated');
  });

  it('未確認のままの記事は未確認のまま(前進していないのに確認済みにしない)', () => {
    const solo = withConfidence([item('c', '独自の第一報', 'ZeroHedge')]);
    persistNews(solo, NOW);
    const again = attachStoredConfidence(withConfidence([item('c', '独自の第一報', 'ZeroHedge')]));
    expect(again[0]!.confidence!.level).toBe('unconfirmed');
  });

  it('DB に記録が無ければ今回の判定をそのまま返す(初回起動)', () => {
    const fresh = withConfidence([item('d', '初めて見る記事', 'ZeroHedge')]);
    expect(attachStoredConfidence(fresh)[0]!.confidence!.basis).toBe('single');
  });

  it('空配列でも落ちない', () => {
    expect(attachStoredConfidence([])).toEqual([]);
  });
});
