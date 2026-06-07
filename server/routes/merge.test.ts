import { describe, it, expect } from 'vitest';
import { mergeHandler } from './merge.js';

function mockRes() {
  return { statusCode: 200, body: null as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
}

describe('mergeHandler 検証', () => {
  it('source が無ければ 400', () => {
    const res = mockRes();
    mergeHandler({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
  });
  it('存在しない source は 400', () => {
    const res = mockRes();
    mergeHandler({ body: { source: 'C:/nope/none.db' } } as never, res as never);
    expect(res.statusCode).toBe(400);
  });
});
