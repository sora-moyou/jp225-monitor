import { describe, it, expect } from 'vitest';
import { probeUpdaterEndpoint, isNewerVersion } from './probe.js';

// サーバ側の裏取り。★成功も失敗も **同じ形** で返り、投げないこと(投げると呼び出し側が
// 握りつぶし得る = また無音に戻る)が契約。

const URL_ = 'https://example.invalid/latest.json';

const okFetch = (body: string, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

describe('probeUpdaterEndpoint', () => {
  it('HTTP 200 + version が読めたら ok=true(ステータスと版の両方が残る)', async () => {
    const p = await probeUpdaterEndpoint(URL_, { fetchImpl: okFetch('{"version":"0.9.110","notes":"x"}') });
    expect(p.ok).toBe(true);
    expect(p.httpStatus).toBe(200);
    expect(p.version).toBe('0.9.110');
    expect(p.error).toBeNull();
    expect(p.url).toBe(URL_);
  });

  it('★叩いた URL は引数のものそのまま(別の URL を叩いたら証拠にならない)', async () => {
    const seen: string[] = [];
    await probeUpdaterEndpoint(URL_, { fetchImpl: async (u) => { seen.push(u); return { ok: true, status: 200, text: async () => '{"version":"1.0.0"}' }; } });
    expect(seen).toEqual([URL_]);
  });

  it('非 2xx は ok=false + HTTP ステータスが残る(本文は残さない)', async () => {
    const p = await probeUpdaterEndpoint(URL_, { fetchImpl: okFetch('<html>Not Found</html>', 404) });
    expect(p).toMatchObject({ ok: false, httpStatus: 404, version: null, error: 'HTTP 404' });
  });

  it('JSON として読めない本文は理由つきで失敗(ステータスは残る)', async () => {
    const p = await probeUpdaterEndpoint(URL_, { fetchImpl: okFetch('not json') });
    expect(p.ok).toBe(false);
    expect(p.httpStatus).toBe(200);
    expect(p.error).toContain('JSON として読めない');
  });

  it('version が無い latest.json は失敗として残る(黙って null 版で成功にしない)', async () => {
    const p = await probeUpdaterEndpoint(URL_, { fetchImpl: okFetch('{"notes":"x"}') });
    expect(p).toMatchObject({ ok: false, httpStatus: 200, version: null, error: 'latest.json に version が無い' });
  });

  it('★接続そのものが失敗しても投げない(理由が戻り値に載る)', async () => {
    const p = await probeUpdaterEndpoint(URL_, { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
    expect(p.ok).toBe(false);
    expect(p.httpStatus).toBeNull();
    expect(p.error).toContain('ENOTFOUND');
  });
});

describe('isNewerVersion(★文字列比較にしない)', () => {
  it('0.9.110 は 0.9.109 より新しい', () => {
    expect(isNewerVersion('0.9.110', '0.9.109')).toBe(true);
  });
  it('★0.9.110 は 0.9.9 より新しい(文字列比較だと逆になる罠)', () => {
    expect(isNewerVersion('0.9.110', '0.9.9')).toBe(true);
    expect('0.9.110' > '0.9.9').toBe(false);       // 文字列比較の実挙動を固定しておく
  });
  it('同じ版・古い版は false', () => {
    expect(isNewerVersion('0.9.110', '0.9.110')).toBe(false);
    expect(isNewerVersion('0.9.109', '0.9.110')).toBe(false);
  });
  it('片方が無ければ false(欠測を「新しい」と読まない)', () => {
    expect(isNewerVersion(null, '0.9.110')).toBe(false);
    expect(isNewerVersion('0.9.110', null)).toBe(false);
  });
});
