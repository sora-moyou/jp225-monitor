import { describe, it, expect, afterEach, vi } from 'vitest';
import { updateCheckPayload, normalizeDisplayedVersion, reportUpdateCheck, REPORT_TIMEOUT_MS } from './updateReport.js';
import { UPDATER_PROBE_TIMEOUT_MS } from '../../server/updater/probe.js';
import type { UpdateStatus } from './updater.js';

// ★4状態が **潰されず** サーバへ届くこと。旧 checkForUpdate() は error / latest / unsupported を
//   同じ null に潰しており、起動時の失敗が完全に無音だった(2026-09-09 の事故の一因)。

describe('updateCheckPayload(4状態を潰さない)', () => {
  const cases: Array<[UpdateStatus, string, string | null, string | null]> = [
    [{ state: 'latest' }, 'latest', null, null],
    [{ state: 'available', info: { version: '0.9.110' } }, 'available', '0.9.110', null],
    [{ state: 'error', message: 'Network Error' }, 'error', null, 'Network Error'],
    [{ state: 'unsupported' }, 'unsupported', null, null],
  ];

  for (const [status, verdict, pluginVersion, message] of cases) {
    it(`${status.state} → verdict=${verdict}`, () => {
      expect(updateCheckPayload('startup', status, '0.9.109'))
        .toEqual({ source: 'startup', verdict, pluginVersion, message, clientVersion: '0.9.109' });
    });
  }

  it('4状態がすべて別の verdict になる(どれかが潰れていない)', () => {
    const verdicts = cases.map(([s]) => updateCheckPayload('settings', s, null).verdict);
    expect(new Set(verdicts).size).toBe(4);
  });
});

describe('normalizeDisplayedVersion', () => {
  it("'v0.9.110' → '0.9.110'", () => expect(normalizeDisplayedVersion('v0.9.110')).toBe('0.9.110'));
  it('未取得の表示は null(嘘の版を記録に入れない)', () => {
    for (const v of ['', '  ', 'v?', '…', null, undefined]) expect(normalizeDisplayedVersion(v)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★二重防御の片側(モジュール自身のタイムアウト)の番人。
//   呼び出し側の `void` はテスト④(updateReportWiring.test.ts)が守る。こちらが無いと
//   AbortController を外しても誰も捕まえない(実測: 外しても 21 passed だった)。
// ─────────────────────────────────────────────────────────────────────────────
describe('★記録の送信は必ず有限時間で決着する(モジュール自身の防御)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  /** signal の abort でだけ reject する fetch(= 解決しない相手)。 */
  function neverRespondingFetch(): void {
    vi.stubGlobal('fetch', (_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => {
        rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    }));
  }

  it('応答が永久に返ってこなくても REPORT_TIMEOUT_MS で必ず解決する', async () => {
    vi.useFakeTimers();
    const warns: string[] = [];
    vi.stubGlobal('console', { ...console, warn: (...a: unknown[]) => { warns.push(a.map(String).join(' ')); } });
    neverRespondingFetch();

    let settled = false;
    const p = reportUpdateCheck('startup', { state: 'latest' }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(REPORT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);                       // まだ待っている(早すぎる中断もしていない)
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(settled).toBe(true);                        // ★ここが AbortController を外すと永久に来ない

    // ★文言は断定しない(「送れなかった」と書かない)。
    expect(warns.join(' ')).toContain('応答を 20000ms 待てなかった');
    expect(warns.join(' ')).toContain('記録が成立したかはここからは判定できない');
    expect(warns.join(' ')).not.toContain('送れなかった');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★2つのタイムアウトの大小関係。コメントだけにせず、両方の定数を実際に読んで固定する。
//   ここが逆転すると「正常に完走している応答を待ちきれず、クライアントだけが失敗と思い込む」
//   = ログが嘘をつく(この版が後始末している事故と同じ形)。
// ─────────────────────────────────────────────────────────────────────────────
describe('★クライアントの待ち時間 > サーバの probe 予算', () => {
  it('REPORT_TIMEOUT_MS は UPDATER_PROBE_TIMEOUT_MS より長い', () => {
    expect(REPORT_TIMEOUT_MS).toBeGreaterThan(UPDATER_PROBE_TIMEOUT_MS);
  });

  it('probe 以外(DB 書き込み・応答)のぶんの余裕が 5 秒以上ある', () => {
    expect(REPORT_TIMEOUT_MS - UPDATER_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });

  it('★否定対照: 逆転させると落ちる(この検査は恒真ではない)', () => {
    expect(() => expect(5000).toBeGreaterThan(UPDATER_PROBE_TIMEOUT_MS)).toThrow();
  });
});
