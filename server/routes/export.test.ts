import { describe, it, expect } from 'vitest';
import { exportHandler } from './export.js';

function mockRes() {
  return { statusCode: 200, body: null as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
}

describe('exportHandler 検証', () => {
  it('dest が無ければ 400', () => {
    const res = mockRes();
    exportHandler({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
  });
  it('保存先フォルダが無ければ 400', () => {
    const res = mockRes();
    exportHandler({ body: { dest: 'C:/nope-nowhere-xyz/out.db' } } as never, res as never);
    expect(res.statusCode).toBe(400);
  });
});
