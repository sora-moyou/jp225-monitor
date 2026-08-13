// ─── 分析用ゲート(backpressure + 日次予算 + default への従属) ─────────────
//
// 分析用(別プロセス・2分間隔でチャート画像つき LLM を叩く)が、実取引(A)の経路を
// 劣化させないための最後の関門。**caller==='generator' のときだけ**効く。
// caller 省略/'default' の経路はこのモジュールを一切通らない(byte 不変)。
//
// 3つの停止理由(いずれも「黙って縮退」せず、**止まって・記録する**):
//   busy            … 作業3: 生成中(A/B のプラン生成 or 別の分析用要求)なら分析用は 429 で弾く。
//                     分析用からは A/B の起動条件(lastPlanAt+flat+抑止アンカーの合成)が見えない=
//                     サーバ側にしか判断材料がないため、ここで判定する。
//   budget          … 作業4-1: 分析用だけの日次予算。上限到達で **停止**。
//                     ★モードを書き換えたり無音で縮退したりしない(「上限50回で無音の dryrun 化」が
//                       保護注文を消した過去の事故と同じ轍を踏まない)。
//   default-quota   … 作業4-2(★従属規則): default プールが quota(429/枯渇)を踏んだら、
//                     分析用は **A のポーズが明けるまで停止**。自分の429ではなく **A の429で止まる**。
//                     同一APIキーだと上流のクォータは共有されたままなので、プール分離だけでは足りない。
//                     「実験系は本番の枠を食い残さない」を実装するとこうなる。
//                     ★停止は **時限**(セッション単位ではない)。理由は下の HALT の節。
//
// 状態はプロセス内メモリ(providers.ts の circuitOpenUntil と同じ寿命)。再起動でリセットされる。

import { classifySession } from '../../core/session.js';
import { resolveGeneratorDailyBudget } from '../configStore.js';
// ★型だけの import(実行時には消える)。この語彙の定義は configStore の GeneratorKeySource が唯一の出どころ。
import type { GeneratorKeySource } from '../configStore.js';
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
// 実験は「同じ相場に、決済仕様の異なる説明を与えた分析用」を並走させて提案の差を測る。
// 予算を全腕で1本にすると、**先に叩いた腕が取引日の残りを全部食う**。20時間の取引日を
// 先着順で切ることになるので、標本が Day セッション前半に系統的に偏る。
// この案件の過去の検証(ADR)で見つかった最大の効果は **時間帯そのもの**(Day-AM / Night-NY前 /
// それ以外で性質が全く違う)なので、時間帯で切られた標本で決済パラメータを比べると
// **既知の最大の交絡を標本設計に組み込む**ことになる。だから予算は腕ごとに独立させる。
//
// ★腕の識別子(v0.9.75 で拡張): **実験の軸が2つになった**ので、鍵は「決済変種」ではなく
//   「決済変種 × 質問文変種」の組(server/llm/promptVariant.ts の generatorArmKey が唯一の作り手)。
//   質問文の A/B では両腕とも exitVariant='current' を送るため、変種名だけを鍵にすると
//   **2本の腕が1つの財布を共有** し、上に書いた「先着順で標本が偏る」問題がそのまま戻る。
//   ★質問文が既定('v1')のときの鍵は従来と同じ文字列(=過去の期の帳簿・テストと繋がる)。
type ArmKey = string;

/** 腕ごとの消費カウンタ。腕が増えたら自動で増える(初出は 0)。 */
type ArmUsage = Record<ArmKey, number>;

// ─── ★従属停止は「時限」であって「セッション単位」ではない ────────────────────────
//
// 旧実装は default プールが429を1回踏んだ瞬間に **そのセッションの残り全部** を止めていた。
// 実取引PCの実ログ(4日・20,585行)で測ると、完全な8セッションすべてで開始 0〜70分以内に初回429が来て、
// セッションの 91〜100% が停止していた。設計上 約600提案/取引日 のところ実際に取れたのは数十件で、
// 事前登録した標本数には到底届かない。
//
// しかも **その429で A は困っていない**: 実ログの典型は `gemini 429 → groq 429 → openai 成功` で、
// A はフォールバックで普通にプランを得ている。守るべき対象が無傷の事象で実験だけが1日単位で死ぬ。
//
// ★では何が本当の危険かというと「A が429を踏んで **ポーズしている間** に、分析用が同じ上流の枠を
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
  /** 当該取引日に分析用へ許可した回数の **合計**(全腕の和・診断表示用)。 */
  used: number;
  /** ★当該取引日に **腕ごと** に許可した回数。予算判定はこちらを見る(=腕は互いに枯らし合わない)。 */
  usedByArm: ArmUsage;
  /** ★従属停止の期限[epoch ms]。0=停止していない。now < haltedUntil の間だけ停止する。 */
  haltedUntil: number;
  /** 停止が発火した時点のセッションキー(診断表示用。停止していないときは null)。 */
  haltedAtSessionKey: string | null;
  /** 停止を発火させたプロバイダ名(診断用。どのプロバイダの429で止まっているかを遠隔で読むため)。 */
  haltedProvider: string | null;
  /** 停止理由の記録用カウンタ(無音にしないための最小の可視化)。 */
  skipped: { busy: number; budget: number; defaultQuota: number; disabled: number };
  /** ★従属停止を **見送った** 回数(分析用が専用キーで走っており、A の429が分析用の枠について
   *  何も語らない場合)。止めた回数だけでなく **止めなかった回数** も残さないと、
   *  「なぜ止まっていないのか」を運用者が判断できない(無音の非停止を作らない)。 */
  quotaIgnored: number;
  /** 直近の見送りの内訳(プロバイダと出どころ)。キーの値は含めない。 */
  lastQuotaIgnored: { provider: string; source: GeneratorKeySource; at: number } | null;
  /** 進行中の scalp-plan 生成数(A/B エンジン・route を問わず全経路が計上する)。 */
  inFlight: number;
}

function freshState(keys: Keys): GateState {
  return {
    keys, used: 0, usedByArm: {}, haltedUntil: 0, haltedAtSessionKey: null, haltedProvider: null,
    skipped: { busy: 0, budget: 0, defaultQuota: 0, disabled: 0 },
    quotaIgnored: 0, lastQuotaIgnored: null, inFlight: 0,
  };
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
    state.haltedProvider = prev.haltedProvider;
    if (prev.used > 0 || prev.skipped.busy + prev.skipped.budget + prev.skipped.defaultQuota + prev.skipped.disabled > 0) {
      const perArm = Object.entries(prev.usedByArm).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`[llm:generator] 取引日 ${prev.keys.dayKey} 終了 — 使用 ${prev.used}${perArm ? `(腕別 ${perArm})` : ''} / 見送り `
        + `busy=${prev.skipped.busy} budget=${prev.skipped.budget} default-quota=${prev.skipped.defaultQuota} disabled=${prev.skipped.disabled}`
        + ` / 従属停止を見送り(専用キー)=${prev.quotaIgnored}`);
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
    state.haltedProvider = null;
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

/** ★分析用の関門。**caller==='generator' のときだけ**呼ぶこと。
 *  通過した場合は **その腕の** 予算を1消費する(=呼んだ側は必ず実行に進む前提)。
 *  ★消費は「試行」で数える: チャート撮影に失敗して LLM を呼ばずに見送る場合も1消費する。
 *    予算は上流クォータへの負荷の上限を保守側で押さえるためのもので、過小に数えるより過大に数える方が安全。
 *  ★第2引数 arm = 予算の帳簿を分ける単位(決済仕様の変種名)。省略は 'current'(既定の腕)。
 *    日次予算は **腕ごとに** 適用されるので、片方の腕が先に枯れて他方だけが回り続けることは起きない。 */
export function checkGeneratorGate(now: number = Date.now(), arm: ArmKey = DEFAULT_EXIT_VARIANT): GeneratorGateResult {
  roll(now);
  const budget = resolveGeneratorDailyBudget();

  // ① 予算 0 = 分析用を明示的に無効化(既定ではない。設定で 0 にした時だけ)。
  if (budget <= 0) {
    state.skipped.disabled += 1;
    const detail = '分析用の日次予算が 0(=無効)に設定されています';
    console.warn(`[llm:generator] 見送り(disabled): ${detail} — 通算 ${state.skipped.disabled} 回`);
    return { allowed: false, reason: 'disabled', detail };
  }

  // ② ★従属規則: default が quota を踏んだら、**A のポーズが明けるまで** 分析用を止める。
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

  // ④ backpressure: 生成中(A/B のプラン生成 or 別の分析用要求)なら弾く。
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

// ─── ★従属停止は「上流クォータを共有しているプロバイダ」に限る ───────────────────────
//
// 何が壊れていたか(実取引PCの実ログ 2026-08-03 00:04〜01:11):
//   A は数分おきに 429 を踏む。従属停止はキーの共有を **一切見ずに** 発火していたので、
//   段が 60s → 300s → 1800s → 7200s(2時間)まで伸び、分析用は大半の時間止まって標本が溜まらなかった。
//   ところがユーザーは4プロバイダ全てに **分析用専用キー** を設定済みで、上流のクォータは分かれている。
//   → 専用キーなら「A が 429 を踏んだ」ことは **分析用のクォータについて何も語らない**。
//     存在しない危険のために実験を止めていた。
//
// ★保護の目的は弱めない: 共有キー(shared)のときは従来どおり止める。
//   「A がポーズしている間に分析用が同じ上流を食う」危険は共有キーでは実在するため。
// ★判定は **プロバイダ単位**(全体ではない): キーはプロバイダごとに設定でき、
//   gemini だけ共有・他は専用、という状態が普通に起こりうる。「1つでも共有なら全部止める」でも
//   「1つでも専用なら止めない」でもなく、**429 を踏んだそのプロバイダ** が共有かどうかで決める。
//   (停止そのものは従来どおり分析用 **全体** に効く。共有プロバイダの枠を食う経路は
//    分析用のフォールバック順で必ず通りうるので、そこは弱めない。)

/** その出どころが「分析用専用キー」= 上流クォータが A と分かれている、と言えるか。
 *  ★語彙は configStore の GeneratorKeySource をそのまま使う(新しい語彙を作らない):
 *    'own'/'env' だけが専用。'shared'(共通キーへフォールバック中)と 'none'、
 *    そして **undefined(判定できなかった)** は専用ではない = 止める側に倒す。 */
export function isDedicatedGeneratorKey(source: GeneratorKeySource | undefined): boolean {
  return source === 'own' || source === 'env';
}

/** ★その429で分析用を止めなくてよいか(純関数)。
 *
 *  ここが食い違っていた: **停止は分析用 *全体* に効く**(すぐ上のコメントがそう書いている)のに、
 *  見送りの判断は「429 を踏んだそのプロバイダ」だけを見ていた。
 *  例) gemini=専用 / openai=共有 のとき、gemini の429で停止が **丸ごと** 見送られ、
 *      分析用はフォールバックで **共有の openai** を食える = A の枠を食う経路が残る。
 *  → 見送ってよいのは「分析用がフォールバックで通りうるどのプロバイダも専用キー」のときだけ。
 *
 *  ★出どころを観測できていない呼び出し(allSources 省略)は従来どおり、踏んだプロバイダだけで決める
 *    = 既存の呼び出しの挙動は1ミリも変わらない。
 *  ★「専用と証明できない」(shared/none/undefined)は常に止める側に倒す、という既存の規律は不変。 */
export function shouldIgnoreDefaultQuota(
  keySource: GeneratorKeySource | undefined,
  allSources?: Readonly<Record<string, GeneratorKeySource | undefined>>,
): boolean {
  if (!isDedicatedGeneratorKey(keySource)) return false;
  if (!allSources) return true;
  const values = Object.values(allSources);
  if (values.length === 0) return true;   // 観測できなかった = 踏んだプロバイダの判断に委ねる
  return values.every(s => isDedicatedGeneratorKey(s));
}

/** 共有キー(= A と上流が同じ)のプロバイダ名。停止した理由を名指しで残すため。 */
export function sharedGeneratorProviders(
  allSources: Readonly<Record<string, GeneratorKeySource | undefined>>,
): string[] {
  return Object.entries(allSources)
    .filter(([, s]) => !isDedicatedGeneratorKey(s))
    .map(([name]) => name);
}

/** ★従属規則の発火点。**default プールのプロバイダが quota(429/枯渇)を踏んだ瞬間**に providers.ts から呼ばれる。
 *  transient(5xx)・config(401/403/404)・oversize(413)・badrequest(400)では発火しない(枠の枯渇ではないため)。
 *
 *  @param keySource ★そのプロバイダで **分析用が実際に使っているキーの出どころ**。
 *    'own'/'env'(専用キー)なら上流クォータは分かれているので **止めない**(見送りを必ず1行残す)。
 *    'shared'/'none'/省略(=判定できなかった)は従来どおり止める。省略時に止めるのは
 *    「分からないなら保護側に倒す」ため(既存の呼び出し・テストの挙動も変わらない)。
 *  @param pauseMs A(default プール)がそのプロバイダに実際に入れたポーズの長さ[ms]。
 *    **これがそのまま分析用の停止時間**になる: 危険なのは「A がポーズしている間に分析用が同じ上流を
 *    さらに食うこと」なので、危険が続く時間 = A のポーズ時間。ラダーが深くなれば(最大8時間)停止も
 *    自動で深くなる=保護は弱まらない。省略時は最短段 DEFAULT_HALT_MS。
 *  ★既により長い停止中なら短くしない(max を取る)。停止を **縮める** 経路は作らない。 */
export function notifyDefaultQuota(
  providerName: string, now: number = Date.now(), pauseMs?: number, keySource?: GeneratorKeySource,
  allSources?: Readonly<Record<string, GeneratorKeySource | undefined>>,
): void {
  roll(now);
  // ★踏んだプロバイダが専用でも、**分析用がフォールバックで通りうる先に共有キーが1つでもあれば止める**
  //   (停止は分析用全体に効く=守る対象も全体)。無音にしない: 止めた理由を名指しで残す。
  if (isDedicatedGeneratorKey(keySource) && allSources && !shouldIgnoreDefaultQuota(keySource, allSources)) {
    console.warn(`[llm:generator] ★従属停止: default プール(${providerName})が quota を踏みました。`
      + `${providerName} は分析用専用キー(${keySource})ですが、分析用のフォールバック先に共有キーの`
      + `プロバイダが残っています(${sharedGeneratorProviders(allSources).join(', ')})`
      + ' — その経路で A と同じ上流を食いうるので止めます');
  }
  // ★専用キー = A と分析用で上流のクォータが別。A の429は分析用の枠について何も語らないので止めない。
  //   **無音にしない**: 止めなかったことと、その根拠(出どころ)を必ず1行残す。キーの値は出さない。
  if (shouldIgnoreDefaultQuota(keySource, allSources)) {
    state.quotaIgnored += 1;
    state.lastQuotaIgnored = { provider: providerName, source: keySource!, at: now };
    console.log(`[llm:generator] 従属停止は見送り: default プール(${providerName})が quota を踏みましたが、`
      + `分析用は専用キー(出どころ=${keySource})で走っています(上流クォータが別なので分析用は A の枠を食いません)`
      + ` — 通算 ${state.quotaIgnored} 回`);
    return;
  }
  const ms = typeof pauseMs === 'number' && Number.isFinite(pauseMs) && pauseMs > 0 ? pauseMs : DEFAULT_HALT_MS;
  const until = now + ms;
  if (until <= state.haltedUntil) return;   // 既に同等以上の停止中(ログも増やさない)
  state.haltedUntil = until;
  state.haltedAtSessionKey = state.keys.sessionKey;
  state.haltedProvider = providerName;
  console.warn(`[llm:generator] ★従属停止: default プール(${providerName})が quota を踏みました — `
    + `${Math.round(ms / 1000)}秒(A のポーズと同じ長さ)分析用を止めます(A の枠を食わない)`
    + ` / 分析用のキー出どころ=${keySource ?? '不明'}(専用キー own|env なら止めません)`);
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

/** ★従属停止の中身(いつまで・どのプロバイダの429で・どのセッションで発火したか)。
 *  スナップショットの形(=既存の契約)を変えずに出すための別入口。キーの値は含まない。
 *  止まっていなければ active:false / untilAt:0 / provider:null。 */
export function generatorHaltInfo(now: number = Date.now()): {
  active: boolean; untilAt: number; remainingMs: number; provider: string | null; sessionKey: string | null;
} {
  roll(now);
  const active = isHalted(now);
  return {
    active,
    untilAt: active ? state.haltedUntil : 0,
    remainingMs: Math.max(0, state.haltedUntil - now),
    provider: active ? state.haltedProvider : null,
    sessionKey: active ? state.haltedAtSessionKey : null,
  };
}

/** ★従属停止を **見送った** 回数と、その直近の内訳(専用キーなので止めなかった)。
 *  スナップショットの形(=既存の契約)を変えずに出すための別入口(generatorHaltRemainingMs と同じ作法)。
 *  ★これが無いと「A は429を踏んでいるのに分析用が止まっていない」を運用者が説明できない。
 *  キーの値は含まない(出どころの名前だけ)。 */
export function generatorQuotaIgnored(now: number = Date.now()): {
  count: number;
  last: { provider: string; source: GeneratorKeySource; at: number } | null;
} {
  roll(now);
  return { count: state.quotaIgnored, last: state.lastQuotaIgnored ? { ...state.lastQuotaIgnored } : null };
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
