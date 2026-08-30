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
  B_VARIANTS, buildBSystemPrompt, buildBUserPrompt, buildPlanFromBAnswer, effectiveAskTp, parseBFreeText,
  pickBVariant, type BVariant, type SqueezeState, type TrendDirection,
} from './planVariants.js';
import { buildTrendSystemPrompt, buildTrendUserPrompt, parseTrendAnswer, rawDirectionOf } from './trendPrompt.js';

/** A の答え(buy/sell/range)→ 台帳と下流で使う語。
 *  ★2026-08-25: 語が bull/bear → buy/sell に変わった(ユーザー指定文面)。台帳 a_direction もこの値。 */
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
  /** ★TP(利確幅)を B に尋ねるか。**必須**(渡し忘れが「設定は AI委任なのに尋ねない」という
   *  無言の食い違いになるため、呼ぶ側に必ず宣言させる)。
   *  ★true になるのは 設定が scalpTpEnabled=true かつ scalpTpWidthSource='ai' のときだけ
   *  (解決は server/config/scalpResolvers.ts・判断は呼び出し側の scalpPlan.ts が1箇所で行う)。
   *  ★この1つの値を **プロンプト2本と読み取り1本の3箇所すべて** に渡す=ずれない。 */
  askTp: boolean;
  /** BB スクイーズ判定の生値。版の選択に使う。 */
  squeezeState: SqueezeState;
  /** 判定が使えなかった理由('ready_false'/'closed'/'disabled')。使えたときは undefined。 */
  squeezeUnavailable?: string;
  /** ★2026-08-25(ユーザー指示): **こちらが決めた目線**。指定された回は A を1度も呼ばない。
   *  「手動」= 買い目線/売り目線/レンジ を設定で固定したとき(server/config/scalpResolvers.ts の
   *  resolveForcedTrend)。null/undefined = 従来どおり A に尋ねる。 */
  forcedTrend?: ATrend | null;
  // ★2026-08-22 訂正(リーダー指摘): 一度 delegationNote を SplitPlanOptions に足して B へ渡したが、
  //   取り消した。理由: buildDelegationNote の文面は「上のロジック」「上の2択」「direction」
  //   「regime」「confidence」など、B には存在しないブロック/フィールドへの参照を大量に含み、
  //   分割の芯(side は AI に返させない・返す場所を作らない)と正面衝突する。実測で
  //   B が {"direction":"none","regime":"range","confidence":0.3,...} のような契約外の JSON を
  //   返し、読み取りが拾えず none_reason='aiSilent'(B の故障)に化けることを確認した
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
  /** ★段5: A(目線)を答えたプロバイダ。A の呼び出しが失敗して一度も応答が来なかった回は undefined。
   *  ★2026-08-25: **手動目線の回も undefined**(A を1度も呼んでいない)。
   *    台帳で「AI が答えた目線」と「こちらが決めた目線」を分けるときは a_provider の有無で切れる。 */
  aProvider?: AnsweringProvider;
  /** ★2026-08-25(記録専用): その回の目線を **こちらが決めた**(手動)か。true=A を呼んでいない。
   *  ★画面はこれを見て「理由なしで目線だけ」を出す(AI の言葉でない理由を名乗らせない)。 */
  aForced?: boolean;
  /** ★段5: B(価格と損切幅)を答えたプロバイダ。B を呼ばなかった回(bVariant='none')は undefined。
   *  ★A と別に持つ理由: callWithFallback は呼び出しごとにプールを引くため、A を gemini・B を groq が
   *    答える組み合わせが起こる。1つの provider に混ぜて残すと「どちらが答えたか」が分からなくなる。 */
  bProvider?: AnsweringProvider;
  /** ★段5: A のプロンプトの型の指紋(pb1・データを含まない)。★scalpPlanSplit.ts はここでは設定しない
   *  (呼び出し側=scalpPlanRunner.ts が bVariant 確定後に abPromptBuild.ts で計算して埋める)。 */
  aPromptBuild?: string;
  /** ★段5: B のプロンプトの型の指紋。bVariant='none'(B を呼んでいない)回は未設定のまま。 */
  bPromptBuild?: string;
  /** ★2026-08-30: その回に **実際に TP幅を尋ねたか**(=B の文面が6版のどれか)。
   *  ★**設定の写しではなく実測**: 設定が 'ai' でもレンジ2版では尋ねない(tpAskable)ので false になる。
   *  ★B を呼ばなかった回(bVariant='none')は未設定。★指紋(bPromptBuild)は
   *  呼び出し側(scalpPlanRunner.ts)が bVariant と この値の組で引くので、両方が要る。
   *  ★台帳 signal_plans.tp_source(ai/manual)は **この値から導く**(設定を直接引かない)。 */
  bAskTp?: boolean;
  /** ★2026-08-30(記録専用): **TP幅を読めなかった/曖昧だった** 理由(両脚ぶんを1文に連結)。
   *
   *  ★TP は脚を落とす理由に **しない**(落とすと「TP を足したせいで脚が減る」= 避けたい回帰そのもの)。
   *    しかし落とさないだけだと、読めなかった事実が **どこにも残らない**(脚が立った回は LegDrop が
   *    作られないため)。★無音の失敗を作らないために、この列で数えられるようにする(台帳 tp_read_issue)。
   *  ★aiWhy / missingData とは別物・混ぜない: あちらは AI の言葉、こちらは **こちらの読み取りの失敗**。 */
  tpReadIssue?: string;
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

  // ── ①' ★こちらが目線を決めている回は A を **呼ばない**(2026-08-25・ユーザー指示) ─────
  //   「プロンプトAはAIに渡さず、表示は理由なしで、選択された目線を表示してください。
  //     目線に応じた、プロンプトBのみをAIに渡します。」
  //   ★早期 return にせず「A の呼び出しだけを飛ばす」形にした理由:
  //     ②レンジ不許可 / ③版の選択 / ④B / ⑤組み立て の分岐を **1行も変えずに** 共有できる。
  //     早期 return で B 側を別関数へ切り出すと、同じ判断が2箇所に増える(片方だけ直す事故の元)。
  //   ★理由(aWhy)は付けない: こちらが決めた目線に「AI の言葉の理由」は存在しない。
  //     推測で理由を作ると、台帳の a_why が「AI が言った理由」でなくなる。
  const forced = opts.forcedTrend ?? null;

  // ── ① A(目線) ────────────────────────────────────────────────────────────
  let aRes: SplitCallResult = { text: '', toolCalls: 0 };
  if (!forced) try {
    // ★2026-08-25: A のプロンプトは **設定(rangeEnabled)の関数**。レンジ無効のときは
    //   range という選択肢そのものを出さない(=下の ② はほぼ死に条項になるが、防御として残す)。
    aRes = await deps.callTrend(
      buildTrendSystemPrompt(opts.trendContext, opts.rangeEnabled),
      buildTrendUserPrompt(opts.rangeEnabled),
    );
  } catch (e) {
    // ★A の失敗は「相場が悪かった」ではない。★**B を投げず・再試行せず**に見送る。
    //   ★手動目線の回はここへ来ない(A を呼んでいないので失敗しようがない)。
    console.warn('[scalp-plan] A(目線)の呼び出しに失敗 — B は呼ばず見送り:', e instanceof Error ? e.message : String(e));
    return {
      parsed: withReason(nonePlan(refPrice, '目線の判断が得られませんでした(呼び出し失敗)。'), 'aFailed'),
      record: { ...baseRecord, bVariant: 'none' },
    };
  }
  // ★手動目線の回は parse を通さない(読む文字列がそもそも無い)。
  const answer = forced ? { direction: forced } : parseTrendAnswer(aRes.text);
  if (!answer) {
    // 3語のどれでもない/読めない。★これも aFailed(相場のせいではない)。
    // ★2026-08-25(エバリュエーター指摘(h)): **何と答えたのか** を残す。
    //   この経路は aRecord を作る前なので a_direction も a_why も NULL になり、従来は
    //   aFailed の件数が増えることでしか気づけなかった。★語彙を bull/bear → buy/sell に
    //   切り替えた直後は「先祖返り」と「別の壊れ方」を区別できる必要がある。
    //   ★列は増やさない: 既に台帳へ落ちている rationale に、**direction の値だけ** を足す
    //   (自由文は持ち出さない=モデルの生出力を台帳へ運ばない既存の方針)。
    const raw = rawDirectionOf(aRes.text);
    console.warn(`[scalp-plan] A(目線)の答えが3語のどれでもない — B は呼ばず見送り${raw ? ` (答え: "${raw}")` : ''}`);
    return {
      parsed: withReason(nonePlan(refPrice,
        `目線の判断が得られませんでした(答えが規定の3語でない${raw ? `: "${raw}"` : ''})。`), 'aFailed'),
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
    // ★2026-08-25: 「こちらが決めた目線」の回に印を付ける(a_provider が無いこととの二重の手掛かり)。
    ...(forced ? { aForced: true } : {}),
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
  //   ★askTp は **同じ1つの値** を system / user / 読み取り の3箇所へ渡す
  //     (プロンプトが尋ねているのに読み取りが読まない、という食い違いを構造的に作らない)。
  //   ★★設定(opts.askTp)と **版** の AND をここで1回だけ解く(effectiveAskTp)。
  //     レンジ2版は受け取っても置き場所が無いので尋ねない(リーダー裁定1)。
  //     ★以降はこの askTp だけを使う。opts.askTp を直接読まない。
  const askTp = effectiveAskTp(variant, opts.askTp);
  const bRes = await deps.callOrder(
    buildBSystemPrompt(variant, opts.floorYen, opts.ceilingYen, opts.orderContext, askTp),
    buildBUserPrompt(variant, refPrice, opts.floorYen, opts.ceilingYen, askTp),
  );
  const provider = bRes.provider ?? aRes.provider;
  const toolCalls = addCalls(aRes.toolCalls, bRes.toolCalls);
  const rec = {
    ...aRecord, bVariant: variant, ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(bRes.provider ? { bProvider: bRes.provider } : {}),
    // ★B を呼んだ回にだけ入る(呼ばなかった回は undefined=「尋ねていない」ではなく「B が無い」)。
    //   ★入れるのは **実際に尋ねた値**(版で正規化した後)。設定の写しではない。
    bAskTp: askTp,
  };

  // ★2026-08-25: B の応答は **自由文**。読み取りは注文タイプの語だけで脚を決め、
  //   読めなかった脚は理由を残す(黙って別の脚へ入れない)。
  const bAnswer = parseBFreeText(bRes.text, variant, askTp);
  if (!bAnswer) {
    // ★空応答。**B の故障** であって相場ではない。
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
  // ★TP の読み取り失敗(あ/い)を1文に。★尋ねていない回(askTp=false)は readIssues.aTp/iTp が
  //   そもそも設定されないので、必ず undefined = 列は NULL(=「尋ねていない」が形から読める)。
  const tpReadIssue = [bAnswer.readIssues?.aTp, bAnswer.readIssues?.iTp]
    .filter((x): x is string => typeof x === 'string' && x.length > 0).join(' / ') || undefined;
  const record: SplitRecord = {
    ...rec,
    ...(bAnswer.strategy ? { bStrategy: bAnswer.strategy } : {}),
    ...(aiWhy ? { aiWhy } : {}),
    // ★段6: 見送ったかどうかに関わらず、B が「足りなかったデータ」を書けばそのまま記録する。
    ...(bAnswer.missingData ? { missingData: bAnswer.missingData } : {}),
    // ★2026-08-30(記録専用): TP幅の読み取り失敗。★脚は落とさないので、ここで拾わないと
    //   どこにも残らない(=無音の失敗)。両脚ぶんを ' / ' で連結する
    //   (どちらの脚かは文の先頭の「逆指値買い」等で読める=既存の readIssues と同じ書式)。
    ...(tpReadIssue ? { tpReadIssue } : {}),
  };

  // ★2026-08-25(記録専用): 読み取り段で立たなかった脚を legDrops として運ぶ。
  //   ★下流(scalpPlan.ts)は `[...(parsed.legDrops ?? []), ...(enforced.legDrops ?? [])]` で
  //     そのまま leg_drops_json へ落とす=**配線を1行も足さずに** 「読めなかった」が台帳に残る。
  const legDropsField = built.legDrops.length ? { legDrops: built.legDrops } : {};

  // ★v0.9.103(RECORD-ONLY): 申告 LC幅/向き の突き合わせを **旧経路と同じ器** に載せる。
  //   ★実測(複製 signal_plans 3,008行): v0.9.96〜v0.9.102 の lc_audit_json は **全行 NULL** だった。
  //     原因はここ——分割経路は parsed を自前で組み立てており lcAudit を一度も設定していなかった
  //     (旧経路 scalpPlan.ts の lcAuditFor を通らない)。a_direction が入り始めた版と完全に一致する。
  //   ★下流(scalpPlan.ts:3353 の `if (parsed.lcAudit?.length) out.lcAudit = parsed.lcAudit;`)は
  //     1行も足さずにそのまま台帳へ落とす。★中身は buildPlanFromBAnswer が
  //     **ずらし(applyPivotNudge)より前** の生の値から採っている。
  const lcAuditField = built.lcAudit ? { lcAudit: built.lcAudit } : {};

  if (built.bothDropped) {
    // ★理由が有る=AI の判断('ai') / 理由も無い=無言の故障('aiSilent')。
    const reason: NoneReason = aiWhy ? 'ai' : 'aiSilent';
    return {
      parsed: { ...withReason(built.plan, reason), ...legDropsField, ...lcAuditField },
      record, ...(provider ? { provider } : {}),
    };
  }
  return {
    parsed: { ok: true, plan: built.plan, ...legDropsField, ...lcAuditField },
    record, ...(provider ? { provider } : {}),
  };
}

/** 画面と台帳に出す根拠文。★機械生成の注記は下流(buildLegNote)が足すので、ここは AI の言葉だけ。 */
export function buildRationale(a: ReturnType<typeof parseBFreeText>, variant: BVariant): string {
  if (!a) return '';
  const parts: string[] = [];
  if (a.strategy) parts.push(a.strategy);
  const spec = B_VARIANTS[variant];
  if (a.aWhy) parts.push(`${spec.legs.a.orderJa}: ${a.aWhy}`);
  if (a.iWhy) parts.push(`${spec.legs.i.orderJa}: ${a.iWhy}`);
  return parts.join(' / ');
}
