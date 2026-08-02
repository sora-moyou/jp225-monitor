import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── ★台帳(提案・影)の書き出し経路(C5) ──────────────────────────────────────
//
// 何を守っているか:
//   1年かけて溜める標本(generator_proposals.db / shadow_exits.db)に **書き出し経路が無かった**。
//   = 1年分が実売買PCの1ファイルにしか存在しない。過去に「別PCの書き出しが空だった」実事故が
//   あるので、①機構で書き出し、②その **成否と件数** を必ず観測できるようにする。
//
// ★否定対照: git show HEAD:collector/index.ts / server/db/ledgerExport.ts(存在しない)に戻すと
//   このファイルは import 解決に失敗して全部赤(=書き出し経路が無いことの証明)。

import {
  exportLedgerSnapshot, runLedgerExport, formatLedgerExportStatus,
  writeLedgerExportStatus, readLedgerExportStatus, ledgerExportFileName, hostLabel,
  LEDGER_EXPORT_STATUS_KEY, LEDGER_SPECS, type LedgerSpec,
} from './ledgerExport.js';
import { openDb, getMeta } from './store.js';

let dir = '';
const paths = { gen: '', shadow: '', dest: '' };

/** 中身のある台帳を作る(表と行を持たせる)。 */
function makeLedger(path: string, table: string, rows: number): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, v TEXT)`);
  const st = db.prepare(`INSERT INTO ${table} (v) VALUES (?)`);
  for (let i = 0; i < rows; i++) st.run(`r${i}`);
  db.close();
}

const specOf = (label: string, path: string, table: string): LedgerSpec =>
  ({ label, resolvePath: () => path, countTable: table });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-export-'));
  paths.gen = join(dir, 'generator_proposals.db');
  paths.shadow = join(dir, 'shadow_exits.db');
  paths.dest = join(dir, 'sync');
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('台帳を同期フォルダへ書き出す', () => {
  it('★原本(readOnly)を一貫スナップショットして、行数まで数えて返す', () => {
    makeLedger(paths.gen, 'proposals', 7);
    const r = exportLedgerSnapshot(specOf('generator_proposals', paths.gen, 'proposals'), paths.dest, 1_700_000_000_000, 'kabu');
    expect(r.state).toBe('ok');
    expect(r.rows).toBe(7);                      // ★「ファイルはあるのに空」を検出できる
    expect(r.file).toBe(join(paths.dest, 'generator_proposals_kabu.db'));
    expect(existsSync(r.file!)).toBe(true);
    expect(r.bytes).toBe(statSync(r.file!).size);
    // 書き出したファイルは単独で開けて、同じ行数が読める(=別PCで解析できる)。
    const out = new DatabaseSync(r.file!);
    expect((out.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n).toBe(7);
    out.close();
    // 一時ファイルを残さない(部分書き込みを同期フォルダに置かない)。
    expect(existsSync(`${r.file}.tmp`)).toBe(false);
  });

  it('原本が無ければ missing(失敗ではない・作りもしない)', () => {
    const r = exportLedgerSnapshot(specOf('shadow_exits', paths.shadow, 'shadow_exits'), paths.dest, 1, 'kabu');
    expect(r.state).toBe('missing');
    expect(existsSync(paths.shadow)).toBe(false);
    expect(r.rows).toBeNull();
  });

  it('★壊れたファイルでも例外を投げず、理由を値として残す(無音にしない)', () => {
    writeFileSync(paths.gen, 'not a sqlite file');
    const r = exportLedgerSnapshot(specOf('generator_proposals', paths.gen, 'proposals'), paths.dest, 1, 'kabu');
    expect(r.state).toBe('error');
    expect(r.error).toBeTruthy();
  });

  it('2回書き出すと最新で上書きされる(追記の台帳を丸ごと差し替える)', () => {
    makeLedger(paths.gen, 'proposals', 2);
    const spec = specOf('generator_proposals', paths.gen, 'proposals');
    const first = exportLedgerSnapshot(spec, paths.dest, 1, 'kabu');
    const db = new DatabaseSync(paths.gen);
    db.prepare('INSERT INTO proposals (v) VALUES (?)').run('more');
    db.close();
    const second = exportLedgerSnapshot(spec, paths.dest, 2, 'kabu');
    expect(first.rows).toBe(2);
    expect(second.rows).toBe(3);
    expect(second.file).toBe(first.file);
  });

  it('書き出し先が未設定なら何もしない(台帳は溜まり続ける=ティックと同じ表現)', () => {
    makeLedger(paths.gen, 'proposals', 1);
    expect(runLedgerExport('', 1, [specOf('generator_proposals', paths.gen, 'proposals')])).toEqual([]);
  });

  it('★書き出す台帳の一覧に、提案の台帳と影の台帳が両方入っている', () => {
    expect(LEDGER_SPECS.map(s => s.label).sort()).toEqual(['generator_proposals', 'shadow_exits']);
  });

  it('ファイル名にホストが入る(複数PCの書き出しが衝突しない)', () => {
    expect(ledgerExportFileName('shadow_exits', 'kabu-pc')).toBe('shadow_exits_kabu-pc.db');
    expect(hostLabel('KABU_PC 01')).toBe('kabu-pc-01');
  });
});

describe('★成否が観測できる(共有DBの meta = 既存の30分スナップショットに乗る)', () => {
  it('件数つきの1行と JSON が meta に残る', () => {
    makeLedger(paths.gen, 'proposals', 4);
    const results = [
      exportLedgerSnapshot(specOf('generator_proposals', paths.gen, 'proposals'), paths.dest, 1_700_000_000_000, 'kabu'),
      exportLedgerSnapshot(specOf('shadow_exits', paths.shadow, 'shadow_exits'), paths.dest, 1_700_000_000_000, 'kabu'),
    ];
    const shared = openDb(':memory:');
    writeLedgerExportStatus(shared, results, 1_700_000_000_000, paths.dest);

    const line = getMeta(shared, LEDGER_EXPORT_STATUS_KEY)!;
    expect(line).toContain('PARTIAL');                    // 片方 ok / 片方 原本なし
    expect(line).toContain('generator_proposals=4件');    // ★件数が読める(空だと気づける)
    expect(line).toContain('shadow_exits=原本なし');

    const hb = readLedgerExportStatus(shared)!;
    expect(hb.results.map(r => r.state)).toEqual(['ok', 'missing']);
    expect(hb.destDir).toBe(paths.dest);
    shared.close();
  });

  it('失敗は ★つきで1行に出る(見た目で分かる)', () => {
    const failed = [{
      label: 'shadow_exits', state: 'error' as const, src: 'x', file: null,
      rows: null, bytes: null, error: 'disk full', at: 1_700_000_000_000,
    }];
    const line = formatLedgerExportStatus(failed, 1_700_000_000_000, paths.dest);
    expect(line.startsWith('ERROR')).toBe(true);
    expect(line).toContain('★shadow_exits=失敗: disk full');
  });
});
