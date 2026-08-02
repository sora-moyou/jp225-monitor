import { describe, it, expect, afterEach } from 'vitest';
import {
  parseExitStopRequest, exitStopResponse, exitStopHandler,
  exitStopReadiness, exitStopAccessGate,
} from './exitStop.js';
import { computeExitStop, _setExitImpl, type ExitState } from '../signalTrade/exit/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// POST /api/exit-stop(決済逆指値の権威)。
// ★このテストは公開(git 追跡)なので **決済の実数値を一切書かない**。検証は
//   「同じ関数(computeExitStop)を通っているか」「状態の検証が効くか」「応答に価格以外が出ないか」
//   「権威でないときに値を返さないか」「ブラウザ文脈から引けないか」だけ。
//
// ★このファイルは **loadExitImpl() を呼ばない**(呼ぶと以後 'unloaded' を再現できなくなる)。
//   実装がロードされた状態での実質(=含み益で床が動く)は exitStopAuthority.test.ts が受け持つ。

describe('parseExitStopRequest(状態の検証・純関数)', () => {
  const ok = { direction: 'buy', entryPrice: 39000, initialStop: 38900, peakProfit: 0 };

  it('正しい状態を ExitState へ通す', () => {
    const r = parseExitStopRequest(ok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state).toEqual({ direction: 'buy', entryPrice: 39000, initialStop: 38900, peakProfit: 0 });
  });

  it('sell も通る', () => {
    const r = parseExitStopRequest({ ...ok, direction: 'sell', initialStop: 39100 });
    expect(r.ok).toBe(true);
  });

  it('★未知/欠落を黙って既定へ倒さない(必ずエラーを返す)', () => {
    for (const bad of [
      null, 'x', 42,
      { ...ok, direction: 'long' },            // 方向の別表記は受けない。
      { ...ok, direction: undefined },
      { ...ok, entryPrice: 'x' },
      { ...ok, entryPrice: Number.NaN },
      { ...ok, initialStop: undefined },
      { ...ok, initialStop: Number.POSITIVE_INFINITY },
      { ...ok, peakProfit: -1 },               // 含み益ピークは 0 以上。
      { ...ok, peakProfit: null },
    ]) {
      const r = parseExitStopRequest(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('★エラー文に決済パラメータらしき数値を混ぜない(受信値のエコーは方向の文字列だけ)', () => {
    const r = parseExitStopRequest({ direction: 'nope', entryPrice: 1, initialStop: 1, peakProfit: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(/\d/.test(r.error)).toBe(false);
  });
});

describe('exitStopResponse(状態 → 価格)', () => {
  it('★monitor 自身の建玉と同じ関数(computeExitStop)の出力をそのまま返す', () => {
    const states: ExitState[] = [
      { direction: 'buy', entryPrice: 39000, initialStop: 38900, peakProfit: 0 },
      { direction: 'buy', entryPrice: 39000, initialStop: 38900, peakProfit: 500 },
      { direction: 'sell', entryPrice: 39000, initialStop: 39100, peakProfit: 260 },
    ];
    for (const s of states) expect(exitStopResponse(s)).toEqual({ exitStop: computeExitStop(s) });
  });

  it('★応答は exitStop ただ1つ(決済パラメータを載せる隙間を作らない)', () => {
    const out = exitStopResponse({ direction: 'buy', entryPrice: 39000, initialStop: 38900, peakProfit: 120 });
    expect(Object.keys(out)).toEqual(['exitStop']);
  });

  it('決済実装を差し替えるとそれが反映される(=独自の再実装を持っていない証拠)', () => {
    const sentinel = 12345;
    try {
      _setExitImpl(() => sentinel);
      expect(exitStopResponse({ direction: 'buy', entryPrice: 39000, initialStop: 38900, peakProfit: 0 }))
        .toEqual({ exitStop: sentinel });
    } finally {
      _setExitImpl(null);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★B2: 権威でないときに値を返さない。
//   ルートは app.listen の時点で生きているが、非公開実装のロードは別経路(engine)にあった。
//   未ロード時の computeExitStop は「初期LC固定」= 全 peak で initialStop と同値(劣化)。
//   それを 200 で返すと呼び出し側(trade2)に判別手段が無く **静かに間違う**。
// ─────────────────────────────────────────────────────────────────────────────
describe('exitStopReadiness(権威かどうか・純関数)', () => {
  it('未ロード / 公開フォールバックでは権威として答えない', () => {
    for (const s of ['unloaded', 'simple'] as const) {
      const r = exitStopReadiness(s);
      expect(r.ready, s).toBe(false);
      if (!r.ready) expect(r.error.length).toBeGreaterThan(0);
    }
  });
  it('非公開実装がロードされているときだけ権威', () => {
    expect(exitStopReadiness('private').ready).toBe(true);
  });
  it('★理由文に数値を書かない(決済パラメータの手掛かりを出さない)', () => {
    for (const s of ['unloaded', 'simple'] as const) {
      const r = exitStopReadiness(s);
      if (!r.ready) expect(/\d/.test(r.error)).toBe(false);
    }
  });
});

describe('exitStopAccessGate(ブラウザ文脈を塞ぐ・純関数)', () => {
  it('Origin / Referer / Sec-Fetch-Site を持つ要求は拒否する', () => {
    for (const h of [
      { origin: 'https://evil.example' },
      { origin: 'http://127.0.0.1:3000' },     // ★同一オリジンの頁でも通さない(許可リストを作らない)。
      { referer: 'https://evil.example/p' },
      { 'sec-fetch-site': 'cross-site' },
      { origin: ['https://evil.example'] },    // 配列ヘッダ。
    ]) {
      const r = exitStopAccessGate(h as Record<string, unknown>);
      expect(r.ok, JSON.stringify(h)).toBe(false);
    }
  });

  it('trade2(Node fetch)/curl 相当=これらを送らない要求は通す', () => {
    expect(exitStopAccessGate({ 'content-type': 'application/json', host: '127.0.0.1:3000' }).ok).toBe(true);
    expect(exitStopAccessGate({}).ok).toBe(true);
    expect(exitStopAccessGate(undefined).ok).toBe(true);
    expect(exitStopAccessGate({ origin: '' }).ok).toBe(true);   // 空文字は「無し」と同じ。
  });
});

describe('exitStopHandler(HTTP)', () => {
  afterEach(() => { _setExitImpl(null); });

  function fakeRes(): { status: (n: number) => unknown; json: (b: unknown) => unknown; code: number; body: unknown } {
    const r = {
      code: 200, body: undefined as unknown,
      status(n: number) { r.code = n; return r; },
      json(b: unknown) { r.body = b; return r; },
    };
    return r;
  }
  /** 権威(非公開実装)がロード済みの状態を作る。★実数値は書かない=合成の恒等的な差し替え。 */
  function withAuthority(): void { _setExitImpl(s => s.initialStop); }

  it('★実装が未ロードなら値を返さない(503)。劣化フォールバックを権威として返さない', () => {
    const res = fakeRes();
    const state: ExitState = { direction: 'buy', entryPrice: 39000, initialStop: 38900, peakProfit: 400 };
    exitStopHandler({ body: state, headers: {} } as never, res as never);
    expect(res.code).toBe(503);
    expect((res.body as { exitStop?: number }).exitStop).toBeUndefined();
    expect((res.body as { error?: string }).error).toBeTruthy();
  });

  it('★未ロードは「状態が不正」より先に判定する(不正な状態でも 400 でなく 503)', () => {
    const res = fakeRes();
    exitStopHandler({ body: { direction: 'buy' }, headers: {} } as never, res as never);
    expect(res.code).toBe(503);
  });

  it('正しい状態 → 200 と { exitStop }(権威ロード済みのとき)', () => {
    withAuthority();
    const res = fakeRes();
    const state: ExitState = { direction: 'buy', entryPrice: 39000, initialStop: 38900, peakProfit: 400 };
    exitStopHandler({ body: state, headers: {} } as never, res as never);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ exitStop: computeExitStop(state) });
  });

  it('不正な状態 → 400(黙って価格を返さない)', () => {
    withAuthority();
    const res = fakeRes();
    exitStopHandler({ body: { direction: 'buy' }, headers: {} } as never, res as never);
    expect(res.code).toBe(400);
    expect((res.body as { error?: string }).error).toBeTruthy();
    expect((res.body as { exitStop?: number }).exitStop).toBeUndefined();
  });

  it('★ブラウザ文脈(Origin 付き)からは、権威ロード済みでも価格を返さない(403)', () => {
    withAuthority();
    const res = fakeRes();
    const state: ExitState = { direction: 'buy', entryPrice: 39000, initialStop: 38900, peakProfit: 400 };
    exitStopHandler({ body: state, headers: { origin: 'https://evil.example' } } as never, res as never);
    expect(res.code).toBe(403);
    expect((res.body as { exitStop?: number }).exitStop).toBeUndefined();
  });
});

// ★再混入を止める(トリップワイヤ): この経路が落ちると trade2 の孤児建玉だけが決済定数の複製へ戻る。
//   経路を消すには「index.ts の登録を消す + この検査を消す」の両方が要る = 気づかずに戻ることはない。
describe('★経路の登録', () => {
  it('server/index.ts に POST /api/exit-stop が登録されている', () => {
    const src = readFileSync(resolve(fileURLToPath(import.meta.url), '..', '..', 'index.ts'), 'utf-8');
    expect(
      src.includes("app.post('/api/exit-stop'"),
      '決済逆指値の権威(POST /api/exit-stop)の登録が消えている。'
      + 'trade2 の孤児建玉はこの経路が無いと決済定数のローカル複製へ戻る(本件で潰した欠陥そのもの)。',
    ).toBe(true);
  });

  it('★variant ゲートしていない(lite に繋いだ trade2 の孤児保護を無音で落とさない)', () => {
    const src = readFileSync(resolve(fileURLToPath(import.meta.url), '..', '..', 'index.ts'), 'utf-8');
    const line = src.split(/\r?\n/).find(l => l.includes("app.post('/api/exit-stop'"))!;
    expect(line).not.toContain('resolveVariant');
    expect(line).not.toContain('full');
  });

  it('★起動時に決済実装をロードする(エンジン無効=SIGNAL_TRADE=0 でも権威が成立する)', () => {
    const src = readFileSync(resolve(fileURLToPath(import.meta.url), '..', '..', 'index.ts'), 'utf-8');
    expect(
      src.includes('loadExitImpl()'),
      'server/index.ts の起動経路から loadExitImpl() が消えている。'
      + 'エンジン(startSignalEngine)側にしか無いと SIGNAL_TRADE=0 で一度も走らず、'
      + 'ルートだけが生きて劣化フォールバックを返す状態に戻る(本件で潰した欠陥)。',
    ).toBe(true);
  });

  it('★この経路には CORS の * を付けない(無認証オラクルへ戻さない)', () => {
    const src = readFileSync(resolve(fileURLToPath(import.meta.url), '..', '..', 'index.ts'), 'utf-8');
    expect(
      src.includes('NO_CORS_PATHS'),
      'CORS の除外(NO_CORS_PATHS)が消えている。全ルートへ Access-Control-Allow-Origin: * を付けると、'
      + 'ブラウザで開いた任意の頁の JS がこの経路を叩いて段構造を復元できる(実測済み)。',
    ).toBe(true);
    const idx = src.indexOf('NO_CORS_PATHS');
    expect(src.slice(idx, idx + 200)).toContain('/api/exit-stop');
  });
});
