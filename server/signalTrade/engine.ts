// トレードシグナルの「紙(表示専用)エンジン」。
//
//   FLAT ──(一定間隔で AI scalp-plan)──▶ ARMED(ブラケット: 指値+逆指値の新規, 各初期LC)
//   ARMED ─(現在値が entry を跨ぐ=擬似約定, 他レッグは自動キャンセル)─▶ FILLED(保有)
//   FILLED ─(非公開 phase-exit がラチェット決済逆指値を動かし、現在値が達したら擬似決済)─▶ FLAT
//
// 実発注・endpoint・売買命令送信は一切持たない。SSE の現在値 tick だけで擬似約定/擬似決済し、
// 決済確定ごとに signal_trades へ1行 INSERT する。trade2(forward.db/engine/API)には触れない。
//
// このファイルは SignalEngine(状態保持・副作用=DB/LLM/broadcast/heartbeat)の
// オーケストレーションに徹する。約定判定・phase 遷移・SSE state 組み立てなどの純関数は
// ./decisions.js、決済記録の DB/JSON ビルダーは ./persist.js に切り出してある。
// 外部契約(公開シンボル)は従来どおり engine.js から re-export するため import 元は不変。

import type { SignalTradeState } from '../types.js';
import { loadExitImpl } from './exit/index.js';
import { checkSanity } from './sanity.js';
import { broadcast } from '../sse/broker.js';
import { getPrices } from '../cache.js';
import { openDb, resolveDbPath, insertSignalTrade, insertSignalExitStop, getSignalIdCounter, setSignalIdCounter, getArmedTimeoutStats, bumpArmedTimeout } from '../db/store.js';
import { inPollWindow } from '../../core/session.js';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';
import { shouldRearmOnLevel, rearmBounds } from './levelGate.js';
import { resolveScalpCooldownDirective, resolveScalpDotenEnabled, resolveScalpRangeReevalEnabled, type SignalProfile } from '../configStore.js';
import {
  advance, toSignalTradeState, computeHold, planToArmed, armedToCurrentSignal,
  inCooldown, realizedLcFromArmed, checkStaleLegs, ARMED_TIMEOUT_MS,
  opposite, reverseToDoten, shouldRequestHeldEval, sameHeldPosition,
  computeAvgFillMs, shouldRangeReeval, bothRangeLegsLimit, sameArmedBracket, sameBracketShape,
  AVG_FILL_SAMPLES, MIN_SAMPLES, DEFAULT_AVG_FILL_MS, REEVAL_FACTOR, REEVAL_CAP_MS,
  type SignalPhase, type EngineState, type CurrentSignal, type SignalHold, type RecordedTrade,
  type OpenPosition, type HeldIdentity, type ArmedBracket, type ArmedIdentity, type StaleLegReport,
} from './decisions.js';
import type { ScalpPlanResult } from '../llm/openai.js';
import { checkRefDrift, recheckArmedSanity } from './armGate.js';
import { buildSignalTradeInsert, buildSettingsSnapshot, buildExitStopRecord, type ExitStopTracker } from './persist.js';

// 純粋な決定コア(型/純関数)と永続化ビルダーは従来どおり engine.js から公開する(import 元を変えない)。
export * from './decisions.js';
export * from './persist.js';

const NIKKEI_SYMBOL = 'NIY=F';

// ─── オーケストレーション(状態保持・副作用) ──────────────────

const DEFAULT_PLAN_INTERVAL_MS = 3 * 60_000;

function resolvePlanIntervalMs(): number {
  const v = Number(process.env.SIGNAL_PLAN_INTERVAL_MS);
  return Number.isFinite(v) && v >= 30_000 ? v : DEFAULT_PLAN_INTERVAL_MS;
}

/** SIGNAL_TRADE=0/false/off でエンジン自体を無効化(既定は有効)。 */
function engineEnabled(): boolean {
  const v = process.env.SIGNAL_TRADE;
  if (v === undefined) return true;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

// 抑止中の安全弁: 節目を跨がなくてもこの長間隔が経てば1回だけ再計画を許す(詰まり防止)。
const SUPPRESS_SAFETY_MS = 20 * 60_000;

// ★診断ハートビートの間隔[ms]。各エンジンがこの間隔で phase/planning/経過を1行ログする(固着の早期発見)。
const HEARTBEAT_MS = 5 * 60_000;

/** System B(紙専用)を個別に無効化する env(既定は有効)。SIGNAL_TRADE_B=0/false/off でオフ。
 *  A は SIGNAL_TRADE(engineEnabled)配下で不変。B の並走(独立の AI 呼び出し)を止めたい時に使う。 */
function engineBEnabled(): boolean {
  const v = process.env.SIGNAL_TRADE_B;
  if (v === undefined) return true;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

/** ★v0.8.2: エンジンインスタンスの構成。A(実売買・グローバル設定)と B(紙専用・signalB 設定)で切り替える。 */
export interface EngineConfig {
  profile: SignalProfile;                       // 設定解決 & scalp-plan プロファイル('A' | 'B')
  systemTag: 'A' | 'B' | null;                  // persist の system 列。A は null(=既存挙動と byte 一致)/ B は 'B'
  broadcastType: 'signalTrade' | 'signalTradeB'; // SSE イベント名
  maintainsCurrentSignal: boolean;              // A=true(currentSignal/hold を露出)/ B=false(絶対に露出しない)
}

/** ★v0.8.2: トレードシグナル紙エンジン(インスタンス化)。純関数(advance/detectFill/…)は共有・不変。
 *  A インスタンスは currentSignal/hold を露出し 'signalTrade' を出す(=trade2 が従来どおり追従・実売買A)。
 *  B インスタンスは currentSignal を一切持たず 'signalTradeB' を別露出する(紙のみ・trade2 は B を追わない)。
 *  ★A(profile:'A')の挙動は全て従来のモジュール singleton と byte 一致(提案/arm/約定/決済/記録/SSE/currentSignal)。 */
export class SignalEngine {
  private state: EngineState = { phase: 'flat' };
  // 現在シグナル(trade2 追従用・A のみ)。ARM ごとに signalId を単調増加で採番して更新し、
  // 擬似約定(filled)後も保持する(見送り none では更新しない)。null = まだ一度も ARM していない。
  // ★signalId は「最後に採番した値」を DB(signal_meta)に永続する。start() で永続値からシードして再起動を
  //   跨いで継続し(1 へ戻らない)、リセットは履歴消去(clearSignalTrades)のときだけ 0 に戻す。
  private signalIdCounter = 0;
  private currentSignal: CurrentSignal | null = null;
  private running = false;
  private planning = false;
  private lastPlanAt = 0;
  private lastBroadcastJson = '';
  // 決済(filled→flat)時刻。この後 scalpCooldownSec 秒は再ARM(plan要求)を抑止する。null=まだ決済無し。
  private lastSignalExitAt: number | null = null;
  // ★直近に決済(filled→flat)したシグナルの signalId(trade2 の即時再同期用・A のみ)。決済時に currentSignal.signalId を
  //   捕捉し、次の決済まで保持する。undefined=まだ一度も決済していない(=SSE に載せない=既存 JSON 不変=dedupe 保持)。
  private lastExitedSignalId: number | undefined = undefined;
  // cooldown ログの多重抑止(毎tick出さない)。決済ごとに false へ戻し、cooldown 中に一度だけ出す。
  private cooldownLogged = false;
  private readonly planIntervalMs = resolvePlanIntervalMs();
  // ★ドテン(保有中の反転評価=held-eval)の最終要求時刻。flat-plan 間隔以上の長間隔でクールダウンする(held は spend が倍化しやすい)。
  private lastHeldEvalAt = 0;
  private readonly heldEvalIntervalMs = 2 * this.planIntervalMs;
  // 見送り(direction:'none')後の再計画抑止アンカー。null = 抑止していない。
  private planSuppressedAnchor: number | null = null;
  // ★検証用(RECORD-ONLY): 決済逆指値(hold.exitStop)の「前回記録値」。変化時のみ signal_exit_stops へ1行記録するための dedupe 用。
  private exitStopTracker: ExitStopTracker = { openedAt: null, value: null };
  // ★レンジ再評価(未約定→ブレイク): ARM→約定所要[ms]の直近サンプル(移動平均用)。in-memory(再起動でリセット=許容)。
  //   約定(armed→filled)ごとに position.at−armed.at を push し、AVG_FILL_SAMPLES を超えたら古い方から捨てる。
  private fillDurations: number[] = [];
  // ★レンジ再評価の最終要求時刻(過度な差替えを抑えるクールダウン。held-eval と同じ長間隔を共有)。
  private lastRangeReevalAt = 0;
  // ★未約定失効(armed-timeout)の累計と最終発生時刻。start() で DB(signal_meta)からシードし、発生ごとに
  //   加算+永続し、SSE(SignalTradeState.armedTimeout)へ載せる。0件のあいだは SSE に出ない(既存 JSON 不変)。
  private armedTimeouts: { count: number; lastAt: number | null } = { count: 0, lastAt: null };

  constructor(private readonly cfg: EngineConfig) {}

  /** ログ接頭辞(A=[signalTrade] で従来ログと byte 一致 / B=[signalTradeB])。 */
  private get logTag(): string { return this.cfg.profile === 'B' ? '[signalTradeB]' : '[signalTrade]'; }

  /** signalId 永続カウンタの system キー(A は systemTag=null → 'A' / B は 'B')。系統別に独立。 */
  private get counterKey(): 'A' | 'B' { return this.cfg.systemTag === 'B' ? 'B' : 'A'; }

  /** 起動時: 永続値(最後に採番した signalId)から signalIdCounter をシードする(再起動を跨いで継続)。
   *  失敗しても致命的にしない(表示専用ゆえ 0 のまま=最悪でも従来挙動へ劣化)。 */
  private loadSignalIdCounter(): void {
    try {
      const db = openDb(resolveDbPath());
      try {
        this.signalIdCounter = getSignalIdCounter(db, this.counterKey);
        // ★未約定失効の累計も同じ契機でシード(再起動で件数が 0 に戻ると「無音の失敗」が数えられなくなる)。
        this.armedTimeouts = getArmedTimeoutStats(db, this.counterKey);
      } finally { db.close(); }
    } catch (e) {
      console.warn(`${this.logTag} signalId seed failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  /** ★未約定失効を1件記録する(永続 + in-memory)。失敗しても致命的にしない(件数は落ちるがログは残る)。 */
  private recordArmedTimeout(at: number): void {
    this.armedTimeouts = { count: this.armedTimeouts.count + 1, lastAt: at };
    try {
      const db = openDb(resolveDbPath());
      try { this.armedTimeouts = bumpArmedTimeout(db, this.counterKey, at); } finally { db.close(); }
    } catch (e) {
      console.warn(`${this.logTag} armed-timeout persist failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  /** テスト用: 未約定失効の累計を覗く。 */
  _peekArmedTimeouts(): { count: number; lastAt: number | null } { return this.armedTimeouts; }

  /** ARM で採番するたびに、最後に採番した signalId を永続する(再起動後のシード元)。失敗は握りつぶす。 */
  private persistSignalIdCounter(): void {
    try {
      const db = openDb(resolveDbPath());
      try { setSignalIdCounter(db, this.counterKey, this.signalIdCounter); } finally { db.close(); }
    } catch (e) {
      console.warn(`${this.logTag} signalId persist failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  /** 履歴消去に合わせて in-memory の signalId カウンタを 0 に戻す(永続側は clearSignalTrades が 0 化)。
   *  次の ARM は 1 から採番される。テスト/リセットの reset() と違い、この経路だけが実運用のリセット。 */
  resetSignalIdCounter(): void {
    this.signalIdCounter = 0;
    // ★未約定失効カウンタも同時に 0(DB 側は resetSignalIdCounter(store) が 0 化する=in-memory と食い違わせない)。
    this.armedTimeouts = { count: 0, lastAt: null };
  }

  /** テスト用: 現在の signalId カウンタ(=最後に採番した signalId)を覗く。 */
  _peekSignalIdCounter(): number { return this.signalIdCounter; }

  /** SSE/hold に載せる現在シグナル。A は currentSignal / B は常に null(currentSignal を露出しない)。 */
  private signalForState(): CurrentSignal | null {
    return this.cfg.maintainsCurrentSignal ? this.currentSignal : null;
  }

  /** ★stale plan veto に渡す「新鮮な」live 価格(NIY=F)。取れない/古い(stale)なら null。
   *  ★必ず stale を見る: priceLoop は取得失敗/清算の銘柄を「前回値を古い timestamp のまま stale:true で持ち越す」
   *    (実弾安全ルール)ため、キャッシュには古い価格が残る。約定判定側は `if (niy && !niy.stale)` で新鮮値のみを
   *    feed している。ここで stale を見ないと、フィード断中に解決した計画を「古い価格」で判定して
   *    (a) 跨いでいなければ抑止漏れ(元のバグが残る)、(b) 跨いでいれば未到達レッグを落とす誤抑止 が起きる。
   *    null = 判定せず素通し(=従来どおり ARM。新しい抑止で取引を止めない)。 */
  private livePrice(): number | null {
    const p = getPrices().find(x => x.symbol === NIKKEI_SYMBOL);
    return p && !p.stale ? p.price : null;
  }

  /** テスト用: ゲートに渡る live 価格(新鮮値のみ・stale/欠落は null)を覗く。 */
  _peekLivePrice(): number | null { return this.livePrice(); }

  /** ★通過済み(stale)レッグを1行ログする(記録専用)。tag で経路を区別する(plan-stale / doten-stale / reeval-stale)。
   *  例) `[signalTrade] plan-stale dir=sell ref=61905 live=61920 limit=61905(通過済み) stop=62000` */
  private logStaleLegs(tag: string, dir: string, refPrice: number, live: number | null, legs: StaleLegReport[]): void {
    const s = legs.map(l => `${l.name}=${Math.round(l.entry)}${l.stale ? '(通過済み)' : ''}`).join(' ');
    console.log(`${this.logTag} ${tag} dir=${dir} ref=${Math.round(refPrice)} `
      + `live=${live != null && Number.isFinite(live) ? Math.round(live) : '-'} ${s}`);
  }

  /** 起動: 非公開 exit 実装をロードしてエンジンを有効化(冪等)。 */
  async start(): Promise<void> {
    if (this.running) return;
    if (!engineEnabled()) { console.log(`${this.logTag} disabled (SIGNAL_TRADE=0)`); return; }
    if (this.cfg.profile === 'B' && !engineBEnabled()) { console.log('[signalTradeB] disabled (SIGNAL_TRADE_B=0)'); return; }
    const kind = await loadExitImpl();
    // ★signalId を永続値からシード(再起動を跨いで継続=1 へ戻らない)。reset() は in-memory 0 化だが
    //   実運用の起動はここで必ず永続から復元する(履歴消去でのみ 0 になった値を尊重)。
    this.loadSignalIdCounter();
    this.running = true;
    console.log(`${this.logTag} engine started (exit=${kind}, planInterval=${Math.round(this.planIntervalMs / 1000)}s, signalId=${this.signalIdCounter})`);
  }

  stop(): void { this.running = false; }

  /** 現在の SSE state(stream.ts の初回送出 / 各 tick の broadcast 用)。 */
  getState(now = Date.now()): SignalTradeState {
    const price = getPrices().find(p => p.symbol === NIKKEI_SYMBOL)?.price ?? null;
    return toSignalTradeState(this.state, price, now, this.signalForState(), this.lastExitedSignalId, this.armedTimeouts);
  }

  /** 現在シグナル(trade2 追従用)。A のみ。B は常に null(=露出しない)。 */
  getCurrentSignal(): CurrentSignal | null { return this.signalForState(); }

  getPhase(): SignalPhase { return this.state.phase; }

  /** 保有中の意図(hold・trade2 追従用)。A の filled 中のみ非 null。B は常に null。 */
  getHold(): SignalHold | null { return computeHold(this.state, this.signalForState()); }

  /** テスト/リセット用: エンジン内部状態を初期化する。 */
  reset(): void {
    this.state = { phase: 'flat' };
    this.signalIdCounter = 0;
    this.currentSignal = null;
    this.planning = false;
    this.lastPlanAt = 0;
    this.lastHeldEvalAt = 0;
    this.lastBroadcastJson = '';
    this.planSuppressedAnchor = null;
    this.lastSignalExitAt = null;
    this.cooldownLogged = false;
    this.exitStopTracker = { openedAt: null, value: null };
    this.lastExitedSignalId = undefined;
    this.fillDurations = [];
    this.lastRangeReevalAt = 0;
    this.armedTimeouts = { count: 0, lastAt: null };
  }

  // 非公開: DB へ決済を1行記録(失敗は握りつぶす=表示専用ゆえ致命的にしない)。系統タグ(A=null/B='B')を付与する。
  //   ★検証用: 現在シグナルの signalId(A のみ・B は null)を signal_id 列に載せて trade2 と結合可能にする。
  private persistTrade(t: RecordedTrade): void {
    try {
      const db = openDb(resolveDbPath());
      try {
        insertSignalTrade(db, buildSignalTradeInsert(t, this.cfg.systemTag, this.currentSignal?.signalId));
      } finally { db.close(); }
    } catch (e) {
      console.warn(`${this.logTag} persist failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  // 非公開(RECORD-ONLY・検証用): 決済逆指値(hold.exitStop)が「変化したとき」だけ signal_exit_stops へ1行記録する。
  //   毎tickではなく変化時のみ(buildExitStopRecord の dedupe)。hold は既存の computeHold をそのまま読むだけで
  //   決済ロジック/SSE には一切影響しない。A のみ(B は signalForState=null → hold=null で自然に無記録)。失敗は握りつぶす。
  private recordExitStopChange(now: number): void {
    try {
      const rec = buildExitStopRecord(computeHold(this.state, this.signalForState()), this.exitStopTracker, now);
      if (!rec) return;
      const db = openDb(resolveDbPath());
      try { insertSignalExitStop(db, rec); } finally { db.close(); }
      this.exitStopTracker = { openedAt: rec.openedAt, value: rec.exitStop };
    } catch (e) {
      console.warn(`${this.logTag} exit-stop record failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  // 非公開: FLAT かつ間隔経過なら AI へプランを1本要求(非同期・多重発火ガード)。
  // 見送り(none)抑止中は、価格が節目を跨ぐ(shouldRearmOnLevel)まで要求しない。安全弁として
  // SUPPRESS_SAFETY_MS 経過時のみ抑止中でも1本要求を許す(詰まり防止)。
  private maybeRequestPlan(price: number, now: number): void {
    if (this.planning || this.state.phase !== 'flat') return;
    if (!inPollWindow(now)) return;   // 取引時間外は要求しない。

    // クールダウンゲート: 決済(filled→flat)後 scalpCooldownSec 秒は再ARM(plan要求)を抑止する。
    // ★v0.7.56: クールダウンが AI委任(mode==='ai')のときはゲートを無効化(AI の選択性に委ねる)。manual のみゲート。
    const cd = resolveScalpCooldownDirective(this.cfg.profile);
    if (cd.mode === 'manual' && inCooldown(this.lastSignalExitAt, now, cd.value)) {
      if (!this.cooldownLogged) {
        const remain = Math.max(0, Math.ceil((this.lastSignalExitAt! + cd.value * 1000 - now) / 1000));
        console.log(`${this.logTag} cooldown 決済後の再ARM抑止(あと${remain}秒)`);
        this.cooldownLogged = true;
      }
      return;
    }

    // 見送り抑止ゲート: アンカーが在れば、節目クロス or 安全弁時間まで再計画を抑止する。
    if (this.planSuppressedAnchor !== null) {
      const levels = getLevelsSnapshot();
      if (shouldRearmOnLevel(this.planSuppressedAnchor, price, levels)) {
        const b = rearmBounds(this.planSuppressedAnchor, levels);
        console.log(`${this.logTag} plan-rearm 節目クロス anchor=${Math.round(this.planSuppressedAnchor)} `
          + `price=${Math.round(price)} bounds=[${b.lower ?? '±'},${b.upper ?? '±'}]`
          + `${b.usedFallback ? ' (±50fallback)' : ''}`);
        this.planSuppressedAnchor = null;   // 再武装(=以降は通常の間隔判定へ)。
      } else if (now - this.lastPlanAt >= SUPPRESS_SAFETY_MS) {
        console.log(`${this.logTag} plan-rearm 安全弁(${Math.round(SUPPRESS_SAFETY_MS / 60_000)}分経過) `
          + `anchor=${Math.round(this.planSuppressedAnchor)} price=${Math.round(price)}`);
        // アンカーは維持(none が返れば下でアンカー更新)。安全弁として1本だけ要求へ進む。
      } else {
        return;   // 抑止継続。
      }
    }

    if (now - this.lastPlanAt < this.planIntervalMs) return;
    this.planning = true;
    this.lastPlanAt = now;   // 起動直後の多重要求を防ぐため、要求時点で更新する。
    const anchorPrice = price;   // 見送りが返った場合のアンカー(要求時点の現在値)。
    void (async () => {
      try {
        // route(/api/scalp-plan・trade2)と同一の共通関数を使う。profile で A/B の設定を解決する
        // (A=グローバル=trade2 と同条件 / B=signalB)。画像未生成/LLM 失敗は result.ok=false → FLAT 維持(見送り)。
        const { runScalpPlanWithChart } = await import('../llm/scalpPlanRunner.js');
        const result = await runScalpPlanWithChart({ profile: this.cfg.profile });
        if (this.state.phase === 'flat' && result.ok) {
          // ★正規シグナルのゲート(A/B 共通): trade2 の送信直前サニティ(src/ai/sanity.ts)を先取りして
          //   検証し、trade2 が REJECT する構造の計画は「正規シグナル」として出さない(=紙 ARM もしない・
          //   currentSignal も更新しない・broadcast もしない)。これで monitor の紙と trade2 の実弾が乖離しない。
          //   maintainsCurrentSignal に依らず適用(=計画が構造的にトレード可能かの判定・A/B とも通過した計画だけが
          //   シグナルになる)。
          //   ★検証は計画自身の参照価格 plan.refPrice(計画ビルド時に見た NIY=F=各レッグが挟む基準値)に対して行う。
          //   anchorPrice は「要求時点」の現在値であり、この後の画像生成+LLM 呼び出し(数秒のレイテンシ)を挟むため
          //   plan.refPrice とは乖離し得る。trade2(追従側)は受信時の自前の鮮度価格(≒refPrice)で checkSanity を
          //   再検証するので、ここも refPrice を基準にしないと (a) refPrice に対して妥当な計画を古い anchorPrice で
          //   誤って弾く過剰抑止、(b) monitor が anchor でだけ通し trade2 が refPrice で弾く乖離、が起きる。
          //   非有限(refPrice 欠落等)なら checkSanity が NG→抑止(安全)。
          const sanity = result.plan.direction === 'none' ? null : checkSanity(result.plan, result.plan.refPrice);
          // ★v0.9.44(記録専用): レンジがプロンプトの規約(2択=fade/breakout の組)に反する形で届いたら1行残す。
          //   判定は buildScalpPlan が **AI の生出力(parse 直後)** に対して行い result に載せる(veto/bias で
          //   片脚が落ちた回も観測できる)。受理は現状のまま(弾かない=バグを発見できる)。該当時だけ出す。
          if (result.rangeAnomaly) {
            console.log(`${this.logTag} ${result.rangeAnomaly.tag} ${result.rangeAnomaly.legs} ref=${Math.round(result.plan.refPrice)}`);
          }
          if (result.plan.direction === 'none') {
            // 見送り: アンカーを記録し、価格が節目を跨ぐまで再計画を抑止する。
            //   ★②a: AI の見送り根拠(rationale)をログに残す=書き出し(serverlog)で「なぜ入らないか」を可視化。
            this.planSuppressedAnchor = anchorPrice;
            const why = (result.plan.rationale ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
            //   ★v0.9.44: veto=y/n の1ビットでは8通りの経路が同じ見た目になるため、none の経路(reason)と
            //     計画自身の参照価格(ref)を添える。さらに落としたレッグの生数値を1行出し、根拠文からの推定を不要にする。
            console.log(`${this.logTag} plan-suppress 見送り(none) anchor=${Math.round(anchorPrice)} ref=${Math.round(result.plan.refPrice)} reason=${result.noneReason ?? '(不明)'} veto=${result.vetoFired ? 'y' : 'n'} 根拠=${why || '(なし)'}`);
            if (result.noneLegs) {
              const legs = result.noneLegs.legs
                .map(l => `${l.name}=${Math.round(l.entry)}${l.stopLoss != null ? `,SL=${Math.round(l.stopLoss)}` : ''}(${l.ok ? 'OK' : 'NG'})`)
                .join(' ');
              console.log(`${this.logTag} plan-legs dir=${result.noneLegs.dir} ref=${Math.round(result.plan.refPrice)} ${legs}`);
            }
          } else if (sanity && !sanity.ok) {
            // サニティ不通過=見送り(none)と同じ扱い: アンカーを記録し節目まで抑止する。
            this.planSuppressedAnchor = anchorPrice;
            const why = (result.plan.rationale ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
            console.log(`${this.logTag} plan-suppress サニティ不通過(${sanity.reason})→ 正規シグナルにしない anchor=${Math.round(anchorPrice)} 根拠=${why || '(なし)'}`);
          } else {
            // ★作業2(refPrice 鮮度): checkStaleLegs より **前** に判定する。refPrice が壊れている/古い計画は
            //   レッグの通過判定を出す前に丸ごと落としたい(「通過済み」ログが出て原因を取り違えるのを防ぐ)。
            //   live が取れない時は判定しない(=従来どおり先へ進む)。
            const liveForGate = this.livePrice();
            const drift = checkRefDrift(result.plan.refPrice, liveForGate);
            if (!drift.ok) {
              this.planSuppressedAnchor = anchorPrice;
              console.log(`${this.logTag} plan-suppress ${drift.reason} → 正規シグナルにしない `
                + `anchor=${Math.round(anchorPrice)} ref=${Math.round(result.plan.refPrice)} reason=refstale`);
              return;   // ★finally で planning=false に戻る(この IIFE を抜けるだけ)。
            }
            const armed0 = planToArmed(result.plan, Date.now(), { vetoFired: result.vetoFired });
            // ★stale plan veto: ARM 時点の live 価格で「もう通過した価格」のレッグは武装しない。
            //   checkSanity は plan.refPrice(撮影時価格)基準のまま(上のコメントの設計判断=不変)。ここは別観点の
            //   ガードで、画像生成+LLM のレイテンシ中に価格が動き「ARM 時点では既にエントリーを通過している」計画を
            //   そのまま武装して次tickで即約定する事故を防ぐ(=現実に執行できない取引が紙の成績に混ざるのを止める)。
            //   判定は checkStaleLegs=detectFill/detectRangeFill の再利用(約定条件と同一規約)。
            //   live 価格が取れない/非有限なら checkStaleLegs は素通し=従来どおり ARM(安全側)。
            //   ★drift ゲートと **同じ1回の読み取り** を使う(livePrice() は可変キャッシュを読むので2度読むと
            //     ゲート間で値が食い違い、どの価格で落としたのかが記録から追えなくなる)。
            const live = liveForGate;
            const stale = armed0 ? checkStaleLegs(armed0, live) : { armed: null, legs: [] as StaleLegReport[] };
            if (stale.legs.some(l => l.stale)) {
              this.logStaleLegs('plan-stale', result.plan.direction, result.plan.refPrice, live, stale.legs);
            }
            const armed = stale.armed;
            if (armed0 && !armed) {
              // 全レッグ通過済み → 見送り(none)と同じ扱い: アンカーを記録し節目まで再計画を抑止する。
              this.planSuppressedAnchor = anchorPrice;
              const why = (result.plan.rationale ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
              console.log(`${this.logTag} plan-suppress 見送り(none) anchor=${Math.round(anchorPrice)} `
                + `ref=${Math.round(result.plan.refPrice)} reason=stale veto=${result.vetoFired ? 'y' : 'n'} 根拠=${why || '(なし)'}`);
            }
            // ★作業1(単レッグ化の再検証): checkStaleLegs で脚が落ちた **後** の形を ARM 時 live 価格で再検証する。
            //   2レッグ時の checkSanity は距離上限を課さないため、片脚が落ちて単レッグ化した瞬間に
            //   「単レッグ ≤200円」が無検査で素通りしていた(実測 sid=361: 残った指値が live から315円・trade2 が147回拒否)。
            //   ★脚が落ちた時だけ再検証する(checkStaleLegs は何も落ちなければ引数と同一参照を返す)。
            //     形が変わっていないなら refPrice 基準の checkSanity は既に通っており、価格側の観点は
            //     checkStaleLegs(=約定条件と同一規約・指値は5円の行き過ぎマージン)が受け持つ。ここで無条件に
            //     再検証すると、そのマージンの内側(現値が指値を数円だけ跨いだだけ)の健全なブラケットまで落ちる。
            //     実測でも trade2 の同型の一時的な拒否は6秒後の再送で自然に解消しており(9件/4日)、
            //     解消しない持続的な不整合は「単レッグ化して距離上限を超えた」sid=361 だけだった。
            if (armed && armed !== armed0) {
              const recheck = recheckArmedSanity(armed, result.plan.refPrice, live);
              if (!recheck.ok) {
                this.planSuppressedAnchor = anchorPrice;
                console.log(`${this.logTag} plan-suppress ${recheck.reason} → 正規シグナルにしない `
                  + `anchor=${Math.round(anchorPrice)} ref=${Math.round(result.plan.refPrice)} reason=recheck`);
                return;   // ★finally で planning=false に戻る。
              }
            }
            if (armed) {
              // ★v0.7.56: 実効設定スナップショット(委任モード+値)を arm 時に確定して持ち回る(profile 別)。
              armed.settings = buildSettingsSnapshot(realizedLcFromArmed(armed), this.cfg.profile);
              // ★遡り解析用(RECORD-ONLY): ARM 時点で monitor が見ていた価格を armed に焼き付ける(ARM 経路①=flat計画)。
              //   同じ live(stale plan veto と同一の新鮮値)を使う=事後の「通過済みだったか」判定と武装判定が同じ数値になる。
              if (live != null) armed.armedPrice = live;
              this.state = { phase: 'armed', armed };   // 新規 armed で直近決済表示はクリア。
              this.planSuppressedAnchor = null;         // actionable で抑止解除。
              if (this.cfg.maintainsCurrentSignal) {
                // ARM ごとに signalId を単調増加で採番し、現在シグナルを更新(A のみ・filled 後も保持・none では更新しない)。
                this.signalIdCounter += 1;
                this.persistSignalIdCounter();   // ★採番のたびに永続(再起動後もこの値+1 から継続=決して再利用しない)。
                this.currentSignal = armedToCurrentSignal(armed, this.signalIdCounter);
              }
              this.broadcastSignalState(Date.now());    // ARM 時に即 broadcast(A は trade2 が即追従できるよう)。
            }
          }
        }
      } catch (e) {
        console.warn(`${this.logTag} plan request failed:`, e instanceof Error ? e.message : String(e));
      } finally {
        this.planning = false;
      }
    })();
  }

  // ★ドテン(保有中の反転評価=held-eval)。state.phase==='filled' かつ dotenEnabled のとき、AI に「反転すべきか」を
  //   都度要求する。in-flight(planning)を flat-plan と共有し(同時に AI を叩かない)、inPollWindow でゲートし、
  //   flat-plan 間隔以上のクールダウンで抑制する。★async 同一性再チェック: 要求時に建玉識別(at+direction+signalId)を
  //   控え、AI 応答解決時に「まだ filled かつ同一建玉」でなければ破棄する(幽霊を反転させない)。
  //   ★A のみ(maintainsCurrentSignal): B は currentSignal を持たない=ドテンできない=held-eval も走らせない(byte 不変)。
  private maybeRequestHeldEval(price: number, now: number): void {
    if (!this.cfg.maintainsCurrentSignal) return;   // B は絶対にドテンしない。
    const dotenEnabled = resolveScalpDotenEnabled(this.cfg.profile);
    if (!shouldRequestHeldEval({
      dotenEnabled, planning: this.planning, phase: this.state.phase,
      inWindow: inPollWindow(now), now, lastHeldEvalAt: this.lastHeldEvalAt, intervalMs: this.heldEvalIntervalMs,
    })) return;
    const pos = this.state.position;
    if (!pos) return;
    // ★評価対象の建玉識別を控える(解決時の同一性再チェック用)。
    const identity: HeldIdentity = { at: pos.at, direction: pos.direction, signalId: this.currentSignal?.signalId };
    const heldDir = pos.direction;
    const heldEntry = pos.entryPrice;
    this.planning = true;   // flat-plan と共有(以降 flat-plan も held-eval も新規要求しない)。
    this.lastHeldEvalAt = now;
    void (async () => {
      try {
        const { runScalpPlanWithChart } = await import('../llm/scalpPlanRunner.js');
        // held-context(§3.2)を注入して反転可否を AI に問う(profile で A/B の設定を解決)。
        const result = await runScalpPlanWithChart({ profile: this.cfg.profile, heldPosition: { dir: heldDir, entry: heldEntry } });
        const nowR = Date.now();
        // priceR = P を成行決済する価格(従来どおり・キャッシュ欠落時は要求時価格へフォールバック)=挙動不変。
        // ★ゲート(stale plan veto)用の価格は別に取る: 新鮮値のみ(stale は null=素通し)。古い持ち越し価格で
        //   レッグを落とす/落とさない を判断しないため、決済価格とは分離する。
        const priceR = getPrices().find(p => p.symbol === NIKKEI_SYMBOL)?.price ?? price;
        this.applyHeldEvalResult(result, identity, nowR, priceR, this.livePrice());
      } catch (e) {
        console.warn(`${this.logTag} held-eval request failed:`, e instanceof Error ? e.message : String(e));
      } finally {
        this.planning = false;
      }
    })();
  }

  /** ★ドテン反映(held-eval 応答の解決)。同一性再チェック→ opposite ガード(第一級・checkSanity とは別)→ 反対ブラケットの
   *  checkSanity → reverseToDoten(P を成行決済して反対ブラケットを arm・doten:true)→ 新 signalId を1回だけ採番して
   *  currentSignal を更新し broadcast。戻り値は 'doten'(反転した)/'stale'(別建玉/決済済みで破棄)/'reject'(反転しない)。
   *  ★純ロジックは decisions.ts(reverseToDoten/opposite/sameHeldPosition)。ここは engine 状態の更新と記録・採番・broadcast のみ。
   *  ★_ 接頭辞: async 経路から呼ぶ内部メソッドだが、単体テストからも直接叩けるよう公開する(_peekSignalIdCounter と同方針)。
   *  price = P を成行決済する価格 / live = stale plan veto の判定に使う「新鮮な」live 価格。
   *  ★既定は null=素通し(fail-safe)。ゲートを効かせたい呼び出し元が **明示的に** live を渡す契約にしてある
   *    (既定を price=決済価格にすると、渡し忘れた呼び出し元が静かに「決済価格でゲート判定」=古い/別用途の価格で
   *     レッグを落とす旧挙動へ戻る。既定は必ず安全側=判定しない に倒す)。実運用の呼び出し元は livePrice() を渡す。 */
  applyHeldEvalResult(
    result: ScalpPlanResult, identity: HeldIdentity, now: number, price: number, live: number | null = null,
  ): 'doten' | 'stale' | 'reject' {
    // ★async 同一性再チェック: まだ filled かつ同一建玉(at+direction)かつ同一 signalId(currentSignal)でなければ破棄。
    if (!sameHeldPosition(this.state, identity)) return 'stale';
    if (this.currentSignal?.signalId !== identity.signalId) return 'stale';
    if (!result.ok) return 'reject';
    const plan = result.plan;
    const heldDir = this.state.position!.direction;
    // 第一級 opposite ガード(checkSanity とは別): 保有と反対方向の actionable プランのときだけドテン候補。
    if (plan.direction !== opposite(heldDir)) return 'reject';
    // 反対ブラケットのサニティ(trade2 と同一・新反対ブラケットの妥当性)。不通過なら反転しない(保有継続)。
    const sanity = checkSanity(plan, plan.refPrice);
    if (!sanity.ok) return 'reject';
    // ★作業2(refPrice 鮮度・ARM 経路②): 計画時価格が ARM 時 live からかけ離れていたら反転しない(保有継続)。
    const drift = checkRefDrift(plan.refPrice, live);
    if (!drift.ok) {
      console.log(`${this.logTag} doten-reject ${drift.reason} ref=${Math.round(plan.refPrice)} reason=refstale`);
      return 'reject';
    }
    const rev = reverseToDoten(this.state, plan, price, now, { vetoFired: result.vetoFired });
    if (!rev) return 'reject';
    // ★stale plan veto(反対ブラケットにも同一規約で適用): ARM 時点の live 価格でもう通過しているレッグは武装しない。
    //   reverseToDoten は純関数=ここまで engine 状態は未変更なので、全レッグ通過済みならそのまま降りれば保有継続(無害)。
    //   ★判定は新鮮な live 価格のみ(null=素通し)。決済価格 price ではなく live を使う(古い持ち越し値で落とさない)。
    const stale = checkStaleLegs(rev.armed, live);
    if (stale.legs.some(l => l.stale)) this.logStaleLegs('doten-stale', plan.direction, plan.refPrice, live, stale.legs);
    if (!stale.armed) return 'reject';
    const armed = stale.armed;   // 生き残ったレッグだけの反対ブラケット(何も落ちなければ rev.armed と同一参照)。
    // ★作業1(単レッグ化の再検証・ARM 経路②): 脚が落ちた後の形を ARM 時 live 価格で再検証する。
    //   ここまで engine 状態は未変更(reverseToDoten は純関数)なので、落ちればそのまま保有継続=無害。
    //   ★脚が落ちた時だけ(armed !== rev.armed)。理由は flat 経路の同じ注記を参照。
    if (armed !== rev.armed) {
      const recheck = recheckArmedSanity(armed, plan.refPrice, live);
      if (!recheck.ok) {
        console.log(`${this.logTag} doten-reject ${recheck.reason} ref=${Math.round(plan.refPrice)} reason=recheck`);
        return 'reject';
      }
    }
    // ① 現保有 P を決済(pnl を signal_trades に記録)。この時点の currentSignal は P の ARM 采番=P の signalId で結合。
    this.persistTrade(rev.recorded);
    this.lastSignalExitAt = now;
    this.cooldownLogged = false;
    if (this.currentSignal) this.lastExitedSignalId = this.currentSignal.signalId;
    // ② 反対ブラケットを arm(実効設定スナップショットを確定)。★新 signalId を1回だけ採番して currentSignal を更新する。
    armed.settings = buildSettingsSnapshot(realizedLcFromArmed(armed), this.cfg.profile);
    // ★遡り解析用(RECORD-ONLY): ドテンの反対建ても「新しい ARM」= ARM 時刻(armed.at=now)と ARM 時点価格を焼き付ける(経路②)。
    if (live != null) armed.armedPrice = live;
    this.state = { ...rev.next, armed };   // ★通過済みレッグを落とした後のブラケットを武装する。
    this.planSuppressedAnchor = null;
    this.signalIdCounter += 1;
    this.persistSignalIdCounter();
    this.currentSignal = armedToCurrentSignal(armed, this.signalIdCounter);
    // ③ 反対建玉は以降 detectFill の交差で filled になる(paper と live が同じタイミング/価格で約定)。
    this.recordExitStopChange(now);
    this.broadcastSignalState(now);
    console.log(`${this.logTag} doten 反転 ${heldDir}→${plan.direction} newSignalId=${this.signalIdCounter} `
      + `P決済pnl=${Math.round(rev.recorded.pnl)}`);
    return 'doten';
  }

  /** テスト用: filled 状態(建玉+現在シグナル)を直接セットする(ドテン反映の単体テスト用)。
   *  実運用の ARM 後と同じく signalIdCounter を現在シグナルの signalId に揃える(次の採番=signalId+1)。 */
  _setFilledForTest(position: OpenPosition, signal: CurrentSignal): void {
    this.state = { phase: 'filled', position };
    this.currentSignal = signal;
    this.signalIdCounter = signal.signalId;
  }

  /** テスト用: held-eval の要求ゲートを叩き、in-flight(planning)になったか(=要求したか)を返す。
   *  OFF/非filled/時間外/間隔未達 なら false(planning は変わらない)。 */
  _peekRequestedHeldEval(): boolean { return this.planning; }

  // ─── レンジ再評価(未約定→ブレイク): 移動平均約定所要 + armed 再評価 ────────────

  /** 約定(armed→filled)所要[ms]を移動平均サンプルへ記録(直近 AVG_FILL_SAMPLES 件を保持・古い方から捨てる)。
   *  非有限/非正は無視(壊れた計測を平均に混ぜない)。in-memory のみ(SSE/DB は不変=byte 一致)。 */
  private recordFillDuration(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.fillDurations.push(ms);
    if (this.fillDurations.length > AVG_FILL_SAMPLES) this.fillDurations.shift();
  }

  /** 現在の移動平均約定所要[ms]。サンプルが MIN_SAMPLES 未満は DEFAULT_AVG_FILL_MS(フォールバック既定)。 */
  private avgFillMs(): number {
    return computeAvgFillMs(this.fillDurations, { min: MIN_SAMPLES, def: DEFAULT_AVG_FILL_MS });
  }

  /** テスト用: 現在の移動平均約定所要[ms]を覗く。 */
  _peekAvgFillMs(): number { return this.avgFillMs(); }

  /** テスト用: armed 状態(+現在シグナル)を直接セットする(レンジ再評価の単体テスト用)。 */
  _setArmedForTest(armed: ArmedBracket, signal?: CurrentSignal): void {
    this.state = { phase: 'armed', armed };
    if (signal) { this.currentSignal = signal; this.signalIdCounter = signal.signalId; }
  }

  // 非公開: ARMED のレンジ両指値(fade)が平均約定所要を超えて未約定なら、AI に「両逆指値(ブレイク)へ切替えるか」を問う。
  //   in-flight(planning)を flat-plan / held-eval と共有し(同時に AI を叩かない)、inPollWindow でゲートし、
  //   held-eval と同じ長間隔でクールダウンする。★async 同一性再チェック: 要求時に armed 識別(at+signalId+mode)を控え、
  //   AI 応答解決時に「まだ同じ未約定 armed」でなければ破棄する(約定/取消/差替え済みなら幽霊差替えしない)。
  //   ★A のみ(maintainsCurrentSignal): B は currentSignal を持たない=差替え(新 signalId 采番)ができない=走らせない(byte 不変)。
  private maybeRequestRangeReeval(now: number): void {
    if (!this.cfg.maintainsCurrentSignal) return;   // B は差替えしない(currentSignal を持たない)。
    if (this.planning) return;                       // flat-plan / held-eval と in-flight を共有。
    if (!inPollWindow(now)) return;                  // 取引時間外は要求しない。
    if (now - this.lastRangeReevalAt < this.heldEvalIntervalMs) return;   // クールダウン(過度な差替え抑制)。
    if (this.state.phase !== 'armed' || !this.state.armed) return;
    const armed = this.state.armed;
    const enabled = resolveScalpRangeReevalEnabled(this.cfg.profile);
    const avgMs = this.avgFillMs();
    if (!shouldRangeReeval({
      enabled, phase: this.state.phase, mode: armed.mode, bothLegsLimit: bothRangeLegsLimit(armed),
      armedAtMs: armed.at, nowMs: now, avgFillMs: avgMs, factor: REEVAL_FACTOR, capMs: REEVAL_CAP_MS,
    })) return;
    // ★評価対象の armed 識別を控える(解決時の同一性再チェック用)。
    const identity: ArmedIdentity = { armedAt: armed.at, signalId: this.currentSignal?.signalId, mode: armed.mode };
    const ageMs = now - armed.at;
    this.planning = true;   // flat-plan / held-eval と共有(以降 新規要求しない)。
    this.lastRangeReevalAt = now;
    void (async () => {
      try {
        const { runScalpPlanWithChart } = await import('../llm/scalpPlanRunner.js');
        // armed-context(§3)を注入して「ブレイク切替 / 現状維持 / none」を AI に問う(profile で A/B の設定を解決)。
        const result = await runScalpPlanWithChart({ profile: this.cfg.profile, armedContext: { mode: 'range-fade', ageMs, avgMs } });
        const nowR = Date.now();
        // ★ゲート(stale plan veto)の判定は新鮮な live 価格のみ。取れない/stale は null=素通し
        //   (要求時価格へのフォールバックはしない=古い価格でレッグを落とさない)。
        this.applyRangeReevalResult(result, identity, nowR, this.livePrice());
      } catch (e) {
        console.warn(`${this.logTag} range-reeval request failed:`, e instanceof Error ? e.message : String(e));
      } finally {
        this.planning = false;
      }
    })();
  }

  /** ★レンジ再評価の反映(AI 応答の解決)。同一性再チェック → checkSanity → 差替え/取消/維持 を判定する。
   *  - stale: 解決までに約定/取消/差替え済み(同一 armed でない・signalId 不一致)なら破棄。
   *  - reject: LLM 失敗 / サニティ不通過 / plan→armed 不能 → 現状維持(何もしない)。
   *  - cancel: direction:none → armed を取消して FLAT(armed-timeout と同型・currentSignal は保持し trade2 の stale 追従に委ねる)。
   *  - keep: AI が実質同じ fade を返した → 何もしない(維持)。
   *  - swap: 妥当かつ現行と異なる新ブラケット(ブレイク両逆指値 等)→ 新 signalId を1回采番して armed を差替え・currentSignal 更新・broadcast。
   *  ★_ 接頭辞: async 経路から呼ぶ内部メソッドだが、単体テストからも直接叩けるよう公開する(applyHeldEvalResult と同方針)。
   *  live = stale plan veto の判定に使う「新鮮な」live 価格(null=取得不能/stale=判定せず素通し=従来どおり差替え)。 */
  applyRangeReevalResult(result: ScalpPlanResult, identity: ArmedIdentity, now: number, live: number | null): 'swap' | 'cancel' | 'keep' | 'stale' | 'reject' {
    if (!sameArmedBracket(this.state, identity)) return 'stale';
    if (this.currentSignal?.signalId !== identity.signalId) return 'stale';
    if (!result.ok) return 'reject';
    const plan = result.plan;
    const cur = this.state.armed!;
    const ageMin = Math.round((now - identity.armedAt) / 60_000);
    const avgMin = Math.round(this.avgFillMs() / 60_000);
    if (plan.direction === 'none') {
      // 場面崩れ → 未約定レンジを取消して FLAT。
      // ★lastExitedSignalId を立てる(armed-timeout 経路と同型)。これが無いと trade2 の resync トリガー
      //   (lastExitedSignalId===S / currentSignal.signalId>tracked)がどちらも成立せず、旧両指値が取り消されず
      //   レンジ抜け時に stale 指値が誤約定する(エバリュ HIGH 指摘)。currentSignal は保持し trade2 に取消追従させる。
      this.lastExitedSignalId = identity.signalId;
      this.state = { phase: 'flat', lastExit: this.state.lastExit };
      this.planSuppressedAnchor = null;
      this.broadcastSignalState(now);
      console.log(`${this.logTag} range-reeval cancel(none) oldSignalId=${identity.signalId} age=${ageMin}m avg=${avgMin}m`);
      return 'cancel';
    }
    // 妥当性(trade2 と同一の checkSanity/checkRangeSanity)。不通過は現状維持(差替えない)。
    const sanity = checkSanity(plan, plan.refPrice);
    if (!sanity.ok) return 'reject';
    // ★作業2(refPrice 鮮度・ARM 経路③): 計画時価格が ARM 時 live からかけ離れていたら差替えない(現状維持)。
    const drift = checkRefDrift(plan.refPrice, live);
    if (!drift.ok) {
      console.log(`${this.logTag} reeval-reject ${drift.reason} ref=${Math.round(plan.refPrice)} reason=refstale`);
      return 'reject';
    }
    const armed0 = planToArmed(plan, now, { vetoFired: result.vetoFired });
    if (!armed0) return 'reject';
    if (sameBracketShape(cur, armed0)) return 'keep';   // 実質同じ fade(=反発継続の維持)→ 何もしない。
    // ★stale plan veto(差替え先にも同一規約で適用): ARM 時点の live 価格でもう通過しているレッグは武装しない。
    //   全レッグ通過済みなら差替えない(reject=現状維持)。まだ engine 状態は未変更なのでそのまま降りれば無害。
    const stale = checkStaleLegs(armed0, live);
    if (stale.legs.some(l => l.stale)) this.logStaleLegs('reeval-stale', plan.direction, plan.refPrice, live, stale.legs);
    if (!stale.armed) return 'reject';
    const armed = stale.armed;
    // ★作業1(単レッグ化の再検証・ARM 経路③): 脚が落ちた後の形を ARM 時 live 価格で再検証する。
    //   まだ engine 状態は未変更なので、落ちればそのまま現状維持=無害。
    //   ★脚が落ちた時だけ(armed !== armed0)。理由は flat 経路の同じ注記を参照。
    if (armed !== armed0) {
      const recheck = recheckArmedSanity(armed, plan.refPrice, live);
      if (!recheck.ok) {
        console.log(`${this.logTag} reeval-reject ${recheck.reason} ref=${Math.round(plan.refPrice)} reason=recheck`);
        return 'reject';
      }
    }
    // 差替え: 実効設定スナップショットを確定 → armed 差替え → 新 signalId を1回采番 → currentSignal 更新 → broadcast。
    armed.settings = buildSettingsSnapshot(realizedLcFromArmed(armed), this.cfg.profile);
    // ★遡り解析用(RECORD-ONLY): 差替えは「新しい ARM」= 新 armed の at(=now)と ARM 時点価格を焼き付ける(経路③)。
    //   古い armed の時刻/価格は引き継がない(armed0 は planToArmed で新規生成=旧値は載っていない)。
    if (live != null) armed.armedPrice = live;
    this.state = { phase: 'armed', armed, lastExit: this.state.lastExit };
    this.planSuppressedAnchor = null;
    const oldSignalId = identity.signalId;
    this.signalIdCounter += 1;
    this.persistSignalIdCounter();
    this.currentSignal = armedToCurrentSignal(armed, this.signalIdCounter);
    this.broadcastSignalState(now);
    console.log(`${this.logTag} range-reeval swap oldSignalId=${oldSignalId} newSignalId=${this.signalIdCounter} `
      + `age=${ageMin}m avg=${avgMin}m mode=${armed.mode ?? 'directional'}`);
    return 'swap';
  }

  // 非公開: 現在の state + (A のみ)currentSignal から SSE state を組み立てて broadcast(前回と同一 JSON なら抑止)。
  private broadcastSignalState(now: number): void {
    const price = getPrices().find(p => p.symbol === NIKKEI_SYMBOL)?.price ?? null;
    const s = toSignalTradeState(this.state, price, now, this.signalForState(), this.lastExitedSignalId, this.armedTimeouts);
    const json = JSON.stringify(s);
    if (json !== this.lastBroadcastJson) {
      this.lastBroadcastJson = json;
      broadcast({ type: this.cfg.broadcastType, payload: s });
    }
  }

  /** priceLoop から毎 tick 呼ぶ。現在値で遷移を進め、決済を記録し、必要なら次プランを要求し、
   *  state を SSE broadcast する。エンジン未起動時は何もしない(既存 SSE を汚さない)。 */
  feed(price: number, now: number): void {
    if (!this.running) return;
    try {
      // ★レンジ再評価: 約定(armed→filled)所要を測るため、遷移前の armed 武装時刻を控える(advance は不変=純関数)。
      const prevPhase = this.state.phase;
      const prevArmedAt = this.state.armed?.at;
      const prevArmed = this.state.armed;   // ★未約定失効の診断ログ用(advance 後は消えるのでここで控える)。
      const { next, recorded, armedTimedOut } = advance(this.state, price, now);
      this.state = next;
      // ★fill latency: armed→filled に遷移したら position.at−armed.at を移動平均サンプルへ記録(平均約定所要=再評価閾値の元)。
      if (prevPhase === 'armed' && next.phase === 'filled' && next.position && prevArmedAt != null) {
        this.recordFillDuration(next.position.at - prevArmedAt);
      }
      if (armedTimedOut) {
        // ★未約定ブラケットの取消。以降 phase=flat で maybeRequestPlan が再計画できる(固着解除)。
        // ★作業3(無音の失敗を潰す): 件数を永続カウンタに刻み、SSE へ載せ、**なぜ届かなかったか** を1行で残す。
        //   monitor が武装 → trade2 が受信後ずっと拒否 → 15分で黙って失効、という乖離の終着点がここ。
        //   実測 sid=361(2026-07-30 23:45)は trade2 が6秒おきに147回拒否したのに、monitor 側にも trade2 側にも
        //   警告もカウンタも一切無かった。ログには「各レッグが現在値からどれだけ離れていたか」を必ず添える。
        this.recordArmedTimeout(now);
        const legDesc: string[] = [];
        const dist = (v: number): string => `${Math.round(v)}(現値差${Math.round(Math.abs(v - price))}円)`;
        if (prevArmed?.limitEntry != null) legDesc.push(`limit=${dist(prevArmed.limitEntry)}`);
        if (prevArmed?.stopEntry != null) legDesc.push(`stop=${dist(prevArmed.stopEntry)}`);
        if (prevArmed?.range?.upper) legDesc.push(`upper=${dist(prevArmed.range.upper.entry)}`);
        if (prevArmed?.range?.lower) legDesc.push(`lower=${dist(prevArmed.range.lower.entry)}`);
        console.log(`${this.logTag} armed-timeout 未約定ブラケットを取消→FLAT`
          + `(${Math.round(ARMED_TIMEOUT_MS / 60_000)}分 未約定・再計画へ) `
          + `signalId=${this.currentSignal?.signalId ?? '-'} dir=${prevArmed?.direction ?? '-'} `
          + `armedPrice=${prevArmed?.armedPrice != null ? Math.round(prevArmed.armedPrice) : '-'} `
          + `price=${Math.round(price)} ${legDesc.join(' ') || '(レッグ不明)'} `
          + `累計未約定失効=${this.armedTimeouts.count}回`);
      }
      if (recorded) {
        this.persistTrade(recorded);
        // 決済(filled→flat)= 全建玉クローズ。クールダウン起点を記録し、ログ抑止を解除(次tickで一度出す)。
        this.lastSignalExitAt = now;
        this.cooldownLogged = false;
        // ★決済したシグナルの signalId を捕捉(A のみ・trade2 の即時再同期用)。filled 中は currentSignal が
        //   そのエントリーの ARM 采番を保持している=この時点で読めば「今抜けた建玉の signalId」。次の決済まで保持。
        //   B は currentSignal を持たない(null)ので変化なし=B の SSE JSON は不変(dedupe 維持)。
        if (this.currentSignal) this.lastExitedSignalId = this.currentSignal.signalId;
      }
      // ★検証用(RECORD-ONLY): 決済逆指値が変化していれば signal_exit_stops へ1行記録(変化時のみ・A のみ)。
      //   state 更新後・broadcast 前に評価。決済ロジック/SSE には影響しない(追加の DB 書込のみ)。
      this.recordExitStopChange(now);
      this.maybeRequestPlan(price, now);
      this.maybeRequestHeldEval(price, now);   // ★ドテン: filled かつ dotenEnabled のとき保有中の反転評価を要求(既定OFF=no-op)。
      this.maybeRequestRangeReeval(now);   // ★レンジ再評価: armed かつ レンジ両指値が平均超過未約定のとき ブレイク切替評価を要求(非レンジ/既定OFF=no-op)。
      this.heartbeat(now);   // ★診断: 定期にエンジン状態を1行ログ(固着の早期発見)。
      this.broadcastSignalState(now);
    } catch (e) {
      console.warn(`${this.logTag} tick error:`, e instanceof Error ? e.message : String(e));
    }
  }

  /** ★診断ログ(HEARTBEAT_MS 毎に1行): 各エンジンの生存と状態を可視化する。固着(armed のまま / planning が
   *  真のまま)を早期に発見できるよう、phase・planning・arm 経過・最終計画からの経過を出す。
   *  例) `[signalTradeB] hb phase=armed planning=false sinceArm=8m lastPlan=8m前 suppressed=false`
   *  → sinceArm が伸び続ける=未約定固着(ARMED_TIMEOUT_MS で自動取消される) / phase=flat かつ planning=true が
   *    続く=計画要求が返らず固着。今回のような無音停止の原因究明を容易にする(通常運用の負荷は無視できる)。 */
  private lastHeartbeatAt = 0;
  private heartbeat(now: number): void {
    if (now - this.lastHeartbeatAt < HEARTBEAT_MS) return;
    this.lastHeartbeatAt = now;
    const phase = this.state.phase;
    const mins = (t: number | undefined | null): string => (t ? `${Math.round((now - t) / 60_000)}m` : '-');
    const sinceArm = phase === 'armed' ? mins(this.state.armed?.at) : '-';
    console.log(`${this.logTag} hb phase=${phase} planning=${this.planning} sinceArm=${sinceArm} `
      + `lastPlan=${mins(this.lastPlanAt)}前 suppressed=${this.planSuppressedAnchor != null}`);
  }
}

// ─── インスタンス: A(実売買・グローバル設定)/ B(紙専用・signalB 設定) ─────────────
// ★A は従来の singleton と同一構成(profile:'A'・system=null・'signalTrade'・currentSignal 露出)=挙動 byte 不変。
const engineA = new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
// B は紙専用: signalB 設定・system='B'・'signalTradeB'・currentSignal を一切持たない(trade2 は B を追わない)。
const engineB = new SignalEngine({ profile: 'B', systemTag: 'B', broadcastType: 'signalTradeB', maintainsCurrentSignal: false });

/** 起動: A と B の両エンジンを有効化(冪等)。A の起動挙動/ログは従来と同一。 */
export async function startSignalEngine(): Promise<void> {
  await engineA.start();
  await engineB.start();
}

export function stopSignalEngine(): void { engineA.stop(); engineB.stop(); }

/** 現在の SSE state(A=実売買)。stream.ts の初回送出 / 各 tick の broadcast 用。外部契約は従来と byte 一致。 */
export function getSignalTradeState(now = Date.now()): SignalTradeState { return engineA.getState(now); }

/** ★v0.8.2: System B(紙専用)の現在 SSE state。signal/hold は含まない(currentSignal を露出しない)。 */
export function getSignalTradeStateB(now = Date.now()): SignalTradeState { return engineB.getState(now); }

/** 現在シグナル(trade2 追従用=A のみ)。まだ ARM していなければ null。表示/連携専用(発注はしない)。 */
export function getCurrentSignal(): CurrentSignal | null { return engineA.getCurrentSignal(); }

/** 現在の phase(flat|armed|filled・A)。trade2 の late-join 用 getter。エンジン挙動は不変(露出のみ)。 */
export function getSignalPhase(): SignalPhase { return engineA.getPhase(); }

/** 保有中の意図(hold・trade2 追従用=A)。filled の間だけ返す(決済逆指値=毎tick算出)。他は null。 */
export function getSignalHold(): SignalHold | null { return engineA.getHold(); }

/** priceLoop から毎 tick 呼ぶ。A と B の両エンジンへ同じ現在値を供給する(A の挙動は不変・B は独立に並走)。 */
export function feedSignalEngine(price: number, now: number): void {
  engineA.feed(price, now);
  engineB.feed(price, now);
}

/** ★履歴消去に合わせて live エンジンの in-memory signalId カウンタを 0 に戻す(次の ARM は 1 から)。
 *  永続側(signal_meta)は clearSignalTrades が 0 化する。route(履歴消去)から両方を協調して呼ぶ。
 *  system: 'A'|'B' で対象系統のみ(未指定=両系統)。B は採番しないので実質 no-op だが対称性のため揃える。 */
export function resetSignalEngineIdCounter(system?: 'A' | 'B'): void {
  if (!system || system === 'A') engineA.resetSignalIdCounter();
  if (!system || system === 'B') engineB.resetSignalIdCounter();
}

/** テスト/リセット用: A エンジン内部状態を初期化する(従来と同一=A の回帰テスト互換)。 */
export function _resetSignalEngine(): void { engineA.reset(); }

/** テスト/リセット用: B エンジン内部状態を初期化する。 */
export function _resetSignalEngineB(): void { engineB.reset(); }
