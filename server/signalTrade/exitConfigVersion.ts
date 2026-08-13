// 決済(phase-exit)設定の「版」を各トレードに残す(RECORD-ONLY・決済ロジックには一切触れない)。
//
// ■ なぜ今から記録するか
//   将来ラダーを調整可能にしたとき、「この取引はどの設定で決済されたか」が無いと過去と比較できない。
//   調整可能になってから記録を始めると、それ以前の行が「版が不明」なのか「版1」なのか区別できなくなる。
//   → **値が固定の今から** 記録を始める(今日から version=1)。
//
// ■ なぜ値そのものを記録しないか
//   記録は同期フォルダ(Documents/trade)経由で機外に出る。決済ラダーの実数値は非公開
//   (server/signalTrade/exit/private.ts・gitignored)なので、DB にもログにもエラーメッセージにも
//   **絶対に出さない**。→ 一方向ハッシュ(16桁hex)だけを残す。
//
// ■ ハッシュの取り方 = 「実際に走った決済関数の振る舞い」の指紋
//   private.ts の中身を読んでハッシュするのではなく、**公開 API の computeExitStop を決定論的な
//   入力グリッドで叩き、その出力列をハッシュ**する。
//     - ラダーの閾値・床・トレール幅のどれが変わっても出力が変わる = 版が変わる。
//     - 説明文(describeExitLogic)の言い回しを直しただけでは版が変わらない(誤った版上げをしない)。
//     - private.ts のファイル所在/形式に依存しない(公開フォールバックでも同じ手順で指紋が取れる)。
//     - 出力そのものは **一度も外へ出ない**(ハッシュ入力として消費するだけ)。
//   computeExitStopPrivate は純関数(ExitState → number|null)なので、この試打は engine の状態にも
//   建玉にも一切影響しない。
//
// ■ 版番号(単調増加の整数)をハッシュとは別に持つ理由
//   ハッシュだけでは順序が読めない(「どちらが新しい設定か」が分からない)。DB の
//   exit_config_versions(hash→version)に初出順で 1,2,3… を採番し、同じハッシュには同じ版を返す
//   (設定を元に戻したら版も元に戻る=同一設定が別版になって集計が割れない)。

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  computeExitStop, computeExitStopSimple, exitImplLoadPending, exitImplStatus,
  type ExitFn, type ExitImplStatus, type ExitState,
} from './exit/index.js';

// 試打グリッド(決定論・固定)。★この定数を変えるとハッシュが全部変わる(=過去の版と繋がらなくなる)ため、
//   よほどの理由が無い限り変更しないこと。変更するなら版体系のリセットとして扱うこと。
const PROBE_DIRECTIONS: readonly ('buy' | 'sell')[] = ['buy', 'sell'];
const PROBE_ENTRIES: readonly number[] = [30000, 67000, 67003];   // 価格丸めの有無を跨ぐ建値(端数あり/なし)
const PROBE_STOP_OFFSETS: readonly number[] = [10, 55, 200];      // |建値 − 初期LC|
const PROBE_PEAK_MAX = 800;                                       // 含み益ピーク 0..800pt を1pt刻みで走査
const PROBE_PEAK_STEP = 1;

/** 指定した決済関数の振る舞い指紋(16桁hex)。出力値はハッシュに食わせるだけで、どこにも出さない。
 *  ★グローバルの実装(computeExitStop)に触らない純関数なので、公開フォールバックの指紋を
 *   「実装を差し替えずに」取ることができる(台帳の誤採番を見分けるのに使う)。 */
export function computeExitConfigHashWith(exit: ExitFn): string {
  const h = createHash('sha256');
  h.update('exit-probe-v1\n');
  for (const direction of PROBE_DIRECTIONS) {
    for (const entryPrice of PROBE_ENTRIES) {
      for (const off of PROBE_STOP_OFFSETS) {
        const initialStop = direction === 'buy' ? entryPrice - off : entryPrice + off;
        for (let peakProfit = 0; peakProfit <= PROBE_PEAK_MAX; peakProfit += PROBE_PEAK_STEP) {
          const s: ExitState = { direction, entryPrice, initialStop, peakProfit };
          const out = exit(s);
          // 建値からの相対にして丸め誤差を排除(絶対価格そのものは食わせない)。
          h.update(out === null ? 'n;' : `${(out - entryPrice).toFixed(4)};`);
        }
      }
    }
  }
  return h.digest('hex').slice(0, 16);
}

/** 決済関数の振る舞い指紋(16桁hex)。**現在有効な実装**(computeExitStop)で試打する。 */
export function computeExitConfigHash(): string {
  return computeExitConfigHashWith(computeExitStop);
}

/** 公開フォールバック(初期LC固定・ラチェット無し)そのものの指紋。**実装には一切触れない**。
 *  非公開実装が有効なプロセスでこの指紋が台帳に居たら、それは「実装が確定する前に採番された誤り」。 */
export function publicFallbackExitConfigHash(): string {
  return fallbackHash ??= computeExitConfigHashWith(computeExitStopSimple);
}
let fallbackHash: string | null = null;

/** hash → 単調増加の版番号。初出は max(version)+1(最初は 1)、既出は同じ版を返す。 */
export function resolveExitConfigVersion(db: DatabaseSync, hash: string, now: number): number {
  db.exec(`CREATE TABLE IF NOT EXISTS exit_config_versions (
    hash TEXT PRIMARY KEY, version INTEGER NOT NULL, first_seen INTEGER NOT NULL
  )`);
  const found = db.prepare('SELECT version FROM exit_config_versions WHERE hash = ?').get(hash) as { version: number } | undefined;
  if (found) return found.version;
  const max = (db.prepare('SELECT MAX(version) AS m FROM exit_config_versions').get() as { m: number | null }).m ?? 0;
  const version = max + 1;
  // 別プロセスと競合しても壊れないように OR IGNORE → 入らなければ既存版を読み直す。
  db.prepare('INSERT OR IGNORE INTO exit_config_versions (hash, version, first_seen) VALUES (?, ?, ?)')
    .run(hash, version, now);
  const row = db.prepare('SELECT version FROM exit_config_versions WHERE hash = ?').get(hash) as { version: number } | undefined;
  return row?.version ?? version;
}

/** hash → 既に採番済みの版番号(**読み取り専用**・未採番/表未作成は null)。
 *  診断表示(/api/status)から呼ぶための入口。resolveExitConfigVersion と違って
 *  **採番も表作成もしない**(表示のために台帳へ行を足さない)。SQL の知識はこのモジュールに閉じる。 */
export function lookupExitConfigVersion(db: DatabaseSync, hash: string): number | null {
  try {
    const row = db.prepare('SELECT version FROM exit_config_versions WHERE hash = ?').get(hash) as { version: number } | undefined;
    return row?.version ?? null;
  } catch {
    return null;   // 表がまだ無い(=一度も決済していない)。表示上は「未採番」。
  }
}

export interface ExitConfigStamp { version: number; hash: string; }

// ─── ★実装が確定していないときに指紋を確定させない ───────────────────────────────
//
// ■ 直した欠陥(実運用で起きたこと・消すとまた同じ壊れ方をする)
//   起動順序は server/index.ts:176-177 で
//     ① void loadExitImpl()      … 完了を待たない(非公開実装の import は in-flight)
//     ② void startSignalEngine() … engine.start() の `await loadExitImpl()` は **待たずに** 'simple' を受領
//                                  (exit/index.ts の「2人目は待たせない」早期 return)
//     ③ engine.start() が warmExitConfigHash() を呼ぶ ← ここで **公開フォールバックの指紋** が焼き付く
//   焼き付いた値はプロセスの寿命のあいだ返り続けるので、① が private を読み終えた後も
//   台帳の採番・取引に刻む版・/api/status・分析用の runs が **全部その嘘の指紋** になる。
//   実測: 実装 private のまま /api/status が f7264…(=公開フォールバックの指紋)を返した。
//
// ■ 直し方
//   キャッシュを「そのとき有効だった実装の種別」で **鍵づけ** し、ロードが in-flight
//   (= 実装が未確定)の間は **計算も保存もしない**。未確定のあいだは「値が無い」と答える。
//   → 嘘の指紋が確定することも、それが記録に刻まれることも起こり得ない。
//   ★実装が確定したあと(private でも公開 lite の 'simple' でも)は従来どおり1回だけ計算してキャッシュする。
let cached: { status: ExitImplStatus; hash: string } | null = null;

/** テスト用: ハッシュのキャッシュを捨てる(実装を差し替えた後に呼ぶ)。 */
export function _resetExitConfigHashCache(): void { cached = null; }

/** 現在の決済設定の指紋(16桁hex)。**実装が未確定のあいだは null**(嘘の値を返さない)。
 *  一方向ハッシュなので実数値は復元できない=DB/CSV に既に載っているのと同じ粒度で診断表示にも出してよい。 */
export function exitConfigHashOrNull(): string | null {
  if (exitImplLoadPending()) return null;   // ★確定前は答えない・焼き付けない
  const status = exitImplStatus();
  if (cached && cached.status === status) return cached.hash;
  const hash = computeExitConfigHash();
  cached = { status, hash };
  return hash;
}

/** 起動時(loadExitImpl が **settle した後**)に指紋を先に計算しておく。決済確定時の記録経路から
 *  計算コストを外すため。★未確定のあいだは何もしない(焼き付けない)。
 *  失敗しても起動は止めない(記録専用)。 */
export function warmExitConfigHash(): void {
  try { exitConfigHashOrNull(); } catch { /* 記録専用: 起動は止めない */ }
}

/** そのトレードに刻む {版番号, ハッシュ}。失敗しても記録専用なので null を返して握りつぶす。
 *  ★実装が未確定なら **刻まない**(誤った版を記録するより、記録しない方がよい)。 */
export function exitConfigStamp(db: DatabaseSync, now: number): ExitConfigStamp | null {
  try {
    const hash = exitConfigHashOrNull();
    if (hash === null) return null;
    return { version: resolveExitConfigVersion(db, hash, now), hash };
  } catch {
    return null;
  }
}

// ─── ★既に誤って採番された版に印をつける(追記のみ・過去の行は書き換えない) ─────────────
//
// 焼き付いた指紋は台帳(exit_config_versions)に **公開フォールバックの指紋** として採番済みで、
// その版が取引にも分析用の runs にも刻まれている。台帳の行を消す/採番し直すのは
// 「過去の記録を書き換えない」に反するし、既に刻まれた取引の版番号は動かせない。
// → **別表に追記** して「この版は公開フォールバックの指紋 = 非公開実装のプロセスで採番されたなら誤り」
//   と分かる形にする。1年後の分析者は runs / signal_trades をこの表と突き合わせるだけで、
//   汚染された行を機械的に除外できる。
const NOTE_PUBLIC_FALLBACK = 'public-fallback-fingerprint';

export interface ExitConfigVersionNote { hash: string; version: number; }

/** 非公開実装が有効なプロセスで、台帳に **公開フォールバックの指紋** の版が居たら印をつける(冪等)。
 *  - 実装が確定していない/非公開実装でないときは **何もしない**(公開 lite ではその版が正しいため)。
 *  - 印は追記のみ。exit_config_versions の行(hash/version/first_seen)には一切触れない。
 *  - 記録専用なので失敗は握りつぶして null を返す(起動を止めない)。 */
export function markFallbackExitConfigVersion(db: DatabaseSync, now: number): ExitConfigVersionNote | null {
  try {
    if (exitImplLoadPending() || exitImplStatus() !== 'private') return null;
    const hash = publicFallbackExitConfigHash();
    const found = lookupExitConfigVersion(db, hash);
    if (found === null) return null;   // 汚染された版は存在しない(健全)
    db.exec(`CREATE TABLE IF NOT EXISTS exit_config_version_notes (
      hash TEXT PRIMARY KEY, version INTEGER NOT NULL, note TEXT NOT NULL, noted_at INTEGER NOT NULL
    )`);
    db.prepare('INSERT OR IGNORE INTO exit_config_version_notes (hash, version, note, noted_at) VALUES (?, ?, ?, ?)')
      .run(hash, found, NOTE_PUBLIC_FALLBACK, now);
    return { hash, version: found };
  } catch {
    return null;
  }
}
