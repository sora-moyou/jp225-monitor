import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── 偽の monitor を立てて実走する(★外部 LLM は一切叩かない)──────────────────────
//
// 何を守っているか:
//   単体のモックだけだと「型は合うが実 HTTP では動かない」ことに気づけない。
//   実際に HTTP サーバを立て、実 fetch でサイクルを回し、実 SQLite に記録が落ちることを確かめる
//   (このプロジェクトの「テスト緑では完了としない/実描画・実HTTPを出荷の入場券に」に従う)。
//
// ★偽 monitor は /api/scalp-plan を **固定の JSON** で返すだけ。LLM もチャート撮影も起きない。

import { runPreflight } from './preflight.js';
import { runCycle, makeCycleId } from './cycle.js';
import { buildEpochInput, computeEpoch } from './epoch.js';
import { resolveGeneratorConfig, epochGeneratorConfig } from './config.js';
import {
  openGeneratorDb, insertProposal, insertRun, appendDailyTally, countProposals, readGeneratorLedgerStatus,
} from '../db/generatorStore.js';

const STATUS_JSON = {
  yahoo: { fallback: false, skipUntil: 0 },
  llm: [],
  exit: { impl: 'private', variantImpl: 'private', configVersion: 3, configHash: 'e01dde67fe62b2f8' },
};
const SETTINGS_JSON = {
  generatorKeySources: { gemini: 'own', groq: 'own', openai: 'own', kimi: 'env' },
  generatorDailyBudget: 800,
  scalpLcFloorYen: 45,
  providers: [{ name: 'gemini', enabled: true, paused: false, pausedUntil: 0 }],
};

interface Seen { exitVariant: string; promptVariant: string; caller: string }

/** 偽 monitor。/api/scalp-plan は撮影の同一性つきの固定応答を返す(shotIds を順に消費)。 */
function fakeMonitor(shotIds: string[], seen: Seen[]): Promise<{ server: Server; url: string }> {
  let i = 0;
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/status') return send(200, STATUS_JSON);
    if (req.url === '/api/settings') return send(200, SETTINGS_JSON);
    if (req.url === '/api/scalp-plan' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += String(c); });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Seen;
        seen.push(body);
        const shotId = shotIds[Math.min(i, shotIds.length - 1)] ?? 'x';
        i += 1;
        send(200, {
          ok: true,
          plan: { direction: 'none', rationale: `見送り(${body.exitVariant})`, refPrice: 38250, regime: 'range', confidence: 35 },
          noneReason: 'ai',
          vetoFired: false,
          exitVariant: body.exitVariant,
          chartShot: { shotId, ageMs: i * 1000, origin: i === 1 ? 'fresh' : 'cache' },
        });
      });
      return;
    }
    send(404, { ok: false, error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) { try { cleanup.pop()!(); } catch { /* ignore */ } } });

describe('偽 monitor を立てて実走(実 HTTP + 実 SQLite・外部 LLM は叩かない)', () => {
  it('★前提検証 → 2サイクル実走 → 台帳に記録が落ちる', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
    const seen: Seen[] = [];
    // サイクル0(①①'②)は同じ画像、サイクル1(①②)は TTL 超過で別の画像という筋書き。
    const { server, url } = await fakeMonitor(['s1', 's1', 's1', 's2', 's3'], seen);
    cleanup.push(() => server.close());
    const dir = mkdtempSync(join(tmpdir(), 'jp225-genlive-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const cfg = resolveGeneratorConfig({ GENERATOR_MONITOR_URL: url }, 3000);

    // ① 起動時の検証(実 HTTP)
    const pre = await runPreflight(cfg.monitorUrl, fetch, 5000);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.exit.configHash).toBe('e01dde67fe62b2f8');

    // epoch(凍結設定 + 決済指紋 + 分析用設定)
    const epochInput = buildEpochInput(pre.settings, pre.exit, epochGeneratorConfig(cfg));
    const epoch = computeEpoch(epochInput);
    // ★接頭辞は意図的に literal。方式(epoch の計算)を変えたらここが落ちるのが正しい
    //   (EPOCH_SCHEMA を参照すると、無自覚な方式変更を誰も検知できなくなる)。
    // ★v0.9.75 で 'g2' → 'g3'(実験の軸を決済仕様 → 質問文へ載せ替え、腕の構成を epoch の入力に入れた)。
    expect(epoch).toMatch(/^g3:[0-9a-f]{16}$/);

    const dbPath = join(dir, 'generator_proposals.db');
    const db = openGeneratorDb(dbPath);
    cleanup.push(() => db.close());
    insertRun(db, {
      startedAt: Date.now(), epoch, monitorUrl: cfg.monitorUrl,
      exitImpl: pre.exit.impl, exitVariantImpl: pre.exit.variantImpl,
      exitConfigVersion: pre.exit.configVersion, exitConfigHash: pre.exit.configHash,
      settingsJson: JSON.stringify(pre.settings), epochInputJson: JSON.stringify(epochInput),
      generatorConfigJson: JSON.stringify(cfg),
    });

    const dep = { fetcher: fetch, now: Date.now, sleep: async () => { /* noop */ }, random: () => 0 };
    for (const cycleIndex of [0, 1]) {
      const rows = await runCycle(cfg, dep, {
        epoch, cycleId: makeCycleId('live0001', Date.now() + cycleIndex, cycleIndex), cycleIndex,
      });
      for (const r of rows) expect(insertProposal(db, r)).toBe(true);
    }

    // ── 実走の結果
    // サイクル0 = ①①'②(3本)、サイクル1 = ①②(2本)
    expect(countProposals(db)).toBe(5);
    expect(seen.map(s => s.caller)).toEqual(['generator', 'generator', 'generator', 'generator', 'generator']);
    // ★v0.9.75: 決済仕様は全腕 'current'。動かす変数は質問文だけ。
    expect(seen.map(s => s.exitVariant)).toEqual(['current', 'current', 'current', 'current', 'current']);
    expect(seen.map(s => s.promptVariant)).toEqual(['v1', 'v1', 'v1d', 'v1', 'v1d']);

    const rows = db.prepare('SELECT arm, seq, status, direction, none_reason, shot_id, cycle_id, prompt_variant FROM proposals ORDER BY id')
      .all() as unknown as Array<Record<string, unknown>>;
    expect(rows.map(r => r.arm)).toEqual(['current', 'control', 'prompt-v1d', 'current', 'prompt-v1d']);
    // ★送った質問文が **実DBの列** に落ちている(腕名からの推測ではない)
    expect(rows.map(r => r.prompt_variant)).toEqual(['v1', 'v1', 'v1d', 'v1', 'v1d']);
    expect(rows.every(r => r.status === 'plan' && r.direction === 'none' && r.none_reason === 'ai')).toBe(true);

    // ★①①'②が同じ1枚を見たことが **記録** から言える
    const c0 = rows.slice(0, 3);
    expect(new Set(c0.map(r => r.shot_id))).toEqual(new Set(['s1']));
    expect(new Set(c0.map(r => r.cycle_id)).size).toBe(1);
    // ★60秒を超えたサイクルは「別の画像を見た」と記録される
    const c1 = rows.slice(3);
    expect(new Set(c1.map(r => r.shot_id))).toEqual(new Set(['s2', 's3']));

    // 取引日ごとの件数を追記(いつ止まったかが読める)
    expect(appendDailyTally(db, Date.now())).toBeGreaterThan(0);

    // /api/status に出す死活も実ファイル経由で読める
    const led = readGeneratorLedgerStatus(dbPath, Date.now());
    expect(led.available).toBe(true);
    expect(led.total).toBe(5);
  });

  it('★monitor が公開フォールバックなら実走しない(前提検証で止まる)', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/status'
        ? { ...STATUS_JSON, exit: { ...STATUS_JSON.exit, variantImpl: 'fallback' } }
        : SETTINGS_JSON));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    cleanup.push(() => server.close());
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const pre = await runPreflight(`http://127.0.0.1:${port}`, fetch, 5000);
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.reason).toContain('変種が実体を持ちません');
  });

  it('★分析用専用キーが共通キーへ落ちていたら実走しない', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/status'
        ? STATUS_JSON
        : { ...SETTINGS_JSON, generatorKeySources: { gemini: 'shared', groq: 'own', openai: 'own', kimi: 'own' } }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    cleanup.push(() => server.close());
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const pre = await runPreflight(`http://127.0.0.1:${port}`, fetch, 5000);
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.reason).toContain('gemini=shared');
  });

  it('★monitor に到達できなければ実走しない', async () => {
    const pre = await runPreflight('http://127.0.0.1:1', fetch, 1500);
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.reason).toContain('到達できません');
  });
});
