// ★TP(利確の成行決済)の検証。
//
//   TP = 「建値からの **幅**」に価格が到達したら **成行** で強制決済する、利側の出口。
//   出所は2つ: 手動(設定の現在値・毎tick引き直す) / AI委任(約定時に建玉へ焼き付ける)。
//
// ■ このファイルが固定する契約(壊れたら金銭事故になるもの)
//   ① 境界は **含む**(建値+幅 ちょうどで発火する)。1円手前では発火しない。
//   ② 同じ tick で損側と利側が両方成立したら **損側が勝つ**(レンジ分岐の「損側優先(安全)」と同じ順序)。
//   ③ 手動TP幅は **毎tick 引き直す**(保有中に設定を変えたら次の tick から効く)。
//      いまの含み益より小さい値に変えたら、次の tick で即座に決済される。
//   ④ TP幅が無い(null)なら **従来と完全に同じ**(recorded も next も、JSON まで一致)。
//   ⑤ `rangeTp` を流用していない(レンジ建玉の固定LC/ラチェット無しの分岐に落ちない)。
//   ⑥ 決済時に `lastExitedSignalId` を立てても `currentSignal` は **non-null のまま**。
//      trade2 が `sig!.signalId`(非nullアサーション)を使うので、null にすると毎サイクル TypeError で落ちる。
//   ⑦ `computeHold` は directional 建玉にも `tpTrigger` を載せる(trade2 が先回りで閉じるための冗長化)。
//
// ★このファイルは非公開 phase-exit(exit/private.ts)の数値を一切使わない。
//   既定は簡易フォールバック(初期LC固定・ラチェット無し)、ラチェットが要る回だけ **契約だけ** を
//   再現した疑似実装を opts.exitFn で渡す(グローバル差し替えをしない=並走テストに干渉しない)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  advance, computeHold, planToArmed, resolveTpWidth, takeProfitTrigger, rangeTpTrigger,
  SLIPPAGE_YEN, STOP_SLIPPAGE_YEN,
  type ArmedBracket, type CurrentSignal, type EngineState, type OpenPosition, type TpDirective,
} from './decisions.js';
import { _setExitImpl, type ExitFn } from './exit/index.js';
import type { ExitReason } from '../../core/exitReasons.js';
import { EXIT_REASON_SPEC } from '../../core/exitReasons.js';
import { SignalEngine } from './engine.js';
import {
  resetConfigCache, resolveScalpTpEnabled, resolveScalpTpWidthYen, resolveScalpTpWidthDirective,
} from '../configStore.js';
import { openDb, resolveDbPath, getSignalTrades, insertSignalPlan, type SignalTradeRow } from '../db/store.js';
import { buildSettingsSnapshot, buildTradeMetaJson } from './persist.js';
import { buildSignalPlanInsert } from './planLedger.js';

// テスト専用の任意値(非公開の段構成とは無関係。丸い数を避けて選んである)。
const TEST_ARM_PT = 37;      // これ以上まで伸びたら、逆指値を利側へ動かす
const TEST_LOCK_YEN = 23;    // 動かした先(建値からの距離)
const ARMED_PT = TEST_ARM_PT + 1;   // 「もう動いている」状態を作るための値
const TP_NARROW = 13;        // 動かした先より内側にある TP幅(=同 tick で両方成立させる)

/** テスト用の疑似「利側へ動く逆指値」(非公開の数値は使わない・**契約だけ** を再現する):
 *  伸びが TEST_ARM_PT 以上になったら、逆指値を建値±TEST_LOCK_YEN へ。有利側にのみ動き、初期LC より不利にはしない。 */
const fakeLock: ExitFn = (s) => {
  if (!Number.isFinite(s.initialStop)) return null;
  if (s.peakProfit < TEST_ARM_PT) return s.initialStop;
  const lock = s.direction === 'buy' ? s.entryPrice + TEST_LOCK_YEN : s.entryPrice - TEST_LOCK_YEN;
  return s.direction === 'buy' ? Math.max(s.initialStop, lock) : Math.min(s.initialStop, lock);
};

const buyPos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500, ...over,
});
const sellPos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  direction: 'sell', entryPrice: 38000, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'r', at: 500, ...over,
});
const filled = (position: OpenPosition): EngineState => ({ phase: 'filled', position });
/** 手動TP設定(scalpTpEnabled=true / source='manual' / 幅=yen)。engine が毎tick 解決して渡す形。 */
const manual = (yen: number): TpDirective => ({ enabled: true, manualYen: yen });
/** AI委任(手動幅は無し=建玉に焼いた幅が効く)。 */
const aiTp: TpDirective = { enabled: true, manualYen: null };
/** ★TP を切った状態(scalpTpEnabled=false)。AI委任の pos.tpWidth も含めて一切効かない。 */
const tpOff: TpDirective = { enabled: false, manualYen: null };

// ═══ 純関数 ═══════════════════════════════════════════════════════════

describe('takeProfitTrigger(発火価格は毎回導出する・建玉には幅だけ持つ)', () => {
  it('buy は 建値+幅 / sell は 建値−幅(方向が反転する)', () => {
    expect(takeProfitTrigger('buy', 38000, 60)).toBe(38060);
    expect(takeProfitTrigger('sell', 38000, 60)).toBe(37940);
  });
  it('★rangeTpTrigger とは別の関数(節目の内側5円ずらしをしない)', () => {
    expect(takeProfitTrigger('buy', 38000, 400)).toBe(38400);
    expect(rangeTpTrigger('buy', 38400)).toBe(38395);   // レンジTP は節目の5円内側
  });
});

describe('resolveTpWidth(手動 > 建玉に焼いた AI の幅 > 無し)', () => {
  it('手動の値が来ていればそれ(建玉に焼いた値より優先)', () => {
    expect(resolveTpWidth(buyPos({ tpWidth: 60 }), 120)).toBe(120);
  });
  it('手動が無ければ建玉の値', () => {
    expect(resolveTpWidth(buyPos({ tpWidth: 60 }), null)).toBe(60);
    expect(resolveTpWidth(buyPos({ tpWidth: 60 }), undefined)).toBe(60);
  });
  it('どちらも無ければ null(=TP を使わない)', () => {
    expect(resolveTpWidth(buyPos(), null)).toBeNull();
  });
  it('0/負/非有限は幅として認めない(幅0は約定 tick で建値決済を量産する)', () => {
    expect(resolveTpWidth(buyPos({ tpWidth: 60 }), 0)).toBe(60);      // 手動0 は無効 → 建玉の値へ落ちる
    expect(resolveTpWidth(buyPos({ tpWidth: 0 }), null)).toBeNull();
    expect(resolveTpWidth(buyPos({ tpWidth: -60 }), null)).toBeNull();
    expect(resolveTpWidth(buyPos({ tpWidth: NaN }), null)).toBeNull();
    expect(resolveTpWidth(buyPos(), NaN)).toBeNull();
  });
});

describe('決済理由の表に take_profit が在る(range_tp とは別物)', () => {
  it('take_profit は非ラチェット・range_tp とキーが別', () => {
    expect(EXIT_REASON_SPEC.take_profit.ratchet).toBe(false);
    expect(EXIT_REASON_SPEC.take_profit.label).not.toBe(EXIT_REASON_SPEC.range_tp.label);
  });
});

// ═══ 境界(★契約①)═══════════════════════════════════════════════════

describe('★TP の境界(建値±幅 ちょうどで発火する)', () => {
  it('buy: TP幅60 → 建値+60 ちょうどで発火(境界は含む)', () => {
    const { next, recorded } = advance(filled(buyPos({ tpWidth: 60 })), 38060, 2_000);
    expect(next.phase).toBe('flat');
    expect(recorded!.exitReason).toBe<ExitReason>('take_profit');
    // ★成行決済 = SLIPPAGE_YEN(1tick)。逆指値用の STOP_SLIPPAGE_YEN(0)ではない。
    expect(recorded!.exitPrice).toBe(38060 - SLIPPAGE_YEN);
    expect(recorded!.pnl).toBe(55);
    expect(SLIPPAGE_YEN).not.toBe(STOP_SLIPPAGE_YEN);
  });
  it('buy: 建値+59 では発火しない(保有継続)', () => {
    const { next, recorded } = advance(filled(buyPos({ tpWidth: 60 })), 38059, 2_000);
    expect(next.phase).toBe('filled');
    expect(recorded).toBeUndefined();
  });
  it('sell: 方向が反転する(建値−60 ちょうどで発火・−59 では発火しない)', () => {
    const hit = advance(filled(sellPos({ tpWidth: 60 })), 37940, 2_000);
    expect(hit.next.phase).toBe('flat');
    expect(hit.recorded!.exitReason).toBe<ExitReason>('take_profit');
    expect(hit.recorded!.exitPrice).toBe(37940 + SLIPPAGE_YEN);   // 売り決済は不利=高く買い戻す
    expect(hit.recorded!.pnl).toBe(55);
    const miss = advance(filled(sellPos({ tpWidth: 60 })), 37941, 2_000);
    expect(miss.next.phase).toBe('filled');
    expect(miss.recorded).toBeUndefined();
  });
  it('★buy で「建値−60」に落ちても発火しない(符号を取り違えていない)', () => {
    const { next } = advance(filled(buyPos({ tpWidth: 60, initialStop: 37800 })), 37940, 2_000);
    expect(next.phase).toBe('filled');
  });
});

// ═══ 順序(★契約②: 損側 → 利側)═════════════════════════════════════

describe('★同 tick で損側と利側が両方成立 → 損側が勝つ', () => {
  // buy: 利側へ動いた逆指値 = 建値+TEST_LOCK_YEN(38023)。TP = 建値+TP_NARROW(38013)。
  //   価格 38020 は「逆指値を割った(損側成立)」と「TP を超えた(利側成立)」を同時に満たす。
  const collideBuy = 38000 + TEST_LOCK_YEN - 3;
  // sell: 逆指値 = 建値−TEST_LOCK_YEN(37977)。TP = 建値−TP_NARROW(37987)。価格 37980 で両方成立。
  const collideSell = 38000 - TEST_LOCK_YEN + 3;

  it('buy: 損側と利側が同 tick で成立 → 損側(ratchet_floor)が勝つ', () => {
    const pos = buyPos({ peakProfit: ARMED_PT, tpWidth: TP_NARROW });
    const { next, recorded } = advance(filled(pos), collideBuy, 2_000, { exitFn: fakeLock, prevTick: null });
    expect(collideBuy >= takeProfitTrigger('buy', 38000, TP_NARROW)).toBe(true);   // 利側は成立している
    expect(next.phase).toBe('flat');
    expect(recorded!.exitReason).toBe<ExitReason>('ratchet_floor');
    // 逆指値決済=逆指値価格ちょうど(成行スリップではない=利側で閉じていない証拠)。
    expect(recorded!.exitPrice).toBe(38000 + TEST_LOCK_YEN);
  });
  it('sell: 損側と利側が同 tick で成立 → 損側(ratchet_floor)が勝つ', () => {
    const pos = sellPos({ peakProfit: ARMED_PT, tpWidth: TP_NARROW });
    const { next, recorded } = advance(filled(pos), collideSell, 2_000, { exitFn: fakeLock, prevTick: null });
    expect(collideSell <= takeProfitTrigger('sell', 38000, TP_NARROW)).toBe(true);
    expect(next.phase).toBe('flat');
    expect(recorded!.exitReason).toBe<ExitReason>('ratchet_floor');
    expect(recorded!.exitPrice).toBe(38000 - TEST_LOCK_YEN);
  });
  it('損側が成立しない tick では利側が効く(順序を入れただけで利側を殺していない)', () => {
    const pos = buyPos({ peakProfit: ARMED_PT, tpWidth: TP_NARROW });
    const { recorded } = advance(filled(pos), 38060, 2_000, { exitFn: fakeLock, prevTick: null });
    expect(recorded!.exitReason).toBe<ExitReason>('take_profit');
  });
});

// ═══ 手動TP幅は毎tick引き直す(★契約③)════════════════════════════════

describe('★手動TP幅は毎tick引き直す(保有中の変更が次tickで効く)', () => {
  it('同じ建玉・同じ価格でも、引数の幅を変えるだけで挙動が変わる', () => {
    const st = filled(buyPos());   // 建玉には TP幅を焼いていない(手動運用)
    const wide = advance(st, 38060, 2_000, { tp: manual(100), prevTick: null });
    expect(wide.next.phase).toBe('filled');   // 幅100 → トリガ38100 未到達
    const narrow = advance(st, 38060, 2_100, { tp: manual(60), prevTick: null });
    expect(narrow.next.phase).toBe('flat');   // 幅60 → トリガ38060 到達
    expect(narrow.recorded!.exitReason).toBe<ExitReason>('take_profit');
  });

  it('★いまの伸びより小さい幅に変えたら、次tickで即座に決済される', () => {
    // 1st tick: 幅 211(遠い)のまま 38083(=建値+83)まで伸ばす。決済しない。
    const t1 = advance(filled(buyPos()), 38083, 2_000, { tp: manual(211), prevTick: null });
    expect(t1.next.phase).toBe('filled');
    expect(t1.next.position!.peakProfit).toBe(83);
    // 2nd tick: ユーザーが幅を 47 に縮めた(いまの伸び 83 より小さい)→ 同じ価格でも即決済。
    const t2 = advance(t1.next, 38083, 2_100, { tp: manual(47), prevTick: null });
    expect(t2.next.phase).toBe('flat');
    expect(t2.recorded!.exitReason).toBe<ExitReason>('take_profit');
    // ★決済価格は **トリガ(38047)ではなく現在値(38083)** に成行スリップ。実際に叩ける価格で記録する。
    expect(t2.recorded!.exitPrice).toBe(38083 - SLIPPAGE_YEN);
  });

  it('★arm 時のスナップショット(pos.settings)は手動TPに使わない(保有中の変更が反映されなくなるため)', () => {
    // settings に何が入っていても、引数が無ければ TP は効かない(=設定スナップショットを見ていない証拠)。
    const pos = buyPos({ settings: { lcYen: 60 } as unknown as OpenPosition['settings'] });
    expect(advance(filled(pos), 39000, 2_000).next.phase).toBe('filled');
  });

  it('手動の幅は建玉に焼いた AI の幅より優先される', () => {
    const st = filled(buyPos({ tpWidth: 60 }));
    expect(advance(st, 38060, 2_000, { tp: manual(200), prevTick: null }).next.phase).toBe('filled');
    expect(advance(st, 38200, 2_000, { tp: manual(200), prevTick: null }).next.phase).toBe('flat');
  });
});

// ═══ TP無しは従来と1バイトも変わらない(★契約④)═══════════════════════

describe('★TP幅が無い(null)なら従来と完全に同じ', () => {
  it('価格列を通しても TP では一度も決済されない(初期LC だけが効く)', () => {
    let st: EngineState = filled(buyPos());
    const reasons: ExitReason[] = [];
    for (const p of [38010, 38100, 38400, 39000, 38500, 38000, 37960]) {
      const r = advance(st, p, 2_000);
      st = r.next;
      if (r.recorded) reasons.push(r.recorded.exitReason);
    }
    expect(st.phase).toBe('filled');   // 初期LC 37950 に触れていないので保有継続
    expect(reasons).toEqual([]);
  });
  it('初期LC 決済の回でも TP の記録欄は「TP 無し」= null(0 でも欠落でもない)', () => {
    const r = advance(filled(buyPos()), 37940, 2_000);
    expect(r.recorded!.exitReason).toBe<ExitReason>('initial_stop');
    // ★TP を使っていない回は **null**。★0 にしない(集計で「幅0のTP」と混ざる)・
    //   ★キーを落とさない(「書き忘れ」と「TP不在」が区別できなくなる)。
    expect(r.recorded!.tpWidth).toBeNull();
    expect(r.recorded!.tpTrigger).toBeNull();
    // 次の state(建玉/lastExit)には TP 由来のフィールドは1つも増えていない。
    expect(JSON.stringify(r.next)).not.toContain('tp');
  });
  it('tp を渡さない呼び出しは opts なしと完全一致(JSON)', () => {
    const st = filled(buyPos());
    for (const p of [38010, 38050, 37940]) {
      const a = advance(st, p, 2_000);
      const b = advance(st, p, 2_000, { prevTick: null });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });
});

// ═══ rangeTp を流用していない(★契約⑤)══════════════════════════════

describe('★rangeTp を流用していない(レンジ分岐へ落ちない)', () => {
  it('tpWidth を据えても mode/rangeTp は付かず、利側へ動く逆指値は生きたまま', () => {
    // 逆指値は建値+TEST_LOCK_YEN(38023)へ動いている。TP幅を 777(遠い)にしても、その決済は従来どおり効く。
    const pos = buyPos({ peakProfit: ARMED_PT, tpWidth: 777 });
    const { recorded, next } = advance(filled(pos), 38000 + TEST_LOCK_YEN - 3, 2_000, { exitFn: fakeLock, prevTick: null });
    expect(next.phase).toBe('flat');
    expect(recorded!.exitReason).toBe<ExitReason>('ratchet_floor');   // レンジ分岐なら range_stop になる
    expect(recorded!.mode).toBeUndefined();
  });
  it('レンジ建玉(rangeTp 設定済)は手動TP幅を渡しても挙動が変わらない', () => {
    const pos = buyPos({ mode: 'range', rangeTp: 38400 });
    const a = advance(filled(pos), 38100, 2_000);
    const b = advance(filled(pos), 38100, 2_000, { tp: manual(30), prevTick: null });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));   // 幅30(=38030)を渡しても決済されない
    expect(b.next.phase).toBe('filled');
    // レンジTP は従来どおり節目の5円内側で発火し、理由は range_tp のまま。
    const tp = advance(filled(pos), 38395, 2_000, { tp: manual(30), prevTick: null });
    expect(tp.recorded!.exitReason).toBe<ExitReason>('range_tp');
  });
});

// ═══ 約定時の焼き付け(ArmedBracket → OpenPosition)══════════════════

describe('約定したレッグの TP幅だけを建玉へ焼く', () => {
  const armed = (over: Partial<ArmedBracket> = {}): ArmedBracket => ({
    direction: 'buy', rationale: 'r', at: 1_000,
    limitEntry: 37950, stopLossForLimit: 37900,
    stopEntry: 38100, stopLossForStop: 38050,
    ...over,
  });
  it('指値レッグ約定 → tpWidthForLimit が tpWidth になる', () => {
    const st: EngineState = { phase: 'armed', armed: armed({ tpWidthForLimit: 60, tpWidthForStop: 90 }) };
    const { next } = advance(st, 37945, 2_000);   // 指値は 5円 行き過ぎて約定
    expect(next.position!.entryPrice).toBe(37950);
    expect(next.position!.tpWidth).toBe(60);
  });
  it('逆指値レッグ約定 → tpWidthForStop が tpWidth になる', () => {
    const st: EngineState = { phase: 'armed', armed: armed({ tpWidthForLimit: 60, tpWidthForStop: 90 }) };
    const { next } = advance(st, 38100, 2_000);   // 逆指値はタッチ約定
    expect(next.position!.entryPrice).toBe(38100);
    expect(next.position!.tpWidth).toBe(90);
  });
  it('片側だけ幅がある計画で、幅の無いレッグが約定したら tpWidth は付かない', () => {
    const st: EngineState = { phase: 'armed', armed: armed({ tpWidthForLimit: 60 }) };
    const { next } = advance(st, 38100, 2_000);   // 逆指値約定(tpWidthForStop 無し)
    expect('tpWidth' in next.position!).toBe(false);
  });
  it('幅が無い計画の建玉は従来と byte 一致(tpWidth キーごと付かない)', () => {
    const st: EngineState = { phase: 'armed', armed: armed() };
    const { next } = advance(st, 37945, 2_000);
    expect(JSON.stringify(next.position)).not.toContain('tpWidth');
  });
  it('0/負/非有限の幅は焼かない', () => {
    for (const w of [0, -60, NaN, Infinity]) {
      const st: EngineState = { phase: 'armed', armed: armed({ tpWidthForLimit: w }) };
      expect('tpWidth' in advance(st, 37945, 2_000).next.position!).toBe(false);
    }
  });
});

// ═══ computeHold の冗長化(★契約⑦)═══════════════════════════════════

describe('★computeHold は directional 建玉にも tpTrigger を載せる(trade2 が先回りで閉じる)', () => {
  const sig: CurrentSignal = { signalId: 7, at: 500, direction: 'buy', rationale: 'r' };
  it('AI委任(pos.tpWidth)→ tpTrigger=建値+幅', () => {
    const h = computeHold(filled(buyPos({ tpWidth: 60 })), sig)!;
    expect(h.tpTrigger).toBe(38060);
    expect(h.rangeTp).toBeUndefined();   // ★レンジ節目ではない(混ぜない)
    expect(h.exitStop).toBe(37950);      // 決済逆指値は従来どおり出し続ける
  });
  it('手動(引数)→ tpTrigger も毎tick引き直す', () => {
    const st = filled(buyPos());
    expect(computeHold(st, sig, manual(100))!.tpTrigger).toBe(38100);
    expect(computeHold(st, sig, manual(50))!.tpTrigger).toBe(38050);   // 保有中に変えたら次の hold で変わる
  });
  it('sell は 建値−幅', () => {
    const sellSig: CurrentSignal = { ...sig, direction: 'sell' };
    expect(computeHold(filled(sellPos({ tpWidth: 60 })), sellSig)!.tpTrigger).toBe(37940);
  });
  it('★幅が無ければフィールドごと付けない(既存 SSE JSON と byte 一致=dedupe を壊さない)', () => {
    const h = computeHold(filled(buyPos()), sig)!;
    expect('tpTrigger' in h).toBe(false);
    expect(JSON.stringify(h)).not.toContain('tpTrigger');
  });
  it('レンジ建玉の tpTrigger は従来どおり rangeTpTrigger(節目の5円内側)のまま', () => {
    const h = computeHold(filled(buyPos({ mode: 'range', rangeTp: 38400 })), sig, manual(60))!;
    expect(h.tpTrigger).toBe(38395);   // 手動幅60(=38060)に **ならない**
    expect(h.rangeTp).toBe(38400);
    expect(h.exitStop).toBe(37950);    // レンジは固定初期LC(ラチェットしない)
  });
});

// ═══ ★不変条件: lastExitedSignalId を立てても currentSignal を null にしない ═══
//
//   trade2(entryLoop.ts:1027)は `sig!.signalId` と非nullアサーションで読む。決済時に monitor が
//   currentSignal を null にすると、trade2 は **flatten を送る前に TypeError で落ちる**
//   = 実口座の建玉が閉じないまま毎サイクル落ち続ける。TP で新しい決済経路が増えても、この規約は変わらない。

describe('★不変条件: TP 決済でも currentSignal は non-null のまま(trade2 が毎サイクル落ちない)', () => {
  let dir: string;
  let origAppData: string | undefined;
  const cfgA = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-tp-'));
    origAppData = process.env.APPDATA;
    process.env.APPDATA = dir;   // persistTrade を temp DB へ隔離(実DBを書かない)。
  });
  afterEach(() => {
    _setExitImpl(null);   // start() が読み込んだ非公開実装を戻す(他の describe へ漏らさない)。
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    rmSync(dir, { recursive: true, force: true });
  });

  it('TP で決済 → lastExitedSignalId が立ち、currentSignal は残る', async () => {
    const eng = new SignalEngine(cfgA);
    await eng.start();
    const sig: CurrentSignal = { signalId: 11, at: 500, direction: 'buy', rationale: 'r', limitEntry: 37950, stopLossForLimit: 37900 };
    eng._setFilledForTest(buyPos({ tpWidth: 60 }), sig);
    eng.feed(38060, 2_000);   // 建値+60 ちょうど → TP 決済
    expect(eng.getPhase()).toBe('flat');
    const s = eng.getState(2_100);
    expect(s.lastExitedSignalId).toBe(11);          // trade2 が「この建玉は閉じた」と分かる
    expect(eng.getCurrentSignal()).not.toBeNull();  // ★null にしない(trade2 の sig!.signalId が落ちる)
    expect(eng.getCurrentSignal()!.signalId).toBe(11);
    expect(s.signal?.signalId).toBe(11);            // SSE にも残る
    eng.stop();
  });

  it('初期LC で決済したとき(従来経路)と同じ扱いであること', async () => {
    const eng = new SignalEngine(cfgA);
    await eng.start();
    const sig: CurrentSignal = { signalId: 12, at: 500, direction: 'buy', rationale: 'r', limitEntry: 37950, stopLossForLimit: 37900 };
    eng._setFilledForTest(buyPos(), sig);
    eng.feed(37940, 2_000);   // 初期LC 到達
    expect(eng.getPhase()).toBe('flat');
    expect(eng.getState(2_100).lastExitedSignalId).toBe(12);
    expect(eng.getCurrentSignal()).not.toBeNull();
    eng.stop();
  });
});

// ═══ ★設定 → engine → SSE の実配線(「無音の片肺」を潰したことの実証)═══════
//
//   ★何を潰したか: `computeHold` に TP の実効設定を渡す経路は3本ある
//     (broadcast / getState=stream 初回送出 / getHold=GET)。
//     ここを1本でも渡し忘れると **手動TP のときだけ** `hold.tpTrigger` が SSE に載らず、
//     trade2 の先回り決済(`maybeRangeTakeProfit` は `hold.tpTrigger` の有無だけを見る)が
//     **無音で** 効かなくなる(AI委任のときは pos.tpWidth があるので気づけない)。
//   ★だから型やモックではなく、**実際の設定ファイル → engine → toSignalTradeState を通した JSON** で見る。

describe('★手動TP設定が SSE の hold.tpTrigger まで実際に届く(実配線)', () => {
  let dir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origAppData: string | undefined;
  const cfgA = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };
  const sig: CurrentSignal = { signalId: 21, at: 500, direction: 'buy', rationale: 'r', limitEntry: 37950, stopLossForLimit: 37900 };

  /** 設定ファイルを書いてキャッシュを落とす(configStore は homedir()/.jp225-monitor/config.json を読む)。 */
  const writeCfg = (cfg: Record<string, unknown>): void => {
    mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify(cfg), 'utf-8');
    resetConfigCache();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-tpcfg-'));
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE; origAppData = process.env.APPDATA;
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    resetConfigCache();
  });
  afterEach(() => {
    _setExitImpl(null);
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('★手動(source=manual・幅47)→ toSignalTradeState を通した実 JSON に tpTrigger=38047 が載る', () => {
    writeCfg({ scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const eng = new SignalEngine(cfgA);
    eng._setFilledForTest(buyPos(), sig);   // ★建玉に AI の幅は焼いていない(手動運用)
    const s = eng.getState(3_000);
    expect(s.hold?.tpTrigger).toBe(38047);                       // 建値38000 + 幅47
    expect(JSON.stringify(s)).toContain('"tpTrigger":38047');    // ★実ペイロードに文字列として在る
    // ★同じ設定で決済(advance)も同じ価格で閉じる=SSE が示す価格と紙の決済が一致する。
    expect(eng.getHold()?.tpTrigger).toBe(38047);                // GET 経路(late-join の trade2)も同じ
  });

  it('★保有中に幅を変えると、次に組み立てた SSE の tpTrigger も動く(毎tick引き直し)', () => {
    writeCfg({ scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const eng = new SignalEngine(cfgA);
    eng._setFilledForTest(buyPos(), sig);
    expect(eng.getState(3_000).hold?.tpTrigger).toBe(38047);
    writeCfg({ scalpTpWidthSource: 'manual', scalpTpWidthYen: 211 });   // 保有したまま設定変更
    expect(eng.getState(3_100).hold?.tpTrigger).toBe(38211);
  });

  it('★既定(source 未設定)は AI委任 → 手動の幅80 は使われない(hold に tpTrigger が出ない)', () => {
    writeCfg({});   // 何も設定していない状態
    expect(resolveScalpTpWidthYen()).toBe(80);                   // 既定値は 80
    expect(resolveScalpTpWidthDirective().mode).toBe('ai');      // 既定の出所は 'ai'
    expect(resolveScalpTpEnabled()).toBe(true);                  // 既定は ON
    const eng = new SignalEngine(cfgA);
    eng._setFilledForTest(buyPos(), sig);                        // AI の幅も無い建玉
    const s = eng.getState(3_000);
    expect(s.hold?.tpTrigger).toBeUndefined();                   // ★80 が勝手に使われない
    expect(JSON.stringify(s)).not.toContain('tpTrigger');
  });

  it('AI委任(既定)でも、建玉に焼いた AI の幅は hold に載る', () => {
    writeCfg({});
    const eng = new SignalEngine(cfgA);
    eng._setFilledForTest(buyPos({ tpWidth: 60 }), sig);
    expect(eng.getState(3_000).hold?.tpTrigger).toBe(38060);
  });

  it('★scalpTpEnabled=false なら、手動でも AI委任の幅でも tpTrigger は載らない(切れば従来どおり)', () => {
    writeCfg({ scalpTpEnabled: false, scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const eng = new SignalEngine(cfgA);
    eng._setFilledForTest(buyPos({ tpWidth: 60 }), sig);         // AI の幅も焼いてある
    const s = eng.getState(3_000);
    expect(s.hold?.tpTrigger).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('tpTrigger');
    expect(eng.getHold()?.tpTrigger).toBeUndefined();
  });

  it('★手動TP設定のとき、feed() が同じ価格で実際に決済する(SSE の予告と決済が一致)', async () => {
    writeCfg({ scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const eng = new SignalEngine(cfgA);
    await eng.start();
    eng._setFilledForTest(buyPos(), sig);
    const trigger = eng.getState(3_000).hold!.tpTrigger!;
    expect(trigger).toBe(38047);
    eng.feed(trigger - 1, 3_100);
    expect(eng.getPhase()).toBe('filled');   // 1円手前では閉じない
    eng.feed(trigger, 3_200);
    expect(eng.getPhase()).toBe('flat');     // 予告した価格ちょうどで閉じる
    expect(eng.getState(3_300).lastExitedSignalId).toBe(21);
    expect(eng.getCurrentSignal()).not.toBeNull();   // ★不変条件(trade2 が落ちない)
    eng.stop();
  });

  it('★scalpTpEnabled=false なら feed() は TP で決済しない(切れば従来どおり)', async () => {
    writeCfg({ scalpTpEnabled: false, scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const eng = new SignalEngine(cfgA);
    await eng.start();
    eng._setFilledForTest(buyPos({ tpWidth: 60 }), sig);
    eng.feed(38400, 3_100);   // 手動47 も AI 60 も遥かに超える価格
    expect(eng.getPhase()).toBe('filled');
    eng.stop();
  });
});

// ═══ planToArmed の配線(AiPlan → ArmedBracket)══════════════════════════

describe('planToArmed が計画の TP幅を armed へ運ぶ(在るときだけ付ける)', () => {
  const plan = (over: Record<string, unknown> = {}): Parameters<typeof planToArmed>[0] => ({
    direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900,
    stopEntry: 38100, stopLossForStop: 38050, rationale: 'r', ...over,
  } as Parameters<typeof planToArmed>[0]);

  it('レッグ別の幅をそのまま運ぶ', () => {
    const a = planToArmed(plan({ tpWidthForLimit: 60, tpWidthForStop: 90 }), 1_000)!;
    expect(a.tpWidthForLimit).toBe(60);
    expect(a.tpWidthForStop).toBe(90);
  });
  it('★載っていない計画から作る armed は従来と byte 一致(キーごと付かない)', () => {
    const a = planToArmed(plan(), 1_000)!;
    expect('tpWidthForLimit' in a).toBe(false);
    expect('tpWidthForStop' in a).toBe(false);
    expect(JSON.stringify(a)).not.toContain('tpWidth');
  });
  it('0/負/非有限は運ばない(幅0の TP は約定 tick で建値決済を量産する)', () => {
    for (const w of [0, -60, NaN, Infinity]) {
      const a = planToArmed(plan({ tpWidthForLimit: w }), 1_000)!;
      expect('tpWidthForLimit' in a).toBe(false);
    }
  });
  it('片側だけ載っている計画は、その片側だけ運ぶ', () => {
    const a = planToArmed(plan({ tpWidthForStop: 90 }), 1_000)!;
    expect('tpWidthForLimit' in a).toBe(false);
    expect(a.tpWidthForStop).toBe(90);
  });
  it('★計画 → armed → 約定 → 決済 が1本で通る(指値レッグ)', () => {
    const armed = planToArmed(plan({ tpWidthForLimit: 60, tpWidthForStop: 90 }), 1_000)!;
    const f = advance({ phase: 'armed', armed }, 37945, 2_000);   // 指値は 5円 行き過ぎて約定
    expect(f.next.position!.entryPrice).toBe(37950);
    expect(f.next.position!.tpWidth).toBe(60);                    // 約定した側の幅だけが焼かれる
    const x = advance(f.next, 37950 + 60, 2_100);
    expect(x.recorded!.exitReason).toBe<ExitReason>('take_profit');
  });
});

describe('★TP を切っている間は幅を焼かない(切れば1バイトも変わらない)', () => {
  const armed: ArmedBracket = {
    direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 1_000,
    tpWidthForLimit: 60,
  };
  it('tp.enabled=false の約定では position に tpWidth が付かない', () => {
    const { next } = advance({ phase: 'armed', armed }, 37945, 2_000, { tp: tpOff, prevTick: null });
    expect('tpWidth' in next.position!).toBe(false);
    expect(JSON.stringify(next.position)).not.toContain('tpWidth');
  });
  it('tp.enabled=true(既定)の約定では付く', () => {
    expect(advance({ phase: 'armed', armed }, 37945, 2_000, { tp: aiTp, prevTick: null }).next.position!.tpWidth).toBe(60);
    expect(advance({ phase: 'armed', armed }, 37945, 2_000).next.position!.tpWidth).toBe(60);   // opts 省略=既定 ON
  });
  it('tp.enabled=false なら、幅を焼いた建玉でも決済されない', () => {
    const pos = buyPos({ tpWidth: 60 });
    expect(advance(filled(pos), 38400, 2_000, { tp: tpOff, prevTick: null }).next.phase).toBe('filled');
    expect(resolveTpWidth(pos, 47, false)).toBeNull();   // 手動幅も効かない
  });
});

// ═══ ★signal_trades への記録(実ファイル SQLite)════════════════════════
//
//   ★これが「この版の目的」に直結する部分: AI が出した TP幅と、実際の MFE(shadow_exits)を
//     突き合わせて「当たったか」を1行で出せるようにするための列。
//   ★列は在るのに書き込むコードが無ければ、記録は **永久に NULL** で目的そのものが達成できない。
//     だからここは型・モックではなく **実ファイルの .db に実際に INSERT された行** で確かめる。

describe('★signal_trades.tp_width / tp_trigger に実際に値が入る(実ファイル SQLite)', () => {
  let dir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origAppData: string | undefined;
  const cfgA = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };

  const writeCfg = (cfg: Record<string, unknown>): void => {
    mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify(cfg), 'utf-8');
    resetConfigCache();
  };
  /** 実ファイルの jp225.db を開いて signal_trades を読む(メモリDBではない)。 */
  const readTrades = (): SignalTradeRow[] => {
    const path = resolveDbPath();
    expect(existsSync(path)).toBe(true);              // ★実ファイルが在ること
    expect(statSync(path).size).toBeGreaterThan(0);
    const db = openDb(path);
    try { return getSignalTrades(db, 10); } finally { db.close(); }
  };
  /** 指値 37950(SL 37900)で武装 → 37945 で約定(建値 37950)。 */
  const armAndFill = (eng: SignalEngine, tpWidthForLimit?: number): void => {
    const a: ArmedBracket = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 1_000 };
    if (tpWidthForLimit != null) a.tpWidthForLimit = tpWidthForLimit;
    eng._setArmedForTest(a, { signalId: 41, at: 1_000, direction: 'buy', rationale: 'r', limitEntry: 37950, stopLossForLimit: 37900 });
    eng.feed(37945, 11_000);
    expect(eng.getPhase()).toBe('filled');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-tprec-'));
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE; origAppData = process.env.APPDATA;
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    resetConfigCache();
  });
  afterEach(() => {
    _setExitImpl(null);
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    resetConfigCache();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL を掴んでいることがある */ }
  });

  it('★TP で決済 → tp_width / tp_trigger が実ファイルの行に入る', async () => {
    writeCfg({ scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const eng = new SignalEngine(cfgA);
    await eng.start();
    armAndFill(eng);
    eng.feed(37997, 30_000);   // 建値37950 + 幅47
    expect(eng.getPhase()).toBe('flat');
    const [row] = readTrades();
    expect(row!.exit_reason).toBe('take_profit');
    expect(row!.tp_width).toBe(47);
    expect(row!.tp_trigger).toBe(37997);
    eng.stop();
  });

  it('★TP で決済しなかった回(initial_stop)にも入る(「その時 TP がどこにあったか」を残す)', async () => {
    writeCfg({ scalpTpWidthSource: 'manual', scalpTpWidthYen: 300 });
    const eng = new SignalEngine(cfgA);
    await eng.start();
    armAndFill(eng);
    eng.feed(37900, 30_000);   // 初期LC 到達(TP=38250 には届いていない)
    const [row] = readTrades();
    expect(row!.exit_reason).toBe('initial_stop');
    expect(row!.tp_width).toBe(300);      // ★NULL ではない
    expect(row!.tp_trigger).toBe(38250);
    eng.stop();
  });

  it('★保有中に手動幅を変えたら、決済時点(=変えた後)の値が入る', async () => {
    writeCfg({ scalpTpWidthSource: 'manual', scalpTpWidthYen: 300 });
    const eng = new SignalEngine(cfgA);
    await eng.start();
    armAndFill(eng);
    eng.feed(37960, 20_000);                                        // 幅300 のうちは決済しない
    expect(eng.getPhase()).toBe('filled');
    writeCfg({ scalpTpWidthSource: 'manual', scalpTpWidthYen: 13 }); // ★保有したまま変更
    eng.feed(37963, 30_000);                                        // 37950 + 13
    expect(eng.getPhase()).toBe('flat');
    const [row] = readTrades();
    expect(row!.tp_width).toBe(13);        // ★300 ではなく 13(決済時点の値)
    expect(row!.tp_trigger).toBe(37963);
    eng.stop();
  });

  it('★scalpTpEnabled=false なら両方 NULL(AI が幅を出していた計画でも)', async () => {
    writeCfg({ scalpTpEnabled: false, scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const eng = new SignalEngine(cfgA);
    await eng.start();
    armAndFill(eng, 60);       // AI が幅60 を出した計画で武装
    eng.feed(37900, 30_000);
    const [row] = readTrades();
    expect(row!.exit_reason).toBe('initial_stop');
    expect(row!.tp_width ?? null).toBeNull();
    expect(row!.tp_trigger ?? null).toBeNull();
    eng.stop();
  });

  it('AI委任(既定)+ 計画の TP幅 → その幅が入る', async () => {
    writeCfg({});
    const eng = new SignalEngine(cfgA);
    await eng.start();
    armAndFill(eng, 60);
    eng.feed(38010, 30_000);   // 37950 + 60
    const [row] = readTrades();
    expect(row!.exit_reason).toBe('take_profit');
    expect(row!.tp_width).toBe(60);
    expect(row!.tp_trigger).toBe(38010);
    eng.stop();
  });
});

// ═══ ★設定スナップショット(settings_json / meta.settings)に TP が載る ═══
//
//   ★何を防ぐか: signal_plans.tp_source が 'manual' になる経路は3通りあり
//     (a) scalpTpWidthSource='manual' / (b) scalpTpEnabled=false / (c) レンジ版
//     台帳ではこれが全部 'manual' に潰れるので、**「TP を切っていた期間」が特定できない**。
//     切っていた期間の回が「AI の TP が当たったか」の標本に黙って混ざる。
//   ★だから (a) と (b) がスナップショットで **区別できる** ことをここで固定する。

describe('★settings_json に TP の3項目が入り、(a)手動 と (b)無効 が区別できる', () => {
  let dir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origAppData: string | undefined;

  const writeCfg = (cfg: Record<string, unknown>): void => {
    mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify(cfg), 'utf-8');
    resetConfigCache();
  };
  /** 実ファイルの jp225.db に signal_plans を1行 INSERT し、settings_json を読んでパースする。 */
  const insertAndReadSettings = (): Record<string, unknown> => {
    const settings = buildSettingsSnapshot(undefined, 'A');
    const row = buildSignalPlanInsert({
      t: 1_000, system: 'A', settings,
      result: { ok: true, plan: { direction: 'buy', limitEntry: 38000, stopLossForLimit: 37950, rationale: 'r', refPrice: 38010 } },
    } as unknown as Parameters<typeof buildSignalPlanInsert>[0]);
    const path = resolveDbPath();
    const db = openDb(path);
    try {
      insertSignalPlan(db, row);
      const raw = (db.prepare('SELECT settings_json FROM signal_plans ORDER BY id DESC LIMIT 1')
        .get() as { settings_json: string }).settings_json;
      expect(existsSync(path)).toBe(true);          // ★実ファイル
      expect(statSync(path).size).toBeGreaterThan(0);
      return JSON.parse(raw) as Record<string, unknown>;
    } finally { db.close(); }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-tpset-'));
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE; origAppData = process.env.APPDATA;
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    resetConfigCache();
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    resetConfigCache();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL */ }
  });

  it('既定(enabled=true / source=ai)が実ファイルの settings_json に入る', () => {
    writeCfg({});
    const s = insertAndReadSettings();
    expect(s.scalpTpEnabled).toBe(true);
    expect(s.scalpTpWidthSource).toBe('ai');
    expect(s.scalpTpWidthYen).toBe(80);
  });

  it('★(a) source=manual の回', () => {
    writeCfg({ scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const s = insertAndReadSettings();
    expect(s.scalpTpEnabled).toBe(true);
    expect(s.scalpTpWidthSource).toBe('manual');
    expect(s.scalpTpWidthYen).toBe(47);
  });

  it('★(b) scalpTpEnabled=false の回', () => {
    writeCfg({ scalpTpEnabled: false });
    const s = insertAndReadSettings();
    expect(s.scalpTpEnabled).toBe(false);
    expect(s.scalpTpWidthSource).toBe('ai');
  });

  it('★★(a) と (b) が区別できる(これがこの記録の存在理由)', () => {
    writeCfg({ scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const a = insertAndReadSettings();
    writeCfg({ scalpTpEnabled: false });
    const b = insertAndReadSettings();
    // 台帳の tp_source では両方 'manual' に潰れるが、スナップショットでは別物として読める。
    expect(a.scalpTpEnabled).toBe(true);
    expect(b.scalpTpEnabled).toBe(false);
    expect(a.scalpTpEnabled).not.toBe(b.scalpTpEnabled);
  });

  it('(a)+(b) が同時でも両方読める(切っていて手動指定も残っている)', () => {
    writeCfg({ scalpTpEnabled: false, scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const s = insertAndReadSettings();
    expect(s.scalpTpEnabled).toBe(false);
    expect(s.scalpTpWidthSource).toBe('manual');
    expect(s.scalpTpWidthYen).toBe(47);
  });

  it('★scalpTpWidthYen は常に「設定の値」で、実測値を混ぜない(lcCeiling の誤読を繰り返さない)', () => {
    // lcCeiling は realizedLcYen を渡すと mode='ai' でも value が **実測LC幅** になる(既存の流儀)。
    writeCfg({ scalpLcCeilingSource: 'ai', scalpTpWidthYen: 47 });
    const snap = buildSettingsSnapshot(123, 'A');   // ★実測LC幅 123 を渡す
    expect(snap.lcCeiling).toEqual({ mode: 'ai', value: 123 });   // 既存: 実測が入る(ここは変えない)
    // ★TP は実測を渡しても設定値のまま(source=ai なのでこの 47 は効いていない、という意味の値)。
    expect(snap.scalpTpWidthSource).toBe('ai');
    expect(snap.scalpTpWidthYen).toBe(47);
  });

  it('meta.settings(signal_trades 側)にも同じ3項目が載る', () => {
    writeCfg({ scalpTpEnabled: false, scalpTpWidthSource: 'manual', scalpTpWidthYen: 47 });
    const meta = JSON.parse(buildTradeMetaJson(undefined, buildSettingsSnapshot(undefined, 'A')));
    expect(meta.settings.scalpTpEnabled).toBe(false);
    expect(meta.settings.scalpTpWidthSource).toBe('manual');
    expect(meta.settings.scalpTpWidthYen).toBe(47);
  });
});
