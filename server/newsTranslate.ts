// server/newsTranslate.ts — 「取得したときに一度だけ訳して DB に貯める」層。
//
// ★設計の要点(壊してはいけない順):
//   1. 翻訳の失敗で **ニュースが消えない・遅れない**。取得と表示は翻訳を待たない(非同期・best-effort)。
//   2. 同じ記事を 2 回訳さない。判定は DB の title_ja / translate_error(=永続)で行うので、
//      再起動しても訳し直さない。ここが今回の永続化が効くところ。
//   3. AI が読む面(title)は 1 バイトも変えない。訳文は titleJa という別欄にだけ入る。
//   4. 無言の失敗を作らない。訳せなかった記事は理由を持ち、画面に控えめな印が出る。

import type { DatabaseSync } from 'node:sqlite';
import type { NewsItem } from '../core/types.js';
import {
  openDb, resolveDbPath, getNewsTranslations, setNewsTranslation,
} from './db/store.js';
import {
  translateTitles, TRANSLATE_MAX_PER_FETCH, type BatchCaller,
} from './llm/translateNews.js';

let db: DatabaseSync | null = null;

/** テスト用: DB ハンドルを捨てて次回に開き直させる。 */
export function resetNewsTranslateForTest(): void { db = null; }

function handle(): DatabaseSync {
  if (!db) db = openDb(resolveDbPath());
  return db;
}

/**
 * 保存済みの訳文を items に載せて返す(非破壊)。DB が読めなければ items をそのまま返す。
 * ★取得直後にこれを通すので、既知の記事は **LLM を一度も呼ばずに** 訳付きで表示される。
 */
export function attachStoredTranslations(items: readonly NewsItem[]): NewsItem[] {
  if (items.length === 0) return [...items];
  try {
    const rows = getNewsTranslations(handle(), items.map(n => n.id));
    const byId = new Map(rows.map(r => [r.id, r]));
    return items.map(n => {
      const r = byId.get(n.id);
      if (!r) return n;
      const out: NewsItem = { ...n };
      if (r.title_ja) out.titleJa = r.title_ja;
      if (r.translate_error) out.translateError = r.translate_error;
      return out;
    });
  } catch (err) {
    console.warn('[newsTranslate] read failed:', err instanceof Error ? err.message : err);
    db = null;
    return [...items];
  }
}

/**
 * まだ訳していない英語記事を選ぶ(純関数)。
 * ★対象は lang==='en' のみ。日本語記事は訳す必要がないので 1 円も使わない。
 * ★translateError を持つものは「一度試して失敗した」= 再試行しない。
 *   毎分リトライすると、LLM が落ちている間ずっと無駄に叩き続けて費用と 429 を生むため。
 *   手動での訳し直しは画面の「訳」ボタン(= 既存の /api/translate)に残してある。
 */
export function selectUntranslated(items: readonly NewsItem[], max = TRANSLATE_MAX_PER_FETCH): NewsItem[] {
  const out: NewsItem[] = [];
  for (const n of items) {
    if (n.lang !== 'en') continue;
    if (n.titleJa) continue;
    if (n.translateError) continue;
    if (!n.title.trim()) continue;
    out.push(n);
    if (out.length >= max) break;   // ★費用の歯止め(1回の取得あたり)
  }
  return out;
}

export interface TranslatePassResult {
  attempted: number;
  translated: number;
  failed: number;
  error: string | null;
}

/**
 * 未訳の英語記事を訳して DB に保存し、訳せたものを返す。
 * ★例外を投げない。呼び出し側(取得ループ)を止めないことが最優先。
 */
export async function translatePass(
  items: readonly NewsItem[],
  now = Date.now(),
  call?: BatchCaller,
): Promise<{ result: TranslatePassResult; updates: Map<string, { titleJa?: string; error?: string }> }> {
  const updates = new Map<string, { titleJa?: string; error?: string }>();
  const targets = selectUntranslated(items);
  const result: TranslatePassResult = { attempted: targets.length, translated: 0, failed: 0, error: null };
  if (targets.length === 0) return { result, updates };

  const { results, error } = await translateTitles(targets.map(n => n.title), call);
  result.error = error;

  for (let i = 0; i < targets.length; i++) {
    const n = targets[i]!;
    const ja = results[i];
    if (ja) {
      updates.set(n.id, { titleJa: ja });
      result.translated++;
    } else {
      // ★訳せなかったことを残す。残さないと「毎回だまって再挑戦し続ける」= 無言の失敗になる。
      updates.set(n.id, { error: error ?? '訳せませんでした' });
      result.failed++;
    }
  }

  try {
    const h = handle();
    for (const [id, u] of updates) {
      setNewsTranslation(h, id, u.titleJa ?? null, u.error ?? null, now);
    }
  } catch (err) {
    console.warn('[newsTranslate] write failed:', err instanceof Error ? err.message : err);
    db = null;   // 次回開き直す(訳文はメモリ側には載るので、この回の表示は生きる)
  }

  if (result.failed > 0 || result.error) {
    // ★画面だけでなくサーバログにも残す(「何件訳せなかったか」が後から数えられる形)。
    console.warn(`[newsTranslate] translated=${result.translated} failed=${result.failed} reason=${result.error ?? '-'}`);
  } else if (result.translated > 0) {
    console.log(`[newsTranslate] translated=${result.translated}`);
  }
  return { result, updates };
}

/** updates を items に反映した新配列を返す(非破壊)。 */
export function applyTranslations(
  items: readonly NewsItem[],
  updates: ReadonlyMap<string, { titleJa?: string; error?: string }>,
): NewsItem[] {
  if (updates.size === 0) return [...items];
  return items.map(n => {
    const u = updates.get(n.id);
    if (!u) return n;
    const out: NewsItem = { ...n };
    if (u.titleJa) out.titleJa = u.titleJa;
    if (u.error) out.translateError = u.error;
    return out;
  });
}
