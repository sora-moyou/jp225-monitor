import type { NewsItem, Price } from '../types.js';
import {
  resolveScalpLcFloorDirective, resolveScalpLcCeilingDirective, resolveScalpTrendVetoDirective,
  resolveScalpBiasDirective, resolveScalpRangeDirective, resolveScalpLcHardMax, resolveScalpCooldownDirective,
  resolveScalpAiTechnicalEnabled,
  type ScalpBias, type KnobSource, type SignalProfile,
} from '../configStore.js';
import { describeExitLogic, describeExitLogicVariant, loadExitImpl, type ExitVariant } from '../signalTrade/exit/index.js';
// ★v0.9.44: レンジの形の観測は依存ゼロの leaf(signalTrade/rangeShape.ts)に置く。engine.ts が LLM スタックを
//   遅延ロードしている設計を壊さないため(engine は result.rangeAnomaly を読むだけ=静的 import 不要)。
import { describeRangeAnomaly, type RangeAnomaly } from '../signalTrade/rangeShape.js';
import { BB_BAND_LABEL } from '../../core/indicatorSpec.js';
import { describeBandwalk, type Bandwalk } from '../bandwalk.js';
// 型だけの import(実行時に消える)。scalpPlan は撮影モジュールを実行時には一切呼ばない。
import type { ChartShotIdentity } from '../chart/chartShot.js';
import { callWithFallback, isLLMEnabled, isVisionCapableProvider } from './providers.js';
import { DEFAULT_CALLER, type LlmCaller } from './caller.js';
import { isWebSearchEnabled, webSearch } from './webSearch.js';
import { getPrices } from '../cache.js';
import {
  NIKKEI_SYMBOL, buildMonitorContext, formatPricesForChat, formatNewsForChat,
  buildDataToolHandlers, runChatWithTools,
  EXPLAIN_MOVE_TOOL, QUERY_ALERTS_TOOL, PRICE_HISTORY_TOOL, WEB_SEARCH_TOOL,
  type ToolHandlers, type CreateFn,
} from './dataTools.js';

// ─── スキャル計画 (POST /api/scalp-plan) ─────────────────────────────
// 兄弟アプリ jp225-trade2(AI トレーダー)が呼ぶ。monitor の LLM を「固定のスキャル戦略質問」で走らせ、
// buildMonitorContext + データツール(explain_move/query_alerts/price_history/web_search)を使って
// ライブデータに基づく構造化プランを返す。既存の chat と同じプロバイダ選択・キー解決・tool ループを再利用する。

/** レンジ両面ストラドルの1レッグ(実験・紙で別枠計測)。現在値の上/下に1つずつ置く。
 *  side=buy/sell × type=limit(レンジ内逆張り指値)/stop(抜け追随逆指値)。entry=新規価格・stopLoss=初期LC。 */
export interface RangeLeg {
  side: 'buy' | 'sell';
  type: 'limit' | 'stop';
  entry: number;
  stopLoss: number;
}

/** trade2 が受け取る構造化スキャルプラン。
 *  direction==='none' は「見送り(良い場面が無い)」で、価格フィールドは不要(rationale + refPrice のみ)。
 *  direction==='range' は「レンジ両面ストラドル」で、range に上下2レッグ(片レッグ落ちも可)を持つ。 */
export interface AiPlan {
  direction: 'buy' | 'sell' | 'none' | 'range';
  limitEntry?: number;        // 指値(押し目/戻り側の新規)。none/range の時は不要。
  stopEntry?: number;         // 逆指値(ブレイク側の新規)。none/range の時は不要。
  stopLossForLimit?: number;  // 指値約定時の損切り逆指値。none/range の時は不要。
  stopLossForStop?: number;   // 逆指値約定時の損切り逆指値。none/range の時は不要。
  rationale: string;         // 判断理由(日本語)。none の時は見送り理由。
  refPrice: number;          // 計画時に見た現在値(NIY=F)
  // ★AI自己レジーム/確信度(v0.7.54・記録のみ=ゲートには使わない)。AI が「まず自分で相場観を述べてから
  //   計画を出す」ための構造化出力。欠落/不正は undefined(後方互換)。決済時に signal_trades.meta へ保存し、
  //   後で「確信度は勝率と相関するか」「自己regimeは実際と合うか」を実測する。
  regime?: 'trend_up' | 'trend_down' | 'range' | 'unclear';
  confidence?: number;       // 0-100(この計画/レジーム判断への確信度)。
  // direction==='range' の時のみ。upper.entry>refPrice>lower.entry。enforce/parse で片レッグに
  // 落ちることがある(その場合 upper か lower が undefined=実質片面)。
  range?: { upper?: RangeLeg; lower?: RangeLeg };
}

/** ★v0.9.44: 見送り(none)に至った経路(記録専用)。判定・採否・SSE・決済には一切影響しない。
 *  従来 engine のログは veto=y/n の1ビットしか区別できず、8通りの経路が同じ見た目になっていた。
 *  - 'ai'            : AI 自身が direction:"none" を返した(良い場面が無い)
 *  - 'geometry'      : エントリーが refPrice の反対側(売りなのに指値が現在値の下 等)で両レッグ落ち
 *  - 'stopSide'      : 損切りがエントリーの内側/反対側で両レッグ落ち
 *  - 'lc'            : 初期LC幅が上限超で両レッグ落ち
 *  - 'lcFloor'       : ★初期LC幅が下限未満で両レッグ落ち(下限は委任対象外=常に強制)
 *  - 'bias'          : バイアス veto(long なのに sell / short なのに buy)
 *  - 'trend'         : トレンド veto(強上昇に逆行する sell / 強下降に逆行する buy)
 *  - 'rangeDisabled' : レンジ無効設定なのに range が返った(防御多重化)
 *  - 'missing'       : AI がレッグを出さなかった / 壊れた形だった
 *  - 'stale'         : ★ARM 時点の live 価格では既にエントリーを通過していて全レッグ落ち(engine の
 *                      stale plan veto=checkStaleLegs。plan 段では起きない=engine のログ専用の値) */
export type NoneReason = 'ai' | 'geometry' | 'stopSide' | 'lc' | 'lcFloor' | 'bias' | 'trend' | 'rangeDisabled' | 'missing' | 'stale';

/** 見送り(none)時に「AI が出したが最終プランに残らなかった」レッグの生数値(記録専用)。
 *  ログ1行に出すことで、根拠文(rationale)から価格を推定する必要を無くす。 */
export interface NoneLeg {
  name: 'limit' | 'stop' | 'upper' | 'lower';
  entry: number;
  stopLoss?: number;
  ok: boolean;    // そのレッグ自体は検証を通っていたか(bias/trend の全体 veto では true になりうる)
}
/** none 化される前に AI が出した direction と、そのレッグ群(記録専用)。 */
export interface NoneLegs { dir: 'buy' | 'sell' | 'range'; legs: NoneLeg[]; }

/** ★v0.9.57(記録専用): **レッグ1本ごと** の脱落。noneLegs が「両レッグ落ちて none になった回」しか
 *  残さないため、**片レッグだけ落ちた回**(=最終プランは成立しているが逆指値だけ消えた 等)は
 *  理由が構造的に残らず、根拠文の日本語(「（逆指値レッグは条件を満たさず不採用）」)しか手掛かりが無かった。
 *  その結果、台帳では「AI が逆指値を出さなかった(missing)」と「向き違反で落とした(geometry/stopSide)」が
 *  どちらも stopEntry:null に潰れて区別できず、実際に誤った測定(見送り行だけを grep して分母が偏る)が起きた。
 *
 *  ★意味づけ: 「そのステージが受け取っていたレッグを、どの検証で落としたか」。
 *    - parse 段: AI が出さなかったレッグも 'missing' として1件残す(=「提案しなかった」を明示的に記録する)。
 *    - enforce 段: **受け取った時点で在ったレッグだけ** を対象にする(parse で既に落ちた/不在のレッグは
 *      ここでは何も落としていないので記録しない=同じ事実を二重に数えない)。
 *  ★理由の語彙は既存の NoneReason をそのまま使う(新しい語彙を作らない)。実際に現れるのは
 *    'missing' / 'stopSide' / 'geometry'(parse 段)と 'stopSide' / 'lc' / 'lcFloor' / 'trend' / 'bias'(enforce 段)。
 *  ★記録専用: 採否・価格・veto・SSE・決済には一切影響しない。 */
export interface LegDrop {
  /** どのレッグか(NoneLeg と同じ語彙)。 */
  name: NoneLeg['name'];
  /** どの検証で落ちたか(NoneReason の語彙をそのまま再利用)。 */
  reason: NoneReason;
  /** AI が出していたエントリー価格。reason='missing'(そもそも出していない)では undefined。 */
  entry?: number;
  /** AI が出していた損切り価格。無ければ undefined。 */
  stopLoss?: number;
}

// vetoFired(v0.7.54): buildScalpPlan が enforcePlanConstraints のトレンド veto が発火したかを surface する
//   (挙動は不変=記録のみ)。regime/confidence は plan 側に載る。engine が meta へ保存し A/B 計測に使う。
// noneReason/noneLegs(v0.9.44): 見送り(none)の経路と落としたレッグの生数値(記録のみ=engine のログ用)。
// rangeAnomaly(v0.9.44): レンジが規約(2択・組を混ぜない)に反する形で届いたか。★必ず **AI の生出力(parse 直後)**
//   に対して判定した結果を載せる(enforce 後だと veto/bias で片脚が落ちて観測できなくなる)。記録のみ。
// chartShot(v0.9.51): ★①と②が **同じ画像を見たか** を仮定でなく記録にするための識別子と齢。
//   scalpPlanRunner が caller!=='default' のときだけ載せる(既存の呼び出し元のオブジェクトは byte 不変)。
//   記録専用で、判定にも決済にも一切影響しない。型は撮影側(chart/chartShot.ts)が SSOT。
// contextOmitted: ★プロンプトから **外した** 文脈ブロックの名前(記録専用)。
//   scalpPlanRunner が caller!=='default'(生成器)のときだけ載せる=既存の呼び出し元は byte 不変。
//   生成器では両腕とも紙成績の履歴を外している(母集団の独立性。理由は scalpPlanRunner.ts の
//   GENERATOR_OMITTED_CONTEXT)。この情報が無い記録は「外していない版で取った標本」を意味する。
// legDrops(v0.9.57): ★**片レッグだけ** 落ちた回も含む、レッグ1本ごとの脱落理由(記録のみ)。
//   noneLegs(両レッグ落ち=none のときだけ)とは別のフィールドで、意味も形も互いに変えない。
export type ScalpPlanResult =
  | { ok: true; plan: AiPlan; vetoFired?: boolean; noneReason?: NoneReason; noneLegs?: NoneLegs; legDrops?: readonly LegDrop[]; rangeAnomaly?: RangeAnomaly; chartShot?: ChartShotIdentity; contextOmitted?: readonly string[] }
  | { ok: false; error: string };

// 見送り理由の優先順位(記録専用)。2レッグで理由が異なるとき、より上流(先に適用される)ステージを採る。
// トレンド/バイアスは plan 全体の veto、LC は制約、geometry/stopSide は AI 応答の幾何、missing は不提示。
// 'stale' は plan 段では発生しない(engine の ARM 直前ガード=最下流)ため末尾に置く。
const NONE_REASON_PRIORITY: NoneReason[] =
  ['trend', 'bias', 'lc', 'lcFloor', 'geometry', 'stopSide', 'missing', 'rangeDisabled', 'ai', 'stale'];

/** 2レッグ分の脱落理由から、ログに載せる代表理由を1つ選ぶ純関数(記録専用)。両方 null なら undefined。 */
export function pickNoneReason(a: NoneReason | null, b: NoneReason | null): NoneReason | undefined {
  const cand = [a, b].filter((x): x is NoneReason => x != null);
  if (cand.length === 0) return undefined;
  return cand.sort((x, y) => NONE_REASON_PRIORITY.indexOf(x) - NONE_REASON_PRIORITY.indexOf(y))[0];
}

/** レンジ2脚の生数値を診断用 NoneLegs にする(記録専用)。AI が出さなかった脚は含めない。 */
function noneLegsFromRange(
  upper0: RangeLeg | null | undefined, lower0: RangeLeg | null | undefined, ok = false,
): NoneLegs | undefined {
  const legs: NoneLeg[] = [];
  if (upper0) legs.push({ name: 'upper', entry: upper0.entry, stopLoss: upper0.stopLoss, ok });
  if (lower0) legs.push({ name: 'lower', entry: lower0.entry, stopLoss: lower0.stopLoss, ok });
  return legs.length ? { dir: 'range', legs } : undefined;
}

/** directional(buy/sell)2脚の生数値を診断用 NoneLegs にする(記録専用)。価格が無い脚は含めない。 */
function noneLegsFromDirectional(
  dir: 'buy' | 'sell',
  v: { limitEntry?: number | null; stopLossForLimit?: number | null; stopEntry?: number | null; stopLossForStop?: number | null },
  limitOk: boolean, stopOk: boolean,
): NoneLegs | undefined {
  const legs: NoneLeg[] = [];
  if (v.limitEntry != null) legs.push({ name: 'limit', entry: v.limitEntry, stopLoss: v.stopLossForLimit ?? undefined, ok: limitOk });
  if (v.stopEntry != null) legs.push({ name: 'stop', entry: v.stopEntry, stopLoss: v.stopLossForStop ?? undefined, ok: stopOk });
  return legs.length ? { dir, legs } : undefined;
}

/** レッグ1本ぶんの脱落を記録用の配列へ足す純関数(記録専用)。reason が null(落ちていない)なら何もしない。
 *  価格は分かる時だけ載せる(missing では entry/stopLoss を持たない=「出していない」ことが形からも読める)。 */
function pushLegDrop(
  out: LegDrop[], name: LegDrop['name'], reason: NoneReason | null,
  entry?: number | null, stopLoss?: number | null,
): void {
  if (reason === null) return;
  const d: LegDrop = { name, reason };
  if (entry != null && Number.isFinite(entry)) d.entry = entry;
  if (stopLoss != null && Number.isFinite(stopLoss)) d.stopLoss = stopLoss;
  out.push(d);
}

// 初期 LC(損切り)幅の既定レンジ。呼び出し側が /api/scalp-plan で lcFloorYen/lcCeilingYen を
// 指定しない時のフォールバック(旧記述の「trade2」は誤り。呼び出し元は上の注記を参照)。★v0.7.39: 旧「原則45〜75/上限95」の二段を撤去し、
// 単一上限「下限〜65 に収める・65 超は出さない」へ collapse。パラメータで上下限を可変にする。
// ★下限の既定は configStore の PARAM_BOUNDS.scalpLcFloorYen.default と同値に揃える(現行 55)。
//   実経路(buildScalpPlan)は必ず設定値を渡すので、この定数は引数省略時のフォールバックのみ。
export const DEFAULT_LC_FLOOR_YEN = 55;
export const DEFAULT_LC_CEILING_YEN = 65;

// ─── ★v0.9.56: LC 上限の「提示」を実効値に揃える(保存値のアンカー化を止める) ─────────────
//
// ★実測(同じ相場・同じ節目データで提示だけを変えた 6+3 サンプル):
//   「下限55 / 上限65【AI委任】/ 安全上限159」と提示 → 出力 LC 幅 60,60,60,60,60,58(6レッグ全部 58〜60)。
//     AI の説明は「本来幅55円+緩衝5円=60円」「55〜65円の許容帯の中央付近」= **委任しても 65 を実質の上限として読む**。
//   「55〜159 の範囲」と提示   → 出力 LC 幅 65,75,110,125,80,70,90,100(65〜125・中央値85)。
//     説明も「63250 の強いレジスタンスの上に余裕を持たせた結果として65円」= **節目起点でレッグごとに変わる**。
//   原因: 保存値(65)がプロンプト内で 8 箇所も反復される一方、「あなたが決めてよい」は委任ノートの1文だけだった。
//   帰結: プロンプト自身が指示する「隣接の節目が弱ければ一段先の強い節目まで引きつける」が、幅が 60 に固着して実行不能だった。
//
// ★方針: 上限が AI委任のときは **保存値を一切印字しない**。代わりにコードが実際に強制する上限
//   (lcEffectiveCeiling = 安全上限が有効ならその値 / 無効なら背骨 LC_YEN_MAX)を「下限〜上限の範囲」として提示する。
//   手動のときは従来どおり保存値をそのまま印字する(byte 一致)。
/** LC 上限の提示モード。delegated=false(既定)は従来と byte 一致。 */
export interface LcCeilingPresentation {
  /** 上限が AI委任か。true=「下限〜上限の範囲で相場構造に応じて決める」形で提示する。 */
  delegated: boolean;
  /** 委任時に提示する上限の呼び名。安全上限 有効='安全上限' / 無効='コード上限'(背骨 LC_YEN_MAX)。 */
  capLabel: string;
}
/** 手動(既定)。この値で呼ぶ限り全てのプロンプト生成は従来と byte 一致する。 */
export const LC_CEIL_MANUAL: LcCeilingPresentation = { delegated: false, capLabel: '安全上限' };

/** 設定(上限の値・委任モード・LC安全上限)から「プロンプトに印字してよい上限」を決める(純関数・SSOT)。
 *  - 手動: 保存値をそのまま返す(=従来と完全一致。実効上限との差は enforce 側が担保する)。
 *  - 委任: 保存値は返さず、実際に強制される上限(安全上限 有効=その値 / 無効=LC_YEN_MAX)を返す。 */
export function resolveLcPresentation(opts: {
  floorYen: number; ceilingYen: number; ceilingMode?: KnobSource; lcHardMax?: LcHardMax;
}): { floorYen: number; ceilingYen: number; ceil: LcCeilingPresentation } {
  if (opts.ceilingMode !== 'ai') return { floorYen: opts.floorYen, ceilingYen: opts.ceilingYen, ceil: LC_CEIL_MANUAL };
  return {
    floorYen: opts.floorYen,
    ceilingYen: lcEffectiveCeiling({ ceilingYen: opts.ceilingYen, ceilingMode: 'ai', lcHardMax: opts.lcHardMax }),
    ceil: { delegated: true, capLabel: opts.lcHardMax?.enabled ? '安全上限' : 'コード上限' },
  };
}

/** ★③ 導出の順序(節目 → ストップ位置 → 幅)。A(委任)/B(手動)で完全に同一の1文。
 *  「幅を先に決めて節目に当てはめる」誤りを名指しで禁じる(実測でこれが起きていた=両レッグ常に同じ幅)。
 *  ★v0.9.61: 実測(2026-08-05)の根拠文 —「指値はサポートの5円上、ブレイク新規はレジスタンスの0〜5円上に設定」
 *    「サポートを考慮し、指値とブレイク新規を設定した」— が示したのは、AI が **エントリーと損切りを同じ節目から**
 *    導いていたこと。旧文は「①根拠にする節目を選ぶ」としか言っておらず、それが **エントリーの節目とは別** だとは
 *    どこにも書いていなかった。同じ節目を両方の基準にすると LC幅は緩衝ぶん(5〜10円)にしかならない=下限と
 *    数学的に両立しない。よって「損切りの節目は別(もう一段外側)」「どれだけ外側かは下限が決める」を①③に置く。 */
export const LC_DERIVATION_ORDER =
  '★【導出の順序(必ずこの順)】①損切りの根拠にする節目/スイングを選ぶ。★これは **エントリーの根拠にした節目とは別** の、'
  + '通常はもう一段外側(買いは下・売りは上)の節目である → ②その節目のさらに外側へ緩衝ぶんだけ離して損切り価格を置く → '
  + '③LC幅(|エントリー − 損切り|)を引き算して数え、下限に届かなければ ①へ戻り もう一段外側の節目を選び直す(上限超なら一段内側)。'
  // ★v0.9.63(削除): 「エントリーと損切りが同じ節目だと幅は数円」「レッグごと・場面ごとに幅が違ってよい(毎回ほぼ同じ幅なら
  //   数値から逆算している)」の2文は、【実出力に在った誤り】の ✗③ / ✗④⑤ が **実際に起きた形として** 同じことを言う。
  //   規則を散文で足すのが3版続けて効かなかったので、抽象文を例に置き換える(規則は1つも失われていない)。
  + 'LC幅は結果であって出発点ではない。先に幅(下限や上限の数値)を決めてから節目に当てはめるのは誤り。';

/** ★② 「+5円」の緩衝が **何に** 加わるのかの明示(3つある「5円」のうちの1つ目=SL の緩衝)。
 *  ★v0.9.60: 実測(2026-08-04)で AI は この5円を **エントリー価格** に足し引きしていた(LC幅=5円)。
 *  ★v0.9.61: 加えて、この5円が「節目の外側 = どれだけ外側か」を決める唯一の量的指示になっていた
 *    (プロンプトは『節目の外側に置け』としか言わず、量は +5円 しか書いていなかった)。緩衝は幅を作る量ではなく
 *    「選んだ節目からわずかに離すだけ」であることを名指しで確定させる(幅を決めるのは節目の選択=下限)。 */
export const LC_BUFFER_NOTE =
  // ★v0.9.63(削除): 「LC幅の下限に5円を足す/エントリー価格に5円を足し引きする という意味ではない」の否定文は、
  //   【実出力に在った誤り】✗① が **その誤りが実際に起きた形**(買い stopEntry=R1+5 / SL=R1)として同じことを示す。
  // ★v0.9.63(圧縮): 末尾の「(幅は どの節目を選ぶか で決まる)」は同じ本文に必ず入る【導出の順序】の主文そのもの。
  // ★v0.9.64(削除): 主語だった「+5円」という数値そのものを外す。この「+5円」は v0.9.60 で
  //   scalpJsonInstruction から『本来のストップ位置から+5円外側』を撤去した時点で **参照先を失っており**、
  //   いま全プロンプト中で「損切り価格に足し引きする量」を数値で名指ししている唯一の箇所になっていた
  //   (実測 2026-08-07: 損切り43件が 建値±5・うち31件は rationale の申告幅が正しい=最後の代入だけが 5 に汚染)。
  //   否定の形("…ではない")でも数値を差し出す以上は供給源なので、量を持たない表現へ置き換える(規則は不変)。
  '★損切り価格は、根拠に選んだ節目から わずかに離すだけ(買いは下へ・売りは上へ)。この緩衝は LC幅を作る量ではない。';

/** ★v0.9.60: 損切りの向きを **エントリーの向きと同格**(不等式・単独ブロック)にする SSOT。
 *  ★根拠(実測 2026-08-04・11時間/138計画): AI が出したレッグの 67件 が「損切りがエントリーの逆側」で落ちており、
 *    その LC幅の中央値は 5円 だった(=建値の隣のティック)。一方エントリーの向きは不等式で単独に置かれていて
 *    ほぼ守られていた。つまり「指示が無い」のではなく「指示の格が違う」。散文の1文を不等式に格上げする。
 *  ★「外側」という語が同じプロンプト内で2つの逆向きの意味に使われていた(ブレイク新規=節目の外側は"抜ける方向"、
 *    損切り=エントリーの外側は"建玉を守る向き")。★v0.9.62 でこの解説行はここから外したが、同じ区別は
 *    【節目への置き方】(question / strategySpec の同一文)に残っている=規則は1つも失われていない。
 *  ★v0.9.62(実測 2026-08-06): 不等式へ格上げした後も stopSide 落ち10件が残り、**その10件全部が売り** で、
 *    **全部がブレイク新規レッグ**(売りの指値レッグは正しく足していた)。根拠文も「ブレイク新規は65660円に設定し、
 *    LC幅は55円で65605円となります」= 幅は正しく、符号だけ逆。つまり不等式は「確認するもの」であって
 *    「計算するもの」ではなく、幅を出した後の符号選択の段では働かない。よって不等式を **符号込みの式** に
 *    置き換え(足すのではなく置換=増分ゼロ)、AI が実際に間違えている一点(「ブレイク新規が下でも損切りは上」)を
 *    名指しで書く。旧「外側」の抽象的な語の解説行は、この具体的な1行が同じことをより強く言うので落とす。 */
export const SL_SIDE_RULE =
  '★【最優先: 損切りの向き(無条件・例外なし)】損切り価格は符号を選ばず次の式で出すこと(LC幅は【導出の順序】で節目から決まる結果)。\n'
  + '  買い: stopLossForLimit = limitEntry − LC幅 ／ stopLossForStop = stopEntry − LC幅\n'
  + '  売り: stopLossForLimit = limitEntry + LC幅 ／ stopLossForStop = stopEntry + LC幅\n'
  + '  ★売りは2つとも「+」。ブレイク新規(stopEntry)は現在値より下だが、その損切りも「+」で stopEntry より上(抜ける方向=下 に置くのは誤り)。\n'
  // ★末尾に「損切りは節目から導く」と書き足さない: 同じ文言の【導出の順序】が同じ本文の中に必ず入るため。
  // ★v0.9.63(削除): 「★エントリーからの固定距離(建値の隣/両レッグ同じ幅/±5円/エントリーと同じ節目)で決めてはならない」は
  //   禁止事項を4つ並べた抽象文で、その4つはそれぞれ ✗①/✗⑤/✗①/✗③ に **実際に起きた形** として入った。
  //   同じ禁止は scalpJsonInstruction の lcNote(フィールド直下・2箇所)にも残っている=規則は失われない。
  + '  range も同じ(buy レッグは「−」・sell レッグは「+」の式)。';

/** ★v0.9.61: 初期LC幅の **下限** を、価格の向き/損切りの向きと同じ格(最優先・不等式・単独ブロック)へ格上げする SSOT。
 *  ★根拠(実測 2026-08-05): 自己検算に「③損切りの幅」を入れた **後でも** lcFloor 落ちが 61件(指値19/逆指値42)。
 *    根拠文は「サポートの5円上に指値」等の **置き方** しか語らず、結果が何円になったかを一度も述べていない
 *    =幅を数えていないから気づかない。よって (a)不等式へ格上げ (b)自分で引き算させる (c)その数値を rationale に
 *    書かせる。★JSON スキーマにフィールドは足さない(parse/記録の形を変えないため。書かせ先は rationale)。
 *  ★責任の所在: 「コードが落とす」だけを書くと免責(=守らなくてよい)に読める。落ちた結果が **あなたの計画が
 *    実行されないこと** だと言い切る。 */
export function lcFloorRule(floorYen: number): string {
  return '★【最優先: 損切りの幅(無条件・例外なし)】各レッグは独立に次の不等式を満たすこと。\n'
    + `  |limitEntry − stopLossForLimit| ≥ ${floorYen}円 ／ |stopEntry − stopLossForStop| ≥ ${floorYen}円 ／ range も各レッグ |entry − stopLoss| ≥ ${floorYen}円\n`
    // ★v0.9.63(圧縮): 例示を1レッグぶんに縮める(同じ書式の完全な例は scalpJsonInstruction の rationale 注記が持つ)。
    // ★v0.9.64: 幅の申告(v0.9.61)は効いた(申告値は正しくなった)が、実測 2026-08-07 では
    //   「幅は正しく申告し、損切り価格だけ 建値±数円」= 代入の段が見えないまま汚染される形が31件残った。
    //   よって申告させる単位を「幅」から **代入の式そのもの** に変える(足すのではなく置換)。
    //   式の答えと JSON の値の一致を要求すると、汚染が rationale の中で自己矛盾として露見する。
    + '  ★出力前に必ず自分で引き算して各レッグの LC幅を数え、rationale には 代入の式をそのまま書くこと(出したレッグぶん・例「指値レッグ (エントリー価格)−(LC幅)=(損切り価格)」に実数値を入れる。売りは「−」でなく「+」)。★式の答えが、そのレッグの stopLossFor… に出す数値と 1円でも違ってはならない。置き方だけを述べて式を書かないのは不可。\n'
    // ★v0.9.63(圧縮): 「下限割れのレッグは取引されない=あなたの計画がその分だけ実行されない」は
    //   【実出力に在った誤り】の見出し行が「落ちたレッグは取引されず、両レッグ落ちれば見送り」として
    //   全例に一括で与える(免責に読ませないための『責任は免除されない』だけを残す)。
    + `  ★${floorYen}円未満になったら、まず 損切りの根拠にする節目を もう一段外側へ選び直す。選び直しても届かないレッグだけを 対の損切りごと省く`
    + '(下限を守る責任は免除されない)。';
}

/** ★v0.9.61: 初期LC下限の「意味と責任」。★従来これは buildDelegationNote の `modes.lcFloor==='ai'` の中にしか
 *  無く、運用機の設定(下限=手動)では **一度も AI に届いていなかった**。手動こそユーザーが決めた絶対条件なので、
 *  モードに関係なく常に(戦略仕様ブロックで)出す。 */
export function lcFloorReason(floorYen: number): string {
  return '理由: この決済は「含み益が一定に達して初めて利益ロックの床が発動する」方式なので、下限より狭い初期LCは床が働く前に被弾し決済ロジックが構造的に成立しない。'
    + `下限は好みではなく **計画が成立するための条件** で、手動でもAI委任でも外れない(${floorYen}円未満のレッグは取引されない)。`;
}

/** ★v0.9.60: 出力前の自己検算(SSOT)。従来はエントリーの不等式しか検算させておらず、
 *  損切りの向き・幅は自己検算の対象外だった(=最多の脱落理由が自己検算をすり抜けていた)。同じ場所・同じ強さで検算させる。
 *  ★v0.9.61: ③に「節目の別」を足して4点にする(エントリーと損切りが同じ節目を基準だと幅は構造的に足りない)。
 *  ★v0.9.62: ②を **数値の大小の確認** に具体化する(旧文は不等式の再掲で、符号を選び違えた本人には
 *    同じ選択がもう一度通ってしまう)。実測の誤りは全て「売りのブレイク新規の損切りだけがエントリーより小さい」形
 *    だったので、その形を名指しで検算対象にする。※項目数は4のまま=増分は最小。 */
export function selfCheckNote(floorYen: number, ceilingYen: number): string {
  return '★【出力前の自己検算(必須)】出力前に limitEntry と stopEntry を refPrice と比較し、レッグごとに次の4点を確かめること。\n'
    + '  ①エントリーの向き: 上の不等式を満たすか。\n'
    // ★v0.9.63(削除): 末尾の「(売りのブレイク新規だけ小さい=典型の符号ミス)」は【実出力に在った誤り】✗② が
    //   実際の形(と、それを落とす検証 stopSide)として同じことを言う。
    + '  ②損切りの向き(符号): 2つの損切りの数値を各エントリーと見比べ、売りなら2つとも大きい/買いなら2つとも小さいか。\n'
    // ★v0.9.63(削除): 末尾の「(同じ節目なら④は必ず足りない)」は ✗③ が実際に起きた形として同じことを言う。
    + '  ③節目の別: 損切りの根拠にした節目が、エントリーの根拠にした節目と **別**(もう一段外側)か。\n'
    // ★v0.9.64: 「その数値を書いたか」→「その式を書き、式の答えと出力値が一致するか」。実測 2026-08-07 の
    //   食い違い31件は、幅を書かせるだけでは代入の段が検算対象外だったために起きた(幅は正しかった)。
    + `  ④損切りの幅と代入: |エントリー − 損切り| を実際に引き算し、${floorYen}円以上 ${ceilingYen}円以下 か。その代入の式(エントリー±LC幅=損切り)を rationale に書き、式の答えと 実際に出力する損切りの数値が一致しているか。\n`
    + '  1つでも満たさないレッグは(省く前に、まず上の『節目を選び直す』を試すこと。それでも置けないときだけ)対の損切りごと省略すること。両レッグとも満たさなければ direction:"none" にする。';
}

/** ★v0.9.63(ユーザー指示「だめな例いくつか作成し、AIに見せて」): 規則を散文で足す修正が3版続けて
 *  「別の失敗へ移る」だけに終わったので、**実際に台帳(signal_plans)に残った失敗の形** をそのまま見せる。
 *
 *  ★収録した5つはすべて実記録から取った実在の形(架空の失敗は書かない):
 *    ①損切りが建値の隣(2026-08-04・中央値5円・88件)/②売りのブレイク新規で損切りを建値の下(2026-08-06・19件・
 *    買いでは0件)/③エントリーと損切りを同じ節目から導く(根拠文が実在)/④幅が下限に固着(v0.9.62 期間の
 *    系統A指値の96%が下限〜下限+5・相異なる値は3種類)/⑤両レッグ同じ幅。
 *
 *  ★アンカー対策(この設計の中心・最重要):
 *   このプロジェクトでは「目立つ数値がそのまま選ばれる」現象が2回続けて起きている(上限65 を印字→LC が60に固着 /
 *   下限を最優先ブロックへ格上げ→下限ちょうどに固着)。**だめな例に書いた数値が次の固着を生んでは意味がない** ため:
 *    (a) 価格を実数で書かない。P/R1/R2/S1/S2 の記号だけで書く(コピーできる価格が1つも無い)。
 *    (b) 幅を数値で書かない。「数円」「広め」「狭め」と定性的にだけ言う(良い例も同じ)。
 *    (c) この本文に現れる数値は「5」(既存の節目緩衝)と記号の添字(R1/R2/S1/S2)だけ。
 *        ★**下限・上限の設定値は1度も現れない**=印字回数を1回も増やさない(固着の再生産をしない)。
 *    (d) 「下限ちょうどは禁止」とは書かない(それは『下限+一定』という新しい固着を作る)。
 *        書くのは「下限ちょうどになる場面自体は正しい。誤りは **毎回** そうなること」。
 *   ★良い例を1つだけ併記する理由: だめな例だけだと「ではどうするか」が残らず、④の過剰修正(幅を機械的に広げる)を
 *    招く。ただし良い例に具体的な幅を書けば それ自体が新しいアンカーになるので、良い例の要点は数値ではなく
 *    **「2つのレッグの幅が揃わないこと」** に置く(幅の多様性を、数値の列挙ではなく構造で示す)。
 *
 *  ★[ ]の検証ラベル(ユーザー追加指示): 例が仮の話でなく **実際に落とされる形** だと示す。語彙は実装が使う
 *   NoneReason / LegDrop.reason(lcFloor / stopSide / geometry / lc / missing / trend / bias)と、
 *   画面注記(LEG_DROP_REASON_TEXT)の日本語をそのまま使う=プロンプト・台帳・画面で1つの語になる。
 *   ★④⑤は **どの検証も落とさない**(下限を満たす限りコードは通す)。そこを正直に書くことが、④に効く唯一の圧力。
 *   ※関数名(entrySideOk 等)は書かない: AI に意味があるのは「何を確認され、落ちたらどうなるか」であって内部名ではない。 */
export const PLAN_BAD_EXAMPLES =
  '★【過去の実出力に在った誤り(同じ形を出さないこと)】記号 P=現在値 / R1,R2=Pより上の節目(R2が遠い) / S1,S2=Pより下の節目(S2が遠い)。'
  + '各例の[ ]は その形を落とす検証で、台帳と画面の注記にも同じ語が残る。落ちたレッグは取引されず、両レッグ落ちれば その回は見送り(none)。\n'
  // ★v0.9.64: ①②③に書いていた実数の「5」(±5 / 0〜5円上)を記号と定性語に置き換える。この本文は
  //   実出力の引用だが、引用であっても数値は数値として供給される(設計注 (a)(b) と同じ理由)。
  + '  ✗①建値の隣: 買い stopEntry=R1のすぐ上 に stopLossForStop=R1(幅は数円)。ブレイク新規を節目のすぐ外側に置くための緩衝を、損切りの幅そのものと読んだ形。→損切りの節目は S1/S2 を選び、幅は引き算の結果。[lcFloor=損切り幅が設定の下限より狭い]\n'
  + '  ✗②売りのブレイク新規の符号ミス: 売り stopEntry=S1のすぐ下 の損切りを stopEntry より下に置いた(根拠文の幅は正しかった)。幅が合っていても下側の損切りは建玉を守らず即約定する。→売りは2つとも「+」。[stopSide=損切りがエントリーの逆側]\n'
  + '  ✗③エントリーと損切りが同じ節目: 「指値はサポートのすぐ上、ブレイク新規はレジスタンスのすぐ上」とだけ述べ、損切りも同じ節目を基準にした形。同じ節目の内と外の差は緩衝ぶん(数円)だけで幾何的に下限を満たせない。→買いの指値が S1 の内側なら損切りの基準は S2。[lcFloor]\n'
  + '  ✗④幅が毎回ほぼ同じ・下限ちょうど: 節目の配置は日ごとに違うのに出した幅がほぼ1種類だった形=下限の数値から損切り価格を逆算している。下限は満たすべき条件で、置くべき値ではない(たまたま下限ちょうどの場面はある。誤りは毎回そうなること)。→先に節目を選び、幅は結果として受け取る。\n'
  + '  ✗⑤両レッグが同じ幅: 2つのレッグは基準の節目も向きも違うので、幅が同じ数値になるのは先に幅を決めた時だけ。→レッグごとに独立に引き算する。\n'
  // ★v0.9.64: 2026-08-07 の実出力で新しく現れた2つの形。⑥は「幅の計算も申告も正しいのに損切り価格だけ建値の隣」
  //   (31件)、⑦は「省略すると述べながら価格フィールドを出した」(実在の根拠文)。どちらも規則の理解ではなく
  //   **最後の書き出しの段** で壊れているので、その段を名指しで例にする。※数値・価格は書かない(アンカー対策)。
  + '  ✗⑥申告と実物の食い違い(最後の代入だけが壊れる): rationale には正しい LC幅を書きながら、stopLossForStop には 建値の隣(エントリー±数円)を入れた形。計算も申告も合っていて、代入する瞬間だけ ブレイク新規を節目からずらす緩衝に引きずられている。→式(エントリー±LC幅=損切り)を書き、その答えをそのまま出力する。[lcFloor]\n'
  + '  ✗⑦「省略する」と述べて価格を出す: rationale に「ブレイク新規は下限に届かないので省略した」と書きながら stopEntry と stopLossForStop の数値を出した形。判断は正しいのに JSON に反映されていない。→省略とは その対の価格フィールドを書かないこと。[lcFloor]\n'
  + '  ※④⑤はどの検証にも掛からない=落ちないので誰も直さない。防げるのはあなただけ。\n'
  + '  ○良い形(要点は数値ではなく「2つの幅が揃わないこと」): 買いで S1 が薄く S2 が厚い日 → 指値=S1の内側/損切り=S2の外側 で幅は広め。同じ日のブレイク新規=R1の外側/損切り=直近スイング安値の外側 で幅は狭め。2つの幅は違う数値になる(同じなら、どちらかは節目から導いていない)。';

/** LC 幅の許容レンジの提示文(SSOT)。手動=従来の「A〜B円に収め」/ 委任=「下限A円〜{capLabel}B円 の範囲で…決める」。 */
export function lcRangePhrase(floorYen: number, ceilingYen: number, ceil: LcCeilingPresentation): string {
  return ceil.delegated
    ? `下限${floorYen}円〜${ceil.capLabel}${ceilingYen}円 の範囲で、相場構造(節目/スイングの位置)に応じてあなたが決め`
    : `${floorYen}〜${ceilingYen}円に収め`;
}

/** LC 幅の下限/上限を受けてスキャル戦略質問(ユーザー指定・日本語)を生成する。
 *  初期 LC 幅を {floor}〜{ceiling} 円に収め、{ceiling} 円超は出さない(単一上限)。
 *  上限はレッグ独立(v0.7.37)・指値のみ/逆指値のみの回避を保持。 */
export function buildScalpQuestion(
  floorYen: number = DEFAULT_LC_FLOOR_YEN,
  ceilingYen: number = DEFAULT_LC_CEILING_YEN,
  rangeEnabled = true,
  trendVetoYen: number = DEFAULT_TREND_VETO_YEN,
  // ★v0.9.56: 上限が AI委任のときだけ提示の形を変える(既定=手動=従来と byte 一致)。
  //   ceilingYen には委任時 **実効上限**(安全上限 or 背骨)が入る=保存値はここまで届かない。
  lcCeil: LcCeilingPresentation = LC_CEIL_MANUAL,
): string {
  // レンジ両面ストラドルの追記(実験・紙で別枠計測)。rangeEnabled=false のときは range を禁止する。
  // ★v0.9.44: 1行に詰め込んでいた説明を複数行の箇条書きに開き、「fade / breakout の2択(組で選ぶ)」に書き直す。
  //   従来は4通り(上下×指値/逆指値)を並べていたため、AI が組を混ぜて「下=買い逆指値」のような
  //   定義上ありえない配置(lower.entry<現在値 と両立しない)を出し、parse で落ちて見送りになっていた。
  const rangeNote = rangeEnabled
    ? '\n⑤明確な方向性が無く、上下に反応帯があるレンジと判断したら direction:"range" で、' +
      '現在値の上と下に1レッグずつ置いてよい(両面ストラドル)。各レッグは side/type/entry/stopLoss。\n' +
      '  ★【レンジは2択(組で選ぶ・必須)】次の2つの「組」のどちらか一方を丸ごと選ぶこと。組を混ぜない(4通りから好きな2つを拾わない)。\n' +
      '   ・fade(両側指値/type:"limit")の組 = 上(upper)は 売り指値[side:"sell"/type:"limit"] / 下(lower)は 買い指値[side:"buy"/type:"limit"]\n' +
      '   ・breakout(両側ブレイク新規/type:"stop")の組 = 上(upper)は 買いのブレイク新規[side:"buy"/type:"stop"] / 下(lower)は 売りのブレイク新規[side:"sell"/type:"stop"]\n' +
      // ★v0.9.60(削除): 「※組を混ぜると上下が同じ方向の注文になり…」の理由行は system prompt に同文がある。
      // ★委任時は「最大損切り幅の2倍」を保存値でも安全上限でもなく **そのレンジで自分が置く損切り幅** に対して言う。
      //   保存値を書けばアンカーになり、安全上限を書けば非現実的な閾値になってどちらも規則の意図を壊すため。
      // ★v0.9.60(削除): 上の「理由:」1行も system prompt に同文があるので質問文からは削る。
      (lcCeil.delegated
        ? `  ★どちらの組を選ぶか(重要): 上下の反応帯の幅が、そのレンジで置く損切り幅の2倍より広ければ fade(両側指値)の組、` +
          `損切り幅の2倍以下の狭い横這いなら breakout(両側ブレイク新規)の組にすること。\n`
        : `  ★どちらの組を選ぶか(重要): 上下の反応帯の幅が${ceilingYen * 2}円より広ければ fade(両側指値)の組、` +
          `${ceilingYen * 2}円以下の狭い横這いなら breakout(両側ブレイク新規)の組にすること。\n`) +
      '  ★上下の位置(無条件): upper.entry > 現在値 > lower.entry。この不等式を満たさない数値は出力しないこと。\n' +
      // ★v0.9.60(削除): 「※買いのブレイク新規は必ず現在値より上…定義上ありえない」の2行は
      //   system prompt の rangeLine に同文がある(質問文では重複)。
      `  各レッグの初期LCも上限(≤${ceilingYen}円)内に収めること。\n` +
      '  ★レンジの距離: 上下2本(upper/lower)を出すときは 上と下の価格差を400円以内にする(幅が広すぎるレンジは出さない)。片方だけのレンジは その1本を現在値から200円以内に置く。\n'
    : '\ndirection は buy/sell/none のみ、range(両面)は出さないこと。\n';
  return (
    'あなたが考える現在のスキャル戦略を教えてください。\n' +
    '①最初に買い/売りのどちらかを判断(良い場面が無ければ無理に作らず direction:"none" で見送ってよい)\n' +
    '②指値(limitEntry)とブレイク新規(stopEntry)の両方の新規注文を作り、先に約定した方で取引します' +
    '(指値とブレイク新規は、現在値からそれぞれ少なくとも50円以上離すこと。この最低距離は buy/sell のみで、range の各レッグには適用しない=レンジは上下の反応帯の位置で決める)\n' +
    // ★最優先=無条件の不等式。節目の話より前に単独行で置く(節目基準を主語にしない)。
    '\n★【最優先: 価格の向き(無条件・例外なし)】現在値(refPrice)に対して、次の不等式を必ず満たすこと。\n' +
    '  売り: stopEntry < refPrice < limitEntry\n' +
    '  買い: limitEntry < refPrice < stopEntry\n' +
    '  節目・トレンド・ニュースなど他のどんな理由よりもこの不等式を優先する。この不等式を満たさない数値は出力しないこと。\n' +
    '  言い換えると 買いは 指値=現在値より下 / ブレイク新規=現在値より上、売りは 指値=現在値より上 / ブレイク新規=現在値より下。逆に置くと即約定・不正なので厳禁。\n' +
    // ★v0.9.61(削除): 「片方だけ(指値のみ/ブレイク新規のみ)を出すときも、その1本は上の不等式における自分の位置を
    //   必ず守る」の1行は、直下の【指値・ブレイク新規の距離(必須)】が同じことを言っている(「その1本を向き通りに
    //   置いた上で…」)ので、同じメッセージ内の三重掲載になっていた。
    // ★v0.9.60: 損切りの向きを、直上のエントリーの向きと **同じ格**(不等式・単独ブロック)で置く。
    `\n${SL_SIDE_RULE}\n` +
    // ★v0.9.61: 損切りの **幅の下限** も、上2つと同じ格(最優先・不等式・単独ブロック)で並べる。
    `\n${lcFloorRule(floorYen)}\n` +
    // ★語の分離。「逆指値」がブレイク新規と損切りの両方を指すため混線していた。
    '\n★【用語の区別(混同禁止)】「逆指値」という語は2つの別物を指すので、必ず英語フィールド名で呼び分けること。\n' +
    '  stopEntry = ブレイク新規(まだ建てていない・節目を抜けたら入るエントリー注文)。損切りではない。\n' +
    '  stopLossForLimit / stopLossForStop = 損切り(すでに約定した建玉を守る注文)。エントリーではない。\n' +
    // ★v0.9.60(削除): 「rationale でも別の語で書くこと」の1行は system prompt に同文があり、
    //   質問文の末尾にも rationale の書き方の指示が別に入っているので重複。

    // ★v0.9.63: 【ブレイク新規(stopEntry)の置き場所】は残す。実測の残存誤り(✗②=売りのブレイク新規の符号ミス)が
    //   まさにこのレッグで起きているので、質問文からこの規則を減らすのは逆方向。
    '\n★【ブレイク新規(stopEntry)の置き場所】\n' +
    '  売り(sell)のブレイク新規は サポート(現在値より下) を抜ける価格に置く。' +
    'レジスタンス(現在値より上)の上に置くのは買いのブレイク新規であり、売りプランでは絶対に出さない。\n' +
    '  買い(buy)のブレイク新規は レジスタンス(現在値より上) を抜ける価格に置く。' +
    'サポート(現在値より下)の下に置くのは売りのブレイク新規であり、買いプランでは絶対に出さない。\n' +
    // ★節目基準は不等式の後。ここでの「内側/外側」は節目に対する相対で、上の不等式を覆さない。
    '\n★【節目への置き方(約定させるため必須)】狙うサポート/レジスタンスちょうどには置かない。\n' +
    // ★v0.9.64(圧縮): 「最低5円(目安5〜10円)」→「5〜10円」。範囲は残し、単独の「5円」という量だけ落とす。
    '  指値は節目から 5〜10円 内側[現在値側]にずらす=買いはサポートの5〜10円上・売りはレジスタンスの5〜10円下。\n' +
    // ★v0.9.64: ブレイク新規のずらし量「0〜5円」を撤去し、量を持たない表現にする。実測 2026-08-07 で
    //   ≤10円 の損切り43件は **ほぼ逆指値レッグに集中**(指値レッグは中央値50で健全)。ここが全プロンプト中で
    //   stopEntry の隣に置かれた唯一の小さい数値で、同じ 5 が損切りの代入にも流用されていた。
    //   ★指値側の 5〜10円 は残す(健全な側の唯一の較正で、消す根拠が実測に無い=片側だけ断つ)。
    '  ブレイク新規(stopEntry)は節目の すぐ外側[抜ける方向]に置く=買いはレジスタンスのすぐ上・売りはサポートのすぐ下(抜けたと分かる最小限だけ離す。ずらす量は決めない)。' +
    'この「外側」は抜ける方向であって、損切りの「外側」(建玉を守る向き)とは別物。' +
    '★このずらし幅は損切りには一切使わない(損切りの幅は下の【導出の順序】で節目から出す)。\n' +
    // ★v0.9.60(削除): 「節目ちょうどだと指値は刺さらず/ブレイク新規はだましに遭いやすいため」の理由行は
    //   system prompt に同じ理由文があるので質問文からは削る(理由は1箇所で足りる)。
    // ★v0.9.60(削除): 「逆張り指値の『強さ』でもう一つ先の節目まで引きつけるのと同じ要領で…」は、
    //   質問文から『逆張り指値の節目選び』ブロックを削った時点で参照先の無い文になるため一緒に削る。
    '  ★選んだ節目に置いた結果が上の不等式に反するときは、まず不等式を満たす側の節目を選び直すこと(売りなら 指値=現在値より上のレジスタンス / ブレイク新規=現在値より下のサポート、買いは対称)。選び直しても適切な節目が無いときに限り、そのレッグを省く。\n' +
    // ★v0.9.60(削除): 『★【逆張り指値の節目選び(重要)】』の4行(約230字)は system prompt に同文が入る重複。
    //   質問文(user)側は「向き」の規則に集中させ、節目の強弱の解説は system prompt 1箇所に集約する。
    // ★v0.9.60(圧縮): 距離ルールの1行目は ★最優先 の不等式をこの同じメッセージ内で3度目に書き写していたので、
    //   参照に置き換えた(数値の上限だけを残す)。
    '\n★【指値・ブレイク新規の距離(必須)】両方を出すときは現在値がその2つの価格の間に入るように置き(上の不等式のとおり)、' +
    '指値とブレイク新規の価格差[両者の幅]は400円以内にする=幅が広すぎる両面は出さない。' +
    '片方だけ[指値のみ/ブレイク新規のみ]を出すときは、その1本を向き通りに置いた上で現在値から200円以内に収める' +
    '[200円超離れた片レッグは出さない=約定不能・古い価格になりやすいため]。\n' +
    // ★v0.9.56 ②: 「ストップ幅に5円加える」は下限に足す指示だと読まれていた(AI が『本来のストップ幅=下限55』と解釈し 60 を出した)。
    //   +5円 が何に加わるのかを明示する。
    // ★v0.9.60(削除): ここに在った「損切りは必ずエントリーの外側に置く…内側/反対側には置かないこと」の散文は、
    //   上の SL_SIDE_RULE(不等式・最優先ブロック)に格上げして置き換えた(同じ内容を弱い形で二度書かない)。
    `\n③それぞれのストップ(損切り)を定めてください(向きは上の【最優先: 損切りの向き】に従う)。${LC_BUFFER_NOTE}\n` +
    // ★v0.9.56 ③: 節目 → ストップ位置 → 幅 の順であることを明示(幅を先に決めて節目に当てはめるのは誤り)。
    `  ${LC_DERIVATION_ORDER}\n` +
    '④この建玉は、利が乗ると段階的に利益を確定し損切りを引き上げる決済方式を使う。\n' +
    `  ゆえに初期の損切り(LC)幅は${lcRangePhrase(floorYen, ceilingYen, lcCeil)}、1回の損切りが積み上げた利益を飛ばさない(コツコツドカンを避ける)。\n` +
    // ★v0.9.60(削除): 「損切りは直近の節目/スイングの外側に置き、狭すぎ・広すぎを避ける」は直上の
    //   LC_DERIVATION_ORDER ①②と完全に同義なので削る(弱い言い換えを残すと導出の順序がぼやける)。
    // ★v0.9.61(削除): 「${ceilingYen}円を超える損切りは出さない」は直上の lcRangePhrase(許容範囲)と
    //   直下のレッグ省略ブロックの二重言い換え。上限の数値反復は「幅を先に決める」誤りを誘うので1回減らす。
    `  LC 幅(下限・上限)は、指値レッグ・ブレイク新規レッグ それぞれ独立に満たすこと。\n` +
    rangeNote +
    // ★v0.9.60(圧縮): 4行のうち3行は上限値(${ceilingYen})を5回書き直しているだけだった。上限の数値を
    //   繰り返すほど「幅を先に決める」誤りを誘うので、規則を1行に畳んで数値の反復を1回に減らす。
    // ★v0.9.61(削除): 【LC が収まらないときのレッグ省略】ブロックは、直上④の「レッグごとに独立に満たす」・
    //   【最優先: 損切りの幅】の「選び直す→届かないレッグだけ省く」・自己検算の「両レッグとも満たさなければ none」
    //   の3つで既に言い尽くされていた(同じ質問文の中の4度目の掲載)。規則は1つも失われない。
    // ★v0.9.63: 実出力に在った失敗の形(5つ)+良い形。★自己検算の **直前** に置く=検算の各項目が
    //   「見たことのある形」と結びつく。注入は質問文(user message)の1箇所だけ(同じ内容を3ビルダーに
    //   複写すると、これまで効かなかった散文の増殖と同じことになるため)。
    `\n${PLAN_BAD_EXAMPLES}\n` +
    // ★出力直前の自己検算。ここで落とせば、コード側の検証で両レッグ落ち=見送り(none)になる事故を防げる。
    // ★v0.9.60: エントリーの向きだけでなく **損切りの向きと幅** も同じ場所・同じ強さで検算させる(SSOT=selfCheckNote)。
    `\n${selfCheckNote(floorYen, ceilingYen)}\n` +
    // ★v0.9.64: 従来この規則は片方向(出さないレッグを「置いた」と書かない)だけだった。実測 2026-08-07 の
    //   根拠文「…ブレイク新規のLC幅が下限未満のため、ブレイク新規は省略。指値レッグのみで計画を立てた」に対し
    //   stopEntry/stopLossForStop の数値が出ていた=判断は正しく JSON に反映されていない。逆方向
    //   (省略と述べたなら価格を出さない)を、省略の定義とともに書く。
    '\n★rationale[説明文]は実際に出力したレッグだけ説明すること(食い違いは両方向とも禁止): ' +
    '①出していないレッグを「置いた/設定した」と書かない。' +
    '②逆に「省略する/見送る/出さない」と述べたレッグは、その対の価格フィールド(指値レッグ=limitEntry と stopLossForLimit / ブレイク新規レッグ=stopEntry と stopLossForStop)を JSON に **書かない**こと。★省略とは価格を出さないことであって、価格を出したうえで「省略した」と述べるのは矛盾(そのレッグは書いたとおりに発注される)。\n' +
    trendGuidance(trendVetoYen)
  );
}

// トレンド veto の初期閾値[円]。config resolveScalpTrendVetoYen と揃える(0=veto 無効)。
export const DEFAULT_TREND_VETO_YEN = 100;

/** レンジ両面(direction:"range")の実効許可値。manual は設定値(override 優先)/ ai は AI 委任=許可(true)。
 *  ★SSOT: system prompt の rangeLine と、技術文脈の「直近の勢い」1行に添えるレンジ文言は、必ず同じ値を使う
 *   (片方が「レンジ禁止」もう片方が「レンジ可」だと AI が混乱するため)。scalpPlanRunner が同じ関数を呼ぶ。 */
export function resolveEffectiveRangeEnabled(profile?: SignalProfile, override?: boolean): boolean {
  const d = resolveScalpRangeDirective(profile);
  return d.mode === 'manual' ? (override ?? d.value) : true;
}

/** レジーム/トレンド逆行フェードを禁じる補助プロンプト(遵守はコードの enforcePlanConstraints で担保)。
 *  trendVetoYen<=0(=veto 無効)のときは空文字(=注入なし)。 */
function trendGuidance(trendVetoYen: number): string {
  if (!(trendVetoYen > 0)) return '';
  return (
    // ★トレンド判定は「10分だけ」ではなく 10分・30分・MA20傾き の合議(=『直近の勢い』行の末尾ラベルの正体)。
    //   軸の列挙は実装(computeRegime)と厳密に一致させる。1時間は数値基準を持たないので合議には入れず、
    //   『長い時間軸』ブロックの数値を AI 自身に見せて補助的に参照させる。
    `『レンジ』は 10分・30分・MA20傾き のどれも横ばい(10分が±${trendVetoYen}円未満 かつ 30分が±${trendVetoYen * 2}円未満)` +
    'のときだけと判断すること。10分が静かでも 30分/MA20傾き が一方向に動いていればレンジではない' +
    '(『直近の勢い』行の末尾ラベルがこの合議の結論。『長い時間軸(1時間/2時間/当日始値比)』の数値も併せて参照すること)。' +
    'トレンドと判断したら、トレンド方向の順張り(ブレイク新規(stopEntry)/押し目・戻りの順張り)か direction:"none" で見送りにする。' +
    'トレンドに逆行する新規(順トレンドの高値売り/安値買いの戻り売買)は出さない。' +
    '★直近10分と長い時間軸が逆向きのとき(『直近の勢い』が「戻り」「押し目」表示)は、どちらのトレンドとも断定せず、' +
    'direction:"none"(見送り)を基本とすること。' +
    // ★v0.9.61(削除): 末尾の「上で渡す『直近の勢い』と『長い時間軸』の数値を必ず判断に使うこと。」は、
    //   同じ段落の3文前「(『直近の勢い』行の末尾ラベルが…『長い時間軸』の数値も併せて参照すること)」と同義。
    `※コード側の自動見送り(veto)は直近10分の勢い(±${trendVetoYen}円)だけで判定するので、` +
    `10分が±${trendVetoYen}円未満でも長い時間軸がトレンドなら veto は掛からない=逆行を出さないのはあなたの判断による。`
  );
}

// 固定のスキャル戦略質問(既定 LC 幅 45〜65)。プロンプト文言テストや後方互換のための既定インスタンス。
export const SCALP_QUESTION = buildScalpQuestion();

/** LC 幅の下限/上限を受けてスキャルの system prompt を生成する。
 *  ★v0.7.37 のレッグ独立/指値のみ回避、v0.7.38 のギャップ検証済み知見ガードレールを保持。 */
export function buildScalpSystemPrompt(
  floorYen: number = DEFAULT_LC_FLOOR_YEN,
  ceilingYen: number = DEFAULT_LC_CEILING_YEN,
  rangeEnabled = true,
  trendVetoYen: number = DEFAULT_TREND_VETO_YEN,
  aiTechnicalEnabled = false,   // ★true でテクニカル指標(RSI/BB)許可の1行を追記。false(既定)は byte 一致=従来不変。
  // ★v0.9.56: 上限が AI委任のときだけ提示の形を変える(既定=手動=従来と byte 一致)。
  lcCeil: LcCeilingPresentation = LC_CEIL_MANUAL,
): string {
  // ★テクニカル許可(RSI/BB)。ON のときだけ追記=OFF(既定)では byte 単位で従来の system prompt と一致。
  const techLine = aiTechnicalEnabled
    ? `\n- ★【テクニカル指標(RSI/BB)の活用が許可されています】渡す「テクニカル指標(5分足・RSI14/SMA14/BB${BB_BAND_LABEL})」を、エントリーの"タイミング"判断に使ってよい(例: RSI が売られすぎ[≤30]からの反転や BB 下限からの反発で押し目買い指値、RSI 買われすぎ[≥70]や BB 上限での戻り売り指値など)。ただしテクニカルだけで逆張りせず、上のトレンド判断(生きたトレンドはフェードしない)と節目/勢いを優先すること。※決済(手仕舞い)は既定のロジックが担当するので、テクニカルを根拠に手仕舞いを指示することはしない。`
    : '';
  return buildScalpSystemPromptBody(floorYen, ceilingYen, rangeEnabled, trendVetoYen, techLine, lcCeil);
}

/** system prompt 本体(techLine を末尾に差し込む)。buildScalpSystemPrompt から呼ぶ内部関数。 */
function buildScalpSystemPromptBody(
  floorYen: number,
  ceilingYen: number,
  rangeEnabled: boolean,
  trendVetoYen: number,
  techLine: string,
  lcCeil: LcCeilingPresentation = LC_CEIL_MANUAL,
): string {
  // レンジ両面ストラドル(実験・紙で別枠計測)の指示行。rangeEnabled=false は range を明示禁止する。
  // ★v0.9.44: 1行に詰め込んでいたレンジ指示を複数行に開き、「fade / breakout の2択(組で選ぶ)」へ書き直す。
  //   4通り(上下×指値/逆指値)の並列表記だと AI が組を混ぜて「下=買い逆指値」等の定義上ありえない配置を出し、
  //   lower.entry<現在値 と両立せず parse で落ちて見送りになっていた。
  // ★v0.9.56: レンジの組(fade/breakout)を選ぶ閾値。手動=従来どおり保存値の2倍を印字 / 委任=「自分が置く損切り幅の2倍」。
  //   委任時に保存値(65)を書けばアンカーになり、安全上限(159)を書けば 318円 という非現実的な閾値になる。
  const rangePairChoice = lcCeil.delegated
    ? `★どちらの組を選ぶか[重要]: 上下の反応帯の幅が、そのレンジで置く損切り幅の2倍より広ければ fade(両側指値)の組、損切り幅の2倍以下の狭い横這いなら breakout(両側ブレイク新規)の組にすること。上下幅が損切り幅の2倍以下では逆張りの利幅が損切り幅を上回らず成立しない(狭い横這いは抜けに追随するのが正しい)。`
    : `★どちらの組を選ぶか[重要]: 上下の反応帯の幅が${ceilingYen * 2}円より広ければ fade(両側指値)の組、${ceilingYen * 2}円以下の狭い横這いなら breakout(両側ブレイク新規)の組にすること。損切り幅は最大${ceilingYen}円なので、上下幅が${ceilingYen * 2}円以下では逆張りの利幅が損切り幅を上回らず成立しない(狭い横這いは抜けに追随するのが正しい)。`;
  const rangeLine = rangeEnabled
    ? `\n- ★レンジ両面(direction:"range"): 明確な方向性が無く上下に反応帯があるレンジと判断したら direction:"range" を返してよい(両面ストラドル・実験扱い)。range の時は range.upper / range.lower にそれぞれ side(buy/sell)・type(limit=レンジ内逆張り指値 / stop=抜け追随のブレイク新規)・entry・stopLoss を出す。
  ★【レンジは2択(組で選ぶ・必須)】次の2つの「組」のどちらか一方を丸ごと選ぶこと。組を混ぜない(4通りから好きな2つを拾わない)。
   ・fade(両側指値/type:"limit")の組 = 上(upper)は 売り指値[side:"sell"/type:"limit"] / 下(lower)は 買い指値[side:"buy"/type:"limit"]
   ・breakout(両側ブレイク新規/type:"stop")の組 = 上(upper)は 買いのブレイク新規[side:"buy"/type:"stop"] / 下(lower)は 売りのブレイク新規[side:"sell"/type:"stop"]
   ※組を混ぜると上下が同じ方向の注文になり、それはレンジではなく通常の buy/sell プランと同じものになるため。
  ${rangePairChoice}
  ★上下の位置(無条件): upper.entry > 現在値 > lower.entry。この不等式を満たさない数値は出力しないこと。※買いのブレイク新規は必ず現在値より上・売りのブレイク新規は必ず現在値より下なので、「下(lower)に買いのブレイク新規」「上(upper)に売りのブレイク新規」は定義上ありえない。絶対に出さないこと。
  各レッグの初期LCも上限(≤${ceilingYen}円)内に収める。
  ★レンジの距離: 上下2本(upper/lower)を出すときは 上と下の価格差を400円以内にする(幅が広すぎるレンジは出さない)。片方だけのレンジは その1本を現在値から200円以内に置く。方向性が明確なら従来どおり buy/sell を優先。`
    : `\n- range(両面ストラドル)は出さないこと(direction に range を使わない)。`;
  return `あなたは日経225先物(NIY=F)のスキャルピングを専門とするトレーダーです。
手元の【市場の現状】(現在価格・テクニカル節目・直近アラート・本日OHLC・ニュース)と、
利用可能なデータツール(explain_move / query_alerts / price_history / web_search)を必要に応じて使い、
現在の相場に対する具体的なスキャルのエントリー計画を1つ立ててください。

制約:
- ★まず自分で現在のレジーム(regime: trend_up=上昇トレンド / trend_down=下降トレンド / range=レンジ / unclear=不明)と、その判断・計画への確信度(confidence: 0〜100)を下し、JSON の regime と confidence に入れてから direction 以下の計画を出すこと(自分の相場観を明示してから計画する)。渡された構造化データ(数値の足/節目/ボラ/スイング/アラート結果/自分の成績)を最優先の根拠にする。
- direction は buy / sell / none${rangeEnabled ? ' / range' : ''} のいずれか。良いエントリー場面が無ければ無理にプランを作らず direction:"none"(見送り)を返してよい。その場合 rationale に見送り理由を書き、価格(limitEntry/stopEntry/stopLossForLimit/stopLossForStop)は不要。${rangeLine}
- buy/sell の時: 指値(limitEntry)は押し目買い/戻り売り側の新規、ブレイク新規(stopEntry)は節目を抜けた側の新規。原則として両方の価格を出すが、下記のとおり片方だけ(指値のみ/ブレイク新規のみ)でもよい。
- ★【最優先: 価格の向き(無条件・例外なし)】現在値(refPrice)に対して、次の不等式を必ず満たすこと。
  売り: stopEntry < refPrice < limitEntry
  買い: limitEntry < refPrice < stopEntry
  節目・トレンド・ニュースなど他のどんな理由よりもこの不等式を優先する。この不等式を満たさない数値は出力しないこと。
  言い換えると 買いは 指値=現在値より下 / ブレイク新規=現在値より上、売りは 指値=現在値より上 / ブレイク新規=現在値より下。逆に置くと即約定してしまい不正なので厳禁。
  片方だけ(指値のみ/ブレイク新規のみ)を出すときも、その1本は上の不等式における自分の位置を必ず守る(例: 売りの stopEntry は必ず現在値より下)。
- ${SL_SIDE_RULE}
- ${lcFloorRule(floorYen)}
- ★【用語の区別(混同禁止)】「逆指値」という語は2つの別物を指すので、必ず英語フィールド名で呼び分けること。
  stopEntry = ブレイク新規(まだ建てていない・節目を抜けたら入るエントリー注文)。損切りではない。
  stopLossForLimit / stopLossForStop = 損切り(すでに約定した建玉を守る注文)。エントリーではない。
  rationale(説明文)でも両方をまとめて「逆指値」とだけ書かないこと。
- ★【ブレイク新規(stopEntry)の置き場所】
  売り(sell)のブレイク新規は サポート(現在値より下) を抜ける価格に置く。レジスタンス(現在値より上)の上に置くのは買いのブレイク新規であり、売りプランでは絶対に出さない。
  買い(buy)のブレイク新規は レジスタンス(現在値より上) を抜ける価格に置く。サポート(現在値より下)の下に置くのは売りのブレイク新規であり、買いプランでは絶対に出さない。
- ★【節目への置き方(約定させるため必須)】指値・ブレイク新規を狙う節目(サポート/レジスタンス)ちょうどに置かないこと。
  指値(押し目買い/戻り売り)は節目より 5〜10円 内側(現在値側)にずらす: 買いは対象サポートの 5〜10円上、売りは対象レジスタンスの 5〜10円下。
  ブレイク新規(stopEntry)は節目の すぐ外側(抜ける方向)に置く: 買いは対象レジスタンス(現在値より上)のすぐ上、売りは対象サポート(現在値より下)のすぐ下(抜けたと分かる最小限だけ離す。ずらす量は決めない)。
  理由: 指値を節目ちょうどに置くと反応して約定しない(刺さらない)ことが多く、ブレイク新規を節目ちょうどに置くとだまし(往復)に遭いやすい。
  ★選んだ節目に置いた結果が上の不等式に反するときは、まず不等式を満たす側の節目を選び直すこと(売りなら 指値=現在値より上のレジスタンス / ブレイク新規=現在値より下のサポート、買いは対称)。選び直しても適切な節目が無いときに限り、そのレッグを省く。
  range の各レッグ(limit=逆張り指値 / stop=抜け追随のブレイク新規)も同じ置き方にする。
- ★【逆張り(指値)の節目選び】反発を狙う指値は十分に強い節目(複数回タッチ/主要ラウンド/上位足の節目)にのみ置く。最も近い(隣接の)節目が弱い(タッチ浅い/新しい/薄い)ときは、そこで逆張りせず もう一つ先のより強い節目まで引きつけて置くこと。近くに強い節目が無ければ逆張り指値は見送り、順方向のブレイク新規(stopEntry)を優先する。★この「一段先まで引きつける」考え方は損切りの節目選びにも同じく適用する(下の【導出の順序】)。
- ★【指値・ブレイク新規の距離(必須)】両方を出すときは現在値がその2つの価格の間に入るように置き(上の不等式のとおり)、指値とブレイク新規の価格差(両者の幅)は400円以内にすること=幅が広すぎる両面は出さない。片方だけ(指値のみ/ブレイク新規のみ)を出すときは、その1本を上の向き通りに置いた上で現在値から200円以内に収めること(200円を超えて離れた片レッグは出さない=約定不能・古い価格になりやすいため)。
- それぞれの約定時の損切り(stopLossForLimit / stopLossForStop)を出す。${LC_BUFFER_NOTE}指値レッグは limitEntry+stopLossForLimit、ブレイク新規レッグは stopEntry+stopLossForStop を対で出す(片方だけは不可)。
- ${LC_DERIVATION_ORDER}
- この建玉は、利が乗ると段階的に利益を確定し損切りを引き上げる決済方式を使う。ゆえに初期の損切り(LC)幅は${lcRangePhrase(floorYen, ceilingYen, lcCeil)}、1回の損切りが積み上げた利益を飛ばさない(コツコツドカンを避ける)ようにする。${ceilingYen}円を超える損切りは出さない。
- ★この LC 幅(下限・上限)は 指値レッグ・ブレイク新規レッグ それぞれ独立に 満たすこと。収まらないレッグは まず損切りの節目を選び直す(下限未満=一段外側 / 上限超=一段内側)。
- ${selfCheckNote(floorYen, ceilingYen)}
- ★【検証済みの知見(9年バックテストで確認・従うこと)】寄り付きギャップ(前セッション終値と当セッション始値の乖離)を主要根拠とする戦略は優位性ゼロと確認済み。「ギャップ埋め狙いの逆張り」「ギャップ反転の追随」「ギャップ継続の追随」いずれも期待値マイナス。よって『ギャップが埋まる/反転する/継続する』を主な根拠にしたエントリーは提案しないこと(該当する局面は他に明確な根拠が無ければ direction:"none" で見送る)。ギャップの大小に方向エッジは無い(大きいギャップほど有利ということはない)。※これはギャップを根拠にした売買を禁じるもので、ギャップと無関係の節目/トレンド/アラート根拠のエントリーは通常どおり可。
- すべての価格は円単位の実数(NIY=F の実値レンジ)で、refPrice(現在値)と整合させる。
- rationale は日本語で判断根拠を簡潔に述べる。★rationale は実際に出力したレッグだけ説明すること(食い違いは両方向とも禁止): ①出していないレッグを「置いた」と書かない。②「省略する/見送る」と述べたレッグは その対の価格フィールド(limitEntry+stopLossForLimit / stopEntry+stopLossForStop)を JSON に書かないこと=★省略とは価格を出さないことであり、価格を出して「省略した」と述べるのは矛盾(そのレッグは書いたとおりに発注される)。${trendVetoYen > 0 ? `
- ★【レジーム/勢い】${trendGuidance(trendVetoYen)}` : ''}${techLine}`;
}

// 固定のスキャル system prompt(既定 LC 幅 45〜65)。プロンプト文言テストや後方互換のための既定インスタンス。
export const SCALP_SYSTEM_PROMPT = buildScalpSystemPrompt();

/** 各 knob の委任モード。全 knob 'manual'(既定)なら委任ノートは空=プロンプト不変(回帰なし)。 */
export interface KnobModes {
  lcFloor: KnobSource; lcCeiling: KnobSource; trendVeto: KnobSource;
  cooldown: KnobSource; bias: KnobSource; range: KnobSource;
}

/** ★v0.9.44: buildScalpPlan がインラインで組み立てていた注記を純関数化(出力は byte 不変=挙動不変)。
 *  目的は「AI に届く文字列の生成箇所」を全てテストで固定できるようにすること。旧実装では biasNote /
 *  heldNote / armedNote / visionNote がテストから到達できず、新ルールとの矛盾が入り込んでも検出できなかった。 */

/** エントリー方向の制約(手動バイアス時のみ)。'none' は '' = 注入なし。 */
export function buildBiasNote(bias: ScalpBias): string {
  return bias === 'long'  ? '\n\n【エントリー方向の制約】買い中心。売り(sell)の新規は原則見送り(direction:"none")とし、買い(buy)の好機のみ提案すること。'
       : bias === 'short' ? '\n\n【エントリー方向の制約】売り中心。買い(buy)の新規は原則見送り(direction:"none")とし、売り(sell)の好機のみ提案すること。'
       : '';
}

/** ドテン(保有中の反転評価=held-eval)。未指定(flat-plan)は '' = 従来と byte 一致。 */
export function buildHeldNote(held?: { dir: 'buy' | 'sell'; entry: number }): string {
  if (!held) return '';
  return `\n\n【保有中(ドテン評価)】現在 ${held.dir === 'buy' ? 'long(買い)' : 'short(売り)'}@${Math.round(held.entry)} を保有中です。`
    + `ドテン(反転=決済して同時に反対方向へ新規)が許可されています。決済が妥当かつ反対方向へ強く動く場面だと判断したときだけ、`
    + `direction を保有と反対(${held.dir === 'buy' ? 'sell' : 'buy'})にした反転プランを返してよい(常にではなく、その場面だけ)。`
    + `反転が不要なら direction:"none" で保有継続とすること。`;
}

/** レンジ再評価(未約定→ブレイク)。未指定(通常)は '' = 従来と byte 一致。 */
export function buildArmedNote(ctx?: { mode: 'range-fade'; ageMs: number; avgMs: number }): string {
  if (!ctx) return '';
  return `\n\n【レンジ未約定(ブレイク再評価)】現在レンジ両指値を ARM後 ${Math.round(ctx.ageMs / 60_000)}分 未約定`
    + `(平均 ${Math.round(ctx.avgMs / 60_000)}分 を超過)。レンジが反発せず抜けそうなら breakout(両側ブレイク新規・range 各レッグ type:"stop")の組へ`
    + `切替えたプランを返してよい(組は混ぜない)。反発継続が見込めるなら現状維持(同じ fade=両側指値の組)。場面が崩れたなら direction:none。`;
}

/** ★v0.9.61: バンドウォーク成立中だけの注記(未成立/未判定は '' = プロンプトは従来と byte 一致)。
 *
 *  緩めるのは **エントリーまでの距離と、節目を起点にせよという要求の2つだけ**。
 *  ★損切り(LC)の下限・上限・安全上限、および 価格/損切りの向きの不等式は **一切緩めない**
 *   (この注記の中でもそれを明記して、AI が「全部自由になった」と読まないようにする)。
 *  理由: バンドウォーク中は価格がバンドに沿って動き続けるため、節目まで引きつけた 50円以上離れた指値は
 *  置いていかれて約定しない。ユーザー指定「節目にこだわらず近くの逆指値や指値も可」。 */
export function buildBandwalkNote(bw?: Bandwalk | null): string {
  if (!bw) return '';
  const dirJa = bw.direction === 'up' ? '上昇(買い方向)' : '下降(売り方向)';
  return `\n\n【バンドウォーク成立中(${dirJa})】${describeBandwalk(bw)}\n`
    + 'この局面に限り、上に書いた次の2点だけを緩めてよい:\n'
    + '  ①指値・ブレイク新規を現在値から最低50円離す、という最低距離は課さない(現在値のすぐ近く=数円〜数十円 に置いてよい)。\n'
    + '  ②エントリーを節目(サポート/レジスタンス)から導く要求も課さない(近くに節目が無くてもよい。'
    + `バンドウォークの向き(${bw.direction === 'up' ? '買い' : '売り'})に沿って、押し目/戻りの浅い指値(limitEntry) や `
    + '直近高安をすぐ抜けるブレイク新規(stopEntry) を、現在値の近くに置いてよい)。\n'
    + '  ★緩むのはこの2点のみ。損切り(LC)幅の下限・上限・安全上限、【最優先: 価格の向き】と【最優先: 損切りの向き】の不等式、'
    + '距離の上限(片レッグ200円以内/両レッグ幅400円以内)は **一切変わらない**(そのまま厳守すること)。\n'
    + '  ★バンドウォークは「価格の急変が起きるまで続く」と見なしてよいが、逆方向に強く反転したと判断したら'
    + ' 無理にこの向きへ入らず direction:"none" で見送ること。';
}

/** チャート画像を添付した時だけの注記。 */
export function buildVisionNote(hasImage: boolean): string {
  return hasImage ? '添付のチャート画像(当日の日経225先物のローソク足・主要水準・直近アラート)も判断材料にすること。\n\n' : '';
}

/** ★v0.7.56: AI に委任した knob だけ「この値はあなたが決める(自由・根拠を述べよ)」を動的に注入する。
 *  全 knob 手動(既定)なら '' を返す=system prompt は従来と byte 単位で不変。追記(additive)方式で、
 *  ai の knob については上の手動制約文を上書きする旨を明示する(コードの enforce も同時に制約を外す)。 */
export function buildDelegationNote(
  modes: KnobModes,
  ctx: { floorYen: number; ceilingYen: number; hardMax: LcHardMax },
): string {
  // ★AI委任は「制約を外すだけ」でなく、その項目が本来担っていた判断ロジック(狙い・基準・なぜ・使うデータ)を
  //   AI に正確に転写する。そうしないと AI は"意味を知らないまま自由になる"だけになる(=判断が盲目化する)。
  //   ※非公開の phase-exit の具体数値は書かない(公開リポ)。転写は定性的に留める。
  const lines: string[] = [];
  if (modes.lcCeiling === 'ai') {
    // ★v0.9.56: 上の各所は委任時「下限〜実効上限の範囲」として提示済み(保存値は印字されない)ので、
    //   旧文「上の固定的なLC上限の数値指示は無視してよい」は宛先が消えた=矛盾になる。範囲の読み方に置き換える。
    const capYen = lcEffectiveCeiling({ ceilingYen: ctx.ceilingYen, ceilingMode: 'ai', lcHardMax: ctx.hardMax });
    const capLabel = ctx.hardMax.enabled ? '安全上限' : 'コード上限';
    const cap = ctx.hardMax.enabled
      ? `なお実弾の暴走防止として安全上限 ${ctx.hardMax.value}円 だけは絶対に超えないこと。`
      : '';
    lines.push(
      // ★v0.9.61(削除): 「損切りは **直近の節目**/スイングの外側に置き…妥当な幅を自分で決め」は、実測で判明した
      //   誤りそのもの(隣接=エントリーと同じ節目を損切りの基準にすると幅は数円にしかならない)を指示していた。
      //   併せて「節目/スイングの位置から損切り価格を先に決め、幅はその結果」も LC_DERIVATION_ORDER の弱い写しなので削る。
      `最大初期LC(損切り幅): あなたが決める。狙い=この建玉は利が乗ると段階的に利確し損切りを引き上げる決済方式のため、` +
      `初期LCは「1回の損切りが積み上げた利益を飛ばさない」幅に収める(コツコツドカン回避)。` +
      `上の各所に書いてある LC 幅「下限${ctx.floorYen}円〜${capLabel}${capYen}円」は **あなたが選べる範囲** であって、` +
      `その下限や上限に貼り付ける目安ではない(幅は上の【導出の順序】で節目から導いた結果として出す)。${cap}`,
    );
  }
  if (modes.lcFloor === 'ai') {
    // ★下限は委任できない(決済ロジックの前提条件)。設定が 'ai' でもコードは下限を強制するので、
    //   「自由に決めてよい」と誤解させないよう、委任の対象外であることをここで明示する。
    // ★v0.9.61(削除): 意味と理由の本文は lcFloorReason に一本化し、戦略仕様ブロックで **モードに依らず常時** 出す
    //   (旧実装はこの分岐の中だけに理由があり、運用機の設定=下限手動では一度も AI に届いていなかった)。
    //   ここに残すのは「委任にしても外れない」という、この分岐でしか言えない文脈だけ。
    lines.push(
      `初期LC下限: ★これは委任の対象外です。設定を「AI委任」にしても下限${ctx.floorYen}円は外れません` +
      `(意味と理由は上の【戦略ロジック仕様】の初期LC下限の項を参照し、そのとおり あなたが必ず満たすこと)。`,
    );
  }
  if (modes.trendVeto === 'ai') {
    lines.push(
      `トレンド/レンジの見極め: 固定の数値閾値は課さない=あなたが判定する。判断ロジック: 直近10〜30分がほぼ横ばいのときだけ「レンジ」とみなす。` +
      `レンジと判断したときの取り方は上の2択に従うこと(上下の反応帯の幅が広ければ fade=両側指値の組 / 狭い横這いなら breakout=両側ブレイク新規の組。狭いレンジで逆張りしない)。` +
      `直近が一方向に明確に動いていれば「トレンド」であり、それに逆行する新規(順トレンドの高値を売る/安値を買う戻り売買)は出さないこと。` +
      `★根拠: 生きたトレンドをフェードすると負ける(monitorの実データで勝率約2割・9年バックテストでも不利)ことが確認済み。` +
      `上で渡す「直近の勢い(10分/30分の値動き・MA20傾き・直近高安内の位置)」の数値を必ず根拠に使い、regime と confidence を自分で下すこと。` +
      `トレンドなら順張り(押し目/戻りの順張り or ブレイク新規(stopEntry))か direction:"none" で見送りにする。`,
    );
  }
  if (modes.bias === 'ai') {
    lines.push('売買方向(buy/sell): あなたが自由に決めてよい(バイアスの強制なし)。ただし明確な逆行トレンドには逆らわないこと(上のトレンド判断を優先)。');
  }
  if (modes.range === 'ai') {
    lines.push(
      'レンジ両面: 明確な方向性が無く上下に反応帯があると判断すれば range(両面=現在値の上下に1レッグずつ置く両面ストラドル)を提案してよい。' +
      '取り方は上の2択(fade=両側指値の組 / breakout=両側ブレイク新規の組)に従い、組は混ぜないこと。' +
      '★連敗が続いている(単方向のエントリーが機能していない)ときは、相場がレンジ(往復)で単方向が負け続けている可能性が高い。' +
      'その場合は上の「直近の成績(連敗)」を根拠に、range(両面)へ切り替えた方がよいかを必ず検討すること。' +
      'ただしトレンドが明確なら range にしない(生きたトレンドの両側フェードは不利=負ける)。真に横ばい/往復のときだけ range にする。');
  }
  if (modes.cooldown === 'ai') {
    lines.push('再エントリー: 決済直後でも明確な好機があれば提案してよい(クールダウンの強制なし)。ただし直近で損切りした直後に同じ理由で突入し直すことは避けること。');
  }
  if (lines.length === 0) return '';
  return '\n\n【AI委任(以下の項目はあなたの裁量。上のロジックを踏まえ、必ず根拠を述べること)】\n- ' + lines.join('\n- ');
}

// LLM に構造化 JSON を強制するための出力指示。JSON モード非対応プロバイダでも効くよう厳格な文言で指示し、パースで検証する。
// LC 幅注記に floor/ceiling を反映する(テスト可能なよう export)。
export function scalpJsonInstruction(
  refPrice: number,
  floorYen: number = DEFAULT_LC_FLOOR_YEN,
  ceilingYen: number = DEFAULT_LC_CEILING_YEN,
  rangeEnabled = true,
  // ★v0.9.56: 上限が AI委任のときだけ提示の形を変える(既定=手動=従来と byte 一致)。
  lcCeil: LcCeilingPresentation = LC_CEIL_MANUAL,
): string {
  // ★v0.9.56 ①: LC 幅の書き方だけが手動(保存値)/委任(実効上限までの範囲)で分かれる。
  // ★v0.9.60: 旧文言「本来のストップ位置から+5円外側」をこのフィールド注記から撤去した。
  //   実測(2026-08-04)で落ちたレッグの LC幅は中央値 5円 で、指値レッグは lcFloor・ブレイク新規レッグは
  //   stopSide(=エントリーの上/下 5円)に固まっていた。これは「+5円外側」を **エントリー価格** に対して適用し、
  //   かつ「外側」を直前の『ブレイク新規は節目の0〜5円外側(抜ける方向)』と同じ向きに読んだ結果と完全に整合する。
  //   フィールドのすぐ隣にある注記は最も強く効くので、ここには **向きと幅の判定条件だけ** を置き、
  //   緩衝(+5円)の説明は LC_BUFFER_NOTE / LC_DERIVATION_ORDER 側に一本化する。
  const lcWidth = lcCeil.delegated
    ? `LC幅は${floorYen}〜${ceilingYen}円の範囲で節目から導いてあなたが決める`
    : `LC幅${floorYen}〜${ceilingYen}円`;
  const lcNote = `買いはエントリーより下/売りはエントリーより上・${lcWidth}・${floorYen}円未満は不可・レッグ独立で${ceilingYen}円超は出さない・エントリーからの固定距離(建値の隣のティック等)で決めない`;
  const dirEnum = rangeEnabled ? `"buy" | "sell" | "none" | "range"` : `"buy" | "sell" | "none"`;
  // レンジ両面ストラドルの JSON 形(direction:"range" の時のみ)。数値は円単位の実数。
  const rangeShape = rangeEnabled
    ? `  "range": {                  // direction:"range"(レンジ両面ストラドル)の時のみ。現在値の上下に1レッグずつ\n` +
      `    "upper": { "side": "buy"|"sell", "type": "limit"|"stop", "entry": number, "stopLoss": number },  // entry は現在値超\n` +
      `    "lower": { "side": "buy"|"sell", "type": "limit"|"stop", "entry": number, "stopLoss": number }   // entry は現在値未満\n` +
      `  },\n`
    : '';
  return `最終的な回答は、次のスキーマに厳密に一致する JSON オブジェクトのみを出力してください(前後の説明文・コードフェンス・マークダウンは一切付けない)。\n` +
    `{\n` +
    `  "regime": "trend_up" | "trend_down" | "range" | "unclear",  // まず自分で現在の相場レジームを判定して入れる\n` +
    `  "confidence": number,        // このレジーム判断と計画への確信度(0〜100の整数)\n` +
    `  "direction": ${dirEnum},  // none=見送り(良い場面が無い)。none の時は下の価格4つは不要(rationale と refPrice のみ)${rangeEnabled ? '。range=レンジ両面(range フィールドを使い buy/sell 用の価格4つは不要)' : ''}\n` +
    `  "limitEntry": number,        // 指値(押し目/戻り側の新規)。none/range または指値レッグ不採用(ブレイク新規のみ)の時は省略(stopLossForLimit と対で省く)\n` +
    `  "stopEntry": number,         // ブレイク新規(ブレイク側の新規エントリー。損切りではない)。none/range またはブレイク新規レッグ不採用(指値のみ)の時は省略(stopLossForStop と対で省く)\n` +
    `  "stopLossForLimit": number,  // 指値約定時の損切り(${lcNote})。指値レッグを出さない/none の時は limitEntry と対で省略\n` +
    `  "stopLossForStop": number,   // ブレイク新規約定時の損切り(${lcNote})。ブレイク新規レッグを出さない/none の時は stopEntry と対で省略\n` +
    rangeShape +
    // ★v0.9.64: 幅の申告 → 代入の式の申告(置換)。フィールド直下の注記は最も強く効くので、
    //   ここでも「式の答え=出力する数値」を要求する。併せて「省略」の定義(キーを書かない)を1句だけ添える。
    `  "rationale": string,         // 判断理由(日本語)。none の時は見送り理由。★出したレッグごとに、損切りを出した代入の式(例「指値レッグ (エントリー価格)−(LC幅)=(損切り価格)」・売りは「+」)を必ず含め、式の答えを上の stopLossFor… と一致させる。★「省略」と述べたレッグは そのキー自体を出力しない\n` +
    `  "refPrice": number           // 計画時に見た現在値(${refPrice})\n` +
    `}\n` +
    `refPrice は ${refPrice} を使うこと。数値はすべて円単位の実数(引用符なし)。`;
}

/** レンジ両面ストラドルの1レッグを検証する純関数。side/type の enum・entry/stopLoss の有限性を確認。
 *  不正(型違い・非有限・欠落)なら null。幾何(現在値の上下)の判定は呼び出し側の責務。 */
export function parseRangeLeg(v: unknown): RangeLeg | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.side !== 'buy' && o.side !== 'sell') return null;
  if (o.type !== 'limit' && o.type !== 'stop') return null;
  const entry = typeof o.entry === 'number' && Number.isFinite(o.entry) ? o.entry : null;
  const stopLoss = typeof o.stopLoss === 'number' && Number.isFinite(o.stopLoss) ? o.stopLoss : null;
  if (entry === null || stopLoss === null) return null;
  return { side: o.side, type: o.type, entry, stopLoss };
}

const SCALP_REGIMES = new Set(['trend_up', 'trend_down', 'range', 'unclear']);

/** AI 自己レジームを寛容にパース(enum 外/非文字列は undefined)。記録のみ=後方互換。 */
export function parseAiRegime(v: unknown): AiPlan['regime'] {
  return typeof v === 'string' && SCALP_REGIMES.has(v) ? v as AiPlan['regime'] : undefined;
}

/** AI 確信度を寛容にパース(有限数を 0-100 にクランプ・非有限/非数値は undefined)。記録のみ=後方互換。 */
export function parseAiConfidence(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, v));
}

/** 損切り(stopLoss)がエントリーの正しい外側にあるか(幾何・向き検証)。純関数。
 *  買い(long)は損切りがエントリーの「下」、売り(short)は「上」に置く(建玉を保護する向き)。
 *  境界(stopLoss===entry=幅0)は実質ストップにならないので不正(false)。
 *  ★実害バグ対策: 買いなのに損切りが上(逆側)のプランは trade2 のサニティが拒否し実弾ゼロになる。
 *    発生源(parse/enforce)でこの向きを検証し、違反レッグを落とすことで紙エンジンと実弾を一致させる。 */
export function stopSideOk(side: 'buy' | 'sell', entry: number, stopLoss: number): boolean {
  return side === 'buy' ? stopLoss < entry : stopLoss > entry;
}

/** エントリーが refPrice の正しい側にあるか(幾何・純関数)。
 *  limit(指値=押し目/戻り): buy は現在値より下・sell は現在値より上。
 *  stop(逆指値=ブレイク追随): buy は現在値より上・sell は現在値より下。
 *  境界(entry===refPrice=距離0)は即約定=不正。refPrice 非有限は検証しない(true=従来通り通す)。 */
export function entrySideOk(direction: 'buy' | 'sell', kind: 'limit' | 'stop', entry: number, refPrice: number): boolean {
  if (!Number.isFinite(refPrice)) return true;
  // buy 指値=下 / buy 逆指値=上 / sell 指値=上 / sell 逆指値=下。
  const wantBelow = kind === 'limit' ? direction === 'buy' : direction === 'sell';
  return wantBelow ? entry < refPrice : entry > refPrice;
}

/** LLM のテキスト応答から AiPlan を抽出・検証する純関数。refPrice は monitor 側の現在値で必ず上書きする。
 *  コードフェンスや前後の説明文が混じっていても最初の { … } を拾ってパースする。失敗時は { ok:false }。 */
/** ★v0.9.59: レッグが最終プランに残らなかった理由の表示文(SSOT)。**非公開の決済数値は一切書かない**
 *  (下限/上限は「設定の下限/上限」と呼ぶだけで、値は設定画面にしか出さない)。
 *  語彙は NoneReason をそのまま使う(新しい理由を作らない)。実際に現れるのは
 *  missing / stopSide / geometry(parse 段)と stopSide / lcFloor / lc / trend / bias(enforce 段)。 */
const LEG_DROP_REASON_TEXT: Record<NoneReason, string> = {
  missing:       'AIが提案せず',
  ai:            'AIが提案せず',
  stopSide:      '損切りがエントリーの逆側',
  geometry:      'エントリーが現在値の逆側',
  lcFloor:       '損切り幅が設定の下限より狭い',
  lc:            '損切り幅が設定の上限より広い',
  trend:         'トレンドに逆行',
  bias:          'バイアス設定と逆',
  stale:         '現在値が既にエントリーを通過',
  rangeDisabled: 'レンジ設定が無効',
};

/** 「AI がそもそも出さなかった」理由。ここだけ『なし』と書き、それ以外は『出したが不採用』と書き分ける
 *  (ユーザーにとって意味が違う: 前者は AI の判断・後者はコードの検証で落ちた)。 */
const LEG_NOT_PROPOSED: readonly NoneReason[] = ['missing', 'ai'];

/** レッグ1本ぶんの脱落注記(短文・純関数)。 */
function legDropPhrase(name: '指値' | '逆指値', reason: NoneReason): string {
  const text = LEG_DROP_REASON_TEXT[reason];
  return LEG_NOT_PROPOSED.includes(reason)
    ? `（${name}なし: ${text}）`
    : `（${name}は不採用: ${text}）`;
}

/** ★表示整合(v0.7.41 / 文面刷新 v0.9.59): 最終 plan に **残らなかった** レッグの理由を、日本語の短い注記に
 *  する純関数。パネルは plan.rationale をそのまま表示するため、AI の自由文が「出していないレッグ(逆指値等)を
 *  置いた」と語っても、この注記を末尾に足すことで表示が実プランと矛盾しないようにする。
 *  ★v0.9.59(ユーザー指示): 「（実際の注文: 指値+逆指値）」のような **プラン内容の言い直しは書かない**
 *    (画面のシグナル欄を見れば分かるため)。書くのは「なぜ片方が無いのか」だけ。
 *  - hasLimit/hasStop: 最終 plan に指値/逆指値レッグが入っているか(plan.limitEntry/stopEntry != null)。
 *  - drops: そのステージが記録した LegDrop 群(記録専用の配列をそのまま渡す=表示と記録が同じ理由を指す)。
 *  両レッグ揃っている / 落ちた理由が分からない場合は空文字を返す(追記しない)。private 定数は一切出さない。 */
export function buildLegNote(
  args: { hasLimit: boolean; hasStop: boolean; drops?: readonly LegDrop[] },
): string {
  const { hasLimit, hasStop, drops } = args;
  if (hasLimit && hasStop) return '';   // 両方あるなら説明することは無い(シグナル表示そのもの)。
  const reasonOf = (name: LegDrop['name']): NoneReason | undefined =>
    drops?.find(d => d.name === name)?.reason;
  const parts: string[] = [];
  if (!hasLimit) {
    const r = reasonOf('limit');
    if (r) parts.push(legDropPhrase('指値', r));
  }
  if (!hasStop) {
    const r = reasonOf('stop');
    if (r) parts.push(legDropPhrase('逆指値', r));
  }
  return parts.join('');
}

export function parseScalpPlan(raw: string, refPrice: number): ScalpPlanResult {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'empty response' };
  // ```json … ``` を剥がし、最初の { から最後の } までを候補にする。
  const fenced = text.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON object found' };
  let obj: unknown;
  try {
    obj = JSON.parse(fenced.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof obj !== 'object' || obj === null) return { ok: false, error: 'not an object' };
  const o = obj as Record<string, unknown>;
  if (o.direction !== 'buy' && o.direction !== 'sell' && o.direction !== 'none' && o.direction !== 'range') return { ok: false, error: 'invalid direction' };
  const rationale = typeof o.rationale === 'string' ? o.rationale.trim() : '';
  if (!rationale) return { ok: false, error: 'missing rationale' };
  // ★AI自己レジーム/確信度(記録のみ)。寛容にパースし、成立した全 plan(none/range/directional)に載せる。
  //   ゲートには使わない=既存の direction/価格の検証挙動は完全に不変。
  const regime = parseAiRegime(o.regime);
  const confidence = parseAiConfidence(o.confidence);
  const withMeta = (p: AiPlan): AiPlan => {
    if (regime !== undefined) p.regime = regime;
    if (confidence !== undefined) p.confidence = confidence;
    return p;
  };
  // ★見送り(direction:"none"): 価格は不要。rationale + refPrice のみで ok:true の正当な「見送り」応答。
  //   これはエラー(ok:false)ではない=plan-failed とは区別される。
  if (o.direction === 'none') {
    return { ok: true, plan: withMeta({ direction: 'none', rationale, refPrice }), noneReason: 'ai' };
  }
  // ★レンジ両面ストラドル(direction:"range"): range.upper / range.lower を各レッグ検証。
  //   幾何(upper.entry>refPrice>lower.entry)を満たさない/壊れているレッグは落とす。片レッグでも残れば range として通す。
  //   両レッグとも無効なら「見送り(none)」として ok:true を返す(エラーにはしない)。
  if (o.direction === 'range') {
    const rangeObj = typeof o.range === 'object' && o.range !== null ? o.range as Record<string, unknown> : {};
    let upper = parseRangeLeg(rangeObj.upper);
    let lower = parseRangeLeg(rangeObj.lower);
    // ★v0.9.44(記録専用): 落とす前の生数値を控える。none 化したときログ1行に出す(採否には使わない)。
    const upper0 = upper;
    const lower0 = lower;
    // ★脱落理由の記録(表示専用・v0.9.37): AI の rationale は「上下両面に置いた」と語るのに画面は片側だけ、
    //   という「理由の無い片面」を無くす。落とす前の side を控え、enforcePlanConstraints と同じ流儀
    //   (rangeDropNote + \n 連結)で rationale に追記する。採否ロジック(何を落とすか)は一切変えない。
    const upperSide0 = upper?.side;
    const lowerSide0 = lower?.side;
    // AI がそもそもレッグを出さなかった(欠落・壊れた形で parseRangeLeg が null)場合も無言にしない。
    let upperReason: RangeDropReason | null = upper ? null : 'missing';
    let lowerReason: RangeDropReason | null = lower ? null : 'missing';
    // 現在値の上下の幾何を満たさないレッグは落とす(upper は現在値超・lower は現在値未満)。
    if (upper && !(upper.entry > refPrice)) { upper = null; upperReason = 'geometry'; }
    if (lower && !(lower.entry < refPrice)) { lower = null; lowerReason = 'geometry'; }
    // ★損切りの向き検証: 各レッグは自分の side を持つ → buy レッグは stopLoss<entry・sell レッグは stopLoss>entry。
    //   内側/反対側(境界=幅0 も)の損切りを持つレッグは落とす(不正プランを出さない)。幾何(向き)のみ=LC 幅は enforce の責務。
    if (upper && !stopSideOk(upper.side, upper.entry, upper.stopLoss)) { upper = null; upperReason = 'stopSide'; }
    if (lower && !stopSideOk(lower.side, lower.entry, lower.stopLoss)) { lower = null; lowerReason = 'stopSide'; }
    // ★v0.9.57(記録専用): 脚1本ごとの脱落を、**片脚だけ落ちた回でも** 構造化して残す(採否は不変)。
    const rangeLegDrops: LegDrop[] = [];
    pushLegDrop(rangeLegDrops, 'upper', upperReason, upper0?.entry, upper0?.stopLoss);
    pushLegDrop(rangeLegDrops, 'lower', lowerReason, lower0?.entry, lower0?.stopLoss);
    if (!upper && !lower) {
      // 両脚とも落ちた見送り(none)は rationale を据え置く(enforce の両脚落ちと同じ既存挙動)。
      return {
        ok: true, plan: withMeta({ direction: 'none', rationale, refPrice }),
        noneReason: pickNoneReason(upperReason, lowerReason),
        noneLegs: noneLegsFromRange(upper0, lower0),
        legDrops: rangeLegDrops,
      };
    }
    // 片脚だけ残って range を出す場合、落ちた脚の理由を rationale に明記(表示専用テキスト)。
    const notes: string[] = [];
    if (upperReason) notes.push(rangeDropNote('上部', upperSide0, upperReason));
    if (lowerReason) notes.push(rangeDropNote('下部', lowerSide0, lowerReason));
    const rangeRationale = notes.length ? `${rationale}\n${notes.join('\n')}` : rationale;
    const range: { upper?: RangeLeg; lower?: RangeLeg } = {};
    if (upper) range.upper = upper;
    if (lower) range.lower = lower;
    const rangeOut: Extract<ScalpPlanResult, { ok: true }> =
      { ok: true, plan: withMeta({ direction: 'range', rationale: rangeRationale, refPrice, range }) };
    if (rangeLegDrops.length) rangeOut.legDrops = rangeLegDrops;
    return rangeOut;
  }
  const num = (v: unknown): number | null =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const limitEntry = num(o.limitEntry);
  const stopEntry = num(o.stopEntry);
  const stopLossForLimit = num(o.stopLossForLimit);
  const stopLossForStop = num(o.stopLossForStop);
  // ★レッグ単位の検証: 指値レッグ=limitEntry+stopLossForLimit の対、逆指値レッグ=stopEntry+stopLossForStop の対。
  //   各レッグは「両方あり」か「両方なし」のみ有効(片方だけは不整合=invalid)。少なくとも1レッグあれば ok。
  //   LC≤95 等の数値強制はここではしない(trade2 側の責務)。ここは幾何的なレッグ対の整合のみ。
  const hasLimitLeg = limitEntry !== null && stopLossForLimit !== null;
  const hasStopLeg = stopEntry !== null && stopLossForStop !== null;
  // 片側だけ埋まっているレッグ(対の不整合)は不正。
  if ((limitEntry !== null) !== (stopLossForLimit !== null)) {
    return { ok: false, error: 'invalid limit leg (limitEntry/stopLossForLimit must be paired)' };
  }
  if ((stopEntry !== null) !== (stopLossForStop !== null)) {
    return { ok: false, error: 'invalid stop leg (stopEntry/stopLossForStop must be paired)' };
  }
  // 両レッグとも欠落(direction≠none なのに価格皆無)は不正。
  if (!hasLimitLeg && !hasStopLeg) {
    return { ok: false, error: 'invalid price field(s): at least one leg required' };
  }
  // ★損切りの向き検証(orientation): buy は損切りが各エントリーの下・sell は上。境界(SL==entry=幅0)も不正。
  //   加えて★エントリー位置の向き検証(entrySideOk): refPrice(現在値=SSOT)に対し 指値/逆指値が正しい側にあるか。
  //   買いは 指値=現在値より下・逆指値=現在値より上/売りは 指値=現在値より上・逆指値=現在値より下(逆置きは即約定=不正)。
  //   レッグは stopSideOk と entrySideOk の両方を満たすときだけ有効。違反レッグは落とす(既存の「片レッグ落とし」と同じ
  //   機構=entry+SL を省く)。ここは幾何(向き)のみで、LC 幅≤上限の強制は enforce の責務(不変)。
  //   両レッグとも違反で落ちたら「見送り(none)」を ok:true で返す。
  const limitLegOk = hasLimitLeg && stopSideOk(o.direction, limitEntry!, stopLossForLimit!) && entrySideOk(o.direction, 'limit', limitEntry!, refPrice);
  const stopLegOk = hasStopLeg && stopSideOk(o.direction, stopEntry!, stopLossForStop!) && entrySideOk(o.direction, 'stop', stopEntry!, refPrice);
  // ★v0.9.44(記録専用): どの検証で落ちたかをレッグ単位で判定して残す(採否は不変)。
  //   検証順(stopSideOk → entrySideOk)に合わせ、レッグ不在=missing / SL 向き違反=stopSide / 残りは geometry。
  // ★v0.9.57: 判定を **両レッグ落ちの分岐の外** へ出した(値は従来と同一・null=そのレッグは落ちていない)。
  //   片レッグだけ落ちた回にも同じ理由が要るため。両レッグ落ちの分岐では従来どおり必ず非 null になる
  //   (=noneReason の値は一切変わらない)。
  const limitReason: NoneReason | null =
    limitLegOk ? null
    : !hasLimitLeg ? 'missing'
    : !stopSideOk(o.direction, limitEntry!, stopLossForLimit!) ? 'stopSide' : 'geometry';
  const stopReason: NoneReason | null =
    stopLegOk ? null
    : !hasStopLeg ? 'missing'
    : !stopSideOk(o.direction, stopEntry!, stopLossForStop!) ? 'stopSide' : 'geometry';
  const legDrops: LegDrop[] = [];
  pushLegDrop(legDrops, 'limit', limitReason, limitEntry, stopLossForLimit);
  pushLegDrop(legDrops, 'stop', stopReason, stopEntry, stopLossForStop);
  if (!limitLegOk && !stopLegOk) {
    return {
      ok: true, plan: withMeta({ direction: 'none', rationale, refPrice }),
      noneReason: pickNoneReason(limitReason, stopReason),
      noneLegs: noneLegsFromDirectional(o.direction, { limitEntry, stopLossForLimit, stopEntry, stopLossForStop }, false, false),
      legDrops,
    };
  }
  // refPrice は LLM の自己申告ではなく monitor の現在値を正とする。
  // 存在し、かつ向きが正しいレッグの価格のみ plan に入れる(欠落/向き違反レッグは省略=undefined)。
  const plan: AiPlan = { direction: o.direction, rationale, refPrice };
  if (limitLegOk) {
    plan.limitEntry = limitEntry!;
    plan.stopLossForLimit = stopLossForLimit!;
  }
  if (stopLegOk) {
    plan.stopEntry = stopEntry!;
    plan.stopLossForStop = stopLossForStop!;
  }
  // ★表示整合: 実際に採用したレッグを rationale 末尾に機械生成の注記として追記(directional のみ)。
  //   採用の有無は最終 plan から判定。AI が出したが検証で落ちたレッグは「不採用」タグを付す。none/range 経路は
  //   触らない(上で return 済み)。
  // ★★注記を足すのはこの1箇所だけ=「parseScalpPlan は AI の生応答に対して1回だけ呼ぶ」ことが前提(呼び出し側の責務)。
  //   注記済みの plan を JSON 化して再度この関数に通すと、注記は当然もう1回付く(=二重)。実際 v0.9.46 まで
  //   buildScalpPlan が「runScalpPlan(内部で parse 済) → JSON.stringify → parseScalpPlan」と2回通していたため、
  //   画面の根拠文が『（実際の注文: 指値のみ…）（逆指値レッグは…不採用） （実際の注文: 指値のみ…）』と二重になっていた
  //   (レンジ側も、既に落ちた脚が2回目には「AIが提示しなかった」と誤って追記されていた)。再 parse そのものを廃止して解消。
  //   ここで文字列を見て「もう付いているか」を判定するような対症療法はしない(生 rationale を汚さない)。
  // ★v0.9.59: 注記の理由は **記録用の legDrops と同じ配列** から引く(表示と台帳が同じ理由を指す)。
  const legNote = buildLegNote({
    hasLimit: plan.limitEntry != null,
    hasStop: plan.stopEntry != null,
    drops: legDrops,
  });
  if (legNote) plan.rationale = `${rationale} ${legNote}`;
  // ★v0.9.57(記録専用): 片レッグだけ落ちた回の理由を構造化して返す。上の buildLegNote は日本語の
  //   表示文にしかしないので、台帳では「AI が出さなかった(missing)」と「向き違反で落とした
  //   (geometry/stopSide)」が区別できなかった。plan・rationale・採否は一切変えない。
  const out: Extract<ScalpPlanResult, { ok: true }> = { ok: true, plan: withMeta(plan) };
  if (legDrops.length) out.legDrops = legDrops;
  return out;
}

/** マルチモーダルなユーザメッセージ content を組み立てる。画像があればテキスト+image_url の配列、
 *  無ければ従来どおりプレーン文字列(テキストのみ)を返す。OpenAI/Gemini(OpenAI 互換)共通形式。
 *  data URL は `data:image/png;base64,<...>`。テスト可能な純関数。 */
export function buildScalpUserContent(userPrompt: string, imageDataUrl?: string | null): any {
  if (!imageDataUrl) return userPrompt;
  return [
    { type: 'text', text: userPrompt },
    { type: 'image_url', image_url: { url: imageDataUrl } },
  ];
}

/** スキャルプラン生成の純ループ(LLM 非依存=テスト可能)。tool ループで回答→parse、失敗なら tools 無しで
 *  厳格に1回だけ再要求→再parse。成功で **parse 結果まるごと**(plan + noneReason/noneLegs)、失敗で例外。
 *  ★parseScalpPlan はこの関数の中でしか呼ばない=AI の生応答1つに対して parse は必ず1回(注記も1回)。
 *   呼び出し側(buildScalpPlan)は戻り値をそのまま使い、plan を JSON 化して再 parse してはならない(v0.9.46 の
 *   注記二重付与の真因)。create/handlers を注入してテストする。
 *  imageDataUrl を渡すと初回・再要求ともにチャート画像を添付する(ビジョン対応プロバイダ時のみ呼び出し側で渡す)。 */
export async function runScalpPlanResult(
  create: CreateFn, systemPrompt: string, userPrompt: string,
  tools: unknown[], handlers: ToolHandlers, refPrice: number,
  imageDataUrl?: string | null,
): Promise<Extract<ScalpPlanResult, { ok: true }>> {
  const userContent = buildScalpUserContent(userPrompt, imageDataUrl);
  const baseMessages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const first = await runChatWithTools(create, baseMessages, tools, handlers);
  const parsed = parseScalpPlan(first, refPrice);
  if (parsed.ok) return parsed;
  // パース失敗 → 厳格に1回だけ再要求(tools 無し・JSON のみ)。
  const retry = await create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
      { role: 'assistant', content: first },
      { role: 'user', content: `直前の応答は指定 JSON スキーマに一致していません(${parsed.error})。説明やコードフェンスを一切付けず、スキーマに厳密一致する JSON オブジェクトだけを出力し直してください。` },
    ],
  });
  const retryText = retry.choices?.[0]?.message?.content?.trim() ?? '';
  const parsed2 = parseScalpPlan(retryText, refPrice);
  if (parsed2.ok) return parsed2;
  throw new Error(`parse failed after retry: ${parsed2.error}`);
}

/** runScalpPlanResult の薄いラッパ(後方互換)。plan だけを返す=既存の呼び出し/テストは不変。 */
export async function runScalpPlan(
  create: CreateFn, systemPrompt: string, userPrompt: string,
  tools: unknown[], handlers: ToolHandlers, refPrice: number,
  imageDataUrl?: string | null,
): Promise<AiPlan> {
  return (await runScalpPlanResult(create, systemPrompt, userPrompt, tools, handlers, refPrice, imageDataUrl)).plan;
}

export interface ScalpPlanInput {
  symbol?: string;
  prices?: Price[];
  news?: NewsItem[];
  technical?: string | null;
  /** チャート画像(data URL: `data:image/png;base64,<...>`)。渡されるとビジョン対応プロバイダに添付する。 */
  chartImageDataUrl?: string | null;
  /** 初期 LC(損切り)幅の下限[円]。未指定は monitor 設定(resolveScalpLcFloorYen・既定55)。
   *  ★設定値より **低い値は受け付けない**(clampRequestedLcFloor で床止め)。厳しくする方向のみ有効。
   *  プロンプトに反映され、かつ enforcePlanConstraints で実強制される(下限未満のレッグを落とす)。 */
  lcFloorYen?: number;
  /** 初期 LC(損切り)幅の上限[円]。未指定は monitor 設定(resolveScalpLcCeiling・既定65)。プロンプト指示＋コードで強制。 */
  lcCeilingYen?: number;
  /** エントリー方向のバイアス。未指定は monitor 設定(resolveScalpBias・既定'none')。'long'=売り新規veto / 'short'=買い新規veto。 */
  bias?: ScalpBias;
  /** レンジ両面ストラドルを許可するか。未指定は monitor 設定(resolveScalpRangeEnabled・既定true)。false=range を出させない/万一出ても none 化。 */
  rangeEnabled?: boolean;
  /** 生きたトレンド(勢い)のヒント。runner が barsFor から computeRegime で算出して渡す。
   *  strong のときトレンドに逆行するフェード新規を enforcePlanConstraints が落とす。未指定は veto なし(現行挙動)。 */
  trend?: TrendHint;
  /** ★v0.8.2: 設定プロファイル。未指定/'A'=グローバル設定(=現行挙動と byte 一致・実売買A) /
   *  'B'=System B の独立設定(signalB 優先→未設定はグローバルへフォールバック)。各 knob の解決だけが切り替わる。 */
  profile?: SignalProfile;
  /** ★ドテン(保有中の反転評価=held-eval)。渡すとプロンプトに保有中の建玉を注入し「反転が妥当な場面だけ反対 direction を返してよい」
   *  と促す。未指定(flat-plan)は注入なし=systemPrompt は従来と byte 一致。dotenEnabled=false は engine が呼ばないので常に未指定。 */
  heldPosition?: { dir: 'buy' | 'sell'; entry: number };
  /** ★レンジ再評価(未約定→ブレイク)。ARMED のレンジ両指値(fade)が平均約定所要を超えて未約定のとき、engine が渡す。
   *  渡すとプロンプトに「両逆指値(ブレイク追随)へ切替えてよい/現状維持/direction:none」の判断を促す。
   *  未指定(通常)は注入なし=systemPrompt は従来と byte 一致。rangeReevalEnabled=false は engine が渡さないので常に未指定。 */
  armedContext?: { mode: 'range-fade'; ageMs: number; avgMs: number };
  /** ★呼び出し元(LLM プロバイダ・プールの選択キー)。未指定は 'default' = 従来と完全に同じ経路・同じ状態。
   *  'generator'(分析用の提案生成器)のときだけ generator プールを使い、その 429 は default を止めない。
   *  ★プロンプト・パース・enforce には一切影響しない(どのプールを使うかだけが変わる)。 */
  caller?: LlmCaller;
  /** ★決済仕様の「名前付き変種」。**未指定は従来どおり**(describeExitLogic() を使う=プロンプト byte 不変)。
   *  指定するとその変種の決済仕様説明を AI に渡す(分析用の提案生成器②が候補仕様で提案させるため)。
   *  ★名前だけを受け取り、実数値は非公開側(signalTrade/exit/private.ts)が解決する=数値は外に出ない。
   *  ★プロンプトの決済ブロック **だけ** が変わる。parse/enforce/実際の決済計算には一切影響しない
   *    (実弾の決済は常に現行仕様の computeExitStop が算出する)。 */
  exitVariant?: ExitVariant;
  /** ★v0.9.61: バンドウォークの判定結果(server/bandwalk.ts)。runner が算出して渡す。
   *  成立中のときだけプロンプト末尾に緩和注記(buildBandwalkNote)を足す。
   *  未指定/null(非成立)では systemPrompt は従来と **byte 一致**(緩和は一切起きない)。 */
  bandwalk?: Bandwalk | null;
}

/** トレンド veto に渡す最小形。openai を signalTrade/regime に依存させないため、Regime 全体ではなく
 *  {dir,strong} のみ受ける(構造的タイピング)。strong=false または未指定なら veto は完全に無効(現行挙動一致)。 */
export interface TrendHint { dir: 'up' | 'down' | 'flat'; strong: boolean; }

/** AIエントリー制御のハード適用(純関数・最終保証)。monitor 設定の最大初期LC(ceilingYen)・バイアス(bias)・
 *  生きたトレンド(trend)をコードで強制する。プロンプト指示の保険ではなく確定的保証。
 *  合成順は **トレンド veto → バイアス veto → LC上限 → 空なら none**(トレンド veto を先行ステージとして追加)。
 *  0. トレンド veto: trend.strong のとき、トレンドに逆行する side の脚を落とす。
 *     dir='up' → side='sell' を落とす(上昇の高値を売らない)/ dir='down' → side='buy' を落とす。
 *     directional(buy/sell)は side=direction なので、逆行なら plan 全体を direction:'none' にする(順行は維持)。
 *     range は各脚の side で個別に落とす(強上昇なら上=売り指値を落とし、下=買い側を残す=実質片面)。
 *     trend 未指定 or !strong は null=無効で、以降は従来と完全一致(後方互換)。
 *  1. LC上限: 各レッグの初期LC幅 = |entry − stopLoss| が ceilingYen を「超える」ならそのレッグを落とす(境界=ちょうどは許可)。
 *     両レッグとも落ちたら direction:'none'(見送り)。
 *  2. バイアス: bias='long' かつ direction='sell' → 'none' / bias='short' かつ direction='buy' → 'none' / 'none'は素通し。
 *  direction==='none' は何もしない。 */
/** ★v0.7.56: LC安全上限(policy とは独立の安全系)。enabled のとき手動/AI とも超過レッグを落とす。 */
export interface LcHardMax { enabled: boolean; value: number; }

/** ★v0.7.58: 戦略ロジックを「定数込みで完全に」AI へ渡す仕様ブロック。エントリー全定数(LC/±5円/50円距離/
 *  トレンド閾値/クールダウン/バイアス/レンジ)＋各項目の委任状態(手動=固定 / AI=あなたが決める)＋決済ロジック
 *  (phase-exit の実数値・describeExitLogic は private が在れば実数値・無ければ定性)を1ブロックに集約する。
 *  「何を委任するか」は設定に従い【】で明示する(委任=制約を外すだけでなくロジックを渡す)。純関数。 */
export interface StrategySpecInput {
  floor: { mode: KnobSource; value: number };
  ceiling: { mode: KnobSource; value: number };
  trendVeto: { mode: KnobSource; value: number };
  cooldown: { mode: KnobSource; value: number };
  bias: { mode: KnobSource; value: ScalpBias };
  range: { mode: KnobSource; value: boolean };
  hardMax: LcHardMax;
  exitDesc: string;   // describeExitLogic()(private 在れば実数値つき)
}
function knobTag(mode: KnobSource): string {
  return mode === 'ai' ? '【AI委任=あなたが決めてよい】' : '【手動=固定・厳守】';
}
/** ★LC下限のタグ。下限は委任対象外(常に強制)なので mode を取らない固定文にする。
 *  ★v0.9.61: 旧 '【強制=委任対象外・コードで必ず適用】' は **責任の所在を外に置いていた**。上限には
 *  【手動=固定・厳守】と「厳守」があるのに、下限だけ「コードで必ず適用」=「あなたが守らなくてもシステムがやる」
 *  と読める形で提示されていた(実測: 自己検算に幅を入れた後でも下限割れ 61件/日)。コードが強制する事実は残すが、
 *  それが免責に読まれないよう「あなたが必ず満たす」を先頭に置く。 */
const LC_FLOOR_TAG = '【最優先・厳守=あなたが必ず満たす(AI委任にしても外れない)】';
/** ★バイアスの提示(純関数・SSOT)。委任(mode==='ai')のときは **保存値を印字しない**。
 *  最大初期LC の resolveLcPresentation と同じ手当て。委任した項目の保存値を見せると
 *  「買い中心【AI委任=あなたが決めてよい】」+ 委任ノート「売買方向: あなたが自由に決めてよい」= 正面から矛盾する
 *  プロンプトになる(実測)。委任時に実際に効いている値は 'none'(方向veto なし)なので、保存値は宛先が無い。 */
export function biasSpecLabel(bias: ScalpBias, mode: KnobSource): string {
  if (mode === 'ai') return 'あなたが決める(買い/売り/両方向のどれでもよい)';
  return bias === 'long' ? '買い中心(売り新規は見送り)' : bias === 'short' ? '売り中心(買い新規は見送り)' : '両方向';
}
export function buildStrategySpec(i: StrategySpecInput): string {
  const cap = i.hardMax.enabled ? `安全上限 ${i.hardMax.value}円(有効=手動でもAIでも絶対に超えない)` : '安全上限 無効';
  // ★v0.9.56: 上限が AI委任のときは保存値を印字しない。実効上限(安全上限 or 背骨)を範囲として提示する。
  const lcPres = resolveLcPresentation({
    floorYen: i.floor.value, ceilingYen: i.ceiling.value, ceilingMode: i.ceiling.mode, lcHardMax: i.hardMax,
  });
  const lcLine = lcPres.ceil.delegated
    ? `- 初期LC(損切り)幅: 下限${i.floor.value}円${LC_FLOOR_TAG} / 上限=あなたが決める${knobTag(i.ceiling.mode)} / ${cap}`
      + `。★提示する許容範囲は 下限${i.floor.value}円〜${lcPres.ceil.capLabel}${lcPres.ceilingYen}円。この範囲の中から相場構造(節目/スイングの位置)に応じて選ぶこと(下限や上限に貼り付ける目安ではない)`
    : `- 初期LC(損切り)幅: 下限${i.floor.value}円${LC_FLOOR_TAG} / 上限${i.ceiling.value}円${knobTag(i.ceiling.mode)} / ${cap}`;
  const biasLabel = biasSpecLabel(i.bias.value, i.bias.mode);
  return [
    '',
    '【戦略ロジック仕様(完全版・定数込み)】以下のロジックと数値をすべて理解した上で計画すること。各項目末尾の【】は現在の委任設定(手動=固定・厳守 / AI=あなたが決めてよい)。AI委任の項目はその値を自分で決め、手動の項目は記載の値・ルールを厳守する。',
    '■ エントリー',
    lcLine,
    // ★v0.9.61: 「コードが自動で落とす」だけの書き方をやめる(免責に読める)。責任は AI 側にあると先に言い、
    //   意味と理由(lcFloorReason)は **モードに依らず常に** ここで出す(旧実装は委任時しか出していなかった)。
    `- ★初期LC下限(${i.floor.value}円)は あなたが必ず満たす条件: |エントリー − 損切り| ≥ ${i.floor.value}円 をレッグごとに独立に満たすこと。`
      + `${lcFloorReason(i.floor.value)}`
      + `節目までの距離が近すぎて満たせないなら、損切りの根拠にする節目を もう一段外側へ選び直す。それでも満たせないレッグは出さないこと(幅だけ機械的に広げた損切りは置き直さない)。`,
    // ★v0.9.56 ②③: +5円 が何に加わるのか / 導出の順序(節目 → ストップ位置 → 幅)。A(委任)・B(手動)で完全に同一。
    `- 損切りの緩衝: ${LC_BUFFER_NOTE}`,
    `- ${LC_DERIVATION_ORDER}`,
    '- 指値/ブレイク新規は現在値からそれぞれ最低 50円 離す(この最低距離は buy/sell のみ。range の各レッグには適用しない=レンジは上下の反応帯の位置で決める)',
    // ★v0.9.44: 語彙は system prompt / question と統一する(stopEntry=ブレイク新規 / stopLossFor*=損切り)。
    //   ただし spec は「設定値＋委任タグ」が役割なので、規則の全文は重複させず不等式(最重要)だけを置く
    //   (用語の区別・ブレイク新規の置き場所・出力前の自己検算は system prompt と question に完全な形で入る)。
    '- ★最優先: 価格の向き(無条件・例外なし) 現在値(refPrice)に対して次の不等式を必ず満たすこと。'
      + ' 売り: stopEntry < refPrice < limitEntry / 買い: limitEntry < refPrice < stopEntry。'
      + '節目・トレンド・ニュースなど他のどんな理由よりもこの不等式を優先する。この不等式を満たさない数値は出力しないこと。'
      + '言い換えると 買いは 指値=現在値より下 / ブレイク新規=現在値より上、売りは 指値=現在値より上 / ブレイク新規=現在値より下。逆に置くと即約定・不正なので厳禁',
    // ★v0.9.60: 損切りの向きも spec に置く。従来この spec には SL の向きが1文も無く(=不等式はエントリーだけ)、
    //   「同じことが3箇所に書かれるエントリー」と「1箇所も無い損切り」で指示の格が決定的に違っていた。
    `- ${SL_SIDE_RULE}`,
    // ★v0.9.60(圧縮): 末尾の『★選んだ節目に置いた結果が…』は、規則の全文(どちら側の節目を選び直すかの
    //   例示)を system prompt と question が持つので、spec では結論の1文だけに縮める。
    // ★v0.9.61(圧縮): [買い=サポート+5〜10円 / 売り=…]の内訳は system prompt と question が完全な形で持つ重複。
    //   spec は数値(5〜10 / 0〜5)と「外側」の2義の切り分けだけを残す。
    // ★v0.9.63(削除): 「※この『外側』は抜ける方向の意味で、損切りの『外側』(建玉を守る向き)とは別物」は question に
    //   同じ1文が残る(spec の役割は設定値＋委任タグで、規則の全文は system/question が持つ=このファイル内の既存方針)。
    // ★v0.9.64: ブレイク新規のずらし量(0〜5円)を撤去=量を持たない表現へ(question / system prompt と同じ理由)。
    '- 節目への置き方(約定重視・節目ちょうどには置かない): 指値=狙う節目から 5〜10円 内側(現在値側)。ブレイク新規(stopEntry)=狙う節目の すぐ外側(抜ける方向・量は決めない)。★選んだ節目に置いた結果が上の不等式に反するときは、まず不等式を満たす側の節目を選び直すこと。選び直しても適切な節目が無いときに限り、そのレッグを省く。',
    // ★v0.9.60(削除): 『逆張り指値の節目選び』(約190字)も system prompt と question に同文が入る重複。
    //   spec 自身のコメントが宣言しているとおり、規則の全文は system/question が持ち、spec は設定値＋委任タグを担う。
    // ★v0.9.61(圧縮): 距離ルールの不等式の再掲(直上の『最優先: 価格の向き』と同文)と括弧内の理由づけを外し、
    //   spec には数値の上限(400/200)と条件語(片方だけ・間)だけを残す。
    '- ★指値・ブレイク新規の距離(必須): 両方を出すときは現在値が2つの価格の間に入るように置き、指値とブレイク新規の価格差は400円以内。片方だけ(指値のみ/ブレイク新規のみ)を出すときは、その1本を向き通りに置いた上で現在値から200円以内に収める',
    // ★v0.9.64: 逆向き(省略と述べたら価格を出さない)を1文だけ足す。規則の全文は system prompt / question が持つ。
    '- ★rationale(説明文)は実際に出力したレッグだけ説明すること(両方向): 出していないレッグを「置いた」と書かない。「省略する」と述べたレッグは その対の価格フィールドを JSON に書かない=省略とは価格を出さないこと',
    // ★v0.9.61(圧縮): 合議の3条件の書き下しは system prompt / question の【レジーム/勢い】に同内容がある。
    //   spec には閾値の数値(±X / ±2X)と禁止事項・委任タグだけを残す。
    `- トレンド判定: 10分・30分・MA20傾き の合議(10分で±${i.trendVeto.value}円以上 / 30分で±${i.trendVeto.value * 2}円以上)でトレンド`
      + `=それに逆行するフェード新規(順トレンドの高値売り/安値買いの戻り売買)は禁止。`
      + `10分と長い時間軸が逆向きなら どちらとも断定せず見送り(direction:"none")を基本にする。`
      + `※自動見送り(veto)は直近10分の±${i.trendVeto.value}円だけで判定する=長い時間軸のトレンドに逆行しないのはあなたの判断による${knobTag(i.trendVeto.mode)}`,
    `- クールダウン: 決済後 ${i.cooldown.value}秒 は再エントリー抑止${knobTag(i.cooldown.mode)}`,
    `- バイアス: ${biasLabel}${knobTag(i.bias.mode)}`,
    `- レンジ両面(direction:"range"=現在値の上下に1レッグずつ置く両面ストラドル): ${i.range.value ? '有効' : '無効'}${knobTag(i.range.mode)}`,
    '- ★レンジの距離: 上下2本(upper/lower)を出すときは 上と下の価格差を400円以内にする(幅が広すぎるレンジは出さない)。片方だけのレンジは その1本を現在値から200円以内に置く',
    '■ 決済(この建玉の決済逆指値はこう動く=エントリー計画時に前提とすること)',
    i.exitDesc,
  ].join('\n');
}

/** enforce の opts。ceilingMode/lcHardMax は v0.7.56 の追加(いずれも省略時は現状=manual/上限なし)。
 *  - ceilingMode: 'manual'(既定)→設定した上限で落とす / 'ai'→設定上限は外すが、実効上限は
 *    lcHardMax(有効時)、無効なら LC_YEN_MAX まで残る(★上限が完全消滅することはない)。
 *  - lcHardMax: 有効時は ceilingMode に関係なく |entry−SL| が value 超のレッグを落とす(最後の安全網)。
 *  - floorYen: ★初期LC幅の**下限**(円)。渡すと下限未満のレッグを落とす。**委任(scalpLcFloorSource)の
 *    対象外**=AI委任でも必ず効く(下限は設定の好みではなく、決済ロジックが成立するための前提条件)。
 *    省略すると下限判定は一切行わない(=旧挙動。直呼びの既存テスト/呼び出しは不変)。 */
export interface EnforceOpts {
  ceilingYen: number;
  bias: ScalpBias;
  trend?: TrendHint;
  ceilingMode?: KnobSource;
  lcHardMax?: LcHardMax;
  floorYen?: number;
}

export function enforcePlanConstraints(plan: AiPlan, opts: EnforceOpts): AiPlan {
  // 後方互換の薄いラッパ。挙動(返る plan)は enforcePlanConstraintsReport と完全一致=既存の全呼び出し/テスト不変。
  return enforcePlanConstraintsReport(plan, opts).plan;
}

/** ★実効上限[円](純関数)。「委任すると上限がゼロになる」穴を塞ぐための単一の真実。
 *  - 安全網(lcHardMax)が有効ならその値、無効なら **LC_YEN_MAX(=設定として受理しうる LC 幅の絶対上限)** を背骨に使う。
 *  - ceilingMode==='ai'(委任): 設定した上限は外す(委任の意味は保つ)が、上の背骨は残す=上限は完全には消えない。
 *  - ceilingMode!=='ai'(手動・既定): 設定上限と背骨の **厳しい方**。
 *  既定(mode 省略=manual・lcHardMax 省略)では ceilingYen(≤LC_YEN_MAX)そのもの=従来と完全一致。 */
export function lcEffectiveCeiling(opts: { ceilingYen: number; ceilingMode?: KnobSource; lcHardMax?: LcHardMax }): number {
  const backstop = opts.lcHardMax?.enabled ? opts.lcHardMax.value : LC_YEN_MAX;
  return opts.ceilingMode === 'ai' ? backstop : Math.min(opts.ceilingYen, backstop);
}

/** ★v0.7.56: レッグの初期LC幅 w が「広すぎ」でドロップ対象か(境界=ちょうどは許可)。
 *  実効上限は lcEffectiveCeiling に一本化した(委任時も背骨が残る)。 */
export function lcLegExceeds(w: number, opts: { ceilingYen: number; ceilingMode?: KnobSource; lcHardMax?: LcHardMax }): boolean {
  return w > lcEffectiveCeiling(opts);
}

/** ★レッグの初期LC幅 w が「狭すぎ」(下限未満)でドロップ対象か(境界=ちょうど下限は許可)。
 *  floorYen 未指定/非有限/0以下では常に false(=下限判定なし・旧挙動)。
 *  ★この判定に委任(mode)の分岐は無い。下限は「AI に委任できる好み」ではなく、決済ロジック
 *  (含み益が一定に達して初めて利益ロックの床が発動する)が成立するための前提条件だから。
 *  下限より狭い初期LCは床が発動する前に被弾しやすく、決済ロジックが構造的に働かない。 */
export function lcLegBelowFloor(w: number, opts: { floorYen?: number }): boolean {
  const f = opts.floorYen;
  return typeof f === 'number' && Number.isFinite(f) && f > 0 && w < f;
}

/** レンジ脚がコード側で落とされた理由(rationale 明記用)。
 *  trend/lc/bias は enforcePlanConstraints(制約適用)由来、geometry/missing は parseScalpPlan(AI応答の検証)由来、
 *  stopSide は両方で起きうる(parse で落ちた脚は enforce では既に無いので注記は重複しない)。 */
type RangeDropReason = 'trend' | 'stopSide' | 'lc' | 'lcFloor' | 'bias' | 'geometry' | 'missing';

/** 脱落したレンジ脚の位置(上部/下部)・side・理由から、rationale へ追記する注記文を組み立てる。
 *  例: `※下部(買い指値)はバイアス(売り優先)のため除外` / `※上部(売り指値)はLC上限超のため除外`。
 *  テキスト整形のみ(取引ロジックには一切関与しない)。 */
export function rangeDropNote(
  pos: '上部' | '下部',
  side: 'buy' | 'sell' | undefined,
  reason: RangeDropReason,
  bias?: 'long' | 'short' | 'none',
): string {
  // AI がそのレッグを出していない(欠落/壊れた形)場合は side が無いので、位置だけの専用文にする。
  if (reason === 'missing') return `※${pos}のレッグはAIが提示しなかったため無し`;
  const sideLabel = side === 'sell' ? '売り指値' : side === 'buy' ? '買い指値' : '指値';
  let reasonLabel: string;
  switch (reason) {
    case 'trend': reasonLabel = 'トレンド逆行'; break;
    case 'stopSide': reasonLabel = 'SL向き不正'; break;
    case 'geometry': reasonLabel = '現在値との上下関係が不正'; break;
    case 'lc': reasonLabel = 'LC上限超'; break;
    case 'lcFloor': reasonLabel = 'LC下限未満'; break;
    case 'bias':
      reasonLabel = bias === 'long' ? 'バイアス(買い優先)'
        : bias === 'short' ? 'バイアス(売り優先)'
        : 'バイアス';
      break;
  }
  return `※${pos}(${sideLabel})は${reasonLabel}のため除外`;
}

/** enforcePlanConstraints と同一の enforce を行い、さらに **トレンド veto が発火したか(vetoFired)** を surface する
 *  (v0.7.54・計測フック)。返る plan は enforcePlanConstraints と byte 単位で同一(挙動不変)。
 *  vetoFired=true は「トレンド veto ステージが 脚を落とした or plan 全体を none に強制した」場合のみ。
 *  LC上限/バイアス由来の drop/none は vetoFired に含めない(veto の効き目だけを計測するため)。 */
export function enforcePlanConstraintsReport(
  plan: AiPlan,
  opts: EnforceOpts,
): { plan: AiPlan; vetoFired: boolean; noneReason?: NoneReason; noneLegs?: NoneLegs; legDrops?: readonly LegDrop[] } {
  if (plan.direction === 'none') return { plan, vetoFired: false };
  const { ceilingYen, bias, trend, ceilingMode, lcHardMax, floorYen } = opts;
  // ★v0.7.56: レッグの LC 幅ドロップ判定(mode 分岐 + 安全網)。既定(引数省略)は従来と完全一致。
  const lcExceeds = (w: number): boolean => lcLegExceeds(w, { ceilingYen, ceilingMode, lcHardMax });
  // ★LC 下限の実強制。floorYen 省略なら常に false=旧挙動。委任(mode)の分岐は無い=強制が委任に勝つ。
  const lcBelow = (w: number): boolean => lcLegBelowFloor(w, { floorYen });
  // 上限超(広すぎ)/下限未満(狭すぎ)の判定を1つにまとめる。落とし方は上限側と同じ=**そのレッグを落とす**。
  //   クランプ(下限まで損切りを広げる)にしない理由: AI が選んだ損切り位置は「節目/スイングの外側」という
  //   根拠に紐づく。機械的に広げると、誰も検証していない価格に損切りを置き直すことになり、しかも
  //   下限未満のレッグは「節目からの距離の見立てそのものが崩れている」= 幅だけ直しても前提は直らない。
  const lcReason = (w: number): 'lc' | 'lcFloor' | null =>
    lcExceeds(w) ? 'lc' : lcBelow(w) ? 'lcFloor' : null;

  // ★トレンド veto(最優先ステージ): 生きた強トレンドに逆行する side を落とす。
  //   up→sell を落とす / down→buy を落とす。trend 未指定 or !strong なら null=無効(現行挙動と完全一致)。
  const dropSide: 'buy' | 'sell' | null =
    trend && trend.strong
      ? (trend.dir === 'up' ? 'sell' : trend.dir === 'down' ? 'buy' : null)
      : null;

  // ★レンジ両面ストラドル: 各レッグに (0)トレンド veto・(a)LC上限・(b)バイアス veto を独立適用。両レッグ落ちたら none、
  //   片レッグ残れば その単レッグの range(=実質片面)として通す。既存の buy/sell 強制とは別経路。
  if (plan.direction === 'range') {
    let upper = plan.range?.upper;
    let lower = plan.range?.lower;
    // ★v0.9.44(記録専用): 落とす前の生数値を控える。両脚落ち=none のときログ1行に出す(採否には使わない)。
    const upper0 = upper;
    const lower0 = lower;
    // ★脚の脱落理由を記録(rationale 明記用)。AI の rationale は両脚を説明するが、以降のコード側 drop で
    //   片脚だけ表示される場合に「なぜ消えたか」を rationale に追記する。表示ロジック/脚/価格/veto は不変。
    const upperSide0 = upper?.side;
    const lowerSide0 = lower?.side;
    let upperReason: RangeDropReason | null = null;
    let lowerReason: RangeDropReason | null = null;
    // (0) トレンド veto: トレンドに逆行する side の脚を落とす(bias/LC より先)。存在した脚を落としたら vetoFired。
    let vetoFired = false;
    if (dropSide) {
      if (upper?.side === dropSide) { upper = undefined; vetoFired = true; upperReason = 'trend'; }
      if (lower?.side === dropSide) { lower = undefined; vetoFired = true; lowerReason = 'trend'; }
    }
    // (a') 向きの二重防御: 損切りがエントリーの内側/反対側(境界=幅0 含む)のレッグを落とす(parse で落ちている想定=冪等)。
    //      これはトレンド veto ではないので vetoFired には計上しない(veto の効き目だけを計測する)。
    if (upper && !stopSideOk(upper.side, upper.entry, upper.stopLoss)) { upper = undefined; upperReason = 'stopSide'; }
    if (lower && !stopSideOk(lower.side, lower.entry, lower.stopLoss)) { lower = undefined; lowerReason = 'stopSide'; }
    // (a) 初期LC幅 |entry−stopLoss| が上限超 or 下限未満のレッグを落とす(境界=ちょうどは許可)。
    //     ★v0.7.56: 上限は manual→ceilingYen 超 / ai→実効上限(安全網 or LC_YEN_MAX)まで緩む。
    //     ★下限は委任に関係なく常に強制(floorYen を渡した時のみ=直呼びの既存経路は不変)。
    if (upper) {
      const r = lcReason(Math.abs(upper.entry - upper.stopLoss));
      if (r) { upper = undefined; upperReason = r; }
    }
    if (lower) {
      const r = lcReason(Math.abs(lower.entry - lower.stopLoss));
      if (r) { lower = undefined; lowerReason = r; }
    }
    // (b) バイアス veto: long→sell レッグ落とし / short→buy レッグ落とし。
    if (bias === 'long') {
      if (upper?.side === 'sell') { upper = undefined; upperReason = 'bias'; }
      if (lower?.side === 'sell') { lower = undefined; lowerReason = 'bias'; }
    } else if (bias === 'short') {
      if (upper?.side === 'buy') { upper = undefined; upperReason = 'bias'; }
      if (lower?.side === 'buy') { lower = undefined; lowerReason = 'bias'; }
    }
    // ★v0.9.57(記録専用): 脚1本ごとの脱落を、**片脚だけ落ちた回でも** 構造化して残す(採否は不変)。
    //   ここで理由が付くのは「enforce が受け取った時点で在った脚」だけ(上の各分岐が脚の存在を確認している)。
    const rangeLegDrops: LegDrop[] = [];
    pushLegDrop(rangeLegDrops, 'upper', upperReason, upper0?.entry, upper0?.stopLoss);
    pushLegDrop(rangeLegDrops, 'lower', lowerReason, lower0?.entry, lower0?.stopLoss);
    // 両脚とも落ちたら none(既存挙動: rationale は元のまま据え置き)。
    if (!upper && !lower) {
      return {
        plan: { direction: 'none', rationale: plan.rationale, refPrice: plan.refPrice }, vetoFired,
        noneReason: pickNoneReason(upperReason, lowerReason),
        noneLegs: noneLegsFromRange(upper0, lower0),
        ...(rangeLegDrops.length ? { legDrops: rangeLegDrops } : {}),
      };
    }
    // 片脚だけ残って range を出す場合、落ちた脚の理由を rationale に明記(表示専用テキスト)。
    const notes: string[] = [];
    if (upperReason) notes.push(rangeDropNote('上部', upperSide0, upperReason, bias));
    if (lowerReason) notes.push(rangeDropNote('下部', lowerSide0, lowerReason, bias));
    const rationale = notes.length
      ? `${plan.rationale}\n${notes.join('\n')}`
      : plan.rationale;
    const range: { upper?: RangeLeg; lower?: RangeLeg } = {};
    if (upper) range.upper = upper;
    if (lower) range.lower = lower;
    return {
      plan: { direction: 'range', rationale, refPrice: plan.refPrice, range }, vetoFired,
      ...(rangeLegDrops.length ? { legDrops: rangeLegDrops } : {}),
    };
  }

  // ★directional(buy/sell): leg side === direction。逆行(dropSide===direction: 強上昇の sell / 強下降の buy)なら
  //   plan 全体を見送り(none)に。順行はそのまま以降の LC・バイアス処理へ進む。
  if (dropSide && dropSide === plan.direction) {
    return {
      plan: { direction: 'none', rationale: plan.rationale, refPrice: plan.refPrice }, vetoFired: true,
      noneReason: 'trend',
      // レッグ自体は妥当でも plan 全体が veto されるので ok:false(=最終プランに残らなかった)で記録する。
      noneLegs: noneLegsFromDirectional(plan.direction, plan, false, false),
    };
  }

  const out: AiPlan = { ...plan };

  // 1. レッグ単位の LC 上限(境界=ちょうどは許可)+ 向きの二重防御。上限超 or 向き違反のレッグは対で落とす。
  //    向き(stopSideOk): directional は leg side === direction。損切りが内側/反対側(境界=幅0 含む)なら落とす
  //    (parse で落ちている想定=冪等)。既に向きが正しい正常プランには影響しない。
  const limitOk =
    out.limitEntry != null && out.stopLossForLimit != null &&
    lcReason(Math.abs(out.limitEntry - out.stopLossForLimit)) === null &&
    stopSideOk(plan.direction, out.limitEntry, out.stopLossForLimit);
  const stopOk =
    out.stopEntry != null && out.stopLossForStop != null &&
    lcReason(Math.abs(out.stopEntry - out.stopLossForStop)) === null &&
    stopSideOk(plan.direction, out.stopEntry, out.stopLossForStop);
  if (!limitOk) { out.limitEntry = undefined; out.stopLossForLimit = undefined; }
  if (!stopOk) { out.stopEntry = undefined; out.stopLossForStop = undefined; }

  // ★v0.9.57(記録専用): 片レッグだけ落ちた回も理由を残す。**enforce が受け取った時点で在ったレッグだけ**
  //   を対象にする(parse で既に落ちた/AI が出さなかったレッグはここでは何も落としていない=二重に数えない。
  //   その 'missing' は parse 段の legDrops が持っている)。判定順は下の legReason と同一。
  const dirForLegDrop = plan.direction;
  const dropReason = (ok: boolean, entry?: number, sl?: number): NoneReason | null =>
    ok || entry == null || sl == null ? null
    : !stopSideOk(dirForLegDrop, entry, sl) ? 'stopSide'
    : lcReason(Math.abs(entry - sl)) ?? 'lc';
  const legDrops: LegDrop[] = [];
  pushLegDrop(legDrops, 'limit', dropReason(limitOk, plan.limitEntry, plan.stopLossForLimit), plan.limitEntry, plan.stopLossForLimit);
  pushLegDrop(legDrops, 'stop', dropReason(stopOk, plan.stopEntry, plan.stopLossForStop), plan.stopEntry, plan.stopLossForStop);
  const legDropsField = legDrops.length ? { legDrops } : {};

  // 両レッグ落ちたら見送り(価格を持たない none)。
  if (out.limitEntry == null && out.stopEntry == null) {
    // ★v0.9.44(記録専用): レッグ不在=missing / SL 向き違反=stopSide / それ以外は LC 幅(上限超=lc / 下限未満=lcFloor)。
    const dir = plan.direction;   // クロージャ内では絞り込みが効かないので const に束ねる。
    const legReason = (entry?: number, sl?: number): NoneReason =>
      entry == null || sl == null ? 'missing'
      : !stopSideOk(dir, entry, sl) ? 'stopSide'
      : lcReason(Math.abs(entry - sl)) ?? 'lc';
    return {
      plan: { direction: 'none', rationale: out.rationale, refPrice: out.refPrice }, vetoFired: false,
      noneReason: pickNoneReason(legReason(plan.limitEntry, plan.stopLossForLimit), legReason(plan.stopEntry, plan.stopLossForStop)),
      noneLegs: noneLegsFromDirectional(plan.direction, plan, false, false),
      ...legDropsField,
    };
  }

  // 2. バイアス veto。
  if ((bias === 'long' && out.direction === 'sell') ||
      (bias === 'short' && out.direction === 'buy')) {
    return {
      plan: { direction: 'none', rationale: out.rationale, refPrice: out.refPrice }, vetoFired: false,
      noneReason: 'bias',
      // ここまで残ったレッグは幾何/LC を満たしている(=bias だけで消えた)ので ok:true で記録する。
      noneLegs: noneLegsFromDirectional(plan.direction, out, true, true),
      ...legDropsField,
    };
  }

  return { plan: out, vetoFired: false, ...legDropsField };
}

/** レンジ無効設定なのに direction:"range" が返った場合の防御多重化(純関数・プロンプト指示の保険)。
 *  rangeEnabled=false かつ range のときだけ none 化し、記録専用の noneReason='rangeDisabled' を添える。
 *  それ以外は plan をそのまま返す(参照も維持=挙動不変)。 */
export function enforceRangeEnabled(
  plan: AiPlan, rangeEnabled: boolean,
): { plan: AiPlan; noneReason?: NoneReason; noneLegs?: NoneLegs } {
  if (rangeEnabled || plan.direction !== 'range') return { plan };
  return {
    plan: { direction: 'none', rationale: plan.rationale, refPrice: plan.refPrice },
    noneReason: 'rangeDisabled',
    noneLegs: noneLegsFromRange(plan.range?.upper, plan.range?.lower),
  };
}

// LC 幅の下限/上限の受理可能レンジ(サニタイズ用)。この範囲外・非有限・floor>ceiling は既定に戻す。
export const LC_YEN_MIN = 20;
export const LC_YEN_MAX = 300;

// ─── refPrice(計画の基準価格)の鮮度ゲート ─────────────────────────────
//
// ★これが無いと何が起きたか(実測 2026-07-23):
//     21:42:01→21:56:52 sell 指値@66725(その時の実勢 65795・乖離 930円)= trade2 が131回連続で拒否・一度も約定せず。
//     22:44:35→22:59:30 sell 指値@66990(その時の実勢 65995・乖離 995円)= 130回連続で拒否。
//   bars_1m では 66,725 の最終到達は同日 14:45、66,990 は 10:16 = **7〜12時間前の水準** だった。
//   従来の実装は `prices.find(...)?.price ?? 0` で、(a) stale フラグを見ない (b) 取得失敗を静かに 0 にする
//   の二重の穴があった。0 は checkSanity で弾かれるが、「古いまま持ち越された価格」は素通りして
//   その価格を中心にプランが組まれ、そのまま武装される。
//
// ★stale フラグだけでは塞がらない実在の穴:
//   priceLoop.tick() は取引時間外に **setPrices を呼ばずに** 早期 return する。つまり時間外はキャッシュに
//   「最後の場中価格が stale:false のまま」残り続ける。engine 経路は inPollWindow でゲートされるが、
//   POST /api/scalp-plan は時間外でも到達する。よって **経過時間の上限** も要る。
//   ※旧記述「trade2 が叩く」は誤り(2026-08-02 に実確認して訂正)。trade2 は monitor のシグナルを
//     SSE/`/api/current-signal` で追従するだけで /api/scalp-plan は叩かない(コード上のヒットはコメントのみ)。
//     現在この route を叩くのは手動診断と、これから追加する提案生成器(caller='generator')。
//
/** refPrice として許容する価格の最大経過時間[ms]。
 *  根拠: 価格取得間隔 pricePollMs の設定上限が 60,000ms、全滅時のバックオフ PRICE_BACKOFF_MS の最大も
 *  60,000ms。つまり **正常に回っている限り 60秒より古い非 stale 価格は存在しない**。これを超える値は
 *  「ループが止まっている/時間外のキャッシュが凍っている」ことの証拠なので、計画の基準にしない。 */
export const REF_PRICE_MAX_AGE_MS = 60_000;

export type RefPriceResult = { ok: true; refPrice: number } | { ok: false; reason: string };

/** 計画の基準価格(refPrice)を解決する純関数。使えない時は **理由付きで失敗** する(0 へ黙って落ちない)。
 *  条件: ①その銘柄の見積りが在る ②stale でない ③有限かつ正 ④取得から REF_PRICE_MAX_AGE_MS 以内。 */
export function resolveRefPrice(prices: Price[], symbol: string, now: number): RefPriceResult {
  const q = prices.find(p => p.symbol === symbol);
  if (!q) return { ok: false, reason: `${symbol} の現在値がキャッシュに無い` };
  if (q.stale) return { ok: false, reason: `${symbol} の現在値が stale(フィード断で前回値を持ち越し中)` };
  if (!Number.isFinite(q.price) || q.price <= 0) return { ok: false, reason: `${symbol} の現在値が不正(${q.price})` };
  const age = now - q.timestamp;
  if (!(age <= REF_PRICE_MAX_AGE_MS)) {
    return {
      ok: false,
      reason: `${symbol} の現在値が古い(取得から${Math.round(age / 1000)}秒経過・上限${Math.round(REF_PRICE_MAX_AGE_MS / 1000)}秒)`,
    };
  }
  return { ok: true, refPrice: q.price };
}

/** lcFloorYen/lcCeilingYen をサニタイズ・クランプして [floor, ceiling] を返す。
 *  非数値/非有限、LC_YEN_MIN..LC_YEN_MAX の範囲外、floor>ceiling のいずれかなら既定(55/65)へフォールバック。 */
export function resolveLcRange(
  floorYen?: number,
  ceilingYen?: number,
): { floorYen: number; ceilingYen: number } {
  const inRange = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= LC_YEN_MIN && v <= LC_YEN_MAX;
  const floor = inRange(floorYen) ? floorYen : DEFAULT_LC_FLOOR_YEN;
  const ceiling = inRange(ceilingYen) ? ceilingYen : DEFAULT_LC_CEILING_YEN;
  // ceiling を既定 floor(55)より小さく締めた場合、floor を ceiling まで下げて **ユーザーの厳しい上限を尊重** する。
  // ★従来は両方を既定(55/65)へ戻していたため、締めた上限が黙って無視され「緩む方向」へサイレント失敗するフットガンだった
  //   (呼び出し側は floor 未指定=既定下限 で呼ぶため、ceiling をそれより小さくすると発火)。ceiling を単一の真実として優先する。
  if (floor > ceiling) return { floorYen: ceiling, ceilingYen: ceiling };
  return { floorYen: floor, ceilingYen: ceiling };
}

/** 外部(HTTP `/api/scalp-plan` の body/query など)から要求された初期 LC 下限を、**設定値の下限で床止め**する純関数。
 *
 *  ★なぜ必要か: 下限はプロンプトに `【強制=委任対象外・コードで必ず適用】` と書いてあり、AI にも委任しない
 *    唯一の制約になっている。にもかかわらず `/api/scalp-plan` は body/query の lcFloorYen をそのまま
 *    buildScalpPlan へ渡しており、resolveLcRange は LC_YEN_MIN(=20)まで受理するので、
 *    **呼び出し側(trade2 や curl)が 20 を送れば床が 20 に下がっていた**。設定画面には設定値(既定 55)と表示されたまま
 *    実際の強制は 20 になる=文言が嘘になる形。
 *
 *  ★クランプの向き(下限側だけ・上げるのは許可):
 *    - 下げる方向は禁止。下限の根拠は決済ロジック(含み益が一定に達して初めて利益ロックの床が発動する方式)で、
 *      これより狭い初期 LC は床が働く前に被弾する=**戦略が構造的に成立しない**。緩められては意味がない。
 *    - 上げる方向は許可。より広い初期 LC は上の前提を壊さず、効果は「下限未満のレッグをより多く落とす」=
 *      提案が減るだけで安全側。呼び出し側が自分の口座事情でより慎重にするのを妨げる理由がない
 *      (上限 lcCeilingYen 側で別途弾かれるので、無制限に広い建玉になるわけでもない)。
 *  非数値/非有限は「要求なし」= 設定値をそのまま使う。 */
export function clampRequestedLcFloor(requested: number | undefined, configFloorYen: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return configFloorYen;
  return Math.max(configFloorYen, requested);
}

/** 固定のスキャル質問で LLM を走らせ、構造化 AiPlan を返す。既存の chat と同じ tool ループ・プロバイダ選択・
 *  キー解決を再利用する。キー未設定は { ok:false, error:'LLM未設定' }。パース失敗は1回だけ厳格に再要求する。
 *  refPrice は monitor の現在 NIY=F 価格。 */
export async function buildScalpPlan(input: ScalpPlanInput = {}): Promise<ScalpPlanResult> {
  if (!isLLMEnabled()) return { ok: false, error: 'LLM未設定' };
  // ★v0.7.58: 決済ロジック(phase-exit)の実数値説明を AI に渡すため private 実装をロード(冪等・キャッシュ)。
  //   private 不在(公開配布)は定性フォールバックのまま。プランの成否・enforce には影響しない。
  await loadExitImpl();
  const now = Date.now();
  const symbol = typeof input.symbol === 'string' && input.symbol ? input.symbol : NIKKEI_SYMBOL;
  const prices = input.prices ?? getPrices();
  const news = input.news ?? [];
  // ★refPrice の鮮度ゲート(resolveRefPrice)。従来の `?? 0` は stale を見ず取得失敗を静かに 0 にしていた。
  //   古い/壊れた基準価格で計画を組ませない=ここで失敗させる。失敗は必ず1行ログに残す(無言で見送りにしない)。
  const refResolved = resolveRefPrice(prices, symbol, now);
  if (!refResolved.ok) {
    console.warn(`[scalp-plan] refPrice 不採用: ${refResolved.reason} → 計画を作らない`);
    return { ok: false, error: `現在値が使えない(${refResolved.reason})` };
  }
  const refPrice = refResolved.refPrice;
  // ★v0.7.56: 各 knob の directive(manual/ai)を解決。既定は全て manual=現状の挙動を一切変えない。
  //   manual は数値/enum を強制(従来どおり)/ ai は該当制約を課さず AI に委任する。LC安全上限は独立の安全系。
  // ★v0.8.2: プロファイル(A|B)で knob を解決。未指定=A=グローバル(現行と byte 一致)。
  const profile = input.profile;
  const floorD = resolveScalpLcFloorDirective(profile);
  const ceilingD = resolveScalpLcCeilingDirective(profile);
  const biasD = resolveScalpBiasDirective(profile);
  const rangeD = resolveScalpRangeDirective(profile);
  const trendD = resolveScalpTrendVetoDirective(profile);
  const hardMax = resolveScalpLcHardMax(profile);
  // 初期 LC 幅の上限とバイアスは、要求で明示されなければ monitor 設定を既定に使う(＝直呼びのシグナルエンジンも
  // monitor 設定に従う=単一の真実)。上限はサニタイズ・クランプ後にプロンプトへ反映し、最終保証は enforcePlanConstraints。
  const ceilingMode = ceilingD.mode;
  const ceilingInput = input.lcCeilingYen ?? ceilingD.value;
  // バイアス/レンジ: manual は設定(override 優先)を適用 / ai は制約なし(bias='none'・range 許可)。
  const bias: ScalpBias = biasD.mode === 'manual' ? (input.bias ?? biasD.value) : 'none';
  const rangeEnabled = resolveEffectiveRangeEnabled(profile, input.rangeEnabled);
  // ★LC下限は【強制=委任対象外】= 設定値が絶対の床。外部要求(HTTP body/query)で **緩める(下げる)ことは許さない**。
  //   厳しくする(上げる)方向だけ受理する(clampRequestedLcFloor の注記に根拠)。
  const { floorYen, ceilingYen } = resolveLcRange(clampRequestedLcFloor(input.lcFloorYen, floorD.value), ceilingInput);
  // ★v0.9.56: プロンプトに **印字してよい** 上限を決める(enforce は従来どおり ceilingYen + ceilingMode + hardMax)。
  //   手動 → 保存値そのまま(従来と byte 一致)/ 委任 → 保存値を印字せず実効上限(安全上限 or 背骨)を範囲として提示。
  const lcPres = resolveLcPresentation({ floorYen, ceilingYen, ceilingMode, lcHardMax: hardMax });
  const promptCeilingYen = lcPres.ceilingYen;
  const lcCeil = lcPres.ceil;
  // レジーム/トレンド veto の閾値[円](0=無効)。manual は閾値・ai は数値veto無効(=0)。プロンプト文言に反映し、
  // トレンド veto 自体は input.trend で駆動する(0 のとき trend を渡さない=veto なし)。
  const trendVetoYen = trendD.mode === 'manual' ? trendD.value : 0;
  // ★委任ノート: AI に委任した knob だけ「この値はあなたが決める(自由・根拠を述べよ)」を追記する。
  //   全 knob 手動(既定)では '' = プロンプトは従来と byte 単位で不変(回帰なし)。
  const cooldownD = resolveScalpCooldownDirective(profile);
  const delegationNote = buildDelegationNote(
    { lcFloor: floorD.mode, lcCeiling: ceilingD.mode, trendVeto: trendD.mode,
      cooldown: cooldownD.mode, bias: biasD.mode, range: rangeD.mode },
    { floorYen, ceilingYen, hardMax },
  );
  const biasNote = buildBiasNote(bias);
  // ★v0.7.58: 戦略ロジックを定数込みで完全に AI へ渡す(エントリー全定数＋各項目の委任状態＋決済ロジックの実数値)。
  //   「何を委任するか」は設定(各 directive の mode)に従い【】で明示。決済数値は describeExitLogic()=private 実行時注入。
  const strategySpec = buildStrategySpec({
    floor: { mode: floorD.mode, value: floorYen },
    ceiling: { mode: ceilingD.mode, value: ceilingYen },
    trendVeto: { mode: trendD.mode, value: trendD.value },
    cooldown: { mode: cooldownD.mode, value: cooldownD.value },
    bias: { mode: biasD.mode, value: biasD.value },
    range: { mode: rangeD.mode, value: rangeEnabled },
    hardMax,
    // ★決済仕様: 変種 **未指定なら従来の describeExitLogic() をそのまま**(この経路は byte 不変)。
    //   指定時だけ名前 → 非公開定義から説明文を解決する(数値はプロセス内に留まる)。
    exitDesc: input.exitVariant === undefined ? describeExitLogic() : describeExitLogicVariant(input.exitVariant),
  });
  // ★AIテクニカル許可(RSI/BB をエントリーの"タイミング"判断に使ってよい)。既定 ON。OFF では system prompt は従来と byte 一致。
  //   ※決済(手仕舞い)は既定の決済ロジックが担当する=AI に決済判断は委ねない。
  const aiTechnicalEnabled = resolveScalpAiTechnicalEnabled(profile);
  // ★ドテン(保有中の反転評価=held-eval): heldPosition が渡された時だけ注入する。flat-plan(未指定)では '' = 従来と byte 一致。
  const heldNote = buildHeldNote(input.heldPosition);
  // ★レンジ再評価(未約定→ブレイク): armedContext が渡された時だけ注入する。未指定(通常)では '' = 従来と byte 一致。
  const armedNote = buildArmedNote(input.armedContext);
  // ★バンドウォーク成立中だけの緩和注記(距離と節目のみ)。非成立/未指定は '' = 従来と byte 一致。
  const bandwalkNote = buildBandwalkNote(input.bandwalk);
  const monitorCtx = buildMonitorContext(now);
  const scalpQuestion = buildScalpQuestion(floorYen, promptCeilingYen, rangeEnabled, trendVetoYen, lcCeil);
  const systemPrompt =
    // ★bandwalkNote は strategySpec / delegationNote の **後ろ**(= 距離50円・節目起点を書いている
    //   ブロックより後)に置く。緩和は「直前の指示を上書きする」形なので、読み順で後に来る必要がある。
    `${buildScalpSystemPrompt(floorYen, promptCeilingYen, rangeEnabled, trendVetoYen, aiTechnicalEnabled, lcCeil)}${biasNote}${strategySpec}${delegationNote}${bandwalkNote}${heldNote}${armedNote}\n\n` +
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(prices, now)}\n\n` +
    (input.technical ? `${input.technical}\n\n` : '') +
    (monitorCtx ? `${monitorCtx}\n\n` : '') +
    `■ 関連ニュース:\n${formatNewsForChat(news, now, scalpQuestion)}`;

  // chat と同じデータツール(常時有効)+ web_search(Gemini グラウンディング・キーがある時のみ)。
  const tools: unknown[] = [EXPLAIN_MOVE_TOOL, QUERY_ALERTS_TOOL, PRICE_HISTORY_TOOL];
  const handlers: ToolHandlers = buildDataToolHandlers();
  if (isWebSearchEnabled()) {
    tools.push(WEB_SEARCH_TOOL);
    handlers.web_search = async (a: { query?: string }) => {
      const q = typeof a.query === 'string' ? a.query : '';
      return q ? await webSearch(q) : '(クエリ空)';
    };
  }

  // チャート画像がある時は判断材料にするよう明示的に指示する(ビジョン対応プロバイダ時のみ添付される)。
  const img = input.chartImageDataUrl && input.chartImageDataUrl.startsWith('data:image/')
    ? input.chartImageDataUrl : null;
  const visionNote = buildVisionNote(!!img);
  const userPrompt = `${scalpQuestion}\n\n${visionNote}${scalpJsonInstruction(refPrice, floorYen, promptCeilingYen, rangeEnabled, lcCeil)}`;

  try {
    // ★v0.9.46 修正: parse は runScalpPlanResult の中で1回だけ走らせ、その結果をここで受け取る。
    //   以前は「plan を JSON 化 → callWithFallback の string 契約で受け取り → parseScalpPlan で再パース」して
    //   おり、parse 段の機械生成注記(レッグ注記/レンジ脚の脱落理由)が2回連結されて画面に二重表示されていた。
    //   採否ロジックは parse も enforce も一切変えていない(注記の連結回数だけが 2→1 に戻る)。
    let planResult: Extract<ScalpPlanResult, { ok: true }> | null = null;
    const raw = await callWithFallback(async (p) => {
      const create: CreateFn = (params) => p.client!.chat.completions.create({
        model: p.config.chatModel, temperature: 0.4, max_tokens: 8000, ...params,
      } as any);
      // ビジョン非対応プロバイダに切り替わった場合は画像を外す(image_url をテキスト専用モデルへ送らない)。
      const imgForThis = img && isVisionCapableProvider(p.config.name, p.config.chatModel) ? img : null;
      planResult = await runScalpPlanResult(create, systemPrompt, userPrompt, tools, handlers, refPrice, imgForThis);
      // 成功時は整形済み plan JSON 文字列を返す(callWithFallback は string 契約)。戻り値そのものは使わない。
      return JSON.stringify(planResult.plan);
      // ★第3引数(caller)= プロバイダ・プールの選択。未指定は 'default'(既存経路は byte 不変)。
    }, 'scalp-plan', input.caller ?? DEFAULT_CALLER);
    // task が一度も走らなかった場合(callWithFallback がプロバイダ不在の定型文を返す経路)だけ raw を読む。
    // 通常は planResult が入っているので再パースは起きない。
    const parsed: ScalpPlanResult = planResult ?? parseScalpPlan(raw, refPrice);
    if (!parsed.ok) return parsed;
    // トレンド veto: 閾値>0 かつ runner が trend を渡した時だけ効かせる(未指定/0=ai は現行挙動=veto なし)。
    const trend = trendVetoYen > 0 ? input.trend : undefined;
    // ★v0.7.56: LC上限は ceilingMode(manual→設定上限 / ai→実効上限=安全網 or LC_YEN_MAX)で分岐し、
    //   LC安全上限(hardMax)は mode 無関係に常時適用(有効時)。バイアスは ai なら 'none'(上で解決済)=veto なし。
    // ★LC下限(floorYen)は **委任設定 scalpLcFloorSource に関係なく常に渡す**=強制が委任に勝つ(安全側)。
    //   下限は「設定の好み」ではなく決済ロジック(利益ロックの床)が成立するための前提条件のため。
    const enforced = enforcePlanConstraintsReport(parsed.plan, {
      ceilingYen, bias, trend, ceilingMode, lcHardMax: hardMax, floorYen,
    });
    // 防御多重化: レンジ無効設定で万一 range が返っても none に落とす(プロンプト指示の保険)。
    const guarded = enforceRangeEnabled(enforced.plan, rangeEnabled);
    const finalPlan = guarded.plan;
    // AI 自己レジーム/確信度(記録のみ)を最終 plan に保持する。enforce/none 化で新規オブジェクトになり
    // 落ちることがあるため parsed.plan から再付与する(ゲートには使わない=挙動不変)。
    if (parsed.plan.regime !== undefined) finalPlan.regime = parsed.plan.regime;
    if (parsed.plan.confidence !== undefined) finalPlan.confidence = parsed.plan.confidence;
    // ★v0.9.59(表示専用): **enforce 段で落ちたレッグ**の理由も根拠文へ足す。
    //   parse 段の注記(buildLegNote)は AI 応答の幾何しか説明できず、実データで最多の脱落理由
    //   (損切り幅が設定の下限より狭い=lcFloor / 上限より広い=lc)は画面に何の説明も残らなかった。
    //   しかも旧文言では parse 時点の「（実際の注文: 指値+逆指値）」がそのまま残り、片レッグが
    //   enforce で消えた回に **実プランと矛盾する** 表示になっていた。
    //   drops は enforce が受け取った時点で在ったレッグだけ=parse 段の注記と二重にならない。
    //   採否・価格・legDrops の記録内容は一切変えない(足すのは表示文字列だけ)。
    if (finalPlan.direction === 'buy' || finalPlan.direction === 'sell') {
      const enforceNote = buildLegNote({
        hasLimit: finalPlan.limitEntry != null,
        hasStop: finalPlan.stopEntry != null,
        drops: enforced.legDrops,
      });
      if (enforceNote) finalPlan.rationale = `${finalPlan.rationale} ${enforceNote}`;
    }
    const out: Extract<ScalpPlanResult, { ok: true }> = { ok: true, plan: finalPlan, vetoFired: enforced.vetoFired };
    // ★v0.9.44(記録専用): レンジの規約違反は **parsed.plan(AI の生出力)** に対して判定する。
    //   enforce 後の plan で判定すると、トレンド veto / バイアスで片脚が落ちた回が upper/lower 不揃いになり
    //   null=観測不能になる。「プロンプトが効いていない」ことを知りたい母集団はまさにそこなので生出力を見る。
    const anomaly = describeRangeAnomaly(parsed.plan);
    if (anomaly) out.rangeAnomaly = anomaly;
    // ★v0.9.57(記録専用): レッグ1本ごとの脱落を parse 段 → enforce 段の順に連結して載せる。
    //   ここは **none でなくても** 載せるのが要点(片レッグだけ落ちた回=最終プランは成立している回が
    //   まさに記録できていなかった)。同じレッグを二重に数えないことは各段の実装が担保する
    //   (enforce は自分が受け取った時点で在ったレッグしか記録しない)。判定・採否には一切影響しない。
    const legDrops: LegDrop[] = [...(parsed.legDrops ?? []), ...(enforced.legDrops ?? [])];
    if (legDrops.length) out.legDrops = legDrops;
    // ★v0.9.44(記録専用): 見送り(none)の経路と落としたレッグの生数値を surface する。
    //   下流(rangeDisabled)→ enforce → parse の順に「最後に none 化したステージ」の理由を採る。
    if (finalPlan.direction === 'none') {
      const noneReason = guarded.noneReason ?? enforced.noneReason ?? parsed.noneReason;
      const noneLegs = guarded.noneLegs ?? enforced.noneLegs ?? parsed.noneLegs;
      if (noneReason) out.noneReason = noneReason;
      if (noneLegs) out.noneLegs = noneLegs;
    }
    return out;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
