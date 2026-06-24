import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runChatWithTools, buildMonitorContext, buildDataToolHandlers,
  resolveExplainMoveArgs, type ToolHandlers,
} from './openai.js';
import { buildExplainInput } from './explainInput.js';
import * as store from '../db/store.js';
import * as cache from '../cache.js';

function fakeCreate(seq: any[]) {
  let i = 0;
  return vi.fn(async () => seq[i++]);
}

// ハンドラ群を { name: () => 'R' } のマップにする小道具(従来の search 単体テストを名前ディスパッチへ移植)。
function singleHandler(name: string, fn: (args: any) => Promise<string>): ToolHandlers {
  return { [name]: fn };
}

describe('runChatWithTools (name dispatch)', () => {
  it('tool_calls 無し→単発で content 返す', async () => {
    const create = fakeCreate([{ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }]);
    const out = await runChatWithTools(create as any, [{ role: 'user', content: 'hi' }], [{}], {}, 3);
    expect(out).toBe('ok');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('web_search を名前で振り分け→最終回答', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'web_search', arguments: '{"query":"q"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: '最終' }, finish_reason: 'stop' }] },
    ]);
    const web = vi.fn(async (a: { query: string }) => `WEB:${a.query}`);
    const data = vi.fn(async () => 'DATA');
    const handlers: ToolHandlers = { web_search: web, query_alerts: data };
    const out = await runChatWithTools(create as any, [{ role: 'user', content: 'hi' }], [{}], handlers, 3);
    expect(out).toBe('最終');
    expect(web).toHaveBeenCalledWith({ query: 'q' });
    expect(data).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('データツールを名前で振り分け(web_search は呼ばれない)', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'query_alerts', arguments: '{"withinMinutes":30}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: '回答' }, finish_reason: 'stop' }] },
    ]);
    const web = vi.fn(async () => 'WEB');
    const data = vi.fn(async (a: any) => `ALERTS:${a.withinMinutes}`);
    const handlers: ToolHandlers = { web_search: web, query_alerts: data };
    const out = await runChatWithTools(create as any, [{ role: 'user', content: 'hi' }], [{}], handlers, 3);
    expect(out).toBe('回答');
    expect(data).toHaveBeenCalledWith({ withinMinutes: 30 });
    expect(web).not.toHaveBeenCalled();
  });

  it('未知ツール名→例外を投げずループ継続→最終回答', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'nope', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: 'fallback' }, finish_reason: 'stop' }] },
    ]);
    const out = await runChatWithTools(create as any, [{ role: 'user', content: 'hi' }], [{}], {}, 3);
    expect(out).toBe('fallback');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('上限到達→tools無しで最終回答', async () => {
    const toolCall = { choices: [{ message: { content: null, tool_calls: [{ id: 't', function: { name: 'web_search', arguments: '{"query":"x"}' } }] }, finish_reason: 'tool_calls' }] };
    const create = fakeCreate([toolCall, toolCall, { choices: [{ message: { content: '打ち切り回答' } }] }]);
    const out = await runChatWithTools(create as any, [{ role: 'user', content: 'hi' }], [{}], singleHandler('web_search', async () => 'R'), 2);
    expect(out).toBe('打ち切り回答');
    expect(create).toHaveBeenCalledTimes(3);
  });
});

// ─── データツール / 常時注入: 一時DB を resolveDbPath にスタブして検証 ───

// バーは「実時刻に依存しない固定の Day セッション」(2026-06-24 Wed 13:00 JST=04:00 UTC)に置く。
// getSessionOHLC は now ではなくバー時刻を classifySession して集計するため、これで安定して 1 セッション返る。
const BAR_BASE = Date.UTC(2026, 5, 24, 4, 0, 0);   // 2026-06-24 13:00 JST (Day)

/** bars はセッション固定時刻、alerts は now 相対(ハンドラの窓フィルタが Date.now() 基準のため)。 */
function seedDb(db: DatabaseSync, now: number): void {
  store.initSchema(db);
  // バー: 日経 NIY=F に Day セッションの分足を数本(高値38500/安値37900/現値37900)。
  const prices = [38000, 38200, 38500, 38100, 37900];
  prices.forEach((p, i) => {
    store.recordTick(db, 'NIY=F', BAR_BASE + i * 60_000, p, '2026-06-24', 'Day');
  });
  // アラート: 直近(crash)と少し前(shock)。窓フィルタは now 相対なので now 起点で置く。
  store.insertAlert(db, {
    symbol: 'NIY=F', triggeredAt: now - 5 * 60_000, direction: 'down',
    detectionKind: 'crash', windowSeconds: 300, changePercent: -3.1, price: 37900,
    sessionDate: '2026-06-24', session: 'Day',
  });
  store.insertAlert(db, {
    symbol: 'NIY=F', triggeredAt: now - 20 * 60_000, direction: 'up',
    detectionKind: 'shock', windowSeconds: 60, changePercent: 0.5, price: 38200,
    sessionDate: '2026-06-24', session: 'Day', referencePrice: 1,   // identity 重複回避
  });
}

describe('monitor data tools', () => {
  let dir: string;
  let db: DatabaseSync;
  let now: number;

  beforeEach(() => {
    now = Date.now();
    dir = mkdtempSync(join(tmpdir(), 'jp225-chat-'));
    const path = join(dir, 'jp225.db');
    vi.spyOn(store, 'resolveDbPath').mockReturnValue(path);
    db = new DatabaseSync(path);
    seedDb(db, now);
    db.close();
    cache.setPrices([{ symbol: 'NIY=F', price: 37900, changePercent: -3.1, stale: false } as any]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('buildMonitorContext: 直近アラートと本日OHLCの行を含む', () => {
    const ctx = buildMonitorContext(now);
    expect(ctx).toContain('■ 直近アラート(60分以内):');
    expect(ctx).toContain('暴落');
    expect(ctx).toContain('■ 本日の日経');
    expect(ctx).toContain('高値');
    expect(ctx).toContain('38,500');
  });

  it('buildMonitorContext: DB 空でも例外なく空文字(or 該当ブロック無し)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'jp225-empty-'));
    vi.spyOn(store, 'resolveDbPath').mockReturnValue(join(empty, 'x.db'));
    const ctx = buildMonitorContext(now);
    expect(ctx).toBe('');
    rmSync(empty, { recursive: true, force: true });
  });

  it('query_alerts: 一覧+種別別統計を返す', async () => {
    const handlers = buildDataToolHandlers();
    const out = await handlers.query_alerts!({ withinMinutes: 120 });
    expect(out).toContain('直近アラート:');
    expect(out).toContain('暴落');
    expect(out).toContain('種別別統計');
  });

  it('query_alerts: データ無しの分岐', async () => {
    const handlers = buildDataToolHandlers();
    const out = await handlers.query_alerts!({ withinMinutes: 1 });   // 1分以内は無し
    expect(out).toContain('アラートなし');
  });

  it('price_history (today): 本日OHLCを要約', async () => {
    const handlers = buildDataToolHandlers();
    const out = await handlers.price_history!({ symbol: 'NIY=F', window: 'today' });
    expect(out).toContain('日経225先物 本日');
    expect(out).toContain('高値');
    expect(out).toContain('安値');
  });

  it('price_history (recent): 直近N分を要約', async () => {
    const handlers = buildDataToolHandlers();
    const out = await handlers.price_history!({ symbol: 'NIY=F', window: 'recent', minutes: 30 });
    expect(out).toContain('直近30分');
  });

  it('price_history: データ無しの分岐', async () => {
    const handlers = buildDataToolHandlers();
    const out = await handlers.price_history!({ symbol: 'NONEXIST=F', window: 'today' });
    expect(out).toContain('本日のデータなし');
  });
});

describe('explain_move 入力組立', () => {
  let dir: string;
  let path: string;
  let now: number;

  beforeEach(() => {
    now = Date.now();
    dir = mkdtempSync(join(tmpdir(), 'jp225-explain-'));
    path = join(dir, 'jp225.db');
    vi.spyOn(store, 'resolveDbPath').mockReturnValue(path);
    const db = new DatabaseSync(path);
    seedDb(db, now);
    db.close();
    cache.setNews([]);
    cache.setPrices([{ symbol: 'NIY=F', price: 37900, changePercent: -3.1, stale: false } as any]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('buildExplainInput: crash は newsWindow=24h・newsSince=0', () => {
    const inp = buildExplainInput({
      symbol: 'NIY=F', symbolLabel: '日経225先物', changePercent: -3.1,
      windowSeconds: 300, detectionKind: 'crash', direction: 'down',
    });
    expect(inp.newsSince).toBe(0);
    expect(inp.newsWindowMs).toBe(24 * 60 * 60 * 1000);
  });

  it('buildExplainInput: crash 以外は newsWindowMs 未指定', () => {
    const inp = buildExplainInput({
      symbol: 'NIY=F', symbolLabel: '日経225先物', changePercent: 0.5,
      windowSeconds: 60, detectionKind: 'shock', direction: 'up',
    });
    expect(inp.newsWindowMs).toBeUndefined();
  });

  it('resolveExplainMoveArgs: 直近 crash 行を拾い crash 規約の入力になる', () => {
    const db = new DatabaseSync(path);
    const moveArgs = resolveExplainMoveArgs(db, 'NIY=F', 60 * 60_000, now);
    db.close();
    expect(moveArgs).not.toBeNull();
    expect(moveArgs!.detectionKind).toBe('crash');
    const inp = buildExplainInput(moveArgs!);
    expect(inp.newsWindowMs).toBe(24 * 60 * 60 * 1000);
    expect(inp.newsSince).toBe(0);
  });

  it('resolveExplainMoveArgs: アラート無し→セッション高値 vs 現在値から算出', () => {
    // crash/shock 行を窓外にするため sinceMs=1分に絞る。現値37900・高値38500→約1.6%下落=shock。
    const db = new DatabaseSync(path);
    const moveArgs = resolveExplainMoveArgs(db, 'NIY=F', 60_000, now);
    db.close();
    expect(moveArgs).not.toBeNull();
    expect(moveArgs!.detectionKind).toBe('shock');
    expect(moveArgs!.changePercent).toBeLessThan(0);   // 下落
  });
});
