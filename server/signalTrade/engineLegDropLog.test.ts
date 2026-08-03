// ★エンジン側(A系統/B系統)のログに「片レッグだけ落ちた理由」が1行出ることの実証。
//
// ■ なぜ要るか
//   台帳(/api/scalp-plan → proposals)に載るのは **生成器の要求** だけで、実弾につながる A/B の
//   シグナルエンジンは HTTP を通らない(runScalpPlanWithChart を直呼び)。エンジン側は
//   serverlog にしか痕跡が残らないので、片レッグ脱落の理由もそこに1行出ていないと
//   「A系統で向き違反が減ったか」を後から追えない(=これまで追えていなかった)。
//
// ■ ★否定対照(この修正前のコードでの結果)
//   git show HEAD:server/signalTrade/engine.ts > <tmp> には plan-legdrop 行が無く
//   (grep で0件)、本ファイルの「1行出る」テストは赤になる。
//   従来 plan-legs 行は **両レッグ落ち(見送り)** のときしか出ず、片レッグ落ちは根拠文の
//   日本語(「（逆指値レッグは条件を満たさず不採用）」)にしか現れなかった。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** AI が逆指値を出さず(missing)、残った指値だけでは現在値から遠すぎる回。
 *  ★サニティ不通過の枝に入るので ARM も DB 書き込みも起きない(ログだけを見る)。 */
const CANNED = {
  ok: true,
  plan: {
    direction: 'buy' as const,
    rationale: '押し目買い （実際の注文: 指値のみ・逆指値レッグなし）（逆指値レッグは条件を満たさず不採用）',
    refPrice: 38250,
    limitEntry: 37900, stopLossForLimit: 37845,
  },
  vetoFired: false,
  legDrops: [{ name: 'stop' as const, reason: 'missing' as const }],
};

vi.mock('../llm/scalpPlanRunner.js', () => ({
  runScalpPlanWithChart: vi.fn(async () => CANNED),
}));

import { SignalEngine } from './engine.js';

/** 取引時間内(2026-08-03 月曜 10:00 JST)。時間外だと計画要求そのものが出ない。 */
const NOW = Date.UTC(2026, 7, 3, 1, 0, 0);

let dir: string;
let origAppData: string | undefined;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jp225-legdroplog-'));
  origAppData = process.env.APPDATA;
  process.env.APPDATA = dir;   // DB は temp へ隔離(実DBには触らない)
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe('★エンジンのログに片レッグ脱落の理由が出る', () => {
  it('A系統: plan-legdrop 行に「どのレッグが・どの検証で」落ちたかが出る(見送りでない回でも)', async () => {
    const eng = new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
    await eng.start();
    eng.feed(38250, NOW);
    await vi.waitFor(() => expect(logs.some(l => l.includes('plan-legdrop'))).toBe(true), { timeout: 2000 });
    const line = logs.find(l => l.includes('plan-legdrop'))!;
    expect(line).toContain('[signalTrade]');
    expect(line).toContain('dir=buy');
    expect(line).toContain('stop=missing');
    // 採否は変えていない: この回は従来どおりサニティ不通過で正規シグナルにしない。
    expect(logs.some(l => l.includes('サニティ不通過'))).toBe(true);
    expect(eng.getPhase()).toBe('flat');
    eng.stop();
  });

  it('B系統でも同じ1行が出る(腕ごとにログが欠けない)', async () => {
    const eng = new SignalEngine({ profile: 'B', systemTag: 'B', broadcastType: 'signalTradeB', maintainsCurrentSignal: false });
    await eng.start();
    eng.feed(38250, NOW);
    await vi.waitFor(() => expect(logs.some(l => l.includes('plan-legdrop'))).toBe(true), { timeout: 2000 });
    expect(logs.find(l => l.includes('plan-legdrop'))!).toContain('[signalTradeB]');
    eng.stop();
  });
});
