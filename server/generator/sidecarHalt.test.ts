import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';

import { GeneratorHalt } from './run.js';
import { recordHalt, replaySelfCommand, startReplaySchedule, REPLAY_FLAG } from './sidecarRun.js';
import { readGeneratorLedgerStatus, openGeneratorDb, insertProposal, type ProposalRow } from '../db/generatorStore.js';
import { statusHandler, _resetExitStatusCacheForTest } from '../routes/status.js';
import { renderGeneratorDot } from '../../web/components/apiStatusPane.js';

// ★「動いていない」と「止まった理由」は別物。
//
//   運用PCにはインストーラしか入らず、コンソールは見られない。停止理由がプロセスのログにしか
//   無ければ、ユーザーに分かるのは「標本が溜まっていない」ことだけで、**なぜ止まったのか** は
//   永遠に分からない。だから理由を台帳(halts)に残し、/api/status → 死活ドット まで運ぶ。
//
// ★否定対照(是正前/ゲート除去で赤くなること):
//   ・generatorStore の halts 表 + readLatestHalt を消す → 「理由が画面まで届く」が赤
//   ・sidecar の recordHalt 呼び出しを消す(理由をログにだけ出す) → 同上が赤
//   ・startReplaySchedule の enabled() 判定を消す → 「無効中は再生を走らせない」が赤
//   ・replaySelfCommand が別プロセスを組み立てない(同一プロセスで再生する)ようにする
//     → 「再生はサイクルと別プロセス」が赤

const ORIG_DB = process.env.JP225_GENERATOR_DB;
const ORIG_VARIANT = process.env.MONITOR_VARIANT;
const ORIG_APPDATA = process.env.APPDATA;
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;

let dir: string;

interface MockRes extends Response { _json: unknown; }
function mockRes(): MockRes {
  const r = { _json: undefined as unknown, json(b: unknown) { r._json = b; return r; } };
  return r as unknown as MockRes;
}

function row(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    epoch: 'e1', cycleId: 'c1', arm: 'current', exitVariant: 'current', seq: 0,
    sessionDate: '2026-08-03', requestedAt: Date.now(), respondedAt: Date.now(), latencyMs: 10,
    status: 'plan', skipReason: null, httpStatus: 200, error: null,
    retried: 0, retryCount: 0, preRetryReason: null,
    direction: 'none', planJson: '{}', refPrice: 38000, regime: 'range', confidence: 30,
    noneReason: 'ai', noneLegsJson: null, vetoFired: 0, rangeAnomalyJson: null,
    shotId: null, shotAgeMs: null, shotOrigin: null, contextOmittedJson: null,
    createdAt: Date.now(), ...over,
  };
}

describe('分析用: 止まった理由を画面まで届ける', () => {
  beforeEach(() => {
    _resetExitStatusCacheForTest();
    dir = mkdtempSync(join(tmpdir(), 'jp225-genhalt-'));
    process.env.JP225_GENERATOR_DB = join(dir, 'generator_proposals.db');
    process.env.APPDATA = dir; process.env.HOME = dir; process.env.USERPROFILE = dir;
    delete process.env.MONITOR_VARIANT;   // full
  });
  afterEach(() => {
    const restore = (n: string, v: string | undefined) => { if (v === undefined) delete process.env[n]; else process.env[n] = v; };
    restore('JP225_GENERATOR_DB', ORIG_DB); restore('MONITOR_VARIANT', ORIG_VARIANT);
    restore('APPDATA', ORIG_APPDATA); restore('HOME', ORIG_HOME); restore('USERPROFILE', ORIG_USERPROFILE);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('★一度も成功しなかった PC でも、停止理由が台帳に残る(台帳を作ってでも残す)', () => {
    expect(existsSync(process.env.JP225_GENERATOR_DB!)).toBe(false);
    recordHalt(new GeneratorHalt('分析用専用キーが未設定のプロバイダがあります(gemini=shared)', '起動しません'), 1000);
    const led = readGeneratorLedgerStatus(process.env.JP225_GENERATOR_DB!, 2000);
    expect(led.available).toBe(true);
    expect(led.halt?.phase).toBe('起動しません');
    expect(led.halt?.reason).toContain('gemini=shared');
  });

  it('★理由が /api/status → 死活ドット まで届く(コンソールを見られない PC のための唯一の経路)', async () => {
    recordHalt(new GeneratorHalt('決済実装が非公開実装ではありません(exit.impl=fallback)', '起動しません'), 1000);
    const res = mockRes();
    await statusHandler({} as Request, res);
    const body = res._json as { generatorLedger: Parameters<typeof renderGeneratorDot>[0]; generatorEnabled: boolean };
    expect(body.generatorLedger?.halt?.reason).toContain('exit.impl=fallback');
    const html = renderGeneratorDot(body.generatorLedger, true);
    expect(html).toContain('🔴');
    expect(html).toContain('exit.impl=fallback');
  });

  it('★また走り出したら停止理由は消える(直らない赤は読まれなくなる)', () => {
    recordHalt(new GeneratorHalt('稼働中に前提が崩れました', '停止します'), 1000);
    const db = openGeneratorDb(process.env.JP225_GENERATOR_DB!);
    insertProposal(db, row({ requestedAt: 5000 }));
    db.close();
    const led = readGeneratorLedgerStatus(process.env.JP225_GENERATOR_DB!, 6000);
    expect(led.halt).toBeUndefined();
  });

  it('★「無効だから動いていない」と「止まった」を取り違えない', () => {
    // 無効: 理由ではなく「無効」と言う(警告色にしない=警告が読まれなくなる)。
    const off = renderGeneratorDot(undefined, false);
    expect(off).toContain('⚪');
    expect(off).toContain('無効');
    // 有効なのに記録が無い: 「止まった理由」は無いので、赤ではなく黄で「まだ記録がない」と言う。
    const noRecord = renderGeneratorDot(undefined, true);
    expect(noRecord).toContain('🟡');
    expect(noRecord).not.toContain('🔴');
    // enabled を返さない monitor(公開版 lite / 旧版)では従来どおり無言。
    expect(renderGeneratorDot(undefined)).toBe('');
  });

  it('★/api/status の generatorEnabled は既定 false(同梱しても走り出さないことが画面で分かる)', async () => {
    const res = mockRes();
    await statusHandler({} as Request, res);
    expect((res._json as { generatorEnabled: boolean }).generatorEnabled).toBe(false);
  });
});

describe('分析用: 再生を2分サイクルから切り離す', () => {
  it('★再生は「自分自身を別プロセスで起動する」形にする(同じイベントループで回さない)', () => {
    // SEA バイナリ: argv[1] は exe 自身 → 渡すのはフラグだけ。
    expect(replaySelfCommand(['C:/app/jp225-generator.exe', 'C:/app/jp225-generator.exe'], 'C:/app/jp225-generator.exe'))
      .toEqual({ cmd: 'C:/app/jp225-generator.exe', args: [REPLAY_FLAG] });
    expect(replaySelfCommand(['C:/app/jp225-generator.exe'], 'C:/app/jp225-generator.exe'))
      .toEqual({ cmd: 'C:/app/jp225-generator.exe', args: [REPLAY_FLAG] });
    // 開発時(node + スクリプト): スクリプトのパスを引き継ぐ。
    expect(replaySelfCommand(['/usr/bin/node', '/repo/sidecar.js'], '/usr/bin/node'))
      .toEqual({ cmd: '/usr/bin/node', args: ['/repo/sidecar.js', REPLAY_FLAG] });
  });

  it('★スケジュールは起動直後に走らない(アプリの起動を遅らせない)', () => {
    let fired = 0;
    const stop = startReplaySchedule(() => { fired += 1; }, () => true, 60_000, 24 * 3600_000);
    expect(fired).toBe(0);   // タイマーを張っただけ = 起動経路では何もしていない
    stop();
  });

  it('★無効のあいだは再生も走らせない(再生は DB を書く)', async () => {
    let fired = 0;
    const stop = startReplaySchedule(() => { fired += 1; }, () => false, 1, 24 * 3600_000);
    await new Promise(r => setTimeout(r, 20));
    expect(fired).toBe(0);
    stop();
  });

  it('有効なら猶予のあとで走る', async () => {
    let fired = 0;
    const stop = startReplaySchedule(() => { fired += 1; }, () => true, 1, 24 * 3600_000);
    await new Promise(r => setTimeout(r, 20));
    expect(fired).toBe(1);
    stop();
  });
});
