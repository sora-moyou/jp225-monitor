import type { Request, Response } from 'express';
import { gunzipSync } from 'node:zlib';
import { openDb, resolveDbPath } from '../db/store.js';
import { parseNdjsonLine, importBars, type BaseBar } from '../basedata.js';

const ASSET_URL =
  'https://github.com/sora-moyou/jp225-monitor/releases/download/basedata-latest/basedata-1min.ndjson.gz';

export async function basedataImportHandler(_req: Request, res: Response): Promise<void> {
  try {
    const resp = await fetch(ASSET_URL, { redirect: 'follow' });
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
      const fmt = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);
      res.json({ ok: true, applied: r.inserted, skipped: r.skipped, total: r.total,
        from: r.from ? fmt(r.from) : null, to: r.to ? fmt(r.to) : null });
    } finally { db.close(); }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'import failed' });
  }
}
