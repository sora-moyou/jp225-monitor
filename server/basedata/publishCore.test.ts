import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import XLSX from 'xlsx';
import { xlsxBufferToBars, barsToGzMeta, extractXlsxFromZip } from './publishCore.js';
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
