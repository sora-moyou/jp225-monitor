// USD/JPY (JPY=X) の最新有効レートをディスク永続化。
// アプリ再起動直後でも前回終値ベースで USD 銘柄を JPY 換算できる。
//
// 保存先: ~/.jp225-monitor/jpy-cache.json
// 形式  : { rate: number, changePercent: number, timestamp: number }
//
// 設計方針 (v0.3.7+):
//   1. 起動時にディスクから読み込み (起動直後の取得失敗をカバー)
//   2. 新規取得値は範囲 [50, 300] でないと拒否
//   3. キャッシュ済みなら、変動 > 2% (1 tick で) は拒否 — データ corruption 防止
//   4. 妥当値なら毎 tick ディスク更新

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_DIR = () => join(homedir(), '.jp225-monitor');
const CACHE_FILE = () => join(CACHE_DIR(), 'jpy-cache.json');

// 1 tick (= 2 秒) で USD/JPY が 2% 動くことはまずあり得ない。これを超えるなら data 異常。
const MAX_TICK_CHANGE_FRACTION = 0.02;

interface JpyCache {
  rate: number;
  changePercent: number;
  timestamp: number;
}

let memCache: JpyCache | null = null;

function loadFromDisk(): JpyCache | null {
  const file = CACHE_FILE();
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as JpyCache;
    if (typeof raw.rate === 'number' && raw.rate >= 50 && raw.rate <= 300) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

function saveToDisk(c: JpyCache): void {
  try {
    mkdirSync(CACHE_DIR(), { recursive: true });
    writeFileSync(CACHE_FILE(), JSON.stringify(c, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[jpyCache] save failed:', err instanceof Error ? err.message : err);
  }
}

/** 起動時に呼ぶ。前回保存されていたレートをメモリに読み込む。 */
export function initJpyRateCache(): void {
  memCache = loadFromDisk();
  if (memCache) {
    const ageMin = Math.round((Date.now() - memCache.timestamp) / 60_000);
    console.log(`[jpyCache] loaded from disk: ${memCache.rate} (${ageMin} 分前の値)`);
  } else {
    console.log('[jpyCache] no prior cache, will populate on first valid fetch');
  }
}

/**
 * Yahoo から取得した JPY=X 値を検証して、有効ならキャッシュ更新。
 * 戻り値: 'updated' / 'rejected_range' / 'rejected_jump' / 'no_input'
 */
export function tryUpdate(rate: number | undefined, changePercent: number | undefined): 'updated' | 'rejected_range' | 'rejected_jump' | 'no_input' {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'no_input';

  // 範囲チェック (現実的な USD/JPY)
  if (rate < 50 || rate > 300) {
    console.warn(`[jpyCache] reject (out of range): ${rate}`);
    return 'rejected_range';
  }

  // 急変動チェック (キャッシュ済みの場合のみ)
  if (memCache && memCache.rate > 0) {
    const delta = Math.abs(rate - memCache.rate) / memCache.rate;
    if (delta > MAX_TICK_CHANGE_FRACTION) {
      console.warn(`[jpyCache] reject (sudden jump): ${memCache.rate} → ${rate} (Δ${(delta * 100).toFixed(2)}%)`);
      return 'rejected_jump';
    }
  }

  // changePercent の sanity check (±20% 以内のみ採用、外なら 0)
  const chg = typeof changePercent === 'number' && Math.abs(changePercent) <= 20 ? changePercent : 0;

  memCache = { rate, changePercent: chg, timestamp: Date.now() };
  saveToDisk(memCache);
  return 'updated';
}

/** 現在の有効レート (0 = まだ取得できていない)。 */
export function getRate(): number {
  return memCache?.rate ?? 0;
}

/** 現在の有効 changePercent。 */
export function getChangePercent(): number {
  return memCache?.changePercent ?? 0;
}

/** デバッグ / ステータス用。 */
export function getCacheInfo(): { rate: number; ageMs: number } | null {
  if (!memCache) return null;
  return { rate: memCache.rate, ageMs: Date.now() - memCache.timestamp };
}
