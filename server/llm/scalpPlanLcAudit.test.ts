// ★申告 LC幅と実出力の食い違いが「AI の応答 → 計画 → 台帳の列 → SELECT」まで一続きで残ることの実証。
//
// ■ 何を守っているか(実測 2026-08-07)
//   AI は根拠文に「LC幅=55円」と正しく書きながら、損切りには建値の隣(±5円)を入れることがある。
//   その回は enforce の下限(lcFloor)でレッグごと落ちるので、**採用されたレッグを見ても故障は見えない**
//   (実台帳: 落ちたレッグ 41.7% / 採用レッグ 2.0%)。純関数の単体テストだけでは
//   「parse で作った lcAudit が最終結果まで運ばれるか」「台帳の列に届くか」が保証できないので、
//   LLM だけをモックして buildScalpPlan の実経路を通し、実 SQLite に書いて読み戻す。
//
// ■ ★測るだけ(判定には使わない)
//   同じテストで「採否・価格・legDrops が食い違いの有無に一切左右されない」ことも固定する。
//
// ■ ★否定対照(この実装前のコード)
//   git show HEAD:server/llm/scalpPlan.ts には lcAudit が無く、
//   git show HEAD:server/db/store.ts の signal_plans には lc_audit_json 列が無い。
//   よって「結果に載る」「列に届く」テストは赤(SQLite は no such column で落ちる)。
//   一方、同じファイル内の「採否・価格・legDrops」の期待値は旧版でも緑 = 足したのは記録だけ、の対照。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Price } from '../types.js';

const createMock = vi.fn();

// LLM プロバイダ: callWithFallback は task を1回だけ呼び、その戻りを返す実装に置き換える(外部 LLM は呼ばない)。
// ★v0.9.70: プロバイダ名を差し替えられるようにする(ビジョン対応 / テキスト専用のフォールバックを再現するため)。
//   既定は 'test'(=ビジョン非対応)で、従来のテストは1ミリも変わらない。
const providerName = { current: 'test' };
// ★skipTask=true で「プロバイダが1つも使えず task が一度も走らない」経路を再現する
//   (callWithFallback が定型文だけを返す本番の分岐)。
const providerSkip = { current: false };
// ★フォールバックの再現: chain に複数プロバイダを入れると、本番の callWithFallback と同じく
//   前から順に試し、例外なら次へ送る。chain 未指定(空)なら従来どおり providerName 1つだけ。
const providerChain: { list: Array<{ name: string; chatModel: string }> } = { list: [] };
vi.mock('./providers.js', () => ({
  isLLMEnabled: () => true,
  isVisionCapableProvider: (name: string) => name === 'openai' || name === 'gemini',
  callWithFallback: async (task: (p: unknown) => Promise<string>) => {
    if (providerSkip.current) return '(LLM プロバイダが利用できません)';
    const chain = providerChain.list.length
      ? providerChain.list
      : [{ name: providerName.current, chatModel: 'test-model' }];
    let last: unknown = null;
    for (const config of chain) {
      try {
        return await task({ client: { chat: { completions: { create: createMock } } }, config });
      } catch (e) { last = e; }
    }
    throw last;
  },
}));
vi.mock('./webSearch.js', () => ({ isWebSearchEnabled: () => false, webSearch: async () => '' }));
vi.mock('./dataTools.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  buildMonitorContext: () => '',
}));
// 設定は実ユーザー環境に依存させない(LC下限=55円手動・上限65・veto/bias 無効)。
vi.mock('../configStore.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  resolveScalpLcFloorDirective: () => ({ mode: 'manual', value: 55 }),
  resolveScalpLcCeilingDirective: () => ({ mode: 'manual', value: 65 }),
  resolveScalpTrendVetoDirective: () => ({ mode: 'manual', value: 100 }),
  resolveScalpCooldownDirective: () => ({ mode: 'manual', value: 90 }),
  resolveScalpBiasDirective: () => ({ mode: 'manual', value: 'none' }),
  resolveScalpRangeDirective: () => ({ mode: 'manual', value: false }),
  resolveScalpLcHardMax: () => ({ enabled: false, value: 150 }),
  resolveScalpAiTechnicalEnabled: () => false,
}));

const { buildScalpPlan } = await import('./scalpPlan.js');
const { buildSignalPlanInsert } = await import('../signalTrade/planLedger.js');
const { initSchema, insertSignalPlan, getSignalPlans } = await import('../db/store.js');

const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: Date.now(), stale: false } as Price,
];

/** LLM が raw を返すようにして buildScalpPlan を1回走らせる。 */
async function planFrom(raw: string) {
  createMock.mockReset();
  createMock.mockResolvedValue({ choices: [{ message: { content: raw } }] });
  const r = await buildScalpPlan({ symbol: 'NIY=F', prices: PRICES, news: [] });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r;
}

/** ★実データの故障そのもの(売り): 指値は申告どおり55円 / ブレイク新規は申告55円なのに実際は5円。
 *  ブレイク新規レッグは下限(55円)未満なので enforce で落ちる=故障は「落ちたレッグ」にだけ残る。 */
const FAULTY_SELL = JSON.stringify({
  direction: 'sell', refPrice: 1,
  rationale: '戻り売り。指値レッグ LC=55円 で38300に設定。ブレイク新規レッグ LC=55円 で38200に設定した。',
  limitEntry: 38300, stopLossForLimit: 38355,
  stopEntry: 38200, stopLossForStop: 38205,
});

describe('lcAudit: 申告 LC幅と実出力の突き合わせが最終結果まで残る', () => {
  it('★落ちたレッグの食い違い(申告55/実際5)と、採用レッグの一致(55/55)が同じ配列に並ぶ', async () => {
    const r = await planFrom(FAULTY_SELL);
    expect(r.lcAudit?.map(a => [a.leg, a.declaredYen, a.actualYen, a.status])).toEqual([
      ['limit', 55, 55, 'match'],
      ['stop', 55, 5, 'mismatch'],
    ]);
  });

  it('★採否・価格・legDrops は食い違いに一切左右されない(足したのは記録だけ)', async () => {
    const r = await planFrom(FAULTY_SELL);
    expect(r.plan.direction).toBe('sell');
    expect(r.plan.limitEntry).toBe(38300);
    expect(r.plan.stopLossForLimit).toBe(38355);
    // 食い違ったレッグは **食い違いを理由には落ちない**。落ちた理由は従来どおり LC下限(lcFloor)。
    expect(r.plan.stopEntry).toBeUndefined();
    expect(r.plan.stopLossForStop).toBeUndefined();
    expect(r.legDrops?.map(d => [d.name, d.reason, d.entry, d.stopLoss])).toEqual([
      ['stop', 'lcFloor', 38200, 38205],
    ]);
    expect(r.noneReason).toBeUndefined();
  });

  it('★申告が無い根拠文は undeclared(「一致」に化けない)', async () => {
    const r = await planFrom(JSON.stringify({
      direction: 'sell', refPrice: 1,
      rationale: '戻り売り。損切りはレジスタンスの外側に置いた。',
      limitEntry: 38300, stopLossForLimit: 38355,
    }));
    // ★v0.9.70: 旧形式(価格)で来た応答なので widthSource='legacy-price' が同じ行に載る(フォールバックを数えるため)。
    //   向きは正しかったので signCorrected は付かない。
    expect(r.lcAudit).toEqual([
      { leg: 'limit', entry: 38300, stopLoss: 38355, actualYen: 55, declaredYen: null, status: 'undeclared', widthSource: 'legacy-price' },
    ]);
  });

  it('両レッグとも落ちて見送り(none)になった回にも残る(=故障の主戦場が消えない)', async () => {
    // sell の両レッグとも幅5円=下限未満 → enforce で両方落ちて none。
    const r = await planFrom(JSON.stringify({
      direction: 'sell', refPrice: 1,
      rationale: '戻り売り。指値レッグ LC=55円。ブレイク新規レッグ LC=55円。',
      limitEntry: 38300, stopLossForLimit: 38305,
      stopEntry: 38200, stopLossForStop: 38205,
    }));
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('lcFloor');
    expect(r.lcAudit?.map(a => a.status)).toEqual(['mismatch', 'mismatch']);
  });
});

describe('lcAudit: 台帳(signal_plans.lc_audit_json)まで届く', () => {
  let dir = '';
  let db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lcaudit-'));
    db = new DatabaseSync(join(dir, 'test.db'));
    initSchema(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('★AI 応答 → 計画 → 行 → 列 → SELECT の一続きで読み戻せる', async () => {
    const r = await planFrom(FAULTY_SELL);
    insertSignalPlan(db, buildSignalPlanInsert({ t: 1000, system: 'A', result: r }));
    const row = getSignalPlans(db)[0]!;
    // 既存の列は従来どおり(採用レッグの価格・落ちたレッグの理由)。
    expect(row.limit_entry).toBe(38300);
    expect(row.stop_entry).toBeNull();
    expect(JSON.parse(row.leg_drops_json!)).toEqual([{ name: 'stop', reason: 'lcFloor', entry: 38200, stopLoss: 38205 }]);
    // ★新しい列: 落ちたレッグの食い違いが数値で残る。
    const audit = JSON.parse(row.lc_audit_json!);
    expect(audit).toEqual([
      { leg: 'limit', entry: 38300, stopLoss: 38355, actualYen: 55, declaredYen: 55, status: 'match', source: 'width', widthSource: 'legacy-price' },
      { leg: 'stop', entry: 38200, stopLoss: 38205, actualYen: 5, declaredYen: 55, status: 'mismatch', source: 'width', widthSource: 'legacy-price' },
    ]);
  });

  it('突き合わせが1件も無い結果は列ごと NULL(空配列を書かない)', () => {
    insertSignalPlan(db, buildSignalPlanInsert({
      t: 2000, system: 'B',
      result: { ok: true, plan: { direction: 'none', rationale: '様子見', refPrice: REF }, noneReason: 'ai' },
    }));
    expect(getSignalPlans(db)[0]!.lc_audit_json).toBeNull();
  });

  it('★冪等な後付け: 列を持たない旧DBに initSchema を当てても既存行は保持され、旧行は NULL のまま', () => {
    // 旧版のスキーマを模す: 新しい列だけを落とした表を作り、行を1つ入れてから initSchema を再適用する。
    const legacyDir = mkdtempSync(join(tmpdir(), 'lcaudit-legacy-'));
    const legacy = new DatabaseSync(join(legacyDir, 'old.db'));
    legacy.exec(`
      CREATE TABLE signal_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, system TEXT NOT NULL,
        signal_id INTEGER, direction TEXT, none_reason TEXT, veto_fired INTEGER, ref_price REAL,
        regime TEXT, confidence REAL, limit_entry REAL, stop_entry REAL,
        stop_loss_for_limit REAL, stop_loss_for_stop REAL, leg_drops_json TEXT,
        settings_json TEXT, rationale TEXT, error TEXT
      );
    `);
    legacy.prepare("INSERT INTO signal_plans (t, system, direction, rationale) VALUES (1, 'A', 'buy', '旧行')").run();
    initSchema(legacy);
    initSchema(legacy);   // 2回目=冪等(ALTER が二度走って落ちない)
    const cols = (legacy.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('lc_audit_json');
    const rows = getSignalPlans(legacy);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rationale).toBe('旧行');       // 既存行は壊れない
    expect(rows[0]!.lc_audit_json).toBeNull();      // 旧行は NULL のまま
    legacy.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });
});

// ─── ★v0.9.70: 画像の有無と「添付のチャート画像も…」の1行が必ず一致すること ────────────────
//
//  ★直した事故: 旧実装は buildVisionNote(!!img) を **プロバイダ選択より前** に1回だけ評価していた。
//   そのため テキスト専用プロバイダ(groq/kimi)へフォールバックして画像が外れた回でも
//   「添付のチャート画像も判断材料にすること」と言い続けており、**存在しない画像を参照させていた**。
//  ★A/B の成立条件: 2群の違いは【画像の有無】と【この1行の有無】だけ。画像なし側に説明を足さない。
describe('★チャート画像: 送る回だけ注記が入る(2群の違いは画像とこの1行だけ)', () => {
  const NOTE = '添付のチャート画像';
  const RAW = JSON.stringify({
    direction: 'sell', rationale: '戻り売り。指値レッグ 38310と38365の引き算 → LC幅は55円。',
    limitEntry: 38310, lcWidthForLimit: 55, refPrice: REF,
  });
  const IMG = 'data:image/png;base64,QUJD';

  /** 実際に create へ渡った messages を取り出す(system / user)。 */
  function sentPrompts(): { system: string; user: string } {
    const msgs = createMock.mock.calls[0]![0].messages as Array<{ role: string; content: unknown }>;
    const text = (c: unknown): string => typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('') : '';
    return {
      system: text(msgs.find(m => m.role === 'system')?.content),
      user: text(msgs.find(m => m.role === 'user')?.content),
    };
  }
  /** 実際に画像が送られたか(image_url が content に在るか)。 */
  function sentImage(): boolean {
    const msgs = createMock.mock.calls[0]![0].messages as Array<{ role: string; content: unknown }>;
    const u = msgs.find(m => m.role === 'user')?.content;
    return Array.isArray(u) && u.some((x: any) => x?.type === 'image_url');
  }

  it('画像を渡さない回: 画像は1バイトも送らず、注記も入らない', async () => {
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW } }] });
    const r = await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F' });
    expect(r.ok).toBe(true);
    expect(sentImage()).toBe(false);
    expect(sentPrompts().user).not.toContain(NOTE);
    expect(sentPrompts().system).not.toContain(NOTE);
    expect((r as { imageSent?: boolean }).imageSent).toBe(false);
  });

  it('画像を渡す回: 画像が送られ、注記が1回だけ入る', async () => {
    providerName.current = 'openai';   // ビジョン対応プロバイダ
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW } }] });
    const r = await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F', chartImageDataUrl: IMG });
    expect(r.ok).toBe(true);
    expect(sentImage()).toBe(true);
    expect(sentPrompts().user.split(NOTE).length - 1).toBe(1);
    expect((r as { imageSent?: boolean }).imageSent).toBe(true);
  });

  it('★2群の user プロンプトの差は「注記の1行」だけ(他の文言を足していない)', async () => {
    providerName.current = 'openai';
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW } }] });
    await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F' });
    const off = sentPrompts().user;
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW } }] });
    await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F', chartImageDataUrl: IMG });
    const on = sentPrompts().user;
    // 画像あり側から注記(と直後の空行)を取り除くと、画像なし側と **byte 一致** する。
    expect(on.replace(`${NOTE}(当日の日経225先物のローソク足・主要水準・直近アラート)も判断材料にすること。\n\n`, '')).toBe(off);
  });

  it('★テキスト専用プロバイダへ落ちた回: 画像も注記も送られず、imageSent=false と記録される', async () => {
    providerName.current = 'groq';   // ビジョン非対応(実運用の 413 フォールバック先)
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW } }] });
    const r = await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F', chartImageDataUrl: IMG });
    providerName.current = 'test';
    expect(r.ok).toBe(true);
    expect(sentImage()).toBe(false);
    // ★ここが旧実装の欠陥: 画像が外れているのに注記だけ残り、存在しない画像を参照させていた。
    expect(sentPrompts().user).not.toContain(NOTE);
    expect((r as { imageSent?: boolean }).imageSent).toBe(false);
  });
});

// ─── ★v0.9.70: プロンプト指紋は「実際に送った内容」から取る(判断(b)) ──────────────────
//
//  ★旧: プロバイダ選択より **前** に1回だけ = 「組み立てた入力」の指紋。
//   ab の画像あり群でも、gemini が枯れてテキスト専用プロバイダへ落ちれば画像も注記も外れるので、
//   旧方式では **指紋と実際の送信内容がずれる**。凍結再生(plan-replay)はこの指紋を手掛かりにするため、
//   ずれた指紋は「同じ入力から再生したのに違う」という追えない差になる。
//  ★リポ内に prompt_fp を **読む/結合する** コードは1つも無い(書き込みのみ)ので、意味を変えても
//   既存の集計・分析は壊れない。
describe('★プロンプト指紋: 実際に送った内容の指紋になる', () => {
  const RAW2 = JSON.stringify({
    direction: 'sell', rationale: '戻り売り。指値レッグ 38310と38365の引き算 → LC幅は55円。',
    limitEntry: 38310, lcWidthForLimit: 55, refPrice: REF,
  });

  it('画像あり/なしで指紋が変わる(=送信内容を映している)', async () => {
    providerName.current = 'openai';
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW2 } }] });
    let fpNoImage = '';
    await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F', onPromptFingerprint: (fp) => { fpNoImage = fp; } });
    let fpImage = '';
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW2 } }] });
    await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F', chartImageDataUrl: 'data:image/png;base64,QUJD', onPromptFingerprint: (fp) => { fpImage = fp; } });
    providerName.current = 'test';
    expect(fpNoImage).toMatch(/^sp1:[0-9a-f]{16}$/);
    expect(fpImage).not.toBe(fpNoImage);
  });

  it('★テキスト専用へ落ちた回の指紋は「画像なし」の指紋と一致する(送った内容と一致)', async () => {
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW2 } }] });
    let fpNoImage = '';
    await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F', onPromptFingerprint: (fp) => { fpNoImage = fp; } });
    providerName.current = 'groq';   // ビジョン非対応=画像が外れる
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW2 } }] });
    let fpFell = '';
    await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F', chartImageDataUrl: 'data:image/png;base64,QUJD', onPromptFingerprint: (fp) => { fpFell = fp; } });
    providerName.current = 'test';
    expect(fpFell).toBe(fpNoImage);
  });

  it('★1度も送れなかった回(プロバイダ不在)は指紋を記録しない=「送っていない」が形から読める', async () => {
    providerSkip.current = true;
    let called = 0;
    const r = await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F', onPromptFingerprint: () => { called++; } });
    providerSkip.current = false;
    expect(called).toBe(0);
    expect((r as { imageSent?: boolean }).imageSent).toBe(false);
  });
});

// ─── ★v0.9.70: 実際に答えたプロバイダ/モデルの記録 ─────────────────────────────
//
//  ★これが無いと、チャート画像の A/B は「画像 × モデル」の交絡を含んだまま層別できない。
//   値の意味は **答えを返したプロバイダ** に固定する(「送ろうとした先」ではない)。
describe('★答えたプロバイダ/モデルを記録する', () => {
  const RAW3 = JSON.stringify({
    direction: 'sell', rationale: '戻り売り。指値レッグ 38310と38365の引き算 → LC幅は55円。',
    limitEntry: 38310, lcWidthForLimit: 55, refPrice: REF,
  });
  afterEach(() => { providerChain.list = []; providerSkip.current = false; providerName.current = 'test'; });

  it('答えたプロバイダとモデルが結果に載る', async () => {
    providerName.current = 'gemini';
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW3 } }] });
    const r = await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F' });
    expect((r as { provider?: unknown }).provider).toEqual({ name: 'gemini', model: 'test-model' });
  });

  it('★フォールバック: 先頭が落ちて次が答えたら、**答えた方** が記録される', async () => {
    providerChain.list = [
      { name: 'gemini', chatModel: 'gemini-flash-latest' },
      { name: 'groq', chatModel: 'llama-x' },
    ];
    createMock.mockReset()
      .mockRejectedValueOnce(new Error('429 rate limit'))            // gemini が落ちる
      .mockResolvedValue({ choices: [{ message: { content: RAW3 } }] });   // groq が答える
    const r = await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F' });
    expect(r.ok).toBe(true);
    expect((r as { provider?: unknown }).provider).toEqual({ name: 'groq', model: 'llama-x' });
  });

  it('★誰も答えなかった回(プロバイダ不在)は記録しない=台帳では NULL', async () => {
    providerSkip.current = true;
    const r = await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F' });
    expect((r as { provider?: unknown }).provider).toBeUndefined();
  });

  it('★全プロバイダが例外で落ちた回も記録しない(「送ろうとした先」を残さない)', async () => {
    providerChain.list = [
      { name: 'gemini', chatModel: 'gemini-flash-latest' },
      { name: 'groq', chatModel: 'llama-x' },
    ];
    createMock.mockReset().mockRejectedValue(new Error('503 unavailable'));
    const r = await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F' });
    expect(r.ok).toBe(false);
    expect((r as { provider?: unknown }).provider).toBeUndefined();
  });

  it('★画像あり群は必ずビジョン対応が答える=層別に使える(交絡1の観測点)', async () => {
    providerChain.list = [{ name: 'openai', chatModel: 'gpt-4o-mini' }];
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: RAW3 } }] });
    const r = await buildScalpPlan({ prices: PRICES, symbol: 'NIY=F', chartImageDataUrl: 'data:image/png;base64,QUJD' });
    expect((r as { imageSent?: boolean }).imageSent).toBe(true);
    expect((r as { provider?: unknown }).provider).toEqual({ name: 'openai', model: 'gpt-4o-mini' });
  });
});
