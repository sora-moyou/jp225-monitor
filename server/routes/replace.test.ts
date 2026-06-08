import { describe, it, expect } from 'vitest';
import { replaceHandler } from './replace.js';

function mockRes() {
  return { statusCode: 200, body: null as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
}

describe('replaceHandler 検証', () => {
  it('source が無ければ 400', () => {
    const res = mockRes();
    replaceHandler({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
  });
  it('存在しない source は 400(停止やバックアップ前に弾く)', () => {
    const res = mockRes();
    replaceHandler({ body: { source: 'C:/nope/none.db' } } as never, res as never);
    expect(res.statusCode).toBe(400);
  });
});
