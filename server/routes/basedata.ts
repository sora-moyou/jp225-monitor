import type { Request, Response } from 'express';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb, resolveDbPath, getMeta, setMeta } from '../db/store.js';
import { parseNdjsonLine, importBars, type BaseBar } from '../basedata.js';
import { resolveBasedataCreds } from '../configStore.js';
import { login, downloadXlsx } from '../basedata/labo225.js';
import { xlsxBufferToBars, barsToGzMeta, writeGzMeta, ghPublish, extractXlsxFromZip } from '../basedata/publishCore.js';

const BASE = 'https://github.com/sora-moyou/jp225-monitor/releases/download/basedata-latest';
const GZ_URL = `${BASE}/basedata-1min.ndjson.gz`;
const META_URL = `${BASE}/basedata-1min.meta.json`;
const META_KEY = 'basedata_generatedAt';

interface BaseMeta { generatedAt: string; firstBar?: number; lastBar?: number; count?: number; }

const fmtDate = (t: number): string => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);

async function fetchMeta(): Promise<BaseMeta | null> {
  try {
    const r = await fetch(META_URL, { redirect: 'follow' });
    if (!r.ok) return null;
    const m = await r.json() as BaseMeta;
    return typeof m?.generatedAt === 'string' ? m : null;
  } catch { return null; }
}

/** GET /api/basedata/status — 公開メタと取り込み済み版を比較し、新着有無を返す。 */
export async function basedataStatusHandler(_req: Request, res: Response): Promise<void> {
  try {
    const meta = await fetchMeta();
    if (!meta) { res.json({ ok: true, published: false }); return; }
    const db = openDb(resolveDbPath());
    let current: string | null;
    try { current = getMeta(db, META_KEY); } finally { db.close(); }
    res.json({
      ok: true, published: true,
      available: current !== meta.generatedAt,
      generatedAt: meta.generatedAt,
      imported: current,
      count: meta.count ?? null,
      lastBar: meta.lastBar ? fmtDate(meta.lastBar) : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'status failed' });
  }
}

/** POST /api/basedata/import — gz を取得→gunzip→upsert 取り込み。取り込み版(generatedAt)を記録。 */
export async function basedataImportHandler(_req: Request, res: Response): Promise<void> {
  try {
    const meta = await fetchMeta();   // 取り込み版マーカー用(無くても取り込みは実行)
    const resp = await fetch(GZ_URL, { redirect: 'follow' });
    if (!resp.ok) { res.status(502).json({ ok: false, error: `download failed: HTTP ${resp.status}` }); return; }
    const gz = Buffer.from(await resp.arrayBuffer());
    const text = gunzipSync(gz).toString('utf-8');
    const bars: BaseBar[] = [];
    for (const line of text.split('\n')) {
      const b = parseNdjsonLine(line);
      if (b) bars.push(b);
    }
    if (bars.length === 0) { res.status(422).json({ ok: false, error: 'no valid rows' }); return; }
    const db = openDb(resolveDbPath());
    try {
      const r = importBars(db, bars);
      if (meta?.generatedAt) setMeta(db, META_KEY, meta.generatedAt);
      res.json({ ok: true, applied: r.inserted, skipped: r.skipped, total: r.total,
        from: r.from ? fmtDate(r.from) : null, to: r.to ? fmtDate(r.to) : null,
        generatedAt: meta?.generatedAt ?? null });
    } finally { db.close(); }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'import failed' });
  }
}

// ワンボタン公開の多重起動防止(module-level・finally でリセット)。
let publishInFlight = false;

/** POST /api/basedata/publish — monitor2 専用のワンボタン公開。
 *  225labo ログイン→xlsx DL→パース→gz/meta→gh 公開→このPCへ即取込。
 *  公開(gh)成功後にのみローカル取込を行う(部分失敗の不整合を避ける)。creds はログに出さない。 */
export async function basedataPublishHandler(_req: Request, res: Response): Promise<void> {
  if (publishInFlight) { res.status(409).json({ ok: false, error: '実行中です' }); return; }
  const { user, pass } = resolveBasedataCreds();
  if (!user || !pass) {
    res.status(400).json({ ok: false, error: '225labo のユーザー名/パスワードが未設定' });
    return;
  }
  publishInFlight = true;
  try {
    // ① ログイン → ② DL(失敗は 502)。225labo の配布は xlsx を内包した ZIP。
    const cookie = await login(user, pass);
    const downloaded = await downloadXlsx(cookie);
    // ③ ZIP から内側の xlsx を取り出す → パース(未来バー混入で throw=422)。④ gz/meta。
    const xlsx = extractXlsxFromZip(downloaded);
    // 取り出した最新ソース xlsx を固定パスへ「上書き保存」する(config.json と同じ ~/.jp225-monitor 配下)。
    //   ★固定ファイル名は意図的: writeFileSync は常に上書きなので、ブラウザDL式の "(11)" 連番重複が溜まらない。
    //   これはあくまでローカル控え。公開/取込は上のメモリ内バッファを使う(ディスクから読み戻さない)。
    const appDataDir = join(homedir(), '.jp225-monitor');
    mkdirSync(appDataDir, { recursive: true });
    const savedXlsxPath = join(appDataDir, 'basedata-latest.xlsx');
    writeFileSync(savedXlsxPath, xlsx);
    const bars = xlsxBufferToBars(xlsx);
    const { gz, meta } = barsToGzMeta(bars, new Date().toISOString());
    // gz/meta もアプリデータ dir(絶対パス)へ。パッケージ版サーバは cwd が書込可とは限らないため
    //   相対 'dist/' は使わない(CLI は既定 'dist' のまま=従来挙動)。
    const { gzPath, metaPath } = writeGzMeta(gz, meta, appDataDir);
    // ⑤ 公開(gh 失敗=502)。⑥ 公開成功後にのみローカル取込。
    ghPublish(gzPath, metaPath);
    const db = openDb(resolveDbPath());
    try {
      importBars(db, bars);
      setMeta(db, META_KEY, meta.generatedAt);
    } finally { db.close(); }
    res.json({
      ok: true, count: meta.count,
      firstDate: fmtDate(meta.firstBar), lastDate: fmtDate(meta.lastBar),
      generatedAt: meta.generatedAt,
      savedXlsx: savedXlsxPath,   // ローカル控えの保存先(固定・上書き)。creds は含めない。
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 文言でステータスを分ける。未来バー=422 / 認証・取得失敗=502 / gh=502 / その他=502。
    const status = msg.includes('未来日時のバー') ? 422 : 502;
    const error = /gh release|release (upload|create|view)|gh:? not found|gh auth/i.test(msg)
      ? 'GitHub 公開に失敗(gh の認証を確認)'
      : msg;
    res.status(status).json({ ok: false, error });
  } finally {
    publishInFlight = false;
  }
}
