// ★引け全決済(session_close)の検証。
//
// ■ 何を直したか
//   trade2 は引け(15:45 / 6:00)で建玉を全決済する(dryrun=core/engine.ts の flatten / live=atclose 実発注)。
//   monitor の紙エンジンにはその経路が無く、次セッションまで持ち越していた=**決済規則そのものの食い違い**。
//   実測3件の差は +40 / +55 / −80円 で、スリッページでも遅延でも説明できない。
//
// ■ ★実装が「引け以降の最初のティックで発火」ではいけない理由(実測 2026-09-02・prices_kabu.db の複製)
//   monitor のエンジンは **引けから次の寄りまで1本もティックを受け取らない**。
//     bars_1m 407,386本(2025-12-29〜2026-09-02) / ticks 282,089件 / signal_plans 3,254件 /
//     signal_exit_stops 2,279件 — どれを数えても 15:45〜17:00 と 6:00〜8:45 は **全て0件**。
//   (priceLoop が `!niy.stale` のときだけ engine へ供給し、価格源の liveFlag が引けで 0 になるため。
//    inPollWindow の前後マージンは効いていない。)
//   → 「引け以降の最初のティック」は 75〜165分あとの **寄り値**。そこで閉じたら持ち越しの損益がそのまま残り、
//     直そうとした食い違いが1円も直らない。
//   → だから: **発火するのは引け後の最初の tick / 決済価格は引け前に最後に見た価格 / 決済時刻は引けの時刻**。
//     これは trade2 forward/run.ts と同じ材料(sessionClose の price=lastPrice)。
//
// ■ ここで守る順序(規約)
//   ・引けが **この tick より前** … 引けが先(既に閉じているはずの建玉に寄り値の損切りを当てない)。
//   ・引けが **この tick ちょうど** … 損側 → 利側(TP)→ 引け(既存の「損側が先」の規約と同じ)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { advance, armedToCurrentSignal, reverseToDoten, toSignalTradeState, type ArmedBracket, type EngineState, type OpenPosition } from './decisions.js';
import { _setExitImpl, type ExitFn } from './exit/index.js';
import { nextSessionCloseMs } from '../../core/session.js';
import { openDb, resolveDbPath, getSignalTrades, type SignalTradeRow } from '../db/store.js';
import { buildPositionView, type PanelView, type SignalTradeState as PanelState } from '../../web/components/signalPanel.js';
import { SignalEngine } from './engine.js';
import { resetConfigCache } from '../configStore.js';
import { setPrices } from '../cache.js';

/** ★非公開 private.ts の数値を使わない疑似決済関数: 床は一切動かさず初期LC をそのまま返す
 *  (= 引けの判定だけを見たいので、ラチェットの寄与をゼロにする)。 */
const noRatchet: ExitFn = (s) => (Number.isFinite(s.initialStop) ? s.initialStop : null);

// 2026-08-25(火)の日中セッション。JST = UTC+9。
const ENTRY_DAY = Date.UTC(2026, 7, 25, 6, 26, 0);    // 15:26 JST
const CLOSE_DAY = Date.UTC(2026, 7, 25, 6, 45, 0);    // 15:45 JST(引け)
const REOPEN_NIGHT = Date.UTC(2026, 7, 25, 8, 0, 3);  // 17:00:03 JST(引け後の最初の tick)
// 夜間セッション(2026-08-25 17:00 JST → 2026-08-26 6:00 JST)。
const ENTRY_NIGHT = Date.UTC(2026, 7, 25, 20, 0, 0);  // 2026-08-26 05:00 JST
const CLOSE_NIGHT = Date.UTC(2026, 7, 25, 21, 0, 0);  // 2026-08-26 06:00 JST(引け)
const REOPEN_DAY = Date.UTC(2026, 7, 25, 23, 45, 8);  // 2026-08-26 08:45:08 JST

const longPos = (at: number): OpenPosition => ({
  direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at,
});

afterEach(() => _setExitImpl(null));

// ═══ 引けの時刻(core/session.ts が唯一の権威)═══════════════════════════════

describe('nextSessionCloseMs: 引けの時刻(15:45 / 6:00)を core/session.ts から引く', () => {
  it('日中セッション中の時刻 → その日の 15:45', () => {
    expect(nextSessionCloseMs(ENTRY_DAY)).toBe(CLOSE_DAY);
  });
  it('夜間セッション中(夕方)の時刻 → 翌朝 6:00', () => {
    expect(nextSessionCloseMs(ENTRY_NIGHT)).toBe(CLOSE_NIGHT);
  });
  it('早朝継続(0:00-6:00)の時刻 → 当日 6:00', () => {
    expect(nextSessionCloseMs(Date.UTC(2026, 7, 25, 19, 0, 0))).toBe(CLOSE_NIGHT);   // 04:00 JST
  });
  it('引けちょうどは「もう来た」扱い=次の引けを返す(半開区間)', () => {
    expect(nextSessionCloseMs(CLOSE_DAY)).toBe(CLOSE_NIGHT);
    expect(nextSessionCloseMs(CLOSE_DAY - 1)).toBe(CLOSE_DAY);
  });
  it('引けと寄りの間(15:45-17:00)の時刻 → 翌朝 6:00(既に日中の引けは過ぎている)', () => {
    expect(nextSessionCloseMs(Date.UTC(2026, 7, 25, 7, 0, 0))).toBe(CLOSE_NIGHT);   // 16:00 JST
  });
});

// ═══ 引けをまたいだ建玉 ════════════════════════════════════════════════════

describe('引けをまたいだ建玉は引けで全決済される', () => {
  it('日中の引け: 決済時刻=15:45 / 決済価格=引け前に最後に見た価格 **そのもの**(スリップ無し)', () => {
    _setExitImpl(noRatchet);
    const { next, recorded } = advance({ phase: 'filled', position: longPos(ENTRY_DAY) }, 38300, REOPEN_NIGHT,
      { prevTick: { price: 38020, t: CLOSE_DAY - 2_000 } });
    expect(next.phase).toBe('flat');
    expect(recorded!.exitReason).toBe('session_close');
    expect(recorded!.exitT).toBe(CLOSE_DAY);       // ★寄りの時刻(REOPEN_NIGHT)ではない
    expect(recorded!.exitPrice).toBe(38020);       // ★引け値ちょうど(trade2 の closeAt と同じ=スリップを引かない)
    expect(recorded!.pnl).toBe(20);
    expect(recorded!.exitInitialStop).toBe(37950);
    // ★台帳(recorded.exitT)は引けの時刻 / 画面用(lastExit.at)は **この tick の時刻**。
    //   画面は now − lastExit.at < 40秒 で「✔ 決済」を出すので、ここに引けの時刻を入れると
    //   判定した瞬間には既に窓の外=決済表示が一度も出ない(音だけ鳴る)。
    expect(next.lastExit).toEqual({ exitPrice: 38020, pnl: 20, at: REOPEN_NIGHT });
  });

  it('夜間の引け(6:00)も同じ', () => {
    _setExitImpl(noRatchet);
    const { recorded } = advance({ phase: 'filled', position: longPos(ENTRY_NIGHT) }, 38300, REOPEN_DAY,
      { prevTick: { price: 37960, t: CLOSE_NIGHT - 1_000 } });
    expect(recorded!.exitReason).toBe('session_close');
    expect(recorded!.exitT).toBe(CLOSE_NIGHT);
    expect(recorded!.exitPrice).toBe(37960);   // 引け値ちょうど
  });

  it('売り建玉でもスリップしない(引け値ちょうど・向きに依らない)', () => {
    _setExitImpl(noRatchet);
    const pos: OpenPosition = { ...longPos(ENTRY_DAY), direction: 'sell', initialStop: 38050 };
    const { recorded } = advance({ phase: 'filled', position: pos }, 37000, REOPEN_NIGHT,
      { prevTick: { price: 37980, t: CLOSE_DAY - 1_000 } });
    expect(recorded!.exitPrice).toBe(37980);       // ★売りでも引け値ちょうど(±1tick しない)
    expect(recorded!.pnl).toBe(20);
  });

  it('★寄り値が初期LC を割っていても、引けの方が先に起きているので session_close で閉じる', () => {
    _setExitImpl(noRatchet);
    // 寄り 37800 は初期LC 37950 を大きく割っている(=従来はここで initial_stop 決済になっていた)。
    const { recorded } = advance({ phase: 'filled', position: longPos(ENTRY_DAY) }, 37800, REOPEN_NIGHT,
      { prevTick: { price: 38020, t: CLOSE_DAY - 2_000 } });
    expect(recorded!.exitReason).toBe('session_close');
    expect(recorded!.exitPrice).toBe(38020);
  });

  it('レンジ建玉(rangeTp 設定済)も同じ規則で閉じる(mode タグは残る・TP幅は null)', () => {
    const pos: OpenPosition = {
      direction: 'buy', entryPrice: 38100, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'r',
      at: ENTRY_DAY, mode: 'range', rangeTp: 38400,
    };
    const { next, recorded } = advance({ phase: 'filled', position: pos }, 38395, REOPEN_NIGHT,
      { prevTick: { price: 38120, t: CLOSE_DAY - 1_000 } });
    expect(next.phase).toBe('flat');
    expect(recorded!.exitReason).toBe('session_close');
    expect(recorded!.mode).toBe('range');
    expect(recorded!.exitT).toBe(CLOSE_DAY);
    expect(recorded!.exitPrice).toBe(38120);
    expect(recorded!.tpWidth).toBeNull();
    expect(recorded!.tpTrigger).toBeNull();
  });

  it('prevTick が無い(起動直後など)→ 現在値へフォールバック(決済を止めない)', () => {
    _setExitImpl(noRatchet);
    const { recorded } = advance({ phase: 'filled', position: longPos(ENTRY_DAY) }, 38300, REOPEN_NIGHT);
    expect(recorded!.exitReason).toBe('session_close');
    expect(recorded!.exitT).toBe(CLOSE_DAY);
    expect(recorded!.exitPrice).toBe(38300);       // 現在値ちょうど(スリップ無し)
  });

  it('prevTick が引けより後の値しか持たない → 使わずに現在値へフォールバック', () => {
    _setExitImpl(noRatchet);
    const { recorded } = advance({ phase: 'filled', position: longPos(ENTRY_DAY) }, 38300, REOPEN_NIGHT,
      { prevTick: { price: 38020, t: CLOSE_DAY + 1 } });
    expect(recorded!.exitPrice).toBe(38300);
  });
});

// ═══ 引けちょうどの tick(同じ瞬間)の順序 ═══════════════════════════════════

describe('引けちょうどの tick では 損側 → 利側(TP)→ 引け の順', () => {
  it('引けちょうど かつ 初期LC 到達 → initial_stop(損側が先)', () => {
    _setExitImpl(noRatchet);
    const { recorded } = advance({ phase: 'filled', position: longPos(ENTRY_DAY) }, 37950, CLOSE_DAY,
      { prevTick: { price: 38020, t: CLOSE_DAY - 1_000 } });
    expect(recorded!.exitReason).toBe('initial_stop');
    expect(recorded!.exitPrice).toBe(37950);
    expect(recorded!.exitT).toBe(CLOSE_DAY);
  });

  it('引けちょうど かつ TP 到達 → take_profit(利側が引けより先)', () => {
    _setExitImpl(noRatchet);
    const pos: OpenPosition = { ...longPos(ENTRY_DAY), tpWidth: 60 };
    const { recorded } = advance({ phase: 'filled', position: pos }, 38060, CLOSE_DAY,
      { prevTick: { price: 38020, t: CLOSE_DAY - 1_000 } });
    expect(recorded!.exitReason).toBe('take_profit');
  });

  it('引けちょうど かつ 損側も利側も未成立 → session_close(価格は **その tick** の値)', () => {
    _setExitImpl(noRatchet);
    const { recorded } = advance({ phase: 'filled', position: longPos(ENTRY_DAY) }, 38040, CLOSE_DAY,
      { prevTick: { price: 38020, t: CLOSE_DAY - 1_000 } });
    expect(recorded!.exitReason).toBe('session_close');
    expect(recorded!.exitT).toBe(CLOSE_DAY);
    expect(recorded!.exitPrice).toBe(38040);   // ★prevTick(38020)ではなく tick の 38040 ちょうど
  });

  it('レンジ建玉も引けちょうどでは 損側 → 利側 → 引け', () => {
    const pos: OpenPosition = {
      direction: 'buy', entryPrice: 38100, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'r',
      at: ENTRY_DAY, mode: 'range', rangeTp: 38400,
    };
    expect(advance({ phase: 'filled', position: pos }, 38050, CLOSE_DAY).recorded!.exitReason).toBe('range_stop');
    expect(advance({ phase: 'filled', position: pos }, 38395, CLOSE_DAY).recorded!.exitReason).toBe('range_tp');
    expect(advance({ phase: 'filled', position: pos }, 38200, CLOSE_DAY).recorded!.exitReason).toBe('session_close');
  });
});

// ═══ ★実描画: 引け決済の直後のティックで「✔ 決済」が画面に出る ═══════════════════

describe('画面(buildPositionView): 引け決済でも決済表示が出る', () => {
  // ★なぜこのテストが要るか(実害):
  //   lastExit は台帳ではなく **画面用のチャンネル** で、signalPanel.ts の EXIT_DISPLAY_MS(40秒)と
  //   比較される。引け決済が確定するのは引けの 75〜165分後のティックなので、lastExit.at に
  //   引けの時刻(closeMs)を入れると **判定した瞬間に既に窓の外**=「✔ 決済」が一度も出ない。
  //   一方で決済音(`s.lastExit.at > prevExitAt`)は鳴るため、**音だけ鳴って画面は「保有なし」** という
  //   無言の失敗になる。→ 台帳(recorded.exitT)は引け / 画面(lastExit.at)はいま、に分ける。
  const render = (atMs: number): PanelView => {
    _setExitImpl(noRatchet);
    const { next, recorded } = advance({ phase: 'filled', position: longPos(ENTRY_DAY) }, 38300, REOPEN_NIGHT,
      { prevTick: { price: 38020, t: CLOSE_DAY - 2_000 } });
    expect(recorded!.exitReason).toBe('session_close');
    expect(recorded!.exitT).toBe(CLOSE_DAY);            // ★台帳は引けの時刻のまま
    const sse = toSignalTradeState(next, 38300, REOPEN_NIGHT) as unknown as PanelState;
    return buildPositionView(sse, atMs);
  };
  it('引け決済を判定したティックで ✔ 決済 が出る', () => {
    expect(render(REOPEN_NIGHT)).toEqual({ cls: 'exit', main: '✔ 決済 38,020（+20）', rationale: '' });
  });
  it('39秒後はまだ出ている / 40秒後には消える(窓の挙動は従来のまま)', () => {
    expect(render(REOPEN_NIGHT + 39_000).cls).toBe('exit');
    expect(render(REOPEN_NIGHT + 40_000)).toEqual({ cls: 'flat', main: '保有なし', rationale: '' });
  });
});
// ═══ ★スリッページ: 引け決済 **だけ** が例外 ════════════════════════════════

describe('成行決済のスリッページ: 引けだけスリップ無し・他の3経路は従来どおり1tick', () => {
  // ★なぜ引けだけ違うのか(decisions.ts の該当箇所にも同じ理由を書いてある):
  //   引け全決済は「trade2 と一致させること」だけを目的に後から足した経路で、合わせる相手が先に存在する。
  //   trade2 の引け決済(src/core/engine.ts の closeAt)はスリップを引かず引け値ちょうどで閉じるので、
  //   ここで1tick 引くと **引け決済のすべてに新しい5円の系統差を自分で作る** ことになる。
  //   ★逆に、ドテン / レンジTP / TP は monitor が自分で決めた執行モデルなので **1バイトも変えない**。
  it('引け全決済 = 引け値ちょうど(スリップ 0円)', () => {
    _setExitImpl(noRatchet);
    const { recorded } = advance({ phase: 'filled', position: longPos(ENTRY_DAY) }, 38300, REOPEN_NIGHT,
      { prevTick: { price: 38020, t: CLOSE_DAY - 1_000 } });
    expect(recorded!.exitReason).toBe('session_close');
    expect(recorded!.exitPrice).toBe(38020);          // 素の価格ちょうど
  });
  it('TP(建値+幅)= 現在値 − 1tick(従来どおり)', () => {
    _setExitImpl(noRatchet);
    const pos: OpenPosition = { ...longPos(ENTRY_DAY), tpWidth: 60 };
    const { recorded } = advance({ phase: 'filled', position: pos }, 38060, ENTRY_DAY + 60_000, { prevTick: null });
    expect(recorded!.exitReason).toBe('take_profit');
    expect(recorded!.exitPrice).toBe(38055);          // 38060 − 5
  });
  it('レンジTP = 現在値 − 1tick(従来どおり)', () => {
    const pos: OpenPosition = {
      direction: 'buy', entryPrice: 38100, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'r',
      at: ENTRY_DAY, mode: 'range', rangeTp: 38400,
    };
    const { recorded } = advance({ phase: 'filled', position: pos }, 38395, ENTRY_DAY + 60_000, { prevTick: null });
    expect(recorded!.exitReason).toBe('range_tp');
    expect(recorded!.exitPrice).toBe(38390);          // 38395 − 5
  });
  it('ドテンの成行クローズ = 現在値 − 1tick(従来どおり)', () => {
    const pos: OpenPosition = { ...longPos(ENTRY_DAY), peakProfit: 120 };
    const rev = reverseToDoten({ phase: 'filled', position: pos },
      { direction: 'sell', limitEntry: 38050, stopLossForLimit: 38100, rationale: '反転', refPrice: 38000 },
      38020, ENTRY_DAY + 60_000)!;
    expect(rev.recorded.exitReason).toBe('doten');
    expect(rev.recorded.exitPrice).toBe(38015);       // 38020 − 5
  });
});

// ═══ ★否定対照/不変: 引けをまたがない建玉は1バイトも変わらない ═══════════════

describe('引けをまたがない建玉は従来どおり(引けの1ms前まで持ち続ける)', () => {
  it('引けの1ms前の tick では決済しない(保有継続)', () => {
    _setExitImpl(noRatchet);
    const r = advance({ phase: 'filled', position: longPos(ENTRY_DAY) }, 38040, CLOSE_DAY - 1,
      { prevTick: { price: 38020, t: CLOSE_DAY - 2_000 } });
    expect(r.recorded).toBeUndefined();
    expect(r.next.phase).toBe('filled');
  });

  it('引けをまたがない tick 列では prevTick を渡しても返り値が完全一致する(不変の実証)', () => {
    const run = (withPrev: boolean): string => {
      _setExitImpl(noRatchet);
      let st: EngineState = { phase: 'filled', position: longPos(ENTRY_DAY) };
      const out: unknown[] = [];
      let prev: { price: number; t: number } | null = null;
      for (let i = 1; i <= 15; i++) {
        const t = ENTRY_DAY + i * 60_000;          // 15:27〜15:41 JST(引け 15:45 の手前)
        const price = 38000 + ((i * 37) % 90) - 20;
        const r = advance(st, price, t, withPrev ? { prevTick: prev } : undefined);
        out.push(r);
        st = r.next;
        prev = { price, t };
      }
      return JSON.stringify(out);
    };
    expect(run(true)).toBe(run(false));
  });
});

// ═══ ★E2E(engine → 実ファイル SQLite): signal_trades に行が入る ═══════════════

describe('E2E: 引けをまたぐ建玉が signal_trades へ session_close で記録される', () => {
  let dir: string;
  let origAppData: string | undefined;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-sessclose-'));
    origAppData = process.env.APPDATA;
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE;
    process.env.APPDATA = dir;                     // 実ユーザーDB を触らない(temp へ隔離)
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

  function rows(): SignalTradeRow[] {
    const db = openDb(resolveDbPath());
    try { return getSignalTrades(db); } finally { db.close(); }
  }

  /** 実運用と同じ形で ARM → 約定 → (引け) → 寄り の tick を流す。 */
  async function runEngine(crossesClose: boolean): Promise<SignalTradeRow[]> {
    const eng = new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
    await eng.start();
    _setExitImpl(noRatchet);
    const armedAt = ENTRY_DAY - 60_000;
    const armed: ArmedBracket = {
      direction: 'buy', limitEntry: 38000, stopLossForLimit: 37950, rationale: 'r', at: armedAt,
    };
    eng._setArmedForTest(armed, armedToCurrentSignal(armed, 11));
    eng.feed(37995, ENTRY_DAY);                    // 指値レッグ約定(38000 − LIMIT_FILL_MARGIN_YEN)
    expect(eng.getPhase()).toBe('filled');
    eng.feed(38020, CLOSE_DAY - 2_000);            // 引け直前の最後の tick(= prevTick になる)
    expect(eng.getPhase()).toBe('filled');
    if (crossesClose) eng.feed(38300, REOPEN_NIGHT);   // 引け後の最初の tick(次セッションの寄り)
    else eng.feed(38030, CLOSE_DAY - 1_000);           // 引けをまたがない tick
    const r = rows();
    eng.stop();
    return r;
  }

  it('引けをまたぐ → exit_reason=session_close / exit_t=引けの時刻 / 建値と引け値から損益が出る', async () => {
    const r = await runEngine(true);
    expect(r).toHaveLength(1);
    expect(r[0]!.exit_reason).toBe('session_close');
    expect(r[0]!.exit_t).toBe(CLOSE_DAY);           // ★2026-08-25 15:45:00 JST
    expect(r[0]!.entry_t).toBe(ENTRY_DAY);
    expect(r[0]!.exit_price).toBe(38020);           // ★引け直前の値ちょうど(スリップ無し)
    expect(r[0]!.pnl).toBe(20);
    expect(r[0]!.signal_id).toBe(11);
  });

  it('★否定対照: 引けをまたがなければ1行も入らない(従来どおり保有継続)', async () => {
    expect(await runEngine(false)).toHaveLength(0);
  });

  // ★リーダー指摘の確認: 「ドテン ARM でも applyArmWait は呼ばれるが signal_plans には行が残らない。
  //   運ぶこと自体はできるはず」→ できる。ARM の3経路すべてで applyArmWait は
  //   armedToCurrentSignal より **前** に呼ばれているので、armed.waitMs は必ず currentSignal に載る。
  it('★ドテン ARM でも armWaitMs が currentSignal に載る(記録は残らないが SSE には出る)', async () => {
    const eng = new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
    await eng.start();
    _setExitImpl(noRatchet);
    eng._setFilledForTest(
      { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'orig', at: ENTRY_DAY },
      { signalId: 1, at: ENTRY_DAY, direction: 'buy', rationale: 'orig', limitEntry: 37950, stopLossForLimit: 37900 },
    );
    const rev = eng.applyHeldEvalResult(
      { ok: true, plan: { direction: 'sell', limitEntry: 38050, stopLossForLimit: 38100, rationale: '反転', refPrice: 38000 } },
      { at: ENTRY_DAY, direction: 'buy', signalId: 1 }, ENTRY_DAY + 60_000, 38020, null,
    );
    expect(rev).toBe('doten');
    const sig = eng.getCurrentSignal()!;
    expect(sig.doten).toBe(true);
    // ★σ が測れない temp DB では computeArmWait が下限(15分)へ落ちる=載る値は 900000。
    expect(sig.armWaitMs).toBe(15 * 60_000);
    eng.stop();
  });
});

// ═══ ★依頼①: armWaitMs が SSE の JSON に実際に載る ═══════════════════════════

describe('armWaitMs(未約定待ち時間)が SSE へ載る', () => {
  const armed = (waitMs?: number): ArmedBracket => {
    const a: ArmedBracket = {
      direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900,
      stopEntry: 38100, stopLossForStop: 38050, rationale: 'r', at: 1_000,
    };
    if (waitMs !== undefined) a.waitMs = waitMs;
    return a;
  };
  const sse = (waitMs?: number): Record<string, unknown> => {
    const a = armed(waitMs);
    return JSON.parse(JSON.stringify(
      toSignalTradeState({ phase: 'armed', armed: a }, 38000, 5_000, armedToCurrentSignal(a, 42)),
    )) as Record<string, unknown>;
  };

  it('waitMs=27分 の ARM は SSE JSON に armWaitMs=1620000 が載る', () => {
    const s = sse(27 * 60_000) as { signal: { armWaitMs?: number; signalId: number } };
    expect(s.signal.armWaitMs).toBe(1_620_000);
    expect(s.signal.signalId).toBe(42);
  });

  it('★waitMs を持たない ARM の JSON は変更前と byte 一致(フィールドごと欠落)', () => {
    const s = sse();
    expect(JSON.stringify(s).includes('armWaitMs')).toBe(false);
  });

  it('0 / NaN / 負 は載せない(armedWaitMsOf のフォールバック条件と同一=載る値は必ず実際に使う値)', () => {
    for (const v of [0, Number.NaN, -1]) expect(JSON.stringify(sse(v)).includes('armWaitMs')).toBe(false);
  });
});
