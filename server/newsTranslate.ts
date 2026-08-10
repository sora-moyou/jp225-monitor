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
import { shouldRetryTranslation, type TranslateRetryState } from './newsRetryPolicy.js';

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

// ─── 失敗した記事の再試行 ─────────────────────────────────────────────────
//
// ★事故(2026-08-10): 一度 translate_error が付いた記事は **永久に未訳**だった。
//   プロバイダ側の一過性の設定不備(400)で 430 件が固まり、原因を直しても救われなかった。
//   かといって毎分叩き直すのは、LLM が落ちている間ずっと費用と 429 を生むので論外。
//   → **回数と間隔の両方に上限**を置き、その上限を「記事が画面に居る時間」から逆算する。
//
// ─── 再試行ポリシーは葉モジュール(server/newsRetryPolicy.ts)が SSOT ────────────
//   窓の長さの実測値・バックオフ・回数上限・判定はすべてあちらにある(依存ゼロ=測定用スクリプトから
//   LLM 一式を読み込まずに検証できる)。ここでは従来どおり同じ名前で使えるよう再輸出するだけ。
export {
  NEWS_FETCH_WINDOW_MIN_MS, NEWS_PEAK_ARRIVAL_PER_MIN,
  TRANSLATE_RETRY_BACKOFF_MS, TRANSLATE_MAX_ATTEMPTS, TRANSLATE_RETRY_TOTAL_MS,
  shouldRetryTranslation,
} from './newsRetryPolicy.js';
export type { TranslateRetryState } from './newsRetryPolicy.js';

/**
 * まだ訳していない英語記事を選ぶ(純関数)。
 * ★対象は lang==='en' のみ。日本語記事は訳す必要がないので 1 円も使わない。
 * ★translateError を持つものは「一度試して失敗した」記事。retry(DB 由来の再試行状態)を渡したときだけ、
 *   バックオフと回数上限を満たしたものを **もう一度** 対象にする。retry 未指定なら従来どおり対象外。
 */
export function selectUntranslated(
  items: readonly NewsItem[],
  max = TRANSLATE_MAX_PER_FETCH,
  retry: ReadonlyMap<string, TranslateRetryState> = new Map(),
  now = Date.now(),
): NewsItem[] {
  const out: NewsItem[] = [];
  for (const n of items) {
    if (n.lang !== 'en') continue;
    if (n.titleJa) continue;
    if (n.translateError && !shouldRetryTranslation(retry.get(n.id), now)) continue;
    if (!n.title.trim()) continue;
    out.push(n);
    if (out.length >= max) break;   // ★費用の歯止め(1回の取得あたり)
  }
  return out;
}

/**
 * 失敗済み記事の再試行状態を DB から読む。
 * ★読めなければ空 Map を返す(= 再試行しない = 従来の挙動)。ここで投げると取得ループが止まる。
 * ★translate_attempts が NULL の行は、この列が無かった頃に失敗した行。「1回失敗済み」とみなす
 *   = 最初の再試行(10分後)の対象になる。事故で固まった既存 455 件がこれで救われる。
 *   (以後の失敗はプロバイダ側なら 0 に正規化されるので、次からは待ち無しで対象に戻る。)
 */
function readRetryStates(items: readonly NewsItem[]): Map<string, TranslateRetryState> {
  const out = new Map<string, TranslateRetryState>();
  const ids = items.filter(n => n.translateError).map(n => n.id);
  if (ids.length === 0) return out;
  try {
    for (const r of getNewsTranslations(handle(), ids)) {
      if (!r.translate_error) continue;
      out.set(r.id, { attempts: r.translate_attempts ?? 1, lastAttemptAt: r.translated_at ?? 0 });
    }
  } catch (err) {
    console.warn('[newsTranslate] 再試行状態を読めませんでした(再試行しません):', err instanceof Error ? err.message : err);
    db = null;
    return new Map();
  }
  return out;
}

export interface TranslatePassResult {
  attempted: number;
  translated: number;
  failed: number;
  /** ★そのうち「記事に固有の理由」で失敗し、再訳の回数を消費した件数。 */
  itemFailed: number;
  error: string | null;
}

/** 1記事ぶんの更新。★itemFailure=true のときだけ translate_attempts を消費する。 */
export interface TranslationUpdate { titleJa?: string; error?: string; itemFailure?: boolean }

/**
 * 未訳の英語記事を訳して DB に保存し、訳せたものを返す。
 * ★例外を投げない。呼び出し側(取得ループ)を止めないことが最優先。
 */
export async function translatePass(
  items: readonly NewsItem[],
  now = Date.now(),
  call?: BatchCaller,
): Promise<{ result: TranslatePassResult; updates: Map<string, TranslationUpdate> }> {
  const updates = new Map<string, TranslationUpdate>();
  const targets = selectUntranslated(items, TRANSLATE_MAX_PER_FETCH, readRetryStates(items), now);
  const result: TranslatePassResult = {
    attempted: targets.length, translated: 0, failed: 0, itemFailed: 0, error: null,
  };
  if (targets.length === 0) return { result, updates };

  const { results, failures, error } = await translateTitles(targets.map(n => n.title), call);
  result.error = error;

  for (let i = 0; i < targets.length; i++) {
    const n = targets[i]!;
    const ja = results[i];
    if (ja) {
      updates.set(n.id, { titleJa: ja });
      result.translated++;
    } else {
      // ★訳せなかったことを残す。残さないと「毎回だまって再挑戦し続ける」= 無言の失敗になる。
      // ★ただし **回数を消費するのは記事固有の失敗だけ**。プロバイダ側の障害で消費すると、
      //   障害が続いた分だけ窓の中の記事が焼き切れ、救済機能そのものが失われる。
      const itemFailure = failures[i] === 'item';
      updates.set(n.id, { error: error ?? '訳せませんでした', itemFailure });
      result.failed++;
      if (itemFailure) result.itemFailed++;
    }
  }

  try {
    const h = handle();
    for (const [id, u] of updates) {
      setNewsTranslation(h, id, u.titleJa ?? null, u.error ?? null, now, u.itemFailure === true);
    }
  } catch (err) {
    console.warn('[newsTranslate] write failed:', err instanceof Error ? err.message : err);
    db = null;   // 次回開き直す(訳文はメモリ側には載るので、この回の表示は生きる)
  }

  if (result.failed > 0 || result.error) {
    // ★画面だけでなくサーバログにも残す(「何件訳せなかったか」が後から数えられる形)。
    //   ★itemFailed = 再訳の回数を消費した件数。これが 0 なら「連鎖が落ちていただけ」で、
    //     次のパスで同じ記事がまた対象になる(=打ち止めに近づいていない)ことがログから読める。
    console.warn(`[newsTranslate] translated=${result.translated} failed=${result.failed}`
      + ` itemFailed=${result.itemFailed} reason=${result.error ?? '-'}`);
  } else if (result.translated > 0) {
    console.log(`[newsTranslate] translated=${result.translated}`);
  }
  return { result, updates };
}

/** updates を items に反映した新配列を返す(非破壊)。 */
export function applyTranslations(
  items: readonly NewsItem[],
  updates: ReadonlyMap<string, TranslationUpdate>,
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
