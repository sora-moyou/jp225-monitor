// 台帳(提案生成器の generator_proposals.db / 影の shadow_exits.db)の **同期フォルダへの書き出し**。
//
// ■ なぜ要るか
//   この2つは1年かけて溜める標本そのものなのに、書き出し経路が **どこにも無かった**。
//   = 1年分の標本が実売買PCの1ファイルにしか存在しない状態。過去に「別PCの書き出しが空だった」
//     実事故(原因の特定に版を2つ費やした)があるので、人手の運用ではなく機構で担保する。
//
// ■ ★ティックの日次書き出しと **同じ流儀**(新しい機構を作らない)
//   ・置き場所は同じ設定を読む(resolveTickExportDir = trade2 の export.json の exportDir)。
//     monitor 側に2つ目の書き出し設定を作らない(二重管理にすると片方だけ直して無音でズレる)。
//   ・一時ファイルへ書いてから rename(部分書き込みのファイルを同期フォルダに置かない)。
//   ・状態は **共有DB(jp225.db)の meta** に書く。meta は trade2 の 30分ごとの `VACUUM INTO`
//     (prices_<host>.db)にそのまま乗るので、別PCからでも「書けているか」が読める
//     (server/db/tickArchiveHeartbeat.ts と同じ置き場・同じ発想)。
//   ・呼び出しは collector の毎時の書き出しブロック(ティックと同じ場所・同じ間隔)。
//
// ■ ★ティックと違う点(と、その理由)
//   ティックは「確定した過去日」を1日1ファイルで **追記** するが、台帳は追記のみの単一ファイルで
//   日ごとに割れない。→ 毎回 **丸ごとスナップショットを上書き** する(同じファイル名)。
//   複製は `VACUUM INTO`: WAL で書かれている最中でも一貫したスナップショットが取れる
//   (ファイルコピーは WAL を取りこぼす)。読み側は必ず **readOnly** で開く(原本を触らない)。
//   ホスト名をファイル名に入れるのは prices_<host>.db と同じ理由(複数PCの書き出しが衝突しない)。
//
// ■ ★無音にしない
//   書き出しの結末(ok / missing / error)と **行数** を毎回 meta に残す。過去の事故は
//   「ファイルはあるのに空」だったので、bytes だけでなく行数を数えて出す。

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, rmSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAnalysisEnabled } from '../analysisGate.js';
import { getMeta, setMeta } from './store.js';
import { jstStamp } from './tickArchiveHeartbeat.js';
import { resolveGeneratorDbPath } from './generatorStore.js';
import { resolveShadowDbPath } from './shadowStore.js';

/** 共有DB(jp225.db)meta のキー。JSON 本体と、人が読む1行の2本(ティック保管と同じ作法)。 */
export const LEDGER_EXPORT_KEY = 'ledger_export';
export const LEDGER_EXPORT_STATUS_KEY = 'ledger_export_status';

/** 書き出す台帳。★ここに無いものは書き出さない(=新しい DB を足したら必ずここに足す)。 */
export interface LedgerSpec {
  /** ファイル名と meta に出る名前。 */
  label: string;
  /** 原本のパスを解決する関数(既存の解決関数をそのまま使う=パスの二重定義を作らない)。 */
  resolvePath: () => string;
  /** 中身が空でないことを確かめるために数える表。 */
  countTable: string;
}

export const LEDGER_SPECS: readonly LedgerSpec[] = [
  { label: 'generator_proposals', resolvePath: resolveGeneratorDbPath, countTable: 'proposals' },
  { label: 'shadow_exits', resolvePath: resolveShadowDbPath, countTable: 'shadow_exits' },
];

/** 1つの台帳の書き出し結果。**理由まで含めて** 記録する(無音の失敗を作らない)。 */
export interface LedgerExportResult {
  label: string;
  /** 'ok'=書けた / 'missing'=原本が無い(この PC ではまだ動いていない) / 'error'=失敗。 */
  state: 'ok' | 'missing' | 'error';
  src: string;
  file: string | null;
  /** 書き出したファイルの中の行数(★「ファイルはあるのに空」を検出するため)。 */
  rows: number | null;
  bytes: number | null;
  error: string | null;
  at: number;
}

/** ファイル名に使えるようにホスト名を均す(prices_<host>.db と同じ考え方)。 */
export function hostLabel(name: string = hostname()): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'unknown';
}

/** 書き出しファイル名 `<label>_<host>.db`。 */
export function ledgerExportFileName(label: string, host: string = hostLabel()): string {
  return `${label}_${host}.db`;
}

/** 台帳1つを同期フォルダへスナップショットする(原本は readOnly・一時ファイル → rename)。
 *  ★例外を外へ出さない: 1つ失敗しても残りは書き出し、失敗は結果の値として残す。 */
export function exportLedgerSnapshot(
  spec: LedgerSpec, destDir: string, now: number, host: string = hostLabel(),
): LedgerExportResult {
  const src = spec.resolvePath();
  const base = { label: spec.label, src, at: now };
  if (!existsSync(src)) {
    // まだ一度も動いていない = 失敗ではない。ただし「無い」ことは必ず残す(0件と観測不能を混同しない)。
    return { ...base, state: 'missing', file: null, rows: null, bytes: null, error: null };
  }
  const file = join(destDir, ledgerExportFileName(spec.label, host));
  const tmp = `${file}.tmp`;
  let db: DatabaseSync | null = null;
  try {
    mkdirSync(destDir, { recursive: true });
    for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`]) { try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } }
    // readOnly は node 24 ランタイムにあるが @types/node@20 の型に無いためキャストで通す(db/mergeDb.ts と同じ作法)。
    const opts = { readOnly: true } as unknown as ConstructorParameters<typeof DatabaseSync>[1];
    db = new DatabaseSync(src, opts);
    db.exec(`VACUUM INTO '${tmp.replace(/\\/g, '/')}'`);
    db.close();
    db = null;
    // ★中身を数える(書き出した **ファイルの方** を数える=原本を数えて安心する誤りを避ける)。
    const out = new DatabaseSync(tmp, opts);
    let rows: number | null = null;
    try {
      rows = (out.prepare(`SELECT COUNT(*) AS n FROM ${spec.countTable}`).get() as { n: number }).n;
    } catch {
      rows = null;   // 表がまだ無い(開いただけで一度も書いていない)= 行数不明。書き出しは続ける。
    } finally {
      try { out.close(); } catch { /* ignore */ }
    }
    renameSync(tmp, file);
    return { ...base, state: 'ok', file, rows, bytes: statSync(file).size, error: null };
  } catch (e) {
    try { db?.close(); } catch { /* ignore */ }
    for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`]) { try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } }
    return { ...base, state: 'error', file: null, rows: null, bytes: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 台帳を全部書き出す。destDir が '' なら何もしない(未設定=書き出さない・ティックと同じ表現)。
 *  ★公開版(lite)では走らない(分析専用の台帳なので、そもそも存在しない)。 */
export function runLedgerExport(
  destDir: string, now: number, specs: readonly LedgerSpec[] = LEDGER_SPECS, host: string = hostLabel(),
): LedgerExportResult[] {
  if (!destDir || !isAnalysisEnabled()) return [];
  return specs.map(s => exportLedgerSnapshot(s, destDir, now, host));
}

/** 人が読む1行(meta の ledger_export_status)。JSON と同じ構造体から **この関数だけ** で作る。 */
export function formatLedgerExportStatus(results: readonly LedgerExportResult[], now: number, destDir: string): string {
  const worst = results.some(r => r.state === 'error') ? 'ERROR'
    : results.length === 0 ? 'DISABLED'
      : results.every(r => r.state === 'ok') ? 'OK' : 'PARTIAL';
  const parts = [`${worst} ${jstStamp(now)} JST`, destDir ? `書出先=${destDir}` : '書出先=未設定(台帳は溜まり続ける)'];
  for (const r of results) {
    if (r.state === 'ok') parts.push(`${r.label}=${r.rows == null ? '?' : r.rows}件 ${r.bytes}バイト ${r.file}`);
    else if (r.state === 'missing') parts.push(`${r.label}=原本なし(${r.src})`);
    else parts.push(`★${r.label}=失敗: ${r.error}`);
  }
  return parts.join(' | ');
}

export interface LedgerExportHeartbeat {
  v: 1;
  at: number;
  atJst: string;
  destDir: string;
  results: LedgerExportResult[];
}

/** 書き出しの結末を共有DB(jp225.db)の meta に書く(= 30分スナップショットに自動で乗る)。 */
export function writeLedgerExportStatus(
  sharedDb: DatabaseSync, results: readonly LedgerExportResult[], now: number, destDir: string,
): LedgerExportHeartbeat {
  const hb: LedgerExportHeartbeat = {
    v: 1, at: now, atJst: jstStamp(now), destDir, results: [...results],
  };
  setMeta(sharedDb, LEDGER_EXPORT_KEY, JSON.stringify(hb));
  setMeta(sharedDb, LEDGER_EXPORT_STATUS_KEY, formatLedgerExportStatus(results, now, destDir));
  return hb;
}

/** 読み手側(スナップショットを開いた人)。★値が更新されなくなったことを「正常」と誤読させない。 */
export function readLedgerExportStatus(sharedDb: DatabaseSync): LedgerExportHeartbeat | null {
  const raw = getMeta(sharedDb, LEDGER_EXPORT_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as LedgerExportHeartbeat;
    return v && typeof v.at === 'number' && Array.isArray(v.results) ? v : null;
  } catch {
    return null;
  }
}
