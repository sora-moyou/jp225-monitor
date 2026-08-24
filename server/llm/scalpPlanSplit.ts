// server/llm/scalpPlanSplit.ts — ★A→B の直列呼び出し(段4)。**転送は注入する**ので LLM 無しで実行できる。
//
// ■ 流れ
//   ① A(目線)を1回呼ぶ。★ツールは付けない・max_tokens は小さい。
//   ② A が失敗 → ★**B を投げずに見送り**(再試行なし)・none_reason='aFailed'。
//   ③ A が range かつ レンジ不許可 → ★**B を呼ばない**・none_reason='rangeDisabled'・b_variant='none'。
//   ④ それ以外 → コードが版を選び(pickBVariant)、B を1回呼ぶ。★ツールは従来どおり3本。
//   ⑤ B の答えを **既存の AiPlan** に組み立てて返す(下流の enforce/veto/台帳/SSE は1行も変えない)。
//
// ■ ★文脈は取り直さない
//   A に渡した断面(足・指標・基礎データ)を **凍結して** B にも使う。取り直すと
//   「A が見た相場」と「B が値付けした相場」がずれ、A の目線が B の価格と噛み合わなくなる。
//   ★呼び出し側が1回だけ組み立てて、A 用(節目・アラート・長期高安を外したもの)と
//   B 用(全部入り)を **同じ材料から** 作って渡す(server/llm/abContext.ts)。
//
// ■ ★見送りの語の使い分け(段1 で作った語彙)
//   aFailed  … A の呼び出しが失敗した/3語のどれでもない値が返った ＝ **こちらの故障**
//   rangeDisabled … A が range と答えたので B を呼ばなかった ＝ **こちらの設定**
//   ai       … B が「置けない」と **文で** 言った ＝ **AI の判断**
//   aiSilent … B が価格も理由も返さなかった/契約に無い形だった ＝ **B の故障**
//   ★4つを別の語にしてあるので、none_reason='ai' 33.9% が何だったのかを今後は分解できる。

import type { AiPlan, AnsweringProvider, NoneReason, ScalpPlanResult } from './scalpPlan.js';
import {
  B_VARIANTS, buildBSystemPrompt, buildBUserPrompt, buildPlanFromBAnswer, parseBAnswer,
  pickBVariant, type BVariant, type SqueezeState, type TrendDirection,
} from './planVariants.js';
import { buildTrendSystemPrompt, buildTrendUserPrompt, parseTrendAnswer } from './trendPrompt.js';

/** A の答え(bull/bear/range)→ 台帳と下流で使う語。★注文の side ではない。 */
export type ATrend = TrendDirection;

/** ★1回の LLM 呼び出しの結果(転送層が返すもの)。 */
export interface SplitCallResult {
  text: string;
  provider?: AnsweringProvider;
  /** その呼び出しでデータツールが実際に呼ばれた回数。★0(数えて0)と undefined(数えていない)は別物。 */
  toolCalls?: number;
}

/** ★転送の注入点。テストはここを差し替えるだけで、LLM を1回も呼ばずに全経路を通せる。 */
export interface SplitPlanDeps {
  callTrend(systemPrompt: string, userPrompt: string): Promise<SplitCallResult>;
  callOrder(systemPrompt: string, userPrompt: string): Promise<SplitCallResult>;
}

export interface SplitPlanOptions {
  refPrice: number;
  /** A に渡す文脈(節目・アラート・長期高安を外したもの)。 */
  trendContext: string;
  /** B に渡す文脈(全部入り)。★A と同じ断面から作ること。 */
  orderContext: string;
  floorYen: number;
  ceilingYen: number;
  rangeEnabled: boolean;
  /** BB スクイーズ判定の生値。版の選択に使う。 */
  squeezeState: SqueezeState;
  /** 判定が使えなかった理由('ready_false'/'closed'/'disabled')。使えたときは undefined。 */
  squeezeUnavailable?: string;
  // ★2026-08-22 訂正(リーダー指摘): 一度 delegationNote を SplitPlanOptions に足して B へ渡したが、
  //   取り消した。理由: buildDelegationNote の文面は「上のロジック」「上の2択」「direction」
  //   「regime」「confidence」など、B には存在しないブロック/フィールドへの参照を大量に含み、
  //   分割の芯(side は AI に返させない・返す場所を作らない)と正面衝突する。実測で
  //   B が {"direction":"none","regime":"range","confidence":0.3,...} のような契約外の JSON を
  //   返し、parseBAnswer が拾えず none_reason='aiSilent'(B の故障)に化けることを確認した
  //   (正当な見送りが故障に化かる=aiSilent を作った目的の裏返し)。詳細は設計書を参照。
}

/** ★段5 で台帳へ落とす材料(記録専用)。ここでは組み立てるだけで書き込まない。 */
export interface SplitRecord {
  aDirection?: ATrend;
  aWhy?: string;
  /** 渡した版。★呼ばなかった回は 'none' を **明示的に** 入れる(未指定=NULL とは別物)。 */
  bVariant: BVariant | 'none';
  squeezeState: SqueezeState;
  squeezeUnavailable?: string;
  bStrategy?: string;
  /** ★AI が理由つきで見送ったときの理由の文(両脚ぶん)。 */
  aiWhy?: string;
  /** ★段6: B が「判断に必要なデータが足りなかった」と自己申告した自由文。
   *  ★aiWhy(価格を置けないと判断した理由)とは別物・混ぜない——見送ったかどうかに関わらず書かれうる
   *  (片脚だけ置けた回にも書ける)。①(contextPresence)と突き合わせて「AI の自己申告」と
   *  「実際に文脈へ入っていたか」を照合するための列。 */
  missingData?: string;
  /** A と B のツール呼び出し回数の合計。★A は常に 0(ツールを付けない)。 */
  toolCalls?: number;
  /** ★段5: A(目線)を答えたプロバイダ。A の呼び出しが失敗して一度も応答が来なかった回は undefined。 */
  aProvider?: AnsweringProvider;
  /** ★段5: B(価格と損切幅)を答えたプロバイダ。B を呼ばなかった回(bVariant='none')は undefined。
   *  ★A と別に持つ理由: callWithFallback は呼び出しごとにプールを引くため、A を gemini・B を groq が
   *    答える組み合わせが起こる。1つの provider に混ぜて残すと「どちらが答えたか」が分からなくなる。 */
  bProvider?: AnsweringProvider;
  /** ★段5: A のプロンプトの型の指紋(pb1・データを含まない)。★scalpPlanSplit.ts はここでは設定しない
   *  (呼び出し側=scalpPlanRunner.ts が bVariant 確定後に abPromptBuild.ts で計算して埋める)。 */
  aPromptBuild?: string;
  /** ★段5: B のプロンプトの型の指紋。bVariant='none'(B を呼んでいない)回は未設定のまま。 */
  bPromptBuild?: string;
}

export interface SplitPlanOutcome {
  parsed: Extract<ScalpPlanResult, { ok: true }>;
  record: SplitRecord;
  provider?: AnsweringProvider;
}

/** 見送りの plan を作る(価格フィールドは持たせない)。 */
function nonePlan(refPrice: number, rationale: string): AiPlan {
  return { direction: 'none', rationale, refPrice };
}

const withReason = (
  plan: AiPlan, noneReason: NoneReason,
): Extract<ScalpPlanResult, { ok: true }> => ({ ok: true, plan, noneReason });

/** A と B の理由を1つの文にまとめる(どちらか片方でも可)。両方無ければ undefined。 */
function joinWhy(aWhy?: string, iWhy?: string): string | undefined {
  const parts: string[] = [];
  if (aWhy) parts.push(`あ) ${aWhy}`);
  if (iWhy) parts.push(`い) ${iWhy}`);
  return parts.length > 0 ? parts.join(' / ') : undefined;
}

/** 数えていない(undefined)を 0 と混ぜずに足す。両方 undefined なら undefined。 */
function addCalls(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/**
 * ★A → B を直列に呼ぶ。転送は deps 経由なので、LLM を呼ばずに実プロセスで通せる。
 * ★B を呼ばない分岐(A 失敗 / レンジ不許可)では deps.callOrder を **1度も呼ばない**。
 */
export async function runSplitPlan(
  deps: SplitPlanDeps, opts: SplitPlanOptions,
): Promise<SplitPlanOutcome> {
  const { refPrice, squeezeState } = opts;
  const baseRecord = {
    squeezeState,
    ...(opts.squeezeUnavailable ? { squeezeUnavailable: opts.squeezeUnavailable } : {}),
  };

  // ── ① A(目線) ────────────────────────────────────────────────────────────
  let aRes: SplitCallResult;
  try {
    aRes = await deps.callTrend(buildTrendSystemPrompt(opts.trendContext), buildTrendUserPrompt());
  } catch (e) {
    // ★A の失敗は「相場が悪かった」ではない。★**B を投げず・再試行せず**に見送る。
    console.warn('[scalp-plan] A(目線)の呼び出しに失敗 — B は呼ばず見送り:', e instanceof Error ? e.message : String(e));
    return {
      parsed: withReason(nonePlan(refPrice, '目線の判断が得られませんでした(呼び出し失敗)。'), 'aFailed'),
      record: { ...baseRecord, bVariant: 'none' },
    };
  }
  const answer = parseTrendAnswer(aRes.text);
  if (!answer) {
    // 3語のどれでもない/読めない。★これも aFailed(相場のせいではない)。
    console.warn('[scalp-plan] A(目線)の答えが3語のどれでもない — B は呼ばず見送り');
    return {
      parsed: withReason(nonePlan(refPrice, '目線の判断が得られませんでした(答えが規定の3語でない)。'), 'aFailed'),
      record: {
        ...baseRecord, bVariant: 'none', toolCalls: aRes.toolCalls,
        ...(aRes.provider ? { aProvider: aRes.provider } : {}),
      },
      ...(aRes.provider ? { provider: aRes.provider } : {}),
    };
  }
  const aRecord = {
    ...baseRecord,
    aDirection: answer.direction,
    ...(answer.why ? { aWhy: answer.why } : {}),
    ...(aRes.provider ? { aProvider: aRes.provider } : {}),
  };

  // ── ② レンジ不許可なら B を呼ばない ──────────────────────────────────────
  if (answer.direction === 'range' && !opts.rangeEnabled) {
    return {
      parsed: withReason(
        nonePlan(refPrice, `目線はレンジ${answer.why ? `(${answer.why})` : ''}。レンジの取引は設定で無効なため見送り。`),
        'rangeDisabled',
      ),
      record: { ...aRecord, bVariant: 'none', toolCalls: aRes.toolCalls },
      ...(aRes.provider ? { provider: aRes.provider } : {}),
    };
  }

  // ── ③ 版はコードが選ぶ ──────────────────────────────────────────────────
  const variant = pickBVariant(answer.direction, squeezeState);

  // ── ④ B(価格と損切幅) ───────────────────────────────────────────────────
  //   ★A の自由文(why)は渡さない。渡すと反対の目線の語が理由経由で B に入り、分ける意味が消える。
  const bRes = await deps.callOrder(
    buildBSystemPrompt(variant, opts.floorYen, opts.ceilingYen, opts.orderContext),
    buildBUserPrompt(variant, refPrice, opts.floorYen, opts.ceilingYen),
  );
  const provider = bRes.provider ?? aRes.provider;
  const toolCalls = addCalls(aRes.toolCalls, bRes.toolCalls);
  const rec = {
    ...aRecord, bVariant: variant, ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(bRes.provider ? { bProvider: bRes.provider } : {}),
  };

  const bAnswer = parseBAnswer(bRes.text);
  if (!bAnswer) {
    // ★契約に無い形/空。**B の故障** であって相場ではない。
    return {
      parsed: withReason(nonePlan(refPrice, 'AI が規定の形で答えませんでした。'), 'aiSilent'),
      record: rec,
      ...(provider ? { provider } : {}),
    };
  }

  // ── ⑤ 既存の AiPlan に組み立てる(side と損切りの向きはコードが埋める) ──────────
  const built = buildPlanFromBAnswer(variant, bAnswer, refPrice, buildRationale(bAnswer, variant));
  // ★v0.9.96(リーダー裁定): **A の理由を目線の箱へ繋ぐ**。
  //
  //  ■ なぜ(この案件のゴール): 依頼の本体は「なぜ買い目線なのか／なぜこの価格なのか の理由の表示」。
  //    分割ONの回は A が目線を、B が価格を答えるので、**A の理由こそが「なぜこの目線か」** に当たる。
  //    それが `SplitRecord.aWhy` → 台帳 `a_why` にしか入っていなかった(画面へ届く経路が無かった)。
  //    ★これは「意図して空」ではない: 設計書(2026-08-21-ab-split-prompts.md)は理由の5つの箱に
  //      一度も触れておらず、**誰も決めていなかった**(配線漏れ)。ここで繋ぐ。
  //  ■ ★A の理由を B へ渡さない規約は **1バイトも変えていない**(渡すのは画面と台帳の側だけ)。
  //  ■ 置く先は `built.plan` ひとつ。A 失敗 / レンジ不許可 / B 無言 の3経路は **計画そのものが無い**
  //    (画面にも出ない)ので触らない。それらの回でも A の理由は従来どおり台帳 `a_why` に残る。
  //  ■ ★両脚落ち(direction:'none')の plan にも入る: 「なぜこの目線か」は B が価格を置けたかに
  //    依らない。旧経路にも `direction='none'` で `direction_why` だけが在る回は既に存在する
  //    (実測: 2026-08-19〜24 で85件)ので、台帳の形も新しくならない。
  if (answer.why) built.plan.directionWhy = answer.why;
  const aiWhy = joinWhy(built.aWhy, built.iWhy);
  const record: SplitRecord = {
    ...rec,
    ...(bAnswer.strategy ? { bStrategy: bAnswer.strategy } : {}),
    ...(aiWhy ? { aiWhy } : {}),
    // ★段6: 見送ったかどうかに関わらず、B が「足りなかったデータ」を書けばそのまま記録する。
    ...(bAnswer.missingData ? { missingData: bAnswer.missingData } : {}),
  };

  if (built.bothDropped) {
    // ★理由が有る=AI の判断('ai') / 理由も無い=無言の故障('aiSilent')。
    const reason: NoneReason = aiWhy ? 'ai' : 'aiSilent';
    return {
      parsed: withReason(built.plan, reason),
      record, ...(provider ? { provider } : {}),
    };
  }
  return {
    parsed: { ok: true, plan: built.plan },
    record, ...(provider ? { provider } : {}),
  };
}

/** 画面と台帳に出す根拠文。★機械生成の注記は下流(buildLegNote)が足すので、ここは AI の言葉だけ。 */
export function buildRationale(a: ReturnType<typeof parseBAnswer>, variant: BVariant): string {
  if (!a) return '';
  const parts: string[] = [];
  if (a.strategy) parts.push(a.strategy);
  const spec = B_VARIANTS[variant];
  if (a.aWhy) parts.push(`${spec.legs.a.orderJa}: ${a.aWhy}`);
  if (a.iWhy) parts.push(`${spec.legs.i.orderJa}: ${a.iWhy}`);
  return parts.join(' / ');
}
