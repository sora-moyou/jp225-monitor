// バックテスト用DB(や任意の SQLite)を、読み取り専用で開いて VACUUM INTO で1ファイルに書き出す。
// WAL(-wal)にだけある分も含めた整合の取れた写しになる。元ファイルには書かない。
// 出力先に既にファイルがあれば中止(上書きしない)。
//
// Run: npx tsx scripts/backtest-db/snapshot.mts --db <元> --out <写し>
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dbOpenOptions } from '../../server/backtestDb/schema.js';

const argv = process.argv.slice(2);
const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const SRC = val('--db');
const OUT = val('--out');
if (!SRC || !OUT) { console.error('usage: snapshot.mts --db <元> --out <写し>'); process.exit(2); }
if (!existsSync(SRC)) { console.error(`無い: ${SRC}`); process.exit(2); }
if (existsSync(OUT)) { console.error(`出力先が既にある(上書きしない): ${OUT}`); process.exit(1); }

const src = new DatabaseSync(SRC, dbOpenOptions(true));
src.exec('PRAGMA busy_timeout = 30000');
src.prepare('VACUUM INTO ?').run(OUT);
src.close();
const d = new DatabaseSync(OUT, dbOpenOptions(true));
const r = d.prepare('SELECT COUNT(*) n, MIN(t) a, MAX(t) b FROM bars_1m').get() as { n: number; a: number; b: number };
const jst = (t: number) => new Date(t + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
console.log(`写し ${OUT}: bars_1m ${r.n} 本 ${jst(r.a)}..${jst(r.b)} JST`);
d.close();
