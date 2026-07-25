import { describe, it, expect, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync } from 'fflate';
import XLSX from 'xlsx';
import { xlsxBufferToBars, barsToGzMeta, extractXlsxFromZip, apiPublish } from './publishCore.js';
import { parseNdjsonLine } from '../basedata.js';

const toSerial = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m - 1, d) / 86400_000) + 25569;

// aoa(header + rows)→ '1min' シートの xlsx バッファを組み立てる(実ファイルと同じ列意味)。
function buildXlsx(rows: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([['date', 'time', 'o', 'h', 'l', 'c', 'v'], ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '1min');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('xlsxBufferToBars', () => {
  it("'1min' シートをパースして BaseBar[] を返す(ソート済み)", () => {
    const buf = buildXlsx([
      [toSerial(2025, 12, 30), 10 / 24, 50450, 50465, 50415, 50420, 2086],   // 火 10:00(日中)
      [toSerial(2025, 12, 30), 11 / 24, 50420, 50430, 50400, 50410, 1500],   // 火 11:00
    ]);
    const bars = xlsxBufferToBars(buf);
    expect(bars.length).toBe(2);
    expect(bars[0]!.t).toBeLessThan(bars[1]!.t);
    expect(bars[0]).toMatchObject({ o: 50450, h: 50465, l: 50415, c: 50420, v: 2086 });
  });

  it('未来日時のバーが混入したら throw する', () => {
    const buf = buildXlsx([
      [toSerial(2025, 12, 30), 10 / 24, 50450, 50465, 50415, 50420, 2086],
      [toSerial(2099, 1, 5), 10 / 24, 51000, 51010, 50990, 51005, 100],       // 遠い未来
    ]);
    expect(() => xlsxBufferToBars(buf)).toThrow(/未来日時のバー/);
  });

  it('データ行が無ければ throw する', () => {
    expect(() => xlsxBufferToBars(buildXlsx([]))).toThrow(/no data rows/);
  });

  it("'1min' シートが無ければ throw する", () => {
    const ws = XLSX.utils.aoa_to_sheet([['x']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'other');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    expect(() => xlsxBufferToBars(buf)).toThrow(/1min/);
  });
});

describe('extractXlsxFromZip', () => {
  const innerXlsx = buildXlsx([
    [toSerial(2025, 12, 30), 10 / 24, 50450, 50465, 50415, 50420, 2086],
  ]);

  it('xlsx を内包した ZIP から内側の xlsx を取り出す(→そのままパース可能)', () => {
    const zip = Buffer.from(zipSync({ 'N225minif_2026.xlsx': new Uint8Array(innerXlsx) }));
    const extracted = extractXlsxFromZip(zip);
    const bars = xlsxBufferToBars(extracted);
    expect(bars.length).toBe(1);
    expect(bars[0]).toMatchObject({ o: 50450, c: 50420 });
  });

  it('複数エントリでも .xlsx を選ぶ(N225minif 優先)', () => {
    const zip = Buffer.from(zipSync({
      'readme.txt': new Uint8Array(Buffer.from('hello')),
      'other.xlsx': new Uint8Array(buildXlsx([[toSerial(2025, 12, 30), 11 / 24, 1, 2, 0.5, 1.5, 1]])),
      'N225minif_2026.xlsx': new Uint8Array(innerXlsx),
    }));
    const bars = xlsxBufferToBars(extractXlsxFromZip(zip));
    expect(bars[0]).toMatchObject({ o: 50450 });   // N225minif 側(o=50450)を選んだ
  });

  it('既に生 xlsx(OOXML の内部エントリ)ならそのまま返す', () => {
    const extracted = extractXlsxFromZip(innerXlsx);
    expect(xlsxBufferToBars(extracted).length).toBe(1);
  });

  it('xlsx を含まない ZIP は throw する', () => {
    const zip = Buffer.from(zipSync({ 'readme.txt': new Uint8Array(Buffer.from('no xlsx here')) }));
    expect(() => extractXlsxFromZip(zip)).toThrow(/xlsx が見つかりません/);
  });
});

describe('barsToGzMeta', () => {
  const bars = [
    { t: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    { t: 2000, o: 1.5, h: 2.5, l: 1, c: 2, v: 20 },
  ];

  it('注入した nowIso で決定的な meta を返す', () => {
    const now = '2026-07-26T00:00:00.000Z';
    const { meta } = barsToGzMeta(bars, now);
    expect(meta).toEqual({ generatedAt: now, firstBar: 1000, lastBar: 2000, count: 2 });
  });

  it('gz は gunzip すると ndjson(1行1バー)に戻る', () => {
    const { gz, ndjson } = barsToGzMeta(bars, '2026-07-26T00:00:00.000Z');
    expect(gunzipSync(gz).toString('utf-8')).toBe(ndjson);
    const parsed = ndjson.trim().split('\n').map(parseNdjsonLine);
    expect(parsed).toEqual(bars);
  });
});

describe('apiPublish (GitHub REST・fetch モック)', () => {
  interface Call { url: string; method: string; auth?: string; contentType?: string; }

  it('リリース取得→同名アセットDELETE→uploads.github.com へトークン付き POST', async () => {
    const gzPath = join(tmpdir(), 'jp225-apipub-test.gz');
    const metaPath = join(tmpdir(), 'jp225-apipub-test.meta.json');
    writeFileSync(gzPath, Buffer.from('gzbytes'));
    writeFileSync(metaPath, Buffer.from('{}'));

    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, auth: headers.Authorization, contentType: headers['Content-Type'] });
      if (method === 'GET' && url.includes('/releases/tags/basedata-latest')) {
        // gz は既存アセットあり(=DELETE 対象) / meta は存在しない。
        return { ok: true, status: 200, json: async () => ({ id: 42, assets: [{ id: 7, name: 'basedata-1min.ndjson.gz' }] }) } as Response;
      }
      if (method === 'DELETE') return { ok: true, status: 204 } as Response;
      if (method === 'POST' && url.startsWith('https://uploads.github.com')) return { ok: true, status: 201, json: async () => ({}) } as Response;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await apiPublish('SECRET_TOKEN', [
        { path: gzPath, name: 'basedata-1min.ndjson.gz', contentType: 'application/gzip' },
        { path: metaPath, name: 'basedata-1min.meta.json', contentType: 'application/json' },
      ]);
    } finally {
      globalThis.fetch = orig;
      rmSync(gzPath, { force: true });
      rmSync(metaPath, { force: true });
    }

    // (a) タグでリリース取得。
    const getCall = calls.find(c => c.method === 'GET');
    expect(getCall?.url).toBe('https://api.github.com/repos/sora-moyou/jp225-monitor/releases/tags/basedata-latest');
    expect(getCall?.auth).toBe('Bearer SECRET_TOKEN');
    // (b) 既存同名アセット(id 7)を DELETE(meta は重複なし=DELETE は1回だけ)。
    const dels = calls.filter(c => c.method === 'DELETE');
    expect(dels.length).toBe(1);
    expect(dels[0]!.url).toBe('https://api.github.com/repos/sora-moyou/jp225-monitor/releases/assets/7');
    // (c) uploads.github.com へ ?name= 付きで POST(トークン + contentType)。release id 42。
    const gzUp = calls.find(c => c.method === 'POST' && c.url.includes('uploads.github.com') && c.url.includes('name=basedata-1min.ndjson.gz'));
    expect(gzUp).toBeTruthy();
    expect(gzUp!.url).toContain('/releases/42/assets');
    expect(gzUp!.auth).toBe('Bearer SECRET_TOKEN');
    expect(gzUp!.contentType).toBe('application/gzip');
    const metaUp = calls.find(c => c.method === 'POST' && c.url.includes('uploads.github.com') && c.url.includes('name=basedata-1min.meta.json'));
    expect(metaUp).toBeTruthy();
    expect(metaUp!.contentType).toBe('application/json');
  });

  it('アップロード失敗時は "GitHub API" を含む Error を throw', async () => {
    const p = join(tmpdir(), 'jp225-apipub-fail.gz');
    writeFileSync(p, Buffer.from('x'));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ id: 1, assets: [] }) } as Response;
      return { ok: false, status: 403, json: async () => ({}) } as Response;   // upload 403
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await expect(apiPublish('T', [{ path: p, name: 'basedata-1min.ndjson.gz', contentType: 'application/gzip' }]))
        .rejects.toThrow(/GitHub API/);
    } finally {
      globalThis.fetch = orig;
      rmSync(p, { force: true });
    }
  });
});
