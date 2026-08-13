// 影の決済模擬エンジン(RECORD-ONLY・分析用)。
//
// ■ 何をするか
//   1つの提案(AiPlan)に対して、**決済パラメータだけを変えた模擬建玉(=影)を並走**させ、
//   「決済設定を変えていたら、このエントリーはどうなっていたか」を1年かけて溜める。
//
// ■ 絶対条件(この模擬が価値を持つための条件)
//   ① 再実装しない — 約定判定・建玉組み立て・スリッページ・決済理由の規約は **本番と同じ関数** を通す。
//      ・planToArmed(plan, now, extra) … AiPlan → ArmedBracket(A と同じ変換。向きガードも同じ)
//      ・advance(st, price, now, { exitFn }) … 1tick の遷移そのもの(内部で detectFill を使う)
//      ・detectFill(armed, price) … 「どちらのレッグで約定したか」のラベル付け(checkStaleLegs と同じ流儀で
//        条件を書き写さず **同じ関数に問う**)
//      ・spec.exit(=非公開の computeExitStopWith(cfg, s))… 床だけをパラメータで差し替える
//      過去のバックテスト群(scripts/*.mts)が本番コードを import せず再実装したために 9年分の検証結果に
//      留保が付いた。同じ轍を踏むと、1年かけて溜めたデータの価値が落ちる。
//   ② グローバル状態を経由しない — _setExitImpl は使わない(影の計算中に実建玉の逆指値が影のパラメータで
//      算出される競合を作る)。各 spec の exit は自分の cfg を閉じ込めた純関数で、advance へ **引数で** 渡す。
//   ③ 右側打ち切り(censoring)— 地平に達した影は「決済した」ことにしない。censored=true と、
//      打ち切り時点の含み損益 / MFE / MAE / 経過時間を記録する。**観測できなかった と 終わった を混ぜない。**
//   ④ 実取引に触れない・遅らせない — このモジュールは **DB を一切触らない**(行はバッファに積むだけ)。
//      例外は各 set の内側で握り潰して隔離する。影の本数には上限があり、超えたら **拒否**(無音で間引かない)。
//   ⑤ ライブ / オフライン再生で同じコード — 価格は feed(price, now) で外から供給する。供給元が
//      ライブの tick でも保管済み tick でも、このモジュールの計算は同一。

import {
  advance, detectFill, planToArmed, unrealizedPt,
  type ArmedBracket, type EngineState, type RecordedTrade,
} from '../decisions.js';
import {
  getShadowExitLadder,
  type ShadowExitLadder, type ShadowExitSpec, type ShadowParamClass,
} from '../exit/index.js';
import type { ExitReason } from '../../../core/exitReasons.js';
import { isAnalysisEnabled } from '../../analysisGate.js';

/** 観測地平[ms]。**この時間を過ぎた影は「決済した」ことにせず、打ち切り(censored)として記録する。**
 *
 *  ★480分(8時間)にした理由:
 *    - 固定の短い地平で切ると **床が緩い設定ほど保有が長い** ため、測ろうとしている軸に沿って
 *      選択的に不利になる(打ち切りバイアス)。だから「大半の影が自然に終わる」長さが要る。
 *    - 仮想取引エンジンには引け決済が無く建玉は翌場へ持ち越す(実績の最長保有=206分)。ただし 206分は
 *      **現行(=この格子で最も締まった側)の床** での実績なので、床を緩めた影はもっと長く生きうる。
 *      指示の下限 240分では、緩い設定ほど打ち切りが増えるという まさにそのバイアスが残る。
 *    - 日中場は 08:45–15:45 の7時間。480分あれば「寄りで建てて引けまで持ち越した」影も自然終端しうる。
 *    - 上限が要る理由(無限にしない): 影は本数×tick で CPU/メモリを食い、かつ「いつまでも終わらない行」は
 *      分析時に母集団が定義できない。地平は **全 spec 共通** なので、spec 間の比較は歪まない。 */
export const SHADOW_HORIZON_MS = 480 * 60_000;

/** 同時に生かせる影の上限[本]。超える提案は **拒否**(部分的に間引くと母集団が spec 依存で歪む)。
 *  512本 = ラダー約30本 × 提案17件ぶん。ARMED_TIMEOUT_MS(15分)と地平480分から、
 *  同時に生きうる提案の世代は最大でも 480/15+1 ≒ 33 だが、実際の提案間隔はもっと長い。 */
export const MAX_OPEN_SHADOWS = 512;

/** 影の供給元。'generator'=分析用の分析用 / 'live-A'=実取引系 A が実際に武装した提案。 */
export type ShadowSource = 'generator' | 'live-A';

/** 影の終わり方。★'censored' は「終わった」ではなく「**観測を打ち切った**」。 */
export type ShadowOutcome =
  | 'exit'            // 決済した(初期LC or ラチェット床)
  | 'armed_timeout'   // 未約定のままブラケットが失効した(A と同じ ARMED_TIMEOUT_MS の規約)
  | 'censored';       // 右側打ち切り(観測できなかった)

/** 打ち切りの理由。'horizon'=地平に達した / 'ticks_exhausted'=価格の供給が尽きた(再生終了・停止)。 */
export type ShadowCensorReason = 'horizon' | 'ticks_exhausted';

/** 影1本の結末(専用DBの1行になる)。列は最初から全部持たせる(後から足すと期の境界が曖昧になる)。 */
export interface ShadowRow {
  /** 分析用の設定版。name↔決済パラメータの対応はこの版の中でだけ意味を持つ。 */
  epoch: string;
  source: ShadowSource;
  /** 提案の識別子(live-A は signalId・分析用は分析用の採番)。同じ提案の影は同じ値を共有する。 */
  proposalId: string;
  /** 決済仕様の名前(不透明な識別子。**数値は含まない**)。 */
  spec: string;
  paramClass: ShadowParamClass;
  dir: 'buy' | 'sell';
  armedT: number;
  armedPrice: number | null;
  entryT: number | null;
  entryPrice: number | null;
  entryLeg: 'limit' | 'stop' | null;
  initialStop: number | null;
  exitT: number | null;
  exitPrice: number | null;
  exitReason: ExitReason | null;
  pnl: number | null;
  outcome: ShadowOutcome;
  /** 右側打ち切りか。true の行は「決済していない」= 損益(pnl)は無く、含み損益(unrealized)だけがある。 */
  censored: boolean;
  censorReason: ShadowCensorReason | null;
  /** 打ち切り時点の含み損益[pt]。決済/未約定失効の行は null。 */
  unrealized: number | null;
  /** 約定後に観測した最大の含み益[pt](MFE)/ 最小の含み損益[pt](MAE・0以下)。未約定は null。 */
  mfe: number | null;
  mae: number | null;
  /** 終端時点の含み益ピーク[pt](= 床の段を決めていた値)。未約定は null。 */
  peakProfit: number | null;
  /** 約定 → 終端 の経過[ms]。未約定は null。 */
  holdMs: number | null;
  /** 武装 → 終端 の経過[ms]。 */
  elapsedMs: number;
  horizonMs: number;
  /** この影の提案を開いた時点で同時に生きていた影の本数(自分たちを含む)。 */
  concurrent: number;
  /** この影に供給された tick 数(データ欠損の自己診断用。0 なら価格が来ていない)。 */
  ticks: number;
  createdAt: number;
}

/** planToArmed が受け取れる提案の形(= AiPlan の部分集合)。新しい語彙は作らない。 */
export type ShadowPlan = Parameters<typeof planToArmed>[0];

export interface ShadowOpenArgs {
  proposalId: string;
  source: ShadowSource;
  plan: ShadowPlan;
  /** 武装時刻(= planToArmed に渡す now)。 */
  now: number;
  /** 武装時点で見ていた価格(記録専用・取れなければ省略)。 */
  armedPrice?: number | null;
  extra?: { vetoFired?: boolean };
}

export type ShadowOpenResult =
  | { ok: true; opened: number; specs: string[] }
  | { ok: false; reason: 'no-specs' | 'not-directional' | 'duplicate' | 'capacity'; detail: string };

// ─── 影1本 ────────────────────────────────────────────────────────────────

class ShadowLeg {
  private state: EngineState;
  private done = false;
  private ticks = 0;
  private lastT: number | null = null;
  private lastPrice: number | null = null;
  private entryT: number | null = null;
  private entryPrice: number | null = null;
  private entryLeg: 'limit' | 'stop' | null = null;
  private initialStop: number | null = null;
  private mfe: number | null = null;
  private mae: number | null = null;
  private peakProfit: number | null = null;

  constructor(
    private readonly spec: ShadowExitSpec,
    private readonly armed: ArmedBracket,
    private readonly meta: { epoch: string; source: ShadowSource; proposalId: string; armedPrice: number | null; concurrent: number; horizonMs: number },
  ) {
    this.state = { phase: 'armed', armed };
  }

  get isDone(): boolean { return this.done; }

  /** 1tick 進める。終端したらその行を返す(以後は何もしない)。 */
  step(price: number, now: number): ShadowRow | null {
    if (this.done) return null;
    // ★地平の判定は **advance より前**。地平を越えた tick を処理してしまうと、観測窓の外で起きた決済を
    //   「決済した」として記録することになる(打ち切りを決済に混ぜる=その1件は嘘のデータになる)。
    if (now - this.armed.at >= this.meta.horizonMs) return this.censor('horizon');
    this.ticks += 1;
    const prevPhase = this.state.phase;
    const prevArmed = this.state.armed;
    // ★本番と同じ遷移関数。違うのは **exitFn(床のパラメータ)だけ**。
    const r = advance(this.state, price, now, { exitFn: this.spec.exit });
    this.state = r.next;
    if (prevPhase === 'armed' && r.next.phase === 'filled' && r.next.position && prevArmed) {
      const pos = r.next.position;
      // ★どちらのレッグで約定したかのラベル付け(記録専用)。約定判定そのものは advance の中の detectFill。
      //   ここでも条件を書き写さず **同じ detectFill に問う**(checkStaleLegs と同じ流儀)。
      const f = detectFill(prevArmed, price);
      this.entryLeg = f ? f.leg : null;
      this.entryT = pos.at;
      this.entryPrice = pos.entryPrice;
      this.initialStop = pos.initialStop;
    }
    const pos = r.next.position;
    if (pos) {
      const u = unrealizedPt(pos.direction, pos.entryPrice, price);
      this.mfe = this.mfe == null ? u : Math.max(this.mfe, u);
      this.mae = this.mae == null ? u : Math.min(this.mae, u);
      this.peakProfit = pos.peakProfit;
    }
    this.lastT = now;
    this.lastPrice = price;
    if (r.armedTimedOut) return this.finishArmedTimeout(now);
    if (r.recorded) return this.finishExit(r.recorded);
    return null;
  }

  /** 価格の供給が尽きた(再生終了・停止)。生きている影は **打ち切り** として閉じる。 */
  closeCensored(reason: ShadowCensorReason): ShadowRow | null {
    if (this.done) return null;
    return this.censor(reason);
  }

  private base(outcome: ShadowOutcome, endT: number): ShadowRow {
    return {
      epoch: this.meta.epoch,
      source: this.meta.source,
      proposalId: this.meta.proposalId,
      spec: this.spec.name,
      paramClass: this.spec.paramClass,
      dir: this.armed.direction,
      armedT: this.armed.at,
      armedPrice: this.meta.armedPrice,
      entryT: this.entryT,
      entryPrice: this.entryPrice,
      entryLeg: this.entryLeg,
      initialStop: this.initialStop,
      exitT: null, exitPrice: null, exitReason: null, pnl: null,
      outcome,
      censored: outcome === 'censored',
      censorReason: null,
      unrealized: null,
      mfe: this.mfe, mae: this.mae, peakProfit: this.peakProfit,
      holdMs: this.entryT != null ? endT - this.entryT : null,
      elapsedMs: endT - this.armed.at,
      horizonMs: this.meta.horizonMs,
      concurrent: this.meta.concurrent,
      ticks: this.ticks,
      createdAt: endT,
    };
  }

  private censor(reason: ShadowCensorReason): ShadowRow {
    this.done = true;
    // 観測の終わりは **最後に処理した tick**(地平を越えた tick は処理していないので、その値は使わない)。
    const endT = this.lastT ?? this.armed.at;
    const row = this.base('censored', endT);
    row.censorReason = reason;
    const pos = this.state.position;
    if (pos && this.lastPrice != null) {
      row.unrealized = unrealizedPt(pos.direction, pos.entryPrice, this.lastPrice);
    }
    return row;
  }

  private finishArmedTimeout(now: number): ShadowRow {
    this.done = true;
    return this.base('armed_timeout', now);
  }

  private finishExit(rec: RecordedTrade): ShadowRow {
    this.done = true;
    const row = this.base('exit', rec.exitT);
    row.exitT = rec.exitT;
    row.exitPrice = rec.exitPrice;
    row.exitReason = rec.exitReason;
    row.pnl = rec.pnl;
    row.peakProfit = rec.peakProfit;
    row.initialStop = rec.exitInitialStop;
    return row;
  }
}

// ─── 1提案ぶんの影の束 ─────────────────────────────────────────────────────

class ShadowSet {
  private legs: ShadowLeg[];

  constructor(
    readonly proposalId: string,
    readonly armed: ArmedBracket,
    specs: readonly ShadowExitSpec[],
    meta: { epoch: string; source: ShadowSource; armedPrice: number | null; concurrent: number; horizonMs: number },
  ) {
    this.legs = specs.map(s => new ShadowLeg(s, armed, { ...meta, proposalId }));
  }

  get openCount(): number { return this.legs.length; }
  get isEmpty(): boolean { return this.legs.length === 0; }

  feed(price: number, now: number): ShadowRow[] {
    const rows: ShadowRow[] = [];
    const alive: ShadowLeg[] = [];
    for (const leg of this.legs) {
      const row = leg.step(price, now);
      if (row) rows.push(row); else alive.push(leg);
    }
    this.legs = alive;
    return rows;
  }

  closeAll(reason: ShadowCensorReason): ShadowRow[] {
    const rows: ShadowRow[] = [];
    for (const leg of this.legs) {
      const row = leg.closeCensored(reason);
      if (row) rows.push(row);
    }
    this.legs = [];
    return rows;
  }
}

// ─── 影の束の管理(上限・バッファ・例外隔離) ────────────────────────────────

export interface ShadowSimOptions {
  /** 決済仕様の一覧を返す関数(既定=非公開ラダー)。**オフライン再生でも同じ関数を渡せば同じ結果になる。** */
  ladder?: () => ShadowExitLadder;
  horizonMs?: number;
  maxOpenShadows?: number;
  log?: (msg: string) => void;
}

export interface ShadowSimStats {
  openSets: number;
  openShadows: number;
  bufferedRows: number;
  openedShadows: number;
  finishedRows: number;
  rejectedProposals: number;
  errors: number;
}

/** バッファがこの件数を超えたら警告する(フラッシュが止まっていることの自己診断)。 */
const BUFFER_WARN_ROWS = 5_000;

export class ShadowSim {
  private sets: ShadowSet[] = [];
  private rows: ShadowRow[] = [];
  private readonly ladder: () => ShadowExitLadder;
  private readonly horizonMs: number;
  private readonly maxOpen: number;
  private readonly log: (msg: string) => void;
  private counters = { opened: 0, finished: 0, rejected: 0, errors: 0 };
  private bufferWarned = false;

  /** ★公開版(lite)では **入口を閉じる**(分析専用の機構なので構築させない)。
   *  現時点でこのクラスは取引経路から配線されていないため lite が今日壊れることは無い。
   *  将来うっかり配線されたときに、公開版で黙って模擬が回り続けるより開発中に落ちる方が良い。 */
  constructor(opts: ShadowSimOptions = {}) {
    if (!isAnalysisEnabled()) {
      throw new Error('影の決済模擬は分析専用です(公開版では構築できません) — server/analysisGate.ts');
    }
    this.ladder = opts.ladder ?? getShadowExitLadder;
    this.horizonMs = opts.horizonMs ?? SHADOW_HORIZON_MS;
    this.maxOpen = opts.maxOpenShadows ?? MAX_OPEN_SHADOWS;
    this.log = opts.log ?? ((m: string) => console.log(`[shadow] ${m}`));
  }

  get openShadows(): number { return this.sets.reduce((n, s) => n + s.openCount, 0); }

  /** 提案1件ぶんの影を開く。
   *  ★directional のみ。レンジ建玉は固定LC+節目手前TPで **ラチェットを使わない** ので影を作る意味がない。
   *  ★上限を超えたら **提案ごと拒否** する(一部の spec だけ開くと、母集団が spec に依存して歪む)。 */
  open(args: ShadowOpenArgs): ShadowOpenResult {
    const { epoch, specs } = this.ladder();
    if (specs.length === 0) {
      this.counters.rejected += 1;
      this.log(`open 拒否 proposal=${args.proposalId} 理由=決済仕様が0件(非公開ラダー未読込)`);
      return { ok: false, reason: 'no-specs', detail: '決済仕様が0件' };
    }
    if (this.sets.some(s => s.proposalId === args.proposalId)) {
      this.counters.rejected += 1;
      this.log(`open 拒否 proposal=${args.proposalId} 理由=同じ proposalId の影が生存中`);
      return { ok: false, reason: 'duplicate', detail: '同じ proposalId が生存中' };
    }
    // ★A と同じ変換関数。向きガード(損切りがエントリーの正しい外側か)も同じものが効く。
    const armed = planToArmed(args.plan, args.now, args.extra);
    if (!armed || armed.mode === 'range' || armed.range != null) {
      this.counters.rejected += 1;
      return { ok: false, reason: 'not-directional', detail: armed ? 'range は対象外' : 'armed にならない計画' };
    }
    const open = this.openShadows;
    if (open + specs.length > this.maxOpen) {
      this.counters.rejected += 1;
      this.log(`open 拒否 proposal=${args.proposalId} 理由=上限超過 open=${open}+${specs.length} > ${this.maxOpen}`);
      return { ok: false, reason: 'capacity', detail: `上限 ${this.maxOpen} 本を超える` };
    }
    const armedPrice = Number.isFinite(args.armedPrice as number) ? (args.armedPrice as number) : null;
    this.sets.push(new ShadowSet(args.proposalId, armed, specs, {
      epoch, source: args.source, armedPrice,
      concurrent: open + specs.length,
      horizonMs: this.horizonMs,
    }));
    this.counters.opened += specs.length;
    return { ok: true, opened: specs.length, specs: specs.map(s => s.name) };
  }

  /** 価格を1tick 供給する。**DB は触らない**(行はバッファに積むだけ)。
   *  ★例外は set 単位で隔離する。取引経路から呼ばれても、影の不具合が A の決済を止めてはならない。 */
  feed(price: number, now: number): void {
    if (this.sets.length === 0) return;
    if (!Number.isFinite(price) || !Number.isFinite(now)) return;
    const alive: ShadowSet[] = [];
    for (const set of this.sets) {
      try {
        const rows = set.feed(price, now);
        if (rows.length > 0) this.pushRows(rows);
      } catch (e) {
        // 壊れた set は閉じる(残しても同じ例外を毎tick出し続ける)。件数は必ず数える=無音にしない。
        this.counters.errors += 1;
        this.log(`feed 例外 proposal=${set.proposalId}: ${e instanceof Error ? e.message : String(e)}`);
        try { this.pushRows(set.closeAll('ticks_exhausted')); } catch { /* ignore */ }
        continue;
      }
      if (!set.isEmpty) alive.push(set);
    }
    this.sets = alive;
  }

  /** 生きている影をすべて **打ち切り** として閉じる(再生終了 / プロセス停止)。 */
  closeAll(reason: ShadowCensorReason = 'ticks_exhausted'): void {
    for (const set of this.sets) {
      try { this.pushRows(set.closeAll(reason)); } catch { this.counters.errors += 1; }
    }
    this.sets = [];
  }

  /** 溜まった行を取り出して空にする(呼び出し側が別途 DB へフラッシュする)。 */
  drainRows(): ShadowRow[] {
    const out = this.rows;
    this.rows = [];
    this.bufferWarned = false;
    return out;
  }

  stats(): ShadowSimStats {
    return {
      openSets: this.sets.length,
      openShadows: this.openShadows,
      bufferedRows: this.rows.length,
      openedShadows: this.counters.opened,
      finishedRows: this.counters.finished,
      rejectedProposals: this.counters.rejected,
      errors: this.counters.errors,
    };
  }

  private pushRows(rows: ShadowRow[]): void {
    if (rows.length === 0) return;
    this.rows.push(...rows);
    this.counters.finished += rows.length;
    if (!this.bufferWarned && this.rows.length > BUFFER_WARN_ROWS) {
      this.bufferWarned = true;
      this.log(`警告: 未フラッシュの行が ${this.rows.length} 件(フラッシュが止まっている可能性)`);
    }
  }
}
