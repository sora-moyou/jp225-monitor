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
//                     生成器は **そのセッションの残りを停止**。自分の429ではなく **A の429で止まる**。
//                     同一APIキーだと上流のクォータは共有されたままなので、プール分離だけでは足りない。
//                     「実験系は本番の枠を食い残さない」を実装するとこうなる。
//
// 状態はプロセス内メモリ(providers.ts の circuitOpenUntil と同じ寿命)。再起動でリセットされる。

import { classifySession } from '../../core/session.js';
import { resolveGeneratorDailyBudget } from '../configStore.js';

/** 予算/従属停止のリセット境界。取引セッション(core/session の SSOT)で刻む。
 *  - dayKey     = sessionDate。Day D と Night D は同じ D = **同一取引日** → 日次予算の単位。
 *  - sessionKey = `${sessionDate}|${session}` → 従属停止(「そのセッションの残り」)の単位。
 *  取引時間外(セッション外)は **直前のセッションのキーを保持**(sticky)する。
 *  こうすると 15:45〜17:00 の空白帯や週末で予算がリセットされる抜け穴ができず、
 *  かつ core/session の内部日付関数を再実装(=知識の複製)せずに済む。 */
interface Keys { dayKey: string; sessionKey: string; }

const BOOT_KEYS: Keys = { dayKey: '(boot)', sessionKey: '(boot)' };

interface GateState {
  keys: Keys;
  /** 当該取引日に生成器へ許可した回数(=予算の消費)。 */
  used: number;
  /** 従属停止中のセッションキー(null=停止していない)。 */
  haltedSessionKey: string | null;
  /** 停止理由の記録用カウンタ(無音にしないための最小の可視化)。 */
  skipped: { busy: number; budget: number; defaultQuota: number; disabled: number };
  /** 進行中の scalp-plan 生成数(A/B エンジン・route を問わず全経路が計上する)。 */
  inFlight: number;
}

function freshState(keys: Keys): GateState {
  return { keys, used: 0, haltedSessionKey: null, skipped: { busy: 0, budget: 0, defaultQuota: 0, disabled: 0 }, inFlight: 0 };
}

let state: GateState = freshState(BOOT_KEYS);

/** 現在時刻のキーを求める(セッション外は直前のキーを保持)。 */
function keysFor(now: number): Keys {
  const s = classifySession(now);
  if (!s) return state.keys;
  return { dayKey: s.sessionDate, sessionKey: `${s.sessionDate}|${s.session}` };
}

/** 取引日が変わっていれば予算カウンタを、セッションが変わっていれば従属停止を、それぞれ解除する。
 *  ★inFlight は境界で触らない(進行中の生成は日付をまたいでも進行中のまま)。 */
function roll(now: number): void {
  const k = keysFor(now);
  if (k.dayKey !== state.keys.dayKey) {
    const prev = state;
    state = freshState(k);
    state.inFlight = prev.inFlight;
    if (prev.used > 0 || prev.skipped.busy + prev.skipped.budget + prev.skipped.defaultQuota + prev.skipped.disabled > 0) {
      console.log(`[llm:generator] 取引日 ${prev.keys.dayKey} 終了 — 使用 ${prev.used} / 見送り `
        + `busy=${prev.skipped.busy} budget=${prev.skipped.budget} default-quota=${prev.skipped.defaultQuota} disabled=${prev.skipped.disabled}`);
    }
    return;
  }
  if (k.sessionKey !== state.keys.sessionKey) {
    state.keys = k;
    if (state.haltedSessionKey && state.haltedSessionKey !== k.sessionKey) {
      console.log(`[llm:generator] 従属停止を解除(セッション ${state.haltedSessionKey} → ${k.sessionKey})`);
      state.haltedSessionKey = null;
    }
  }
}

export type GeneratorSkipReason = 'busy' | 'budget' | 'default-quota' | 'disabled';

export type GeneratorGateResult =
  | { allowed: true; used: number; budget: number }
  | { allowed: false; reason: GeneratorSkipReason; detail: string };

/** ★生成器の関門。**caller==='generator' のときだけ**呼ぶこと。
 *  通過した場合は予算を1消費する(=呼んだ側は必ず実行に進む前提)。
 *  ★消費は「試行」で数える: チャート撮影に失敗して LLM を呼ばずに見送る場合も1消費する。
 *    予算は上流クォータへの負荷の上限を保守側で押さえるためのもので、過小に数えるより過大に数える方が安全。 */
export function checkGeneratorGate(now: number = Date.now()): GeneratorGateResult {
  roll(now);
  const budget = resolveGeneratorDailyBudget();

  // ① 予算 0 = 生成器を明示的に無効化(既定ではない。設定で 0 にした時だけ)。
  if (budget <= 0) {
    state.skipped.disabled += 1;
    const detail = '生成器の日次予算が 0(=無効)に設定されています';
    console.warn(`[llm:generator] 見送り(disabled): ${detail} — 通算 ${state.skipped.disabled} 回`);
    return { allowed: false, reason: 'disabled', detail };
  }

  // ② ★従属規則: default が quota を踏んだセッションでは、生成器は残りを停止する。
  //    自分の429ではなく A の429で止まる。プール分離の後に残る「同一キー=上流クォータ共有」への答え。
  if (state.haltedSessionKey !== null) {
    state.skipped.defaultQuota += 1;
    const detail = `default プールが quota を踏んだためセッション ${state.haltedSessionKey} の残りを停止中`;
    console.warn(`[llm:generator] 見送り(default-quota): ${detail} — 通算 ${state.skipped.defaultQuota} 回`);
    return { allowed: false, reason: 'default-quota', detail };
  }

  // ③ 日次予算。上限到達=停止(モードは書き換えない・無音で縮退しない)。
  if (state.used >= budget) {
    state.skipped.budget += 1;
    const detail = `取引日 ${state.keys.dayKey} の日次予算 ${budget} 回を使い切りました`;
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

  state.used += 1;
  return { allowed: true, used: state.used, budget };
}

/** ★従属規則の発火点。**default プールのプロバイダが quota(429/枯渇)を踏んだ瞬間**に providers.ts から呼ばれる。
 *  transient(5xx)・config(401/403/404)・oversize(413)では発火しない(枠の枯渇ではないため)。
 *  発火するとそのセッションの残りは生成器を停止する。 */
export function notifyDefaultQuota(providerName: string, now: number = Date.now()): void {
  roll(now);
  if (state.haltedSessionKey === state.keys.sessionKey) return;   // 同一セッション内は1回だけログ
  state.haltedSessionKey = state.keys.sessionKey;
  console.warn(`[llm:generator] ★従属停止: default プール(${providerName})が quota を踏みました — `
    + `セッション ${state.keys.sessionKey} の残りは生成器を止めます(A の枠を食わない)`);
}

/** scalp-plan 生成の開始/終了。**全経路(A/B エンジン・route)が計上する**。
 *  default 経路の挙動は変わらない(カウンタを読むのは generator だけ)。 */
export function beginScalpPlan(): void { state.inFlight += 1; }
export function endScalpPlan(): void { state.inFlight = Math.max(0, state.inFlight - 1); }
export function scalpPlanInFlight(): number { return state.inFlight; }

/** 診断用スナップショット(/api/status 等)。キーは一切含めない。 */
export function generatorGateSnapshot(now: number = Date.now()) {
  roll(now);
  return {
    dayKey: state.keys.dayKey,
    sessionKey: state.keys.sessionKey,
    budget: resolveGeneratorDailyBudget(),
    used: state.used,
    haltedSessionKey: state.haltedSessionKey,
    inFlight: state.inFlight,
    skipped: { ...state.skipped },
  };
}

/** テスト専用: 全状態を初期化する。 */
export function resetGeneratorGateForTest(): void {
  state = freshState(BOOT_KEYS);
}
