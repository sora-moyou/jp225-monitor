// 基礎データ publish の共有コア。scripts/basedata-publish.mts(CLI)と
// server/routes/basedata.ts(ワンボタン公開)が同一実装を共有する(SSOT)。
// 日付変換は server/basedataDate.ts:rowToBar が唯一の正準実装(取り込み側と共有)。
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import XLSX from 'xlsx';
import { rowToBar, type BaseBar } from '../basedataDate.js';

const JST = 9 * 3600_000;

export interface BaseMeta { generatedAt: string; firstBar: number; lastBar: number; count: number; }

// ★basedata-latest は必ず public の jp225-monitor へ公開する(アプリの取得元 server/routes/basedata.ts と一致)。
//   dev origin が private の jp225-monitor2 に移ったため、--repo を明示しないと private 側へ誤公開してしまう
//   (=アプリが取得できず取込不能)。取り違え防止に repo をハードコードする。
export const BASEDATA_REPO = 'sora-moyou/jp225-monitor';

/** ダウンロードした ZIP(225labo の配布形式=xlsx を内包)から内側の xlsx バイト列を取り出す。
 *  - .xlsx エントリを含む → それを解凍して返す(複数あれば N225minif*.xlsx 優先、無ければ先頭 .xlsx)。
 *  - 既に生 xlsx(=[Content_Types].xml/xl/workbook.xml を持つ ZIP)→ そのまま返す。
 *  - どちらでもない → JP エラーで throw。
 *  純関数(ネット非依存)=テスト対象。 */
export function extractXlsxFromZip(buf: Buffer): Buffer {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buf));
  } catch (e) {
    throw new Error(`ZIP の展開に失敗しました(${e instanceof Error ? e.message : String(e)})`);
  }
  const names = Object.keys(entries);
  const xlsxNames = names.filter(n => n.toLowerCase().endsWith('.xlsx'));
  if (xlsxNames.length > 0) {
    const pick = xlsxNames.find(n => /n225minif.*\.xlsx$/i.test(n)) ?? xlsxNames[0]!;
    return Buffer.from(entries[pick]!);
  }
  // .xlsx エントリが無い = このバッファ自体が xlsx(OOXML の内部エントリを持つ ZIP)。
  if (names.some(n => n === '[Content_Types].xml' || n.startsWith('xl/'))) return buf;
  throw new Error('基礎データの取得に失敗(ZIP 内に xlsx が見つかりません)');
}

/** xlsx バッファ('1min' シート) → BaseBar[]。rowToBar でマッピング→ソート。
 *  未来バー検出時 throw(=日付バグを顕在化)。空データも throw。 */
export function xlsxBufferToBars(buf: Buffer): BaseBar[] {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets['1min'];
  if (!ws) throw new Error('sheet "1min" not found');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as unknown[][];
  const bars: BaseBar[] = [];
  for (let i = 1; i < rows.length; i++) {
    const [d, tm, o, h, l, c, v] = rows[i] as (number | undefined)[];
    if (typeof d !== 'number' || typeof tm !== 'number' || typeof o !== 'number') continue;
    bars.push(rowToBar(d, tm, o, h!, l!, c!, typeof v === 'number' ? v : null));
  }
  bars.sort((a, b) => a.t - b.t);
  if (bars.length === 0) throw new Error('no data rows parsed');

  // 未来日時のバーは「取り込みエラー(=日付バグ)」として publish を中止する(黙殺せず顕在化)。方針は
  // 取り込み方法に合わせる(server/basedata.ts:importBars が未来バーをドロップ+error ログする基準実装)。
  // 正しくマッピングできていれば未来バーは出ないはず。
  const future = bars.filter(b => b.t > Date.now() + 2 * 60_000);
  if (future.length > 0) {
    const sample = future.slice(0, 3).map(b => new Date(b.t + JST).toISOString().replace('T', ' ').slice(0, 16)).join(', ');
    throw new Error(`未来日時のバーを検出(${future.length}本・例 ${sample} JST)。`
      + `日付マッピング/ソースを確認してください(server/basedataDate.ts)。`);
  }
  return bars;
}

/** BaseBar[] → gz(ndjson.gz)+ meta。generatedAt は呼び出し側から nowIso を注入(テスト決定性)。 */
export function barsToGzMeta(bars: BaseBar[], nowIso: string): { gz: Buffer; meta: BaseMeta; ndjson: string } {
  const ndjson = bars.map(b => JSON.stringify(b)).join('\n') + '\n';
  const gz = gzipSync(Buffer.from(ndjson, 'utf-8'));
  const meta: BaseMeta = { generatedAt: nowIso, firstBar: bars[0]!.t, lastBar: bars.at(-1)!.t, count: bars.length };
  return { gz, meta, ndjson };
}

/** gz + meta ファイルを outDir に書き出す(パスを返す)。
 *  outDir 既定は 'dist'(=CLI は cwd=リポジトリ root なので従来どおり)。パッケージ版サーバは cwd が
 *  書き込み可能とは限らないため、呼び出し側から絶対パス(~/.jp225-monitor 等)を渡すこと。 */
export function writeGzMeta(gz: Buffer, meta: BaseMeta, outDir = 'dist'): { gzPath: string; metaPath: string } {
  mkdirSync(outDir, { recursive: true });
  // 区切りは '/' 固定(Node の fs は Windows でも '/' を受理)。CLI 出力を従来('dist/…')と同一に保つため。
  const gzPath = `${outDir}/basedata-1min.ndjson.gz`;
  const metaPath = `${outDir}/basedata-1min.meta.json`;
  writeFileSync(gzPath, gz);
  writeFileSync(metaPath, JSON.stringify(meta));
  return { gzPath, metaPath };
}

/** gh CLI で basedata-latest リリースへ gz+meta をアップロード(repo/release はハードコード)。 */
export function ghPublish(gzPath: string, metaPath: string): void {
  try { execSync(`gh release view basedata-latest --repo ${BASEDATA_REPO}`, { stdio: 'ignore' }); }
  catch { execSync(`gh release create basedata-latest --repo ${BASEDATA_REPO} --title "Base data (N225 mini 1min)" --notes "Auto-published base data. Updated weekly."`, { stdio: 'inherit' }); }
  execSync(`gh release upload basedata-latest ${gzPath} ${metaPath} --repo ${BASEDATA_REPO} --clobber`, { stdio: 'inherit' });
}
