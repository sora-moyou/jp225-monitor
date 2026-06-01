import type { Request, Response } from 'express';
import { gunzipSync } from 'node:zlib';
import { openDb, resolveDbPath, getMeta, setMeta } from '../db/store.js';
import { parseNdjsonLine, importBars, type BaseBar } from '../basedata.js';

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
