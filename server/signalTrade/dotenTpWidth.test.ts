// ★ドテンで入り直した建玉に TP(利確の成行決済)が **効く** こと。
//   ★型やモックではなく、AI の生応答 → parseScalpPlan → applyHeldEvalResult(reverseToDoten→planToArmed)
//     → 約定 → 決済 → **実ファイル SQLite の signal_trades.tp_width** まで通して確かめる。
//
// ■ 何が壊れていたか(実データ)
//   TP 導入後の約定 223件のうち A の35件(34.0%)に tp_width が無く、35件すべて直前が
//   exit_reason='doten'。原因はドテンが旧経路(1回呼び出し)へ落ち、その経路が TP を尋ねていなかったこと。
//   ★記録の欠落ではなく **TP が実際に効いていなかった**(=利確が発火しない)。
//
// ■ ドテンの計画は signal_plans に **入らない仕様**(store.ts に明記)なので、効き目が測れるのは
//   ★signal_trades.tp_width。ここでその1点を固定する。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SignalEngine } from './engine.js';
import type { CurrentSignal, HeldIdentity, OpenPosition } from './decisions.js';
import { parseScalpPlan } from '../llm/scalpPlan.js';
import { resetConfigCache } from '../configStore.js';
import { openDb, resolveDbPath, getSignalTrades, type SignalTradeRow } from '../db/store.js';

const REF = 38250;
/** ドテンの反対プラン(保有 buy → 反転 sell)の **AI 生応答**。TP幅は指値120/逆指値90。 */
const DOTEN_RAW = JSON.stringify({
  direction: 'sell', limitEntry: REF + 20, stopEntry: REF - 20,
  lcWidthForLimit: 60, lcWidthForStop: 58,
  tpWidthForLimit: 120, tpWidthForStop: 90,
  rationale: '反転', refPrice: REF,
});

const cfgA = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };
const heldBuyPos: OpenPosition = {
  direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'orig', at: 500,
};
const heldBuySig: CurrentSignal = {
  signalId: 1, at: 500, direction: 'buy', rationale: 'orig', limitEntry: 37950, stopLossForLimit: 37900,
};
const id: HeldIdentity = { at: 500, direction: 'buy', signalId: 1 };

describe('★ドテンの建玉に TP幅が焼かれ、実ファイル SQLite の signal_trades.tp_width に入る', () => {
  let dir = '';
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origAppData: string | undefined;

  const writeCfg = (cfg: Record<string, unknown>): void => {
    mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify(cfg), 'utf-8');
    resetConfigCache();
  };
  const readTrades = (): SignalTradeRow[] => {
    const path = resolveDbPath();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
    const db = openDb(path);
    try { return getSignalTrades(db, 10); } finally { db.close(); }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-dotentp-'));
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE; origAppData = process.env.APPDATA;
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    resetConfigCache();
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    resetConfigCache();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL を掴んでいることがある */ }
  });

  it('★AI応答 → parse → ドテン反転 → 約定 → TP到達で決済 → tp_width=120 が実ファイルの行に入る', async () => {
    writeCfg({});                                   // 既定(TP有効・幅は AI委任)
    // ① AI の生応答をそのままパースする(★尋ねた回=askTp=true。旧経路の実配線と同じ引数)。
    const parsed = parseScalpPlan(DOTEN_RAW, REF, true);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.tpWidthForLimit).toBe(120);
    expect(parsed.plan.tpWidthForStop).toBe(90);

    const eng = new SignalEngine(cfgA);
    await eng.start();
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    // ② ドテン反転(P を成行決済 → 反対ブラケットを武装)。live=REF は両レッグとも未通過。
    expect(eng.applyHeldEvalResult(parsed, id, 2_000, REF, REF)).toBe('doten');
    expect(eng.getPhase()).toBe('armed');
    // ③ 売り指値 38270 に到達して約定(建値 38270)。
    eng.feed(REF + 25, 10_000);
    expect(eng.getPhase()).toBe('filled');
    // ④ TP(建値 − 幅120 = 38150)に到達 → 成行決済。
    eng.feed(38150, 20_000);
    expect(eng.getPhase()).toBe('flat');

    // ⑤ ★実ファイルの signal_trades を読む(新しい順=先頭が反転後の建玉の決済)。
    const rows = readTrades();
    const doten = rows.find(r => r.exit_reason === 'doten')!;
    const after = rows.find(r => r.exit_reason === 'take_profit')!;
    expect(doten).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after.dir).toBe('sell');
    expect(after.tp_width).toBe(120);               // ★ここが NULL だったのが本件
    expect(after.tp_trigger).toBe(38150);
    eng.stop();
  });

  it('★TP無効(scalpTpEnabled=false)なら、幅を持つ計画でもドテン建玉は TP で決済されず NULL のまま', async () => {
    writeCfg({ scalpTpEnabled: false });
    const parsed = parseScalpPlan(DOTEN_RAW, REF, true);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const eng = new SignalEngine(cfgA);
    await eng.start();
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    expect(eng.applyHeldEvalResult(parsed, id, 2_000, REF, REF)).toBe('doten');
    eng.feed(REF + 25, 10_000);
    expect(eng.getPhase()).toBe('filled');
    eng.feed(38150, 20_000);                        // TP 価格まで動いても決済しない
    expect(eng.getPhase()).toBe('filled');
    eng.feed(REF + 25 + 58 + 10, 30_000);           // 初期LC 側で閉じる
    expect(eng.getPhase()).toBe('flat');
    const rows = readTrades();
    const after = rows.find(r => r.exit_reason !== 'doten')!;
    expect(after.tp_width ?? null).toBeNull();
    expect(after.tp_trigger ?? null).toBeNull();
    eng.stop();
  });
});
