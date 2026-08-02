// ─── 生成器ゲート(backpressure + 日次予算 + default への従属) ─────────────
//
// 「提案生成器」(分析用・別プロセス・2分間隔でチャート画像つき LLM を叩く)が、実弾(A)の経路を
// 劣化させないための最後の関門。**caller==='generator' のときだけ**効く。
// caller 省略/'default' の経路はこのモジュールを一切通らない(byte 不変)。
//
// 3つの停止理由(いずれも「黙って縮退」せず、**止まって・記録する**):
//   busy            … 作業3: 生成中(A/B のプラン生成 or 別の生成器要求)なら生成器は 429 で弾く。
//                     生成器からは A/B の起動条件(lastPlanAt+flat+抑止アンカーの合成)が見えない=
//                     サーバ側にしか判断材料がないため、ここで判定する。
//   budget          … 作業4-1: 生成器だけの日次予算。上限到達で **停止**。
//                     ★モードを書き換えたり無音で縮退したりしない(「上限50回で無音の dryrun 化」が
//                       保護注文を消した過去の事故と同じ轍を踏まない)。
//   default-quota   … 作業4-2(★従属規則): default プールが quota(429/枯渇)を踏んだら、
//                     生成器は **A のポーズが明けるまで停止**。自分の429ではなく **A の429で止まる**。
//                     同一APIキーだと上流のクォータは共有されたままなので、プール分離だけでは足りない。
//                     「実験系は本番の枠を食い残さない」を実装するとこうなる。
//                     ★停止は **時限**(セッション単位ではない)。理由は下の HALT の節。
//
// 状態はプロセス内メモリ(providers.ts の circuitOpenUntil と同じ寿命)。再起動でリセットされる。

import { classifySession } from '../../core/session.js';
import { resolveGeneratorDailyBudget } from '../configStore.js';
import { DEFAULT_EXIT_VARIANT, type ExitVariant } from '../signalTrade/exit/index.js';

/** 予算/従属停止のリセット境界。取引セッション(core/session の SSOT)で刻む。
 *  - dayKey     = sessionDate。Day D と Night D は同じ D = **同一取引日** → 日次予算の単位。
 *  - sessionKey = `${sessionDate}|${session}` → 従属停止(「そのセッションの残り」)の単位。
 *  取引時間外(セッション外)は **直前のセッションのキーを保持**(sticky)する。
 *  こうすると 15:45〜17:00 の空白帯や週末で予算がリセットされる抜け穴ができず、
 *  かつ core/session の内部日付関数を再実装(=知識の複製)せずに済む。 */
interface Keys { dayKey: string; sessionKey: string; }

const BOOT_KEYS: Keys = { dayKey: '(boot)', sessionKey: '(boot)' };

// ─── ★予算の単位は「腕(arm)」 ────────────────────────────────────────────────
//
// 実験は「同じ相場に、決済仕様の異なる説明を与えた生成器」を並走させて提案の差を測る。
// 予算を全腕で1本にすると、**先に叩いた腕が取引日の残りを全部食う**。20時間の取引日を
// 先着順で切ることになるので、標本が Day セッション前半に系統的に偏る。
// この案件の過去の検証(ADR)で見つかった最大の効果は **時間帯そのもの**(Day-AM / Night-NY前 /
// それ以外で性質が全く違う)なので、時間帯で切られた標本で決済パラメータを比べると
// **既知の最大の交絡を標本設計に組み込む**ことになる。だから予算は腕ごとに独立させる。
//
// ★腕の識別子は **既存の語彙をそのまま使う**(新しい概念を増やさない): 決済仕様の変種名 ExitVariant。
//   route はリクエストで解決した変種をそのまま渡す(未指定は 'current')。
type ArmKey = ExitVariant;

/** 腕ごとの消費カウンタ。腕が増えたら自動で増える(初出は 0)。 */
type ArmUsage = Partial<Record<ArmKey, number>>;

// ─── ★従属停止は「時限」であって「セッション単位」ではない ────────────────────────
//
// 旧実装は default プールが429を1回踏んだ瞬間に **そのセッションの残り全部** を止めていた。
// 実売買PCの実ログ(4日・20,585行)で測ると、完全な8セッションすべてで開始 0〜70分以内に初回429が来て、
// セッションの 91〜100% が停止していた。設計上 約600提案/取引日 のところ実際に取れたのは数十件で、
// 事前登録した標本数には到底届かない。
//
// しかも **その429で A は困っていない**: 実ログの典型は `gemini 429 → groq 429 → openai 成功` で、
// A はフォールバックで普通にプランを得ている。守るべき対象が無傷の事象で実験だけが1日単位で死ぬ。
//
// ★では何が本当の危険かというと「A が429を踏んで **ポーズしている間** に、生成器が同じ上流の枠を
//   さらに食って、A のポーズが伸びる/深いラダー(最大8時間)へ進む」こと。危険が続くのは
//   **A のポーズが明けるまで** であって、セッションの終わりまでではない。
//   → 停止の長さを **A が実際に入れたポーズと同じ長さ** にする(providers.ts が実測値を渡す)。
//     ラダーが深くなれば停止も自動で長くなる=保護の目的は弱まらず、むしろ危険度に比例する。
//     429が浅い(1発だけ・60秒)なら停止も60秒で、セッションを丸ごと捨てない。

/** 停止の長さが渡されなかったときの既定[ms]。providers.ts の PAUSE_LADDER_MS の最短段と同じ。
 *  ★「分からないから止めない」ではなく「分からないなら最短段のぶんは止める」に倒す。 */
export const DEFAULT_HALT_MS = 60_000;

interface GateState {
  keys: Keys;
  /** 当該取引日に生成器へ許可した回数の **合計**(全腕の和・診断表示用)。 */
  used: number;
  /** ★当該取引日に **腕ごと** に許可した回数。予算判定はこちらを見る(=腕は互いに枯らし合わない)。 */
  usedByArm: ArmUsage;
  /** ★従属停止の期限[epoch ms]。0=停止していない。now < haltedUntil の間だけ停止する。 */
  haltedUntil: number;
  /** 停止が発火した時点のセッションキー(診断表示用。停止していないときは null)。 */
  haltedAtSessionKey: string | null;
  /** 停止理由の記録用カウンタ(無音にしないための最小の可視化)。 */
  skipped: { busy: number; budget: number; defaultQuota: number; disabled: number };
  /** 進行中の scalp-plan 生成数(A/B エンジン・route を問わず全経路が計上する)。 */
  inFlight: number;
}

function freshState(keys: Keys): GateState {
  return { keys, used: 0, usedByArm: {}, haltedUntil: 0, haltedAtSessionKey: null, skipped: { busy: 0, budget: 0, defaultQuota: 0, disabled: 0 }, inFlight: 0 };
}

let state: GateState = freshState(BOOT_KEYS);

/** 現在時刻のキーを求める(セッション外は直前のキーを保持)。 */
function keysFor(now: number): Keys {
  const s = classifySession(now);
  if (!s) return state.keys;
  return { dayKey: s.sessionDate, sessionKey: `${s.sessionDate}|${s.session}` };
}

/** 取引日が変わっていれば予算カウンタを解除する。
 *  ★inFlight は境界で触らない(進行中の生成は日付をまたいでも進行中のまま)。
 *  ★従属停止(haltedUntil)も境界で触らない: 期限は **A のポーズ** で決まるので、
 *    取引日/セッションが変わったからといって早く明けてよい理由が無い(保護を弱めない)。 */
function roll(now: number): void {
  const k = keysFor(now);
  if (k.dayKey !== state.keys.dayKey) {
    const prev = state;
    state = freshState(k);
    state.inFlight = prev.inFlight;
    state.haltedUntil = prev.haltedUntil;
    state.haltedAtSessionKey = prev.haltedAtSessionKey;
    if (prev.used > 0 || prev.skipped.busy + prev.skipped.budget + prev.skipped.defaultQuota + prev.skipped.disabled > 0) {
      const perArm = Object.entries(prev.usedByArm).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`[llm:generator] 取引日 ${prev.keys.dayKey} 終了 — 使用 ${prev.used}${perArm ? `(腕別 ${perArm})` : ''} / 見送り `
        + `busy=${prev.skipped.busy} budget=${prev.skipped.budget} default-quota=${prev.skipped.defaultQuota} disabled=${prev.skipped.disabled}`);
    }
  } else if (k.sessionKey !== state.keys.sessionKey) {
    state.keys = k;
  }
  expireHalt(now);
}

/** 従属停止の期限が来ていたら解除する(★解除は無音にしない=いつ再開したかがログに残る)。 */
function expireHalt(now: number): void {
  if (state.haltedUntil !== 0 && now >= state.haltedUntil) {
    console.log(`[llm:generator] 従属停止を解除(A のポーズ相当の時限が明けました / 発火時 ${state.haltedAtSessionKey})`);
    state.haltedUntil = 0;
    state.haltedAtSessionKey = null;
  }
}

/** 従属停止中か(★時限)。 */
function isHalted(now: number): boolean {
  return now < state.haltedUntil;
}

export type GeneratorSkipReason = 'busy' | 'budget' | 'default-quota' | 'disabled';

export type GeneratorGateResult =
  | { allowed: true; used: number; budget: number }
  | { allowed: false; reason: GeneratorSkipReason; detail: string };

/** ★生成器の関門。**caller==='generator' のときだけ**呼ぶこと。
 *  通過した場合は **その腕の** 予算を1消費する(=呼んだ側は必ず実行に進む前提)。
 *  ★消費は「試行」で数える: チャート撮影に失敗して LLM を呼ばずに見送る場合も1消費する。
 *    予算は上流クォータへの負荷の上限を保守側で押さえるためのもので、過小に数えるより過大に数える方が安全。
 *  ★第2引数 arm = 予算の帳簿を分ける単位(決済仕様の変種名)。省略は 'current'(既定の腕)。
 *    日次予算は **腕ごとに** 適用されるので、片方の腕が先に枯れて他方だけが回り続けることは起きない。 */
export function checkGeneratorGate(now: number = Date.now(), arm: ArmKey = DEFAULT_EXIT_VARIANT): GeneratorGateResult {
  roll(now);
  const budget = resolveGeneratorDailyBudget();

  // ① 予算 0 = 生成器を明示的に無効化(既定ではない。設定で 0 にした時だけ)。
  if (budget <= 0) {
    state.skipped.disabled += 1;
    const detail = '生成器の日次予算が 0(=無効)に設定されています';
    console.warn(`[llm:generator] 見送り(disabled): ${detail} — 通算 ${state.skipped.disabled} 回`);
    return { allowed: false, reason: 'disabled', detail };
  }

  // ② ★従属規則: default が quota を踏んだら、**A のポーズが明けるまで** 生成器を止める。
  //    自分の429ではなく A の429で止まる。プール分離の後に残る「同一キー=上流クォータ共有」への答え。
  //    ★時限なので、浅い429(60秒ポーズ)でセッションを丸ごと捨てることはない。残り時間も必ず記録する。
  if (isHalted(now)) {
    state.skipped.defaultQuota += 1;
    const detail = `default プールが quota を踏んだため停止中(A のポーズ相当・残り ${Math.ceil((state.haltedUntil - now) / 1000)}秒`
      + `/ 発火 ${state.haltedAtSessionKey})`;
    console.warn(`[llm:generator] 見送り(default-quota): ${detail} — 通算 ${state.skipped.defaultQuota} 回`);
    return { allowed: false, reason: 'default-quota', detail };
  }

  // ③ 日次予算。★**腕ごと**に判定する(全腕で1本の帳簿にすると先着の腕が取引日の残りを食い、
  //    標本が Day 前半に偏る=時間帯という既知最大の交絡が標本設計に入る)。上限到達=停止。
  const usedThisArm = state.usedByArm[arm] ?? 0;
  if (usedThisArm >= budget) {
    state.skipped.budget += 1;
    const detail = `取引日 ${state.keys.dayKey} / 腕 ${arm} の日次予算 ${budget} 回を使い切りました`;
    console.warn(`[llm:generator] 見送り(budget): ${detail} — 通算 ${state.skipped.budget} 回`);
    return { allowed: false, reason: 'budget', detail };
  }

  // ④ backpressure: 生成中(A/B のプラン生成 or 別の生成器要求)なら弾く。
  if (state.inFlight > 0) {
    state.skipped.busy += 1;
    const detail = `別の scalp-plan 生成が進行中(inFlight=${state.inFlight})`;
    console.warn(`[llm:generator] 見送り(busy): ${detail} — 通算 ${state.skipped.busy} 回`);
    return { allowed: false, reason: 'busy', detail };
  }

  state.usedByArm[arm] = usedThisArm + 1;
  state.used += 1;
  return { allowed: true, used: state.usedByArm[arm]!, budget };
}

/** ★従属規則の発火点。**default プールのプロバイダが quota(429/枯渇)を踏んだ瞬間**に providers.ts から呼ばれる。
 *  transient(5xx)・config(401/403/404)・oversize(413)では発火しない(枠の枯渇ではないため)。
 *
 *  @param pauseMs A(default プール)がそのプロバイダに実際に入れたポーズの長さ[ms]。
 *    **これがそのまま生成器の停止時間**になる: 危険なのは「A がポーズしている間に生成器が同じ上流を
 *    さらに食うこと」なので、危険が続く時間 = A のポーズ時間。ラダーが深くなれば(最大8時間)停止も
 *    自動で深くなる=保護は弱まらない。省略時は最短段 DEFAULT_HALT_MS。
 *  ★既により長い停止中なら短くしない(max を取る)。停止を **縮める** 経路は作らない。 */
export function notifyDefaultQuota(providerName: string, now: number = Date.now(), pauseMs?: number): void {
  roll(now);
  const ms = typeof pauseMs === 'number' && Number.isFinite(pauseMs) && pauseMs > 0 ? pauseMs : DEFAULT_HALT_MS;
  const until = now + ms;
  if (until <= state.haltedUntil) return;   // 既に同等以上の停止中(ログも増やさない)
  state.haltedUntil = until;
  state.haltedAtSessionKey = state.keys.sessionKey;
  console.warn(`[llm:generator] ★従属停止: default プール(${providerName})が quota を踏みました — `
    + `${Math.round(ms / 1000)}秒(A のポーズと同じ長さ)生成器を止めます(A の枠を食わない)`);
}

/** scalp-plan 生成の開始/終了。**全経路(A/B エンジン・route)が計上する**。
 *  default 経路の挙動は変わらない(カウンタを読むのは generator だけ)。 */
export function beginScalpPlan(): void { state.inFlight += 1; }
export function endScalpPlan(): void { state.inFlight = Math.max(0, state.inFlight - 1); }
export function scalpPlanInFlight(): number { return state.inFlight; }

/** ★腕ごとの消費(/api/status 用)。予算は腕ごとに独立なので、合計だけでは
 *  「どの腕が枯れかけているか」が読めない。数値は回数のみでキーも決済値も含まない。 */
export function generatorArmUsage(now: number = Date.now()): Record<string, number> {
  roll(now);
  return { ...state.usedByArm } as Record<string, number>;
}

/** 診断用スナップショット(/api/status 等)。キーは一切含めない。
 *  ★budget は **腕1本あたり** の上限、used は **全腕の合計**(腕別は generatorArmUsage)。
 *  ★haltedSessionKey は「停止中なら、その停止が発火した時のセッションキー」。停止は時限なので、
 *    期限が明けていれば null になる(=停止していない)。残り時間は checkGeneratorGate の detail に載る。 */
export function generatorGateSnapshot(now: number = Date.now()) {
  roll(now);
  return {
    dayKey: state.keys.dayKey,
    sessionKey: state.keys.sessionKey,
    budget: resolveGeneratorDailyBudget(),
    used: state.used,
    haltedSessionKey: isHalted(now) ? state.haltedAtSessionKey : null,
    inFlight: state.inFlight,
    skipped: { ...state.skipped },
  };
}

/** ★従属停止の残り時間[ms](0=停止していない)。スナップショットの形(=既存の契約)を変えずに
 *  「あと何秒止まるか」を出すための別入口。キーも決済値も含まない。 */
export function generatorHaltRemainingMs(now: number = Date.now()): number {
  roll(now);
  return Math.max(0, state.haltedUntil - now);
}

/** テスト専用: 全状態を初期化する。 */
export function resetGeneratorGateForTest(): void {
  state = freshState(BOOT_KEYS);
}
