#!/usr/bin/env node
// 別PCの jp225.db を、このPCの monitor DB(%APPDATA%/jp225-monitor/jp225.db)へ安全にマージする。
//
// 使い方:
//   1) 【重要】monitor アプリ・collector・jp225-Trade を完全停止する(DBへの書き込みを止める)
//      - monitor の Tauri アプリを閉じる
//      - collector を停止: taskkill /PID (Get-Content "$env:APPDATA\jp225-monitor\collector.pid") /F /T
//      - jp225-Trade を閉じる(読み取りのみだが念のため)
//   2) node scripts/merge-db.mjs <他PCのjp225.dbパス>
//      例: node scripts/merge-db.mjs C:/Users/user/Downloads/jp225.db
//
// 動作:
//   - 事前にローカル DB をバックアップ(jp225.db.bak-merge-YYYYMMDD-HHMMSS)
//   - alerts: id 以外の全列を INSERT OR IGNORE(v0.6.17 の UNIQUE 同一性索引 idx_alerts_identity が重複を弾く)
//   - bars_1m / ticks: PK(symbol,t)で INSERT OR IGNORE(列順差は列名明示で吸収)
//   - 整合性チェック(quick_check)と前後件数を表示
//
// 設計メモ: マージの DB ロジックは server/db/mergeDb.ts の mergeFrom と同一(OR IGNORE)。
//   v0.6.17 で alerts に UNIQUE 同一性索引が張られたため、素の INSERT は制約違反になる。
//   OR IGNORE なら完全一致のみ無視され「同時刻・別水準」等の正当に異なるアラートは保持される
//   (id は PC 間で食い違うが、索引が id を含まない自然な同一性で重複判定する)。

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const src = process.argv[2];
if (!src) {
  console.error('Usage: node scripts/merge-db.mjs <other jp225.db path>');
  process.exit(1);
}
if (!existsSync(src)) {
  console.error(`source not found: ${src}`);
  process.exit(1);
}
const localPath = join(process.env.APPDATA ?? '', 'jp225-monitor', 'jp225.db');
if (!existsSync(localPath)) {
  console.error(`local DB not found: ${localPath}`);
  process.exit(1);
}

// 書き込み中プロセスの簡易チェック(Windows)。あれば警告して中断。
function warnIfWriters() {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-Process -Name jp225-collector,jp225-sidecar,jp225-monitor -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name"', { encoding: 'utf-8' }).trim();
    if (out) {
      console.error('⚠ monitor/collector が稼働中の可能性: ' + out.replace(/\s+/g, ', '));
      console.error('  DB を完全停止してから再実行してください(破損防止)。中断します。');
      process.exit(2);
    }
  } catch { /* powershell 不在等は無視 */ }
}
warnIfWriters();

// バックアップ
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15); // YYYYMMDD-HHMMSS 風
const bak = localPath + `.bak-merge-${ts}`;
copyFileSync(localPath, bak);
console.log(`backup: ${bak}`);

const db = new DatabaseSync(localPath); // read-write
const cnt = (t) => db.prepare('SELECT COUNT(*) n FROM ' + t).get().n;
const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all();

const before = { alerts: cnt('alerts'), bars_1m: cnt('bars_1m'), ticks: cnt('ticks') };
console.log('BEFORE:', JSON.stringify(before));

const srcFwd = src.replace(/\\/g, '/');
db.exec(`ATTACH DATABASE '${srcFwd}' AS other`);
db.exec('BEGIN');
try {
  // alerts: id 以外の全列を OR IGNORE。UNIQUE 同一性索引(idx_alerts_identity)が重複を弾く。
  // (server/db/mergeDb.ts の mergeFrom と同ロジック。)
  const aList = cols('alerts').map((c) => c.name).filter((n) => n !== 'id').join(', ');
  const aRes = db.prepare(`INSERT OR IGNORE INTO main.alerts (${aList}) SELECT ${aList} FROM other.alerts`).run();
  console.log(`alerts 追加: ${aRes.changes} 行`);

  // bars_1m / ticks: PK(symbol,t)で OR IGNORE。列名明示(列順差吸収)。
  for (const t of ['bars_1m', 'ticks']) {
    const list = cols(t).map((c) => c.name).join(', ');
    db.prepare(`INSERT OR IGNORE INTO main.${t} (${list}) SELECT ${list} FROM other.${t}`).run();
  }

  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('ROLLBACK:', e.message);
  db.close();
  process.exit(1);
}
db.exec('DETACH DATABASE other');
try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* readers いれば PASSIVE 相当で可 */ }

const after = { alerts: cnt('alerts'), bars_1m: cnt('bars_1m'), ticks: cnt('ticks') };
console.log('AFTER :', JSON.stringify(after));
console.log('quick_check:', db.prepare('PRAGMA quick_check').get().quick_check);
const f = (t) => (t ? new Date(Number(t)).toISOString().slice(0, 16) : '-');
const ar = db.prepare('SELECT MIN(triggered_at) mn, MAX(triggered_at) mx FROM alerts').get();
console.log('alerts range:', f(ar.mn), '->', f(ar.mx));
db.close();
console.log('✅ merge done. 問題なければ backup は削除可:', bak);
