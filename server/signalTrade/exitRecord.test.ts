// ★決済パラメータ分析用の記録(R1/R2/R3)の検証。**記録のみ**で決済の判断/価格/タイミングは変えない。
//
//   R1 exit_reason       … どの経路で建玉が閉じたか(初期LC / ラチェット床 / レンジLC / レンジTP / ドテン)
//   R2 exit_initial_stop … **約定したレッグ** の初期LC(絶対価格)。meta.settings の LC は代表レッグ(指値優先)で
//                          2レッグのブラケットでは実際に約定したレッグと食い違う(このファイルで実証する)
//   R3 peak_profit       … 決済時点の含み益ピーク[pt](= ラチェット床の決定に使っている値そのもの)
//
// ★このファイルは非公開 phase-exit(exit/private.ts)の数値を一切使わない。ラチェットは「契約」だけを
//   再現した疑似実装(_setExitImpl)で検証する(公開リポに数値を持ち込まないため)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  advance, reverseToDoten, realizedLcFromArmed,
  type ArmedBracket, type EngineState, type OpenPosition, type RecordedTrade,
} from './decisions.js';
import { buildSignalTradeInsert } from './persist.js';
import { _setExitImpl, type ExitFn } from './exit/index.js';
import { EXIT_REASONS, EXIT_REASON_SPEC, isExitReason, exitReasonLabel, type ExitReason } from '../../core/exitReasons.js';
import { openDb, resolveDbPath, getSignalTrades, initSchema, type SignalTradeRow } from '../db/store.js';
import { SignalEngine } from './engine.js';
import { resetConfigCache } from '../configStore.js';
import { setPrices } from '../cache.js';
import type { AiPlan } from '../llm/openai.js';

/** ★テスト用の疑似ラチェット(非公開 private.ts の数値は使わない・**契約だけ** を再現する):
 *  含み益ピークが 100pt に達したら床=建値±50。床は有利側にのみ動き、初期LC より不利にはしない(max/min)。
 *  ★この max/min が exit_reason の判別根拠: 床が未発動/初期LCより不利なら computeExitStop は initialStop を
 *    **そのまま返す** ので、ヒットした逆指値と initialStop の同値比較で「初期LC か 床か」が分かる。 */
const fakeRatchet: ExitFn = (s) => {
  if (!Number.isFinite(s.initialStop)) return null;
  if (s.peakProfit < 100) return s.initialStop;
  const floor = s.direction === 'buy' ? s.entryPrice + 50 : s.entryPrice - 50;
  return s.direction === 'buy' ? Math.max(s.initialStop, floor) : Math.min(s.initialStop, floor);
};

afterEach(() => _setExitImpl(null));

// ═══ SSOT(core/exitReasons.ts)═══════════════════════════════════════════

describe('決済理由の唯一の表(core/exitReasons.ts)', () => {
  it('全理由に表示名がある(表に1行足すまで型検査が通らない=手書き union は存在しない)', () => {
    for (const r of EXIT_REASONS) {
      expect(EXIT_REASON_SPEC[r].label.length).toBeGreaterThan(0);
      expect(exitReasonLabel(r)).toBe(EXIT_REASON_SPEC[r].label);
    }
  });
  it('ラチェット床だけが ratchet:true(=決済パラメータ変更の反実仮想の主対象)', () => {
    expect(EXIT_REASONS.filter(r => EXIT_REASON_SPEC[r].ratchet)).toEqual(['ratchet_floor']);
  });
  it('未検証入力の判定は Object.prototype をすり抜けない', () => {
    expect(isExitReason('initial_stop')).toBe(true);
    expect(isExitReason('toString')).toBe(false);
    expect(isExitReason('constructor')).toBe(false);
    expect(isExitReason(undefined)).toBe(false);
    expect(exitReasonLabel(null)).toBeNull();   // 旧行(NULL)は未知扱い
  });
});

// ═══ R1: 決済理由 ═════════════════════════════════════════════════════════

describe('R1 決済理由: 全5経路がコードの決済地点と1対1で対応する', () => {
  /** 経路①: 初期LC 到達(ラチェット未発動)。 */
  function exitInitialStop(): RecordedTrade {
    _setExitImpl(fakeRatchet);
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500,
    };
    const { next, recorded } = advance({ phase: 'filled', position }, 37950, 2_000);
    expect(next.phase).toBe('flat');
    expect(recorded!.exitPrice).toBe(37950);   // 逆指値決済=逆指値価格ちょうど(実測)
    return recorded!;
  }

  /** 経路②: ラチェット床 到達(ピークが伸びて床が発動した後に戻された)。 */
  function exitRatchetFloor(): RecordedTrade {
    _setExitImpl(fakeRatchet);
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500,
    };
    const up = advance({ phase: 'filled', position }, 38100, 1_000);   // peak=100 → 床=38050 発動(まだ決済しない)
    expect(up.next.phase).toBe('filled');
    expect(up.recorded).toBeUndefined();
    const { next, recorded } = advance(up.next, 38040, 2_000);         // 床 38050 を割った → 決済
    expect(next.phase).toBe('flat');
    expect(recorded!.exitPrice).toBe(38050);   // 床 38050 ちょうど(逆指値決済=スリップ無し)
    return recorded!;
  }

  /** 経路③: レンジ建玉の固定初期LC 到達。 */
  function exitRangeStop(): RecordedTrade {
    _setExitImpl(fakeRatchet);   // ★レンジ建玉はラチェットを使わない(=疑似ラチェットを入れても結果が変わらない)
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 38100, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'r',
      at: 500, mode: 'range', rangeTp: 38400,
    };
    const { next, recorded } = advance({ phase: 'filled', position }, 38050, 2_000);
    expect(next.phase).toBe('flat');
    return recorded!;
  }

  /** 経路④: レンジ建玉の反対側節目手前で成行TP。 */
  function exitRangeTp(): RecordedTrade {
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 38100, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'r',
      at: 500, mode: 'range', rangeTp: 38400,
    };
    const { next, recorded } = advance({ phase: 'filled', position }, 38395, 2_000);   // TP トリガ=38400−5
    expect(next.phase).toBe('flat');
    return recorded!;
  }

  /** 経路⑤: ドテン(保有中の反転評価)で成行決済。 */
  function exitDoten(): RecordedTrade {
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 120, rationale: 'orig', at: 500,
    };
    const plan: AiPlan = { direction: 'sell', limitEntry: 38050, stopLossForLimit: 38100, rationale: '反転', refPrice: 38000 };
    const rev = reverseToDoten({ phase: 'filled', position }, plan, 38020, 2_000)!;
    return rev.recorded;
  }

  it('初期LC 到達 → initial_stop', () => {
    expect(exitInitialStop().exitReason).toBe<ExitReason>('initial_stop');
  });
  it('ラチェット床 到達 → ratchet_floor', () => {
    expect(exitRatchetFloor().exitReason).toBe<ExitReason>('ratchet_floor');
  });
  it('レンジ建玉の固定LC 到達 → range_stop', () => {
    expect(exitRangeStop().exitReason).toBe<ExitReason>('range_stop');
  });
  it('レンジ建玉の成行TP → range_tp', () => {
    expect(exitRangeTp().exitReason).toBe<ExitReason>('range_tp');
  });
  it('ドテンの成行決済 → doten', () => {
    expect(exitDoten().exitReason).toBe<ExitReason>('doten');
  });

  // ★「次に決済経路が増えたときに漏れない」仕掛けの実証(表と実装の双方向チェック):
  //   ・表 → 実装: 表に理由を足したのに、それを出す決済経路が無ければ ここが落ちる(死んだ選択肢の禁止)。
  //   ・実装 → 表: 決済経路を足す = RecordedTrade を作る = 必須の exitReason に表のキーを入れる、以外に方法が無い
  //     (RecordedTrade.exitReason は必須フィールド。型検査が通らないので黙って記録漏れにできない)。
  it('表の全理由が実際の決済経路から1つずつ出る(表と実装が食い違ったら落ちる)', () => {
    const produced = new Set<string>([
      exitInitialStop().exitReason, exitRatchetFloor().exitReason, exitRangeStop().exitReason,
      exitRangeTp().exitReason, exitDoten().exitReason,
    ]);
    expect([...produced].sort()).toEqual([...EXIT_REASONS].sort());
  });

  it('決済しない tick では記録そのものが作られない(理由も付かない)', () => {
    _setExitImpl(fakeRatchet);
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500,
    };
    expect(advance({ phase: 'filled', position }, 38010, 1_000).recorded).toBeUndefined();
  });
});

// ═══ R2: 約定したレッグの初期LC ════════════════════════════════════════════

describe('R2 exit_initial_stop: 代表レッグではなく **約定したレッグ** の初期LC', () => {
  // 2レッグのブラケット: 指値(37950/SL 37900)と 逆指値(38100/SL 38050)。
  const bracket: ArmedBracket = {
    direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900,
    stopEntry: 38100, stopLossForStop: 38050, rationale: 'r', at: 0,
  };

  it('逆指値レッグが約定したら、その初期LC(38050)が記録される', () => {
    _setExitImpl(fakeRatchet);
    const filled = advance({ phase: 'armed', armed: bracket }, 38100, 1_000);   // 逆指値レッグ約定
    expect(filled.next.position).toMatchObject({ entryPrice: 38100, initialStop: 38050 });
    const { recorded } = advance(filled.next, 38050, 2_000);                    // 初期LC 到達
    expect(recorded!.exitReason).toBe<ExitReason>('initial_stop');
    expect(recorded!.exitInitialStop).toBe(38050);
  });

  it('指値レッグが約定したら、その初期LC(37900)が記録される(同じブラケットでも値が違う)', () => {
    _setExitImpl(fakeRatchet);
    const filled = advance({ phase: 'armed', armed: bracket }, 37945, 1_000);   // 指値レッグ約定(5円行き過ぎ)
    expect(filled.next.position).toMatchObject({ entryPrice: 37950, initialStop: 37900 });
    const { recorded } = advance(filled.next, 37900, 2_000);
    expect(recorded!.exitInitialStop).toBe(37900);
  });

  it('★従来 meta.settings に載る「代表レッグ」の LC 幅とは食い違う(=これが記録を足した理由)', () => {
    // 代表レッグ(realizedLcFromArmed)は指値優先 → 幅50。しかし逆指値レッグで約定すると実際の初期LC幅は 50
    // ではなく建玉ごとの実値になる(建値 38100 − 初期LC 38050 = 50)。ここでは幅が一致するので、
    // 「代表レッグでは再現できない」ことは 指値レッグ側(37950−37900=50 vs 逆指値レッグ 38100−38050=50)
    // ではなく **initialStop の絶対値**(37900 vs 38050)で示す。
    expect(realizedLcFromArmed(bracket)).toBe(50);
    _setExitImpl(fakeRatchet);
    const filled = advance({ phase: 'armed', armed: bracket }, 38100, 1_000);
    const pos = filled.next.position!;
    expect(Math.abs(pos.entryPrice - pos.initialStop)).toBe(50);
    const { recorded } = advance(filled.next, 38050, 2_000);
    expect(Math.abs(recorded!.entryPrice - recorded!.exitInitialStop)).toBe(50);   // ★実際に効いた初期LC 幅
    expect(recorded!.exitInitialStop).toBe(38050);   // ★代表レッグの初期LC(37900)ではない=これが記録を足した理由
  });

  it('レンジ/ドテンでも約定レッグの初期LC が載る', () => {
    const rangePos: OpenPosition = {
      direction: 'sell', entryPrice: 38400, qty: 1, initialStop: 38450, peakProfit: 0, rationale: 'r',
      at: 500, mode: 'range', rangeTp: 38100,
    };
    expect(advance({ phase: 'filled', position: rangePos }, 38450, 2_000).recorded!.exitInitialStop).toBe(38450);
    const held: OpenPosition = {
      direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37930, peakProfit: 10, rationale: 'orig', at: 500,
    };
    const plan: AiPlan = { direction: 'sell', limitEntry: 38050, stopLossForLimit: 38100, rationale: '反転', refPrice: 38000 };
    expect(reverseToDoten({ phase: 'filled', position: held }, plan, 38020, 2_000)!.recorded.exitInitialStop).toBe(37930);
  });
});

// ═══ R3: 決済時点の含み益ピーク ════════════════════════════════════════════

describe('R3 peak_profit: エンジンが追跡している含み益ピーク(床の決定に使う値)', () => {
  it('伸びたピークが決済記録に残る(価格を再生せずに MFE と 床の段が分かる)', () => {
    _setExitImpl(fakeRatchet);
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500,
    };
    let st: EngineState = { phase: 'filled', position };
    st = advance(st, 38080, 1_000).next;    // +80
    st = advance(st, 38210, 2_000).next;    // +210 ← ピーク
    st = advance(st, 38150, 3_000).next;    // 戻し(ピークは据え置き)
    expect(st.position!.peakProfit).toBe(210);
    const { recorded } = advance(st, 38040, 4_000);   // 床 38050 割れ → 決済
    expect(recorded!.exitReason).toBe<ExitReason>('ratchet_floor');
    expect(recorded!.peakProfit).toBe(210);          // ★決済時点のピーク
    // ★床の段の逆算: 記録された決済価格(=床ちょうど) − 建値 = +50pt。設定表と突き合わせて「どの段か」が分かる。
    expect(recorded!.exitPrice - recorded!.entryPrice).toBe(50);
  });

  it('sell 側も同じ(下落方向のピーク)', () => {
    _setExitImpl(fakeRatchet);
    const position: OpenPosition = {
      direction: 'sell', entryPrice: 38000, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'r', at: 500,
    };
    let st: EngineState = { phase: 'filled', position };
    st = advance(st, 37850, 1_000).next;   // +150
    const { recorded } = advance(st, 37960, 2_000);   // 床 37950 に届かず…ではなく戻しで床ヒット
    expect(recorded!.peakProfit).toBe(150);
    expect(recorded!.exitReason).toBe<ExitReason>('ratchet_floor');
  });

  it('ラチェット未発動(ピークが小さい)まま初期LC で切られた場合もピークが残る', () => {
    _setExitImpl(fakeRatchet);
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500,
    };
    let st: EngineState = { phase: 'filled', position };
    st = advance(st, 38070, 1_000).next;   // +70(床は発動しない)
    const { recorded } = advance(st, 37940, 2_000);
    expect(recorded!.exitReason).toBe<ExitReason>('initial_stop');
    expect(recorded!.peakProfit).toBe(70);   // ★「あと少しで床だった」が事後に分かる
  });
});

// ═══ 挿入行 / DB ═════════════════════════════════════════════════════════

describe('buildSignalTradeInsert: 3点を挿入行へ', () => {
  const base: RecordedTrade = {
    entryT: 1_000, entryPrice: 38000, dir: 'buy', exitT: 2_000, exitPrice: 38050, pnl: 50, qty: 1, rationale: 'r',
    exitReason: 'ratchet_floor', exitInitialStop: 37950, peakProfit: 210,
  };
  it('理由/初期LC/ピークが挿入行に載る', () => {
    expect(buildSignalTradeInsert(base, null, 3)).toMatchObject({
      exitReason: 'ratchet_floor', exitInitialStop: 37950, peakProfit: 210,
    });
  });
  it('系統 B でも同じ(記録は系統に依らない)', () => {
    expect(buildSignalTradeInsert(base, 'B').exitReason).toBe('ratchet_floor');
  });
  it('非有限な数値は列に入れない(NULL に落として集計を汚さない)', () => {
    const broken = buildSignalTradeInsert({ ...base, exitInitialStop: NaN, peakProfit: Infinity }, null);
    expect('exitInitialStop' in broken).toBe(false);
    expect('peakProfit' in broken).toBe(false);
    expect(broken.exitReason).toBe('ratchet_floor');   // 理由は union なので必ず載る
  });
});

describe('signal_trades のマイグレーション(冪等)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jp225-exitrec-mig-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('旧スキーマ(3列なし)の DB を開くと ALTER で追加され、2回開いても落ちない', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const path = join(dir, 'old.db');
    const raw = new DatabaseSync(path);
    // ★v0.9.49 以前の signal_trades(新3列なし)を再現する。
    raw.exec(`CREATE TABLE signal_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_t INTEGER NOT NULL, entry_price REAL NOT NULL, dir TEXT NOT NULL,
      exit_t INTEGER NOT NULL, exit_price REAL NOT NULL, pnl REAL NOT NULL,
      qty INTEGER NOT NULL, rationale TEXT, meta TEXT, mode TEXT
    )`);
    raw.prepare('INSERT INTO signal_trades (entry_t, entry_price, dir, exit_t, exit_price, pnl, qty) VALUES (1,38000,\'buy\',2,38050,50,1)').run();
    raw.close();

    const db = openDb(path);   // ← initSchema の ALTER が走る
    try {
      initSchema(db);          // ← 2回目(冪等)
      const cols = (db.prepare('PRAGMA table_info(signal_trades)').all() as Array<{ name: string }>).map(c => c.name);
      expect(cols).toEqual(expect.arrayContaining(['exit_reason', 'exit_initial_stop', 'peak_profit']));
      const old = getSignalTrades(db)[0]!;
      expect(old.exit_reason).toBeNull();        // ★既存行は NULL のまま(後方互換)
      expect(old.exit_initial_stop).toBeNull();
      expect(old.peak_profit).toBeNull();
    } finally { db.close(); }   // ★失敗しても閉じる(Windows で temp DB が掴まれたままになるのを防ぐ)
  });
});

// ═══ E2E: ARM → 約定 → 決済 → signal_trades / 記録失敗は取引を止めない ═══════════

describe('E2E(engine → temp DB): 3点が実際に signal_trades へ書かれる', () => {
  let dir: string;
  let origAppData: string | undefined;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-exitrec-'));
    origAppData = process.env.APPDATA;
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE;
    process.env.APPDATA = dir;                                // 実ユーザーDB を触らない(temp へ隔離)。
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    resetConfigCache();
    setPrices([]);
  });
  afterEach(() => {
    _setExitImpl(null);
    setPrices([]);
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  function newEngineA(): SignalEngine {
    return new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
  }
  function rows(): SignalTradeRow[] {
    const db = openDb(resolveDbPath());
    try { return getSignalTrades(db); } finally { db.close(); }
  }
  /** ARM 済み(2レッグ)の engine を作る。AI(scalpPlanRunner)は呼ばない= _setArmedForTest で直接武装する。 */
  async function armedEngine(): Promise<SignalEngine> {
    const eng = newEngineA();
    await eng.start();
    _setExitImpl(fakeRatchet);
    eng._setArmedForTest({
      direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900,
      stopEntry: 38100, stopLossForStop: 38050, rationale: 'r', at: 1_000,
    }, { signalId: 7, at: 1_000, direction: 'buy', rationale: 'r', limitEntry: 37950, stopLossForLimit: 37900 });
    return eng;
  }

  it('逆指値レッグ約定 → 床決済: exit_reason / exit_initial_stop(約定レッグ) / peak_profit が入る', async () => {
    const eng = await armedEngine();
    eng.feed(38100, 2_000);   // 逆指値レッグ約定(建値 38100=逆指値ちょうど・初期LC 38050)
    expect(eng.getPhase()).toBe('filled');
    eng.feed(38250, 3_000);   // +150 → 床(建値+50=38150)発動
    eng.feed(38140, 4_000);   // 床割れ → 決済
    expect(eng.getPhase()).toBe('flat');
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.exit_reason).toBe('ratchet_floor');
    expect(r[0]!.exit_initial_stop).toBe(38050);   // ★代表レッグ(37900)ではなく約定レッグの初期LC
    expect(r[0]!.peak_profit).toBe(150);
    eng.stop();
  });

  it('初期LC で切られた場合は exit_reason=initial_stop(既存列は従来どおり)', async () => {
    const eng = await armedEngine();
    eng.feed(37945, 2_000);   // 指値レッグ約定(建値 37950・初期LC 37900)
    eng.feed(37900, 3_000);   // 初期LC 到達
    expect(eng.getPhase()).toBe('flat');
    const r = rows();
    expect(r[0]!.exit_reason).toBe('initial_stop');
    expect(r[0]!.exit_initial_stop).toBe(37900);
    expect(r[0]!.peak_profit).toBe(0);
    expect(r[0]!.signal_id).toBe(7);          // 既存の記録は不変
    expect(r[0]!.exit_price).toBe(37900);     // 逆指値決済=逆指値価格ちょうど(実測)
    eng.stop();
  });

  // ★「記録の失敗が取引を止めない」= 無音の失敗を作らないための最重要条件。
  //   書き込み経路(resolveDbPath→openDb)を実際に失敗させ、決済が最後まで進むことを確認する。
  it('記録の書き込みが失敗しても決済は止まらない(phase は flat へ進み、次の tick も動く)', async () => {
    const eng = await armedEngine();
    eng.feed(38100, 2_000);   // 逆指値レッグ約定(建値 38105・初期LC 38050)
    expect(eng.getPhase()).toBe('filled');
    eng.feed(38250, 2_500);   // +145 → 床(建値+50=38155)発動

    // ★DB ディレクトリの位置に **ファイル** を置いて mkdirSync/openDb を確実に失敗させる(ディスク/権限障害の再現)。
    writeFileSync(join(dir, 'jp225-monitor-blocked'), 'x');
    process.env.APPDATA = join(dir, 'jp225-monitor-blocked');
    expect(() => resolveDbPath()).toThrow();   // ★否定対照: この状態で書き込み経路は確かに落ちる

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => eng.feed(38150, 3_000)).not.toThrow();   // 床決済の tick(記録は失敗する)
    expect(eng.getPhase()).toBe('flat');                  // ★決済そのものは完了している
    expect(eng.getState(3_000).lastExit).toMatchObject({ exitPrice: 38150 });   // 床 38155 − 成行スリップ5
    expect(warn).toHaveBeenCalled();                      // 失敗は黙殺せずログに出る
    warn.mockRestore();

    // 復旧後は次のトレードが通常どおり記録される(壊れっぱなしにならない)。
    process.env.APPDATA = dir;
    eng._setArmedForTest({ direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r2', at: 4_000 },
      { signalId: 8, at: 4_000, direction: 'buy', rationale: 'r2', limitEntry: 37950, stopLossForLimit: 37900 });
    eng.feed(37945, 5_000);
    eng.feed(37900, 6_000);
    expect(eng.getPhase()).toBe('flat');
    const r = rows();
    expect(r).toHaveLength(1);                            // 失敗した1件は落ちたが、取引は継続している
    expect(r[0]!.exit_reason).toBe('initial_stop');
    eng.stop();
  });
});
