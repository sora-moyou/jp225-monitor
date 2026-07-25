import type { Request, Response } from 'express';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDb, resolveDbPath, getMeta, setMeta } from '../db/store.js';
import { parseNdjsonLine, importBars, type BaseBar } from '../basedata.js';
import { resolveBasedataCreds, resolveBasedataSaveDir, resolveGithubToken } from '../configStore.js';
import { login, downloadXlsx } from '../basedata/labo225.js';
import { xlsxBufferToBars, barsToGzMeta, writeGzMeta, ghPublish, apiPublish, extractXlsxFromZip } from '../basedata/publishCore.js';

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

// ワンボタン公開/自動公開スケジューラで共有する多重起動防止(module-level・finally でリセット)。
//   手動ボタンとスケジューラの tick が重ならないよう、共有フラグ + isPublishInFlight() を公開する。
let publishInFlight = false;
export function isPublishInFlight(): boolean { return publishInFlight; }

export interface BasedataPublishResult {
  count: number; firstDate: string; lastDate: string; generatedAt: string; saveDir: string; savedXlsx: string;
}

/** 基礎データ公開の実処理(HTTP 非依存・再利用可能)。手動ボタンと自動スケジューラの両方から呼ぶ。
 *  225labo ログイン→DL→ZIP展開→保存→パース→gz/meta→公開(PAT or gh)→ローカル取込。
 *  資格情報未設定/各失敗はすべて throw する(呼び出し側が JP 文言/ステータスへ変換)。creds/token はログに出さない。
 *  共有 publishInFlight を立てる(多重起動は 409 側で弾く前提だが、直呼びでも二重実行しないよう here でも保護)。 */
export async function runBasedataPublish(): Promise<BasedataPublishResult> {
  const { user, pass } = resolveBasedataCreds();
  if (!user || !pass) throw new Error('225labo のユーザー名/パスワードが未設定');
  publishInFlight = true;
  try {
    // ① ログイン → ② DL。225labo の配布は xlsx を内包した ZIP。
    const cookie = await login(user, pass);
    const downloaded = await downloadXlsx(cookie);
    // ③ ZIP から内側の xlsx を取り出す → パース(未来バー混入で throw)。④ gz/meta。
    const xlsx = extractXlsxFromZip(downloaded);
    // 取り出した最新ソース xlsx と gz/meta を「保存先フォルダ」へ固定名で上書き保存する(既定 Downloads=
    //   gh 未認証の別PCへコピーしやすい)。★固定ファイル名は意図的: writeFileSync/writeGzMeta は常に上書き
    //   なので、ブラウザDL式の "(11)" 連番重複が溜まらない。これはローカル控えで、公開/取込はメモリ内バッファを使う。
    const saveDir = resolveBasedataSaveDir();
    mkdirSync(saveDir, { recursive: true });
    const savedXlsxPath = `${saveDir}/basedata-latest.xlsx`;
    writeFileSync(savedXlsxPath, xlsx);
    const bars = xlsxBufferToBars(xlsx);
    const { gz, meta } = barsToGzMeta(bars, new Date().toISOString());
    const { gzPath, metaPath } = writeGzMeta(gz, meta, saveDir);
    // ⑤ 公開: PAT があれば REST API(gh 不要)/無ければ gh CLI にフォールバック。⑥ 公開成功後のみ取込。
    const token = resolveGithubToken();
    if (token) {
      await apiPublish(token, [
        { path: gzPath, name: 'basedata-1min.ndjson.gz', contentType: 'application/gzip' },
        { path: metaPath, name: 'basedata-1min.meta.json', contentType: 'application/json' },
      ]);
    } else {
      ghPublish(gzPath, metaPath);
    }
    const db = openDb(resolveDbPath());
    try {
      importBars(db, bars);
      setMeta(db, META_KEY, meta.generatedAt);
    } finally { db.close(); }
    return {
      count: meta.count,
      firstDate: fmtDate(meta.firstBar), lastDate: fmtDate(meta.lastBar),
      generatedAt: meta.generatedAt,
      savedXlsx: savedXlsxPath, saveDir,
    };
  } finally {
    publishInFlight = false;
  }
}

/** POST /api/basedata/publish — monitor2 専用のワンボタン公開。runBasedataPublish の薄いラッパ。
 *  in-flight 409 / creds 400 / JP エラーステータス変換のみを担う。 */
export async function basedataPublishHandler(_req: Request, res: Response): Promise<void> {
  if (publishInFlight) { res.status(409).json({ ok: false, error: '実行中です' }); return; }
  const { user, pass } = resolveBasedataCreds();
  if (!user || !pass) {
    res.status(400).json({ ok: false, error: '225labo のユーザー名/パスワードが未設定' });
    return;
  }
  try {
    const r = await runBasedataPublish();
    res.json({
      ok: true, count: r.count,
      firstDate: r.firstDate, lastDate: r.lastDate,
      generatedAt: r.generatedAt,
      savedXlsx: r.savedXlsx,   // ローカル控えの保存先(固定・上書き)。creds は含めない。
      saveDir: r.saveDir,       // 保存先フォルダ(xlsx/gz/meta の3点)。
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 文言でステータスを分ける。未来バー=422 / 認証・取得失敗=502 / 公開失敗=502 / その他=502。
    const status = msg.includes('未来日時のバー') ? 422 : 502;
    // 公開失敗は経路で JP を分ける: PAT(REST)=トークン/権限 / gh CLI=gh 認証。
    const error = msg.includes('GitHub API')
      ? 'GitHub 公開に失敗(トークン/権限を確認)'
      : /gh release|release (upload|create|view)|gh:? not found|gh auth/i.test(msg)
      ? 'GitHub 公開に失敗(gh の認証を確認)'
      : msg;
    res.status(status).json({ ok: false, error });
  }
}
