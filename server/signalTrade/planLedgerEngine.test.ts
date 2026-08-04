// ★計画サイクルの台帳が **実ファイルの SQLite に本当に行が落ちる** ことの実証(メモリDBではない)。
//
// ■ 何を守っているか
//   A/B 実験(数か月〜1年)の主要指標である「見送り率」「レッグが落ちた理由の内訳」は、実測で
//   **DB に1行も残っていなかった**: 運用機のサーバログには plan-suppress が A=212/B=203 件、
//   plan-legdrop が A=32/B=16 件あるのに、signal_trades(=約定して決済された時だけ1行)には
//   対応する行が存在しない。ログはローテートするので1年の実験では消える。
//   → 計画サイクルのたびに 系統A・系統B の両方について1行残す(約定/見送りに関わらず)。
//
// ■ ★ここが今回いちばん危ない所(B の露出)
//   B にも signalId を采番するようになったが、B は紙専用で trade2 が追従するのは A だけ。
//   採番の結果として B が SSE / API / currentSignal に出ることは **あってはいけない**。
//   下の「§B は trade2 に露出しない」で固定する。
//
// ■ ★否定対照(この実装前のコードでの結果)
//   git show HEAD:server/signalTrade/engine.ts > <tmp> には signal_plans への書き込みが無いので
//   「行が入る」テストは全部赤。B の signalId も常に NULL なので「B にも采番される」も赤。
//   露出のテストだけは旧版でも緑(=退行を検出するための不変条件であって、新機能ではない)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ScalpPlanResult } from '../llm/scalpPlan.js';

/** 差し替え可能な AI 応答(各テストが代入する)。 */
let canned: ScalpPlanResult = { ok: false, error: 'unset' };

vi.mock('../llm/scalpPlanRunner.js', () => ({
  runScalpPlanWithChart: vi.fn(async () => canned),
}));

/** SSE の送出を捕まえる(B の payload に何が載っているかを見るため)。 */
const sent: Array<{ type: string; payload: unknown }> = [];
vi.mock('../sse/broker.js', () => ({
  broadcast: (ev: { type: string; payload: unknown }) => { sent.push(ev); },
}));

import { SignalEngine } from './engine.js';
import {
  openDb, resolveDbPath, getSignalPlans, getSignalTrades, setSignalIdCounter,
  SIGNAL_ID_SPACE_BASE, type SignalPlanRow,
} from '../db/store.js';
import { currentSignalResponse } from '../routes/currentSignal.js';

/** B の最初の采番(番号空間の起点+1)。A とは決して重ならない。 */
const B_FIRST = SIGNAL_ID_SPACE_BASE.B + 1;

/** 取引時間内(2026-08-03 月曜 10:00 JST)。時間外だと計画要求そのものが出ない。 */
const NOW = Date.UTC(2026, 7, 3, 1, 0, 0);
const REF = 38250;

const A_CFG = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };
const B_CFG = { profile: 'B' as const, systemTag: 'B' as const, broadcastType: 'signalTradeB' as const, maintainsCurrentSignal: false };

/** 見送り(none)を返す回。 */
const NONE: ScalpPlanResult = {
  ok: true,
  plan: { direction: 'none', rationale: '方向感が定まらず見送り', refPrice: REF, regime: 'unclear', confidence: 25 },
  vetoFired: true, noneReason: 'trend',
};

/** 両レッグそろって ARM する回(現在値を挟むブラケット)。 */
const ARM: ScalpPlanResult = {
  ok: true,
  plan: {
    direction: 'buy', rationale: '押し目買い', refPrice: REF, regime: 'trend_up', confidence: 70,
    limitEntry: 38200, stopLossForLimit: 38145,
    stopEntry: 38300, stopLossForStop: 38245,
  },
  vetoFired: false,
};

/** 片レッグ(逆指値)が落ちたが、残った指値で ARM する回。 */
const ARM_WITH_LEGDROP: ScalpPlanResult = {
  ok: true,
  plan: { direction: 'buy', rationale: '押し目買い(指値のみ)', refPrice: REF, limitEntry: 38200, stopLossForLimit: 38145 },
  vetoFired: false,
  legDrops: [{ name: 'stop', reason: 'missing' }],
};

let dir: string;
let origAppData: string | undefined;
/** ★記録の失敗は握りつぶすが「握りつぶしたことが分かる1行」は必ず出る。それを検査に使う。 */
let warns: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jp225-planledger-'));
  origAppData = process.env.APPDATA;
  process.env.APPDATA = dir;   // 実DBには触らない(temp の実ファイルへ隔離)
  sent.length = 0;
  warns = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')); });
});
afterEach(() => {
  if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

/** 実ファイルの DB を開いて台帳を読む(engine が書いたものを別の接続で読み戻す)。 */
function readPlans(): SignalPlanRow[] {
  const db = openDb(resolveDbPath());
  try { return getSignalPlans(db); } finally { db.close(); }
}

/** エンジンを1サイクル走らせ、台帳に行が入るまで待つ。 */
async function runCycle(cfg: typeof A_CFG | typeof B_CFG, result: ScalpPlanResult): Promise<SignalEngine> {
  canned = result;
  const eng = new SignalEngine(cfg);
  await eng.start();
  eng.feed(REF, NOW);
  await vi.waitFor(() => expect(readPlans().length).toBeGreaterThan(0), { timeout: 3000 });
  return eng;
}

describe('§実ファイルの DB に1サイクル=1行が落ちる', () => {
  it('見送り(none): 理由・veto・設定・根拠が1行に残る(signal_id は NULL)', async () => {
    const eng = await runCycle(A_CFG, NONE);
    const rows = readPlans();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.system).toBe('A');
    expect(r.direction).toBe('none');
    expect(r.none_reason).toBe('trend');
    expect(r.veto_fired).toBe(1);
    expect(r.ref_price).toBe(REF);
    expect(r.regime).toBe('unclear');
    expect(r.confidence).toBe(25);
    expect(r.signal_id).toBeNull();            // ARM していない
    expect(r.error).toBeNull();                // 計画自体は得られている
    expect(r.rationale).toBe('方向感が定まらず見送り');
    // ★設定スナップショットは signal_trades.meta と同じ組み立て(キーが揃っている)。
    const s = JSON.parse(r.settings_json!) as Record<string, unknown>;
    expect(Object.keys(s)).toEqual(expect.arrayContaining(['lcFloor', 'lcCeiling', 'lcHardMax', 'trendVeto', 'cooldown', 'bias', 'range']));
    expect(eng.getPhase()).toBe('flat');
    eng.stop();
  });

  it('ARM: 采番した signal_id と最終プランの4価格が1行に残る', async () => {
    const eng = await runCycle(A_CFG, ARM);
    const r = readPlans()[0]!;
    expect(eng.getPhase()).toBe('armed');
    expect(r.direction).toBe('buy');
    expect(r.signal_id).toBe(1);
    expect(r.limit_entry).toBe(38200);
    expect(r.stop_entry).toBe(38300);
    expect(r.stop_loss_for_limit).toBe(38145);
    expect(r.stop_loss_for_stop).toBe(38245);
    expect(r.none_reason).toBeNull();
    expect(r.leg_drops_json).toBeNull();
    // ARM した回の設定は arm 時に確定したスナップショット(=決済記録に載るものと同じ)。
    expect(r.settings_json).toBe(JSON.stringify(eng.getCurrentSignal()!.settings));
    eng.stop();
  });

  it('レッグ落ち: どのレッグが・どの検証で落ちたかが JSON 配列で残る(見送りでない回でも)', async () => {
    const eng = await runCycle(A_CFG, ARM_WITH_LEGDROP);
    const r = readPlans()[0]!;
    expect(r.direction).toBe('buy');
    expect(r.signal_id).toBe(1);                       // ARM はしている
    expect(JSON.parse(r.leg_drops_json!)).toEqual([{ name: 'stop', reason: 'missing' }]);
    expect(r.stop_entry).toBeNull();                   // 落ちたレッグの価格は最終プランに無い
    eng.stop();
  });

  it('計画が得られなかった回も1行(error 列で見送りと区別できる)', async () => {
    const eng = await runCycle(A_CFG, { ok: false, error: 'chart-not-generated' });
    const r = readPlans()[0]!;
    expect(r.direction).toBeNull();
    expect(r.none_reason).toBeNull();
    expect(r.error).toBe('chart-not-generated');
    expect(r.settings_json).not.toBeNull();
    eng.stop();
  });
});

describe('§A/B の対称性', () => {
  it('同じ入力で A と B の両方に行が入り、B にも signal_id が付く', async () => {
    canned = ARM;
    const a = new SignalEngine(A_CFG);
    const b = new SignalEngine(B_CFG);
    await a.start();
    await b.start();
    // ★2本の feed をずらす: vitest 1.x は **同時に走る動的 import** の片方でモジュールモックを
    //   取りこぼす(片方が本物の runScalpPlanWithChart を呼んで実際にチャートを撮りに行く)。
    //   実運用は本物同士なので関係ない(テスト用の間合い。判定ロジックには一切関係しない)。
    a.feed(REF, NOW);
    await vi.waitFor(() => expect(readPlans().length).toBe(1), { timeout: 3000 });
    b.feed(REF, NOW);
    await vi.waitFor(() => expect(`${readPlans().length} ${warns.join('|')}`).toBe('2 '), { timeout: 3000 });
    const rows = readPlans();
    const byS = new Map(rows.map(r => [r.system, r]));
    expect([...byS.keys()].sort()).toEqual(['A', 'B']);
    // ★A と B は別々の番号空間(B は下駄を履く)。system を落として join しても互いに当たらない。
    expect(byS.get('A')!.signal_id).toBe(1);
    expect(byS.get('B')!.signal_id).toBe(B_FIRST);
    expect(byS.get('B')!.direction).toBe('buy');
    expect(byS.get('B')!.settings_json).not.toBeNull();
    a.stop(); b.stop();
  });

  it('B の決済記録(signal_trades)にも signal_id が入る(従来は常に NULL で結合不能だった)', async () => {
    const b = await runCycle(B_CFG, ARM);
    expect(b.getPhase()).toBe('armed');
    // 指値 38200 を跨いで擬似約定 → さらに動かして決済させる。
    b.feed(38190, NOW + 1000);
    expect(b.getPhase()).toBe('filled');
    // 逆行させて損切り側へ(初期LC 38145 を割る)。
    b.feed(38100, NOW + 2000);
    await vi.waitFor(() => {
      const db = openDb(resolveDbPath());
      try { expect(getSignalTrades(db, 10, 'B').length).toBe(1); } finally { db.close(); }
    }, { timeout: 3000 });
    const db = openDb(resolveDbPath());
    try {
      const t = getSignalTrades(db, 10, 'B')[0]!;
      expect(t.system).toBe('B');
      expect(t.signal_id).toBe(B_FIRST);   // ★ここが従来 NULL だった
    } finally { db.close(); }
    b.stop();
  });
});

describe('§番号空間: A と B は決して重ならない', () => {
  /** 1サイクルぶん ARM して決済まで進め、エンジンを捨てる(= 次は再起動と同じくDBからシードし直す)。 */
  async function armFillExit(cfg: typeof A_CFG | typeof B_CFG, n: number, t: number): Promise<number> {
    canned = ARM;
    const eng = new SignalEngine(cfg);
    await eng.start();
    eng.feed(REF, t);
    await vi.waitFor(() => expect(readPlans().length).toBe(n), { timeout: 3000 });
    eng.feed(38190, t + 1000);   // 擬似約定
    eng.feed(38100, t + 2000);   // 損切りで決済 → signal_trades へ1行
    const sid = eng._peekArmedSignalId()!;
    eng.stop();
    return sid;
  }

  it('A は既存記録の続き(537〜)/ B は別空間(1,000,001〜)から始まる', async () => {
    // 実機と同じ状況を作る: A は 536 まで采番済み、B はまだ1度も采番していない(実データでは全て NULL)。
    const seed = openDb(resolveDbPath());
    try { setSignalIdCounter(seed, 'A', 536); } finally { seed.close(); }

    const aSid = await armFillExit(A_CFG, 1, NOW);
    const bSid = await armFillExit(B_CFG, 2, NOW + 600_000);
    expect(aSid).toBe(537);
    expect(bSid).toBe(1_000_001);
    expect(SIGNAL_ID_SPACE_BASE.B).toBe(1_000_000);

    // ★台帳と決済記録の **両方** で確認する。
    const rows = readPlans();
    expect(rows.find(r => r.system === 'A')!.signal_id).toBe(537);
    expect(rows.find(r => r.system === 'B')!.signal_id).toBe(1_000_001);
    const db = openDb(resolveDbPath());
    try {
      expect(getSignalTrades(db, 10, 'A')[0]!.signal_id).toBe(537);
      expect(getSignalTrades(db, 10, 'B')[0]!.signal_id).toBe(1_000_001);
    } finally { db.close(); }
  });

  it('再起動しても巻き戻らない/ 何度走らせても A と B の signal_id は1つも重複しない', async () => {
    const seed = openDb(resolveDbPath());
    try { setSignalIdCounter(seed, 'A', 536); } finally { seed.close(); }

    // 各サイクルで **エンジンを作り直す** = 毎回 DB からシードし直す(再起動と同じ経路)。
    const aIds: number[] = [];
    const bIds: number[] = [];
    let n = 0;
    for (let i = 0; i < 3; i++) {
      aIds.push(await armFillExit(A_CFG, ++n, NOW + i * 600_000));
      bIds.push(await armFillExit(B_CFG, ++n, NOW + i * 600_000 + 300_000));
    }
    // 単調増加(巻き戻り無し)。
    expect(aIds).toEqual([537, 538, 539]);
    expect(bIds).toEqual([1_000_001, 1_000_002, 1_000_003]);

    // ★重複ゼロ: system を落として突合しても、互いの行には1件も当たらない。
    const db = openDb(resolveDbPath());
    try {
      const a = new Set(getSignalTrades(db, 100, 'A').map(t => t.signal_id));
      const b = new Set(getSignalTrades(db, 100, 'B').map(t => t.signal_id));
      expect(a.size).toBe(3);
      expect(b.size).toBe(3);
      expect([...a].filter(x => b.has(x))).toEqual([]);
      // 台帳側も同じ(こちらは system が NOT NULL だが、番号だけでも交わらない)。
      const pa = new Set(getSignalPlans(db, 100, 'A').map(r => r.signal_id));
      const pb = new Set(getSignalPlans(db, 100, 'B').map(r => r.signal_id));
      expect([...pa].filter(x => pb.has(x))).toEqual([]);
    } finally { db.close(); }
  });
});

describe('§B は trade2 に露出しない(采番しても)', () => {
  it('B が ARM して signalId を持っても、currentSignal / hold / API / SSE のどこにも出ない', async () => {
    const b = await runCycle(B_CFG, ARM);
    expect(b.getPhase()).toBe('armed');
    // ① 内部では采番されている(記録用)。
    expect(b._peekArmedSignalId()).toBe(B_FIRST);
    expect(readPlans()[0]!.signal_id).toBe(B_FIRST);
    // ② それでも露出経路は空のまま。
    expect(b.getCurrentSignal()).toBeNull();
    expect(b.getHold()).toBeNull();
    const state = b.getState(NOW);
    expect(state.signal).toBeUndefined();
    expect(state.hold).toBeUndefined();
    expect(state.lastExitedSignalId).toBeUndefined();
    // ③ trade2 が読む API の形(=/api/current-signal と同じ組み立て)にも出ない。
    expect(currentSignalResponse(b.getCurrentSignal(), b.getHold(), b.getPhase()))
      .toEqual({ signalId: null, hold: null, phase: 'armed' });
    // ④ SSE: B は 'signalTradeB' だけを出し、その payload に signalId は1つも無い。
    const types = [...new Set(sent.map(e => e.type))];
    expect(types).toEqual(['signalTradeB']);
    for (const e of sent) expect(JSON.stringify(e.payload)).not.toContain('signalId');
    b.stop();
  });

  it('約定→決済まで進んでも B の SSE に signalId は現れない(lastExitedSignalId も出さない)', async () => {
    const b = await runCycle(B_CFG, ARM);
    b.feed(38190, NOW + 1000);   // 擬似約定
    b.feed(38100, NOW + 2000);   // 損切りで決済
    expect(b.getPhase()).toBe('flat');
    expect(b.getState(NOW + 2000).lastExitedSignalId).toBeUndefined();
    for (const e of sent) {
      expect(e.type).toBe('signalTradeB');
      expect(JSON.stringify(e.payload)).not.toContain('signalId');
    }
    b.stop();
  });

  it('A は従来どおり露出する(B を黙らせる変更が A を巻き添えにしていない)', async () => {
    const a = await runCycle(A_CFG, ARM);
    expect(a.getCurrentSignal()?.signalId).toBe(1);
    expect(a.getState(NOW).signal?.signalId).toBe(1);
    expect(sent.every(e => e.type === 'signalTrade')).toBe(true);
    a.stop();
  });
});

describe('§既存DBとの互換', () => {
  it('この表が無い古い DB を開いても落ちず、後付けされて記録が始まる', async () => {
    // 旧スキーマ(signal_plans が無い DB)を手で作る=実運用機の既存 jp225.db と同じ状況。
    const path = resolveDbPath();
    const first = openDb(path);
    first.exec('DROP TABLE signal_plans');
    first.close();
    const check = new DatabaseSync(path);
    try {
      expect((check.prepare("SELECT name FROM sqlite_master WHERE name='signal_plans'").all()).length).toBe(0);
    } finally { check.close(); }

    const eng = await runCycle(A_CFG, NONE);   // openDb 経由で後付けされ、記録も通る
    expect(readPlans()).toHaveLength(1);
    eng.stop();
  });
});
