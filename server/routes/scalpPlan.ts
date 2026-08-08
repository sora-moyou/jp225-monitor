import type { NextFunction, Request, Response } from 'express';
import { runScalpPlanWithChart } from '../llm/scalpPlanRunner.js';
// 型だけの import(実行時には消える)。route テストが '../llm/openai.js' をモックしていても影響しない。
import type { ScalpPlanResult } from '../llm/openai.js';
import { normalizeCaller, DEFAULT_CALLER } from '../llm/caller.js';
import {
  normalizeExitVariant, loadExitImpl, DEFAULT_EXIT_VARIANT, type ExitVariant,
} from '../signalTrade/exit/index.js';
import { exitVariantImplKind } from '../signalTrade/exitVariantImpl.js';
import { checkGeneratorGate } from '../llm/generatorGate.js';
import { inPollWindow } from '../../core/session.js';
import { isAnalysisEnabled } from '../analysisGate.js';

// ★実際の呼び出し元(2026-08-02 に実確認):
//   - **trade2 は叩いていない**。trade2 は monitor のシグナルを SSE / `/api/current-signal` で追従するだけで、
//     コード上のヒットは全てコメント(`src/strategy/levelBracket.ts:525`・`src/backtest/run.ts:10`)だった。
//     かつては trade2 が自前で AI 要求(planner.ts)を持っていた名残の記述で、現在は事実と異なる。
//   - monitor 自身のシグナルエンジン(server/signalTrade/engine.ts)は HTTP を経由せず
//     共通関数 runScalpPlanWithChart を **直呼び**する(この route は通らない)。
//   - よって現状この route を叩くのは **手動診断**と、これから追加する **提案生成器(caller='generator')** のみ。
//
// 兄弟アプリ jp225-trade2(AI トレーダー)向けとして作られた route。monitor の LLM を固定のスキャル戦略質問で走らせ、
// buildMonitorContext + データツール + 既存プロバイダ/キーを再利用して構造化プラン(AiPlan)を返す。
// v0.7.22: ビジョン対応プロバイダ(Gemini/OpenAI)時は当日チャートのスクリーンショットを添付し、
// AI が「実際にチャートを見て」方向・指値/逆指値を決められるようにする。
//
// 「チャート撮影→(無ければ chart-not-generated 見送り)→buildScalpPlan(画像込み)」のコアは
// runScalpPlanWithChart(共通関数・server/llm/scalpPlanRunner.ts)に集約。この route は
// req の LC override を解釈して共通関数へ渡し、結果をそのまま返す薄いラッパ。
// シグナルエンジン(server/signalTrade/engine.ts)も同じ共通関数を呼ぶ＝両経路で提案が一致する。

interface Body {
  symbol?: string;
  /** 初期 LC(損切り)幅の下限[円]。未指定は monitor 設定(既定55)。数値化して optional で受理する。
   *  ★これは「より厳しくする」要求としてのみ効く: buildScalpPlan(clampRequestedLcFloor)が設定値で床止めするので、
   *    設定より小さい値を送っても下限は緩まない(下限は AI にも外部にも委任しない唯一の制約)。 */
  lcFloorYen?: number;
  /** 初期 LC(損切り)幅の上限[円]。未指定は buildScalpPlan 側の既定(65)。これを超える損切りは出さない。 */
  lcCeilingYen?: number;
  /** ★呼び出し元の識別子。**省略時は 'default'**(既存の呼び出しは完全に従来どおり)。
   *  'generator' を指定した時だけ、プロバイダ・プール / backpressure / 日次予算 が分離される。 */
  caller?: unknown;
  /** ★決済仕様の「名前付き変種」。**省略時は現行**(既存の呼び出し元は byte 不変)。
   *  ★設計上の要点: **決済の数値をリクエストに載せない**。ここに載るのは名前
   *  ('current' | 'candidate-a')だけで、名前 → 実数値の解決は monitor プロセス内の
   *  非公開定義が行う。だからリクエスト・アクセスログ・エラーメッセージに実数値は出ない。
   *  不正な名前は **400**(caller と同じ扱い。黙って現行に倒すと実験が静かに壊れる)。 */
  exitVariant?: unknown;
}

/** body/query から数値を optional に受理する(文字列でも数値化)。非有限は undefined を返し、既定に委ねる。
 *  範囲/floor<=ceiling のクランプは buildScalpPlan 側 resolveLcRange が、
 *  「設定値の下限を下回らせない」床止めは同 clampRequestedLcFloor が担う(単一責務)。 */
function optionalNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// ─── ★場外(取引セッション外)の生成器要求を **撮影より前に** 弾く ─────────────
//
// runScalpPlanWithChart は refPrice の鮮度判定(scalpPlan.ts)より **先に** チャートを撮る。
// つまり場外の無意味な要求でも毎回 Chrome が起動し(実測1撮影あたりイベントループが 286ms 停止)、
// その後 refPrice が古くて捨てられる。さらに generatorGate の roll() は場外でも直前のセッションキーを
// 保持する(=予算がリセットされない正しい設計)ため、15:45〜17:00 の 75 分や週末の要求が
// **その取引日の予算をそのまま食う**。どちらも「撮る前に弾く」だけで消える。
//
// ★実弾(A)につながる経路は一切通さない: 判定するのは caller='generator' の要求だけで、
//   caller 省略/'default'(シグナルエンジン・手動診断・既存の呼び出し元)は素通しする。
//   既存の「時間外でも通る」挙動(server/llm/refPriceGate.test.ts の注記)は default では不変。
//
// ★ミドルウェアとして **ハンドラの前** に置く(server/index.ts で登録)。ハンドラ内に置くと
//   「撮影より前」ではあっても、生成器の関門(予算計上)と順序が絡んで責務が混ざる。

/** 場外の生成器要求か(純関数・now 注入可)。true なら弾く。
 *  不正な caller は **ここでは判定しない**(ハンドラが 400 で理由付きに落とす=誤設定を無音にしない)。 */
export function isGeneratorRequestOutOfSession(body: unknown, query: unknown, now: number): boolean {
  const b = (body ?? {}) as Body;
  const q = (query ?? {}) as Record<string, unknown>;
  const callerResult = normalizeCaller(b.caller ?? q.caller);
  if (!callerResult.ok || callerResult.caller === DEFAULT_CALLER) return false;
  return !inPollWindow(now);
}

/** POST /api/scalp-plan の前段ミドルウェア。場外の生成器要求を 429 で弾く(撮影も LLM も行わない)。 */
export function generatorSessionGate(req: Request, res: Response, next: NextFunction): void {
  if (!isGeneratorRequestOutOfSession(req.body, req.query, Date.now())) {
    next();
    return;
  }
  // 弾いたことは必ず1行残す(無音にしない)。予算は1回も消費していない。
  console.warn('[scalp-plan] 見送り(closed): 取引時間外の生成器要求 → 撮影も LLM も行わない');
  res.status(429).json({ ok: false, error: 'closed', detail: '取引時間外(セッション外)です' });
}

type OkPlanResult = Extract<ScalpPlanResult, { ok: true }>;

/** 応答に載せる「決定台帳」用の付随情報(記録専用)。undefined のフィールドは載せない
 *  (=値が無いことと、そのフィールドを返さない実装であることを混同させない)。
 *  ★on=false(レガシー経路)では **必ず空オブジェクト** を返す=応答は従来と byte 一致。 */
function planDiagnostics(r: OkPlanResult, on: boolean): Partial<OkPlanResult> {
  if (!on) return {};
  const out: Partial<OkPlanResult> = {};
  if (r.vetoFired !== undefined) out.vetoFired = r.vetoFired;
  if (r.noneReason !== undefined) out.noneReason = r.noneReason;
  if (r.noneLegs !== undefined) out.noneLegs = r.noneLegs;
  // ★レッグ1本ごとの脱落理由(片レッグだけ落ちた回を含む)。これが無いと台帳では
  //   「AI が逆指値を提案しなかった」と「向き違反/LC で落とされた」がどちらも stopEntry:null に潰れ、
  //   区別できない(実際にこれで誤った測定が起きた)。数値は AI が出したレッグ価格だけ。
  if (r.legDrops !== undefined) out.legDrops = r.legDrops;
  if (r.rangeAnomaly !== undefined) out.rangeAnomaly = r.rangeAnomaly;
  // ★画像の同一性(撮影の識別子と齢)。①と②が同じ1枚を見たことを、仮定ではなく **記録** にするため。
  //   1サイクルが撮影キャッシュの TTL を超えれば②は別の画像を見るが、これが無いと誰にも分からない。
  if (r.chartShot !== undefined) out.chartShot = r.chartShot;
  // ★プロンプトから外した文脈ブロック(生成器のみ)。1年後の分析者が「この標本は A の紙成績を
  //   見ていない」ことを台帳から読めるように、応答へそのまま載せて生成器に記録させる。
  if (r.contextOmitted !== undefined) out.contextOmitted = r.contextOmitted;
  // ★凍結再生の突合(記録専用): 文脈を組み立てた時刻(monitor の時計)と、送ったプロンプトの指紋。
  //   生成器の台帳が持つ requested_at/responded_at は **生成器プロセスの時計** で、撮影と LLM の待ちを
  //   含んだ両端でしかない。「どの断面から文脈を組んだか」は monitor 側にしか無い値なので応答で渡す。
  //   ★指紋は一方向ハッシュ(`sp1:<16桁hex>`)で、プロンプト本文も決済仕様の数値も一切含まない。
  if (r.contextAt !== undefined) out.contextAt = r.contextAt;
  if (r.promptFp !== undefined) out.promptFp = r.promptFp;
  // ★RECORD-ONLY(v0.9.66): 本線の台帳(signal_plans)に載せているのと **同じ2つの突き合わせ** を
  //   生成器の台帳にも載せる。母集団が揃っていないと A/B の比較ができない(同じ故障は生成器側にも出る)。
  //   lcAudit=申告 LC幅 vs 実出力 / omissionAudit=「出さない」表明 vs 実際に発注されるレッグ。
  //   どちらも数値は AI が出したレッグ価格と幅だけで、非公開の決済仕様は入らない。
  if (r.lcAudit !== undefined) out.lcAudit = r.lcAudit;
  if (r.omissionAudit !== undefined) out.omissionAudit = r.omissionAudit;
  return out;
}

/** ★公開版(lite)で受け付けてはいけない要求か(純関数・テスト対象)。
 *  caller='generator' も exitVariant も **決済パラメータの分析専用** の入口なので、
 *  分析を持たないビルドでは受理せず 400 で落とす(黙って現行に倒すと、実験のつもりの
 *  要求が実弾と同じプール・同じ予算で走ってしまう=このゲートが守るものが壊れる)。
 *  ★caller 省略/'default' かつ exitVariant 省略 = 既存の全経路。lite でも素通し(挙動不変)。 */
export function analysisOnlyRequestField(body: unknown, query: unknown): 'caller' | 'exitVariant' | null {
  const b = (body ?? {}) as Body;
  const q = (query ?? {}) as Record<string, unknown>;
  const rawCaller = b.caller ?? q.caller;
  const rawVariant = b.exitVariant ?? q.exitVariant;
  const specified = (v: unknown): boolean => v !== undefined && v !== null && v !== '';
  if (specified(rawCaller) && rawCaller !== DEFAULT_CALLER) return 'caller';
  if (specified(rawVariant)) return 'exitVariant';
  return null;
}

export async function scalpPlanHandler(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Body;
  const query = (req.query ?? {}) as Record<string, unknown>;

  // ── ★分析用の入口を公開版(lite)で閉じる。**唯一のゲート** isAnalysisEnabled() で判断する。
  //    full では isAnalysisEnabled()===true なので、このブロックは1度も入らない(挙動は byte 不変)。
  if (!isAnalysisEnabled()) {
    const field = analysisOnlyRequestField(body, query);
    if (field !== null) {
      const error = `${field} はこのビルドでは指定できません(分析用の経路を持たない公開版です)`;
      console.warn(`[scalp-plan] 400: ${error}`);
      res.status(400).json({ ok: false, error });
      return;
    }
  }

  const symbol = typeof body.symbol === 'string' && body.symbol ? body.symbol : undefined;
  // 初期 LC 幅の下限/上限を optional で受理(body 優先・なければ query)。範囲/整合クランプは buildScalpPlan 側。
  const lcFloorYen = optionalNumber(body.lcFloorYen ?? query.lcFloorYen);
  const lcCeilingYen = optionalNumber(body.lcCeilingYen ?? query.lcCeilingYen);

  // ── ★呼び出し元の識別(作業1)。この1つの値がプール選択・backpressure・予算計上を駆動する。
  const callerResult = normalizeCaller(body.caller ?? query.caller);
  if (!callerResult.ok) {
    // 未知の caller を黙って default に倒すと、実験系が実弾のプール/予算をそのまま使ってしまう。
    // だから受理せず 400 で落とす(誤設定を無音にしない)。
    res.status(400).json({ ok: false, error: callerResult.error });
    return;
  }
  const caller = callerResult.caller;

  // ── ★決済仕様の変種(作業2)。**名前だけ**を受け取り、実数値の解決は非公開側に閉じる。
  //    省略(未指定/null/空文字)は「要求なし」= buildScalpPlan へ渡さない ⇒ 決済ブロックは従来と byte 一致。
  const rawVariant = body.exitVariant ?? query.exitVariant;
  const variantSpecified = rawVariant !== undefined && rawVariant !== null && rawVariant !== '';
  const variantResult = normalizeExitVariant(rawVariant);
  if (!variantResult.ok) {
    // 未知の変種名を黙って現行に倒すと、「候補仕様で生成した」つもりの標本が実は現行仕様になり、
    // A/B の差が消えたことに誰も気づけない(=実験が静かに壊れる)。だから 400 で落とす。
    res.status(400).json({ ok: false, error: variantResult.error });
    return;
  }
  // ★undefined を渡すことが「従来経路」の意味を持つ(scalpPlan 側が describeExitLogic() をそのまま使う)。
  const exitVariant: ExitVariant | undefined = variantSpecified ? variantResult.variant : undefined;
  // 応答へ「どの変種で生成したか」と「見送り理由」を載せるか。レガシー経路(caller 省略 かつ
  // exitVariant 省略)だけは応答も従来どおりにする(フィールドを増やさない=byte 一致)。
  // 生成器は caller または exitVariant を必ず指定するので、生成器から見れば **常に** 返る=記録に穴が空かない。
  // ★変種のエコーも見送り理由の付随情報も、この1つの条件で揃って on/off する。
  const diagnosticsOn = variantSpecified || caller !== DEFAULT_CALLER;
  const echoVariant = diagnosticsOn ? { exitVariant: variantResult.variant } : {};

  // ── ★変種を要求されたのに **実体が無い** なら 400(未知の変種名と同じ扱い)。
  //    private(非公開実装)が無い環境では変種の説明文が公開フォールバック(数値なし)になり、
  //    'candidate-a' のプロンプトが 'current' とほぼ同一になる。それでも応答は
  //    exitVariant:'candidate-a' を返すので、**実験は何も測っていないのに記録には
  //    「候補仕様で生成した」と残る**。黙って現行に倒すのと全く同じ壊れ方なので、同じ作法で拒否する。
  //    ★'current'(既定)は対象外: 実体が無くても現行仕様として正しく動くので、この壊れ方は起きない。
  if (variantSpecified && variantResult.variant !== DEFAULT_EXIT_VARIANT) {
    await loadExitImpl();   // 冪等(起動時に済んでいれば即返る)。これを経ないと必ずフォールバック判定になる。
    if (exitVariantImplKind(variantResult.variant) === 'fallback') {
      const error = `exitVariant '${variantResult.variant}' はこのビルドでは解決できません(決済仕様の実体が読み込まれていない)`;
      console.warn(`[scalp-plan] 400: ${error}`);
      res.status(400).json({ ok: false, error });
      return;
    }
  }

  // ── ★生成器だけの関門(作業3 backpressure + 作業4 予算/従属)。
  //    caller 省略/'default' はこのブロックを **一切通らない**(既存の呼び出し元に影響ゼロ)。
  //    ★予算は **腕(=決済仕様の変種)ごと** に独立させる。全腕で1本の帳簿だと先着の腕が
  //      取引日の残りを食い切り、標本が Day セッション前半に偏る(=時間帯という既知最大の交絡)。
  if (caller !== DEFAULT_CALLER) {
    const gate = checkGeneratorGate(Date.now(), variantResult.variant);
    if (!gate.allowed) {
      // 429 = 「今は投げるな」。生成器は reason で busy / budget / default-quota / disabled を区別できる。
      // 見送りは checkGeneratorGate 側で必ず1行ログ+カウンタに記録される(無音にしない)。
      res.status(429).json({ ok: false, error: gate.reason, detail: gate.detail });
      return;
    }
  }

  try {
    const result = await runScalpPlanWithChart({ symbol, lcFloorYen, lcCeilingYen, caller, exitVariant });
    if (result.ok) {
      // ★見送りの経路を **応答に載せる**(記録専用・判定には一切影響しない)。
      //   これが無いと direction:'none' のとき、外の記録側は「AI が見送った(ai)」「LC上限で落ちた(lc)」
      //   「下限未満で落ちた(lcFloor)」「トレンド veto(trend)」を区別できない。区別できないと
      //   2本の生成器の見送り率の差が「AI の適応」なのか「enforce の副作用」なのか判別不能になり、
      //   実験の主要比較そのものが成立しない(エンジンは engine.ts でログに出しているが HTTP 越しには届かない)。
      //   ★数値は AI が出したレッグの価格(noneLegs)だけで、決済ラダーの実数値は一切含まれない。
      res.json({ ok: true, plan: result.plan, ...planDiagnostics(result, diagnosticsOn), ...echoVariant });
    } else {
      // キー無し/パース失敗/LLM 失敗/チャート未生成は 200 + ok:false で返す(キーは決して漏らさない)。
      // 見送りも実験の1標本なので、変種名(名前のみ・数値なし)は同じように返す。
      res.json({ ok: false, error: result.error, ...echoVariant });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scalp-plan] error:', msg);
    res.status(500).json({ ok: false, error: msg.slice(0, 200) });
  }
}
