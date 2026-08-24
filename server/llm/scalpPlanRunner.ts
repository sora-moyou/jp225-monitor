import type { DatabaseSync } from 'node:sqlite';
import { buildScalpPlan, firstAvailableVisionProvider, resolveEffectiveRangeEnabled, type ScalpPlanResult } from './openai.js';
import { getPrices, getNews } from '../cache.js';
import { buildNikkeiTechnical } from '../chatContext.js';
import { captureChartPngCached, type ChartShotIdentity } from '../chart/chartShot.js';
import {
  resolvePort, resolveScalpTrendVetoYen, resolveScalpChartFallbackText, resolveIndicatorsEnabled,
  resolveBandwalkEnabled, resolveEffectiveScalpBias, resolveShockParams, resolveScalpChartVisionMode,
  type SignalProfile, type ChartVisionMode,
} from '../configStore.js';
import { buildBandwalkSamples, evaluateBandwalk, DEFAULT_BANDWALK, type Bandwalk } from '../bandwalk.js';
import { getRealtimeOHLCBars } from '../feedBars.js';
import { computeRegime, formatMomentumLine, formatMomentumLineForTrend, type Regime } from '../signalTrade/regime.js';
import { openDb, resolveDbPath, getRecentAlerts, getSessionOHLC, getSignalTrades, getDailyCloses } from '../db/store.js';
import { collectRecentBars } from '../barsSource.js';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';
import { buildScalpMarketData, buildScalpTradeHistory } from './scalpContext.js';
// ★v0.9.98: 基礎データ(日足)ブロック。純関数 + 既存の取得だけ(新しい計算・新しい閾値は無し)。
import { buildBasedataContext, type DailyBar } from './basedataContext.js';
// ★v0.9.100(段4): A/B 分割が有効なときだけ、A 用(節目・アラート・長期高安ぬき)の文脈も作る。
import { buildTrendContext } from './abContext.js';
import { isPlanSplitEnabled } from './planSplitConfig.js';
import { getIndicatorsSnapshot } from '../loops/indicatorsLoop.js';
import type { SqueezeState } from './planVariants.js';
import type { SplitRecord } from './scalpPlanSplit.js';
// ★段5: A/B 分割のプロンプトの型の指紋(データを含まない・pb1 と同じ作法)。
import { aTrendPromptBuildFp, bOrderPromptBuildFp } from './abPromptBuild.js';
// ★段5続き: 文脈のどのブロックが実際に入ったか(データ不足による黙示的な省略)を検出する純関数。
import { detectContextPresence, type ContextPresence } from './contextPresence.js';
import { DAILY_CLOSES_KEEP, DAILYBAND_FETCH_SESSIONS } from '../dailyBand.js';
import { DEFAULT_CALLER, type LlmCaller } from './caller.js';
import type { ExitVariant } from '../signalTrade/exit/index.js';
import { DEFAULT_PROMPT_VARIANT, type PromptVariant } from './promptVariant.js';
// ★v0.9.93(RECORD-ONLY): 版とプロンプトの型の指紋。**記録の層別キー**(sp1 とは別物)。
import { currentBuildIdentity, promptBuildFor } from '../buildIdentity.js';
import type { EntryTrendDir } from '../../core/entryLabel.js';
import { beginScalpPlan, endScalpPlan } from './generatorGate.js';

// 構造化データブロックに使う実 OHLC の取得窓(直近6時間ぶんの1分足)。
const RICH_BARS_WINDOW_MS = 6 * 60 * 60_000;

/** ★分析用(caller!=='default')のプロンプトから **外した** 文脈ブロックの名前(記録専用の不透明な識別子)。
 *  値は HTTP 応答 → 分析用の台帳(proposals.context_omitted)へそのまま流れる。
 *
 *  なぜ外すか(母集団の独立性):
 *    仮想取引の成績の履歴は **A の建玉列** で、A の決済設定の関数になっている。これを両腕に見せると、
 *    ②(候補の決済仕様を教えた腕)は「候補で建てろ」と言われながら **現行決済で決済された成績表** を
 *    読むことになり、①vs② の対比が汚染される(しかも②の適応を弱める=帰無側へ倒す方向)。
 *    この実験で一番使いたい結論が帰無側(「①と②で提案がほとんど変わらない」)である以上、
 *    帰無側へ倒す既知のバイアスをこれ以上増やさない。
 *  なぜ **両腕から等しく** 外すか:
 *    片腕だけ外すと不公平な対比になる。等しく外せば ①vs② の対比は清潔になる。
 *    代償(提案が A の見るものと更に違う)は承知の上で、記録に残して1年後の分析者へ渡す。
 *  ★A/B(caller='default'・実取引につながる経路)では **一切外さない**(従来どおり履歴を入れる)。 */
export const GENERATOR_OMITTED_CONTEXT: readonly string[] = ['paper-trade-history'];

/** ★A(目線)に渡す技術文脈=**A の全文のデータ部** を組み立てる純関数。
 *
 *  ■ なぜ export するか(2026-08-24・真因はここ)
 *    「A に注文の語0件」の検査は これまで **プロンプトのテンプレートだけ** を数えており、
 *    データ部を数えていなかったので、勢い1行に混ざった注文・戦略・執行の語を素通りさせた。
 *    ★検査が「実際に送る全文」を組めるように、組み立てをここに1本化して export する。
 *
 *  ■ ★baseTech(buildNikkeiTechnical)は **渡さない**(2026-08-24・第2次)
 *    ■ 主目的は振り分け表(server/llm/abContext.ts)の履行:
 *        節目 … A × / B ○   ・   基礎データ長期高安 … A × / B ○(価格の候補=節目の一種)
 *      buildTrendContext が `levels:null` で外した当のものを、baseTech が
 *      「上値メド/下値メド/上昇目途候補(節目)」として **先頭で渡していた**(実測: 節目×2〜4)。
 *    ■ ★ただしこれは「表の履行」だけでは **ない**。★表に無い項目まで巻き添えで落としている。
 *      ★実測(本番の経路1・実データ): **8行 / 765字 / −28.5%** が A から消える。
 *        ① 見出し ② 上値メド ③ 下値メド … 表で A × と決めていたもの(意図どおり)
 *        ④ フィボ戻し「…転換目安は未達」… ★価格ではなく **方向転換の判断**。A に代替なし
 *        ⑤ ― 予測(ADR/シーズナリティ) ― の見出し
 *        ⑥ ADR(直近13セッション中央値): 上580円/下555円 … ★**ボラ/レンジ=表では A ○ の側**
 *        ⑦ 本日ADR予測メド: 上限/下限 … 価格の候補なので落として妥当
 *        ⑧ 時間帯傾向(05:00台,19日): 平均-0.05%/上昇37% … ★**方向の事前確率**。A に代替なし
 *      ★④⑥⑧ は表に無い項目の巻き添え。**承知の上で落としている**(意図と事故を混同しないこと)。
 *      ⑥⑦⑧ が実データで実際に埋まることは DB複製で確認済み(ADR samples=13 / seasonality samples=19)。
 *      ★戻すかどうかは別途の判断で、ここでは「落ちている」ことを記録に残すに留める。
 *    ■ ★なぜ「節目だけ外す」(b) にしなかったか
 *      ★(b) は **技術的には成立する**(buildBasedataContext の `scope` と同じ形で分けられる)。
 *      採らなかったのは、chatContext.ts に **A 専用の第2の整形器** を持つことになり、
 *      abContext.ts 冒頭が警告する「2つ持つと片方だけ直してズレる」に正面から反するため。
 *      ★「3経路すべてが節目を含むので (b) は作れない」ではない(前の版のコメントは誤り)。
 *    ■ ★向きの材料の重複について(前の版のコメントは母集団違いだった)
 *      「向きの材料は全部重複している」は **経路2(levels 無し)の話**。★本番は経路1で、
 *      `15分平均`/`60分平均` の水準も `傾向` ラベルも **そもそも出ていない**(=失っていない)。
 *      経路1で失う向きの材料は上の ④⑧ で、これは A のどこにも代替が無い。
 *
 *  ■ ★現値の1行だけは付ける(振り分け表の「現在価格 ○(呼び出し側が別ブロックで付ける)」)
 *    buildTrendContext は現在価格を **相対値でしか** 書かない(「本日高安…内50%」「1時間-244円」)。
 *    絶対値は実測で1文字も出ない。★baseTech を丸ごと外すと A から現値が消えるので、
 *    表どおり呼び出し側が付ける。★文言は baseTech の見出しと **同じ形**(新しい語彙を作らない)。
 *
 *  ■ ★書き忘れで節目が戻らない形(formatMomentumLineForTrend と同じ流儀)
 *    この関数は **baseTech を引数に取らない**。渡す口が無いので、呼び出し側が
 *    「A にも基礎テクニカルを付けよう」と書き戻す事故が構造的に起きない。 */
export function buildTechnicalForTrend(currentPrice: number | undefined, regime: Regime, trendText: string): string {
  const head = typeof currentPrice === 'number' && Number.isFinite(currentPrice) && currentPrice > 0
    ? `現値 ${Math.round(currentPrice).toLocaleString('en-US')}円\n`
    : '';
  return `${head}${formatMomentumLineForTrend(regime)}\n\n${trendText}`;
}

/** ★BB スクイーズ判定の解決結果。★state(判定できた) と unavailable(判定できなかった理由) は **別物**。
 *  これを分けないと「スクイーズでなかった」と「測れなかった」が同じ NULL に潰れる(段1 の設計)。 */
export interface SqueezeForPlan { state: SqueezeState; unavailable?: string }

/** ★既存の指標スナップショットから、版の選択に使う生値と「使えなかった理由」を取り出す純関数。
 *  ★新しい判定は作らない(buildSqueezeSnapshot の結果をそのまま読むだけ)。
 *    snapshot 無し           → 'no_snapshot'
 *    progress が closed/disabled → その語(取引時間外/機能OFF で **計算そのものが止まっている**)
 *    squeeze 欠落            → 'no_squeeze'
 *    ready=false             → 'ready_false'(参照本数が揃っていない)
 *    それ以外                → state をそのまま('squeeze' / 'bulge' / null=どちらでもない) */
export function resolveSqueezeFromSnapshot(
  snap: ReturnType<typeof getIndicatorsSnapshot>,
): SqueezeForPlan {
  if (!snap) return { state: null, unavailable: 'no_snapshot' };
  const ps = snap.progress?.state;
  if (ps === 'closed' || ps === 'disabled') return { state: null, unavailable: ps };
  const sq = snap.squeeze;
  if (!sq) return { state: null, unavailable: 'no_squeeze' };
  if (!sq.ready) return { state: null, unavailable: 'ready_false' };
  return { state: sq.state };
}

/** 実行時の解決(スナップショットを読むだけ)。 */
function resolveSqueezeForPlan(): SqueezeForPlan {
  try { return resolveSqueezeFromSnapshot(getIndicatorsSnapshot()); }
  catch { return { state: null, unavailable: 'no_snapshot' }; }
}

/** 構造化データ(数値主軸)＋自分の仮想取引成績を組み立てる(DB 読み・欠損は各ブロック省略)。
 *  DB/足/levels 不在(取引時間外など)は '' を返し、scalp-plan は従来どおり動く(壊さない)。
 *  ★caller!=='default'(分析用)のときだけ仮想取引の成績ブロックを外す(理由は GENERATOR_OMITTED_CONTEXT)。
 *  ★export しているのは負荷の実測(1要求あたりのイベントループ停止時間)を **本物の関数で** 測るため。
 *    呼び出し元は増やさない(この経路の唯一の呼び出しは下の runScalpPlanWithChartInner)。 */
export function buildRichScalpContext(
  symbol: string, currentPrice: number, now: number, profile?: SignalProfile, caller: LlmCaller = DEFAULT_CALLER,
): string {
  return buildRichScalpContextResult(symbol, currentPrice, now, profile, caller).text;
}

/** buildRichScalpContext と同じ処理で、文脈テキストに加えて **バンドウォークの判定結果** も返す。
 *  ★1回の足取得で「AI 文脈に書く行」と「プロンプトの緩和判断」の両方を賄うためのもの(DB を二度開かない)。
 *  bandwalk: Bandwalk=成立中 / null=非成立 / undefined=判定していない(機能OFF・目線なし・足不足)。 */
export function buildRichScalpContextResult(
  symbol: string, currentPrice: number, now: number, profile?: SignalProfile, caller: LlmCaller = DEFAULT_CALLER,
): { text: string; trendText?: string; bandwalk?: Bandwalk | null } {
  if (!(typeof currentPrice === 'number' && currentPrice > 0)) return { text: '' };
  // ★DB が開けなくても止めない: メモリ内ライブ足だけで足/ボラ/スイング/テクニカルは組める。
  //   indicatorsLoop(DB無しでも継続)と挙動を揃える=DB 一発で AI 文脈をゼロにしない。
  //   DB 依存のブロック(アラート履歴/セッションOHLC/仮想取引の成績)だけが欠落し、各ブロックは元々欠損で省略される。
  let db: DatabaseSync | null = null;
  try { db = openDb(resolveDbPath()); }
  catch (e) {
    console.warn('[scalp-plan] DB を開けません(メモリ内ライブ足のみで文脈構築):', e instanceof Error ? e.message : String(e));
  }
  try {
    // ★足は「DBの bars_1m ∪ メモリ内のライブ足」= collectRecentBars。DB だけを見ていたため
    //   collector 未稼働の環境では窓内0本→ブロックA/C/D/G(テクニカル)がまるごと消えていた(修正)。
    const bars = collectRecentBars(db, symbol, now - RICH_BARS_WINDOW_MS);
    const levels = getLevelsSnapshot();
    const alerts = db ? getRecentAlerts(db, 8) : [];
    const session = db ? (getSessionOHLC(db, symbol, 1)[0] ?? null) : null;
    // ★v0.9.98(基礎データ): 日足MA/バンド/長期高安/日足OHLC。★出所は **アラートが読むのと同じ**
    //   daily_closes(基礎データ import が歴史を埋め、ライブが確定日を追記する)と bars_1m のセッション集計。
    //   ■ 古い値が残らない: ここで **毎回 DB から読み直す**。モジュール側にキャッシュを置いていないので、
    //     collector が止まって系列が伸びなければ **確定日が古いまま見出しに出る**(黙って新しい顔にならない)。
    //   ■ DB が無い/読めない回は空配列 → basedataContext が「取得できず」と書く(ブロックを消さない)。
    let dailyCloses: number[] = [];
    let dailyBars: DailyBar[] = [];
    if (db) {
      try {
        dailyCloses = getDailyCloses(db, symbol, DAILY_CLOSES_KEEP).map(r => r.close);
        // 取引日足 = Day セッション。★古い→新しい順に並べ、直近 DAILY_CLOSES_KEEP 本に切る。
        dailyBars = getSessionOHLC(db, symbol, DAILYBAND_FETCH_SESSIONS)
          .filter(x => x.session === 'Day')
          .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate))
          .slice(-DAILY_CLOSES_KEEP)
          .map(x => ({ sessionDate: x.sessionDate, open: x.open, high: x.high, low: x.low, close: x.close }));
      } catch (e) {
        // ★失敗を握りつぶして「日足が無い」ように見せない: 空にして basedataContext に書かせる。
        dailyCloses = []; dailyBars = [];
        console.warn('[scalp-plan] 基礎データ(日足)取得失敗:', e instanceof Error ? e.message : String(e));
      }
    }
    // ★v0.8.2: 自系統の仮想取引の成績のみを文脈に入れる(A は 'A'=NULL含む / B は 'B')。
    //   A は自分の履歴だけを見る=B の仮想取引に汚染されない(=A の提案が B の存在で変わらない)。
    // ★分析用(caller!=='default')は **両腕とも** 仮想取引の成績を読まない(DB も引かない)。理由は
    //   GENERATOR_OMITTED_CONTEXT。A/B(default)は従来どおり=1ミリも変わらない。
    const omitHistory = caller !== DEFAULT_CALLER;
    const trades = db && !omitHistory ? getSignalTrades(db, 30, profile === 'B' ? 'B' : 'A') : [];
    // ★バンドウォーク: アラート(detect/registry)と **同じ純関数・同じパラメータ・同じ目線** で判定する。
    //   機能OFF / テクニカルOFF では判定しない(undefined=文脈に行を出さない)。
    //   目線 'none'(未設定/AI委任)は「方向一致を問わない」= 判定は行う(上下とも成立しうる)。
    //   ★判定の失敗は **バンドウォークの行が消えるだけ** に閉じ込める(この1機能で文脈全体を落とさない)。
    const indicatorsOn = resolveIndicatorsEnabled();
    let bandwalk: Bandwalk | null | undefined;
    try {
      if (indicatorsOn && resolveBandwalkEnabled()) {
        bandwalk = evaluateBandwalk(
          buildBandwalkSamples(bars, DEFAULT_BANDWALK.windowBars, resolveShockParams()),
          resolveEffectiveScalpBias(profile), DEFAULT_BANDWALK,
        );
      }
    } catch (e) {
      console.warn('[scalp-plan] bandwalk 判定失敗(省略):', e instanceof Error ? e.message : String(e));
    }
    // ★テクニカル指標(ブロックG)は indicatorsEnabled=false のとき省略(AIへ供給しない)。
    const marketData = buildScalpMarketData({ bars, levels, alerts, now, currentPrice, session, indicatorsEnabled: indicatorsOn, bandwalk });
    // 外した回は buildScalpTradeHistory を呼ばない(空配列で呼んで '' を得るのと結果は同じだが、
    // 「読んでいない」ことをコード上でも一意にする)。
    const history = omitHistory ? '' : buildScalpTradeHistory(trades, now);
    // ★基礎データは **足の直後・仮想取引の成績の前** に置く(大きい時間軸 → 小さい時間軸 の順)。
    const basedata = buildBasedataContext({ dailyCloses, dailyBars, currentPrice });
    // ★A/B 分割が有効なときだけ A 用の文脈も組む(無効なら1回も作らない=無駄な計算をしない)。
    //   ★同じ材料(bars/levels/alerts/日足)から作るので、A と B は **同じ断面** を見る。
    const trendText = isPlanSplitEnabled()
      ? buildTrendContext({
        market: { bars, levels, alerts, now, currentPrice, session, indicatorsEnabled: indicatorsOn, bandwalk },
        basedata: { dailyCloses, dailyBars, currentPrice },
      })
      : undefined;
    return {
      text: [marketData, basedata, history].filter(Boolean).join('\n\n'),
      ...(trendText === undefined ? {} : { trendText }),
      bandwalk,
    };
  } catch (e) {
    console.warn('[scalp-plan] rich context 構築失敗(省略):', e instanceof Error ? e.message : String(e));
    return { text: '' };
  } finally {
    try { db?.close(); } catch { /* close 失敗は無視 */ }
  }
}

// トレードシグナルの AI 提案(scalp-plan)を「チャート撮影 → (無ければ見送り) → buildScalpPlan(画像込み)」の
// 逐次オンデマンドゲート付きで生成する共通関数。route(/api/scalp-plan・trade2 向け)と
// シグナルエンジン(server/signalTrade/engine.ts)が両方これを呼ぶことで、両経路の入力
// (チャート画像 + ガードレール + LC 上限 + バイアス)を完全一致させる(＝同一提案)。
//
// 逐次ゲート(ユーザー指定の厳密順序 ②画像生成→③生成確認→④戦略作成):
//   チャートを使う設定(vision 対応プロバイダあり かつ SCALP_CHART_VISION 有効)の時は、
//   ②新規撮影→③生成確認を行い、③で画像が生成できなければ AI を一切呼ばず
//   { ok:false, error:'chart-not-generated' } で見送る。画像が出た時だけ④ buildScalpPlan を呼ぶ。
//   「チャートを使わない設定」(vision プロバイダ無し / SCALP_CHART_VISION 無効)はゲート対象外＝
//   従来どおり画像なしテキストのみで判断する(既存挙動を壊さない)。

const NIKKEI_SYMBOL = 'NIY=F';

export interface RunScalpPlanOverrides {
  /** 対象シンボル。未指定は NIY=F。 */
  symbol?: string;
  /** 初期 LC(損切り)幅の下限[円]。未指定は buildScalpPlan 側の既定(=monitor 設定・既定55)。 */
  lcFloorYen?: number;
  /** 初期 LC(損切り)幅の上限[円]。未指定は monitor 設定(resolveScalpLcCeiling・既定65)。 */
  lcCeilingYen?: number;
  /** ★v0.8.2: 設定プロファイル。未指定/'A'=グローバル(実取引A・現行と byte 一致) / 'B'=System B(仮想取引専用・signalB 設定)。
   *  trend veto 閾値・LC/バイアス・自系統の仮想取引の成績文脈が profile で切り替わる。 */
  profile?: SignalProfile;
  /** ★ドテン(保有中の反転評価=held-eval)。渡すとプロンプトに保有中の建玉(方向・建値)を注入し、反転可否を AI に問う。
   *  未指定(flat-plan)は従来どおり注入なし=byte 一致。 */
  heldPosition?: { dir: 'buy' | 'sell'; entry: number };
  /** ★レンジ再評価(未約定→ブレイク)。渡すとプロンプトにレンジ両指値の未約定経過を注入し、ブレイク切替可否を AI に問う。
   *  未指定(通常)は注入なし=byte 一致。 */
  armedContext?: { mode: 'range-fade'; ageMs: number; avgMs: number };
  /** ★呼び出し元。未指定は 'default'(シグナルエンジン・既存 route = 実取引につながる経路。挙動不変)。
   *  'generator' のときだけ LLM プロバイダ・プールが generator に切り替わる。 */
  caller?: LlmCaller;
  /** ★決済仕様の「名前付き変種」。未指定は従来どおり(プロンプトの決済ブロックは byte 不変)。
   *  指定するとその変種の決済仕様を AI に教える(実数値は非公開側が解決=数値は HTTP に載らない)。
   *  ★実際の決済(computeExitStop)には一切影響しない=提案の入力が変わるだけ。 */
  exitVariant?: ExitVariant;
  /** ★質問文の変種(v0.9.75)。未指定は 'v1' = 従来と byte 一致。'v2' は user プロンプトだけを差し替える。
   *  ★ExitVariant とは別の軸(決済の説明ではなく、質問そのもの)。parse/enforce/実決済には影響しない。 */
  promptVariant?: PromptVariant;
}

/** チャートビジョンを無効化する env(既定は「設定に従う」)。SCALP_CHART_VISION=0/false で **強制オフ**。
 *  ★この env は「オフに倒す」ことしかできない(オンには倒せない)。課金の効く方向へ倒す入口を増やさないため。 */
function chartVisionEnvKill(): boolean {
  const v = process.env.SCALP_CHART_VISION;
  if (v === undefined) return false;
  return /^(0|false|off|no)$/i.test(v.trim());
}

/** ★v0.9.70(A/B): そのサイクルで **画像を撮って送ろうとするか** を決める純関数。
 *
 *  ■ なぜ「全量」を作らないか
 *    実測(稼働機のログ)で、画像つきの呼び出しが1日約1,600回(08-06:1,478 / 08-07:1,614)。
 *    画像は 1280x760・detail 未指定(=高精細=6タイル)で、無料枠(gemini)がレート制限で休むと
 *    groq は 413・kimi は 404 で必ず落ちるため **OpenAI が全部かぶる**。gpt-4o-mini は画像の
 *    トークン換算率が極端に高く、1枚で約36,800トークン。結果、1日5.5ドル(月165ドル)。
 *    ★そして「画像が効いているか」は一度も測っていない(画像が事実上100%に付いており対照群が無い)。
 *    → 既定は off(1枚も送らない・撮影もしない)。測りたくなったら ab にすれば **課金は半分のまま** 比較できる。
 *
 *  ■ 群の割り当て
 *    サイクルごとに独立に コイン投げ(rng<0.5)。時刻やカウンタで交互にしないのは、
 *    A/B 2系統・サイクル間隔・場況の周期と位相が噛み合って群が時間帯に偏るのを避けるため。
 *  ★rng はテスト注入点(既定 Math.random)。 */
export function decideChartVision(
  mode: ChartVisionMode, envKill: boolean, rng: () => number = Math.random,
): { mode: ChartVisionMode; wantImage: boolean } {
  if (envKill || mode !== 'ab') return { mode, wantImage: false };
  return { mode, wantImage: rng() < 0.5 };
}

/** ★テスト注入点: A/B のコイン投げ。既定は Math.random(本番)。 */
let chartVisionRng: () => number = Math.random;
/** テスト専用: コイン投げを差し替える(戻り値で元に戻す)。 */
export function setChartVisionRngForTest(fn: () => number): () => void {
  const prev = chartVisionRng;
  chartVisionRng = fn;
  return () => { chartVisionRng = prev; };
}

/** チャート撮影ゲート付きで scalp-plan を生成する。
 *  戻り値は buildScalpPlan と同じ ScalpPlanResult。画像生成できなければ AI を呼ばず
 *  { ok:false, error:'chart-not-generated' } を返す(見送り)。
 *  LC/バイアスの override を渡さなければ monitor 設定を既定に使う(＝route/エンジンが同条件)。 */
export async function runScalpPlanWithChart(
  overrides: RunScalpPlanOverrides = {},
): Promise<ScalpPlanResult> {
  // ★作業3(backpressure)の計上点: **全経路**(A/B シグナルエンジン・route)がここで進行中カウンタを上下させる。
  //   このカウンタを読むのは caller='generator' の関門だけなので、default 経路の挙動は一切変わらない。
  //   分析用からは A/B の起動条件(lastPlanAt + flat + 抑止アンカーの合成)が外部から予測不能なため、
  //   「今 A/B が生成中か」はサーバ側にしか判断材料がない。だから共通関数で数える。
  beginScalpPlan();
  try {
    return await runScalpPlanWithChartInner(overrides);
  } finally {
    endScalpPlan();
  }
}

async function runScalpPlanWithChartInner(
  overrides: RunScalpPlanOverrides,
): Promise<ScalpPlanResult> {
  const caller = overrides.caller ?? DEFAULT_CALLER;
  const symbol =
    typeof overrides.symbol === 'string' && overrides.symbol ? overrides.symbol : NIKKEI_SYMBOL;
  const prices = getPrices();
  const price = prices.find(p => p.symbol === symbol)?.price;

  // ── チャートビジョン + 逐次オンデマンドゲート(②生成→③確認→④戦略)。
  let chartImageDataUrl: string | null = null;
  // ★「その提案がどの1枚を見たか」。分析用の①と②が同じ画像を見たことを **仮定でなく記録** にする。
  let chartShot: ChartShotIdentity | null = null;
  // ★v0.9.70: そのサイクルの群を **撮影の前に** 決める(off なら撮影自体を行わない=ヘッドレスChromeを起動しない)。
  const visionDecision = decideChartVision(resolveScalpChartVisionMode(), chartVisionEnvKill(), chartVisionRng);
  const visionOn = visionDecision.wantImage;
  // ★プールを渡す: 「画像を撮るべきか」は **自分が使うプールの** ポーズ状態で判断する
  //   (default 経路は引数 'default' = 従来と同じ判定)。
  const vision = visionOn ? firstAvailableVisionProvider(caller) : null;
  if (visionOn && vision) {
    // ② 画像生成(A/B共有キャッシュ+進行中相乗り=同時2起動を防ぐ)。ws-error 等の一過性に備え失敗時は1回リトライ。
    //   ★キャッシュ/相乗りは caller ごとに隔離する(第4引数)。分析用の撮影が A のキャッシュを温めて
    //     「A は毎サイクル撮り直す」不変条件を壊すことも、分析用の進行中撮影に A が相乗りして
    //     その遅延/失敗を継承することも無い。caller='default'(A/B)は従来と完全に同一。
    //   第2/第3引数は撮影関数/時計のテスト注入点なので既定のまま(undefined)を渡す。
    let shot = await captureChartPngCached(resolvePort(), undefined, undefined, caller);
    if (!shot.buffer) {
      console.warn(`[scalp-plan] vision: 画像生成失敗 → 1回リトライ reason=${shot.reason ?? 'unknown'}`);
      shot = await captureChartPngCached(resolvePort(), undefined, undefined, caller);
    }
    // ★どの1枚を見たか(identity)。撮影側が返さない場合(テストのモック等)は null=「画像の同一性は不明」。
    chartShot = shot.identity ?? null;
    // ③ 2回とも失敗: 設定に応じて「テキストのみで継続(縮退運転=全停止を防ぐ)」or 従来どおり「見送り」。
    if (!shot.buffer) {
      if (resolveScalpChartFallbackText()) {
        console.warn(`[scalp-plan] vision: 2回失敗 → テキストのみで AI 継続(縮退運転) reason=${shot.reason ?? 'unknown'}`);
        // chartImageDataUrl は null のまま=画像なしで戦略作成へ(取引を止めない)。
      } else {
        console.log('[scalp-plan] vision: 画像生成できず → 見送り(AI呼ばない) reason=' + (shot.reason ?? 'unknown'));
        // ★この回も群を残す(requested=true / sent=false = 「撮ろうとしたが送れなかった」)。
        return attachChartVision({ ok: false, error: 'chart-not-generated' }, visionDecision);
      }
    } else {
      // 画像あり → 添付して④戦略作成へ。
      chartImageDataUrl = `data:image/png;base64,${shot.buffer.toString('base64')}`;
      console.log(`[scalp-plan] vision: 画像生成OK (${(shot.buffer.length / 1024).toFixed(0)}kB) → 戦略作成 `
        + `provider=${vision.name}`);
    }
  } else if (!visionOn) {
    // ★off / A/B の「画像なし」群 / env 強制オフ。撮影(ヘッドレスChrome)は **1回も走らない**。
    console.log(`[scalp-plan] vision: no-image (mode=${visionDecision.mode}${chartVisionEnvKill() ? '/env-off' : ''}) → text-only(撮影もしない)`);
  } else {
    console.log('[scalp-plan] vision: skip (no vision-capable provider available) → text-only');
  }

  // ── レジーム/勢いを1回だけ算出し、(a)技術文脈への注入 と (b)コードの trend veto の両方へ同じ値を渡す(一貫)。
  //   ★v0.9.38: リアルタイム足は分内の高安(h/l)を持つ(feedBars)ので、そのまま OHLC として渡す。
  //   以前は close を o/h/l/c 全てに写像していたため、computeRegime の「直近30分高安[L-H]内pos%」が
  //   終値ベースで過小になっていた(実レンジより狭い)。dir/strong は ret10(終値差)だけで決まるので不変。
  const vetoYen = resolveScalpTrendVetoYen(overrides.profile);
  const ohlc = getRealtimeOHLCBars(symbol);
  const regime = computeRegime(ohlc, Date.now(), vetoYen > 0 ? vetoYen : 100);
  // ★レンジ両面の実効許可値。buildScalpPlan が system prompt の rangeLine に使うのと同じ関数=同じ値
  //   (プロファイル A/B も同じ解決。B は A へフォールバック)。勢い1行のレンジ文言と rangeLine が食い違うと
  //   AI が「レンジ禁止なのにレンジ可」と矛盾した指示を受けるため、必ず SSOT を共有する。
  //   ※runner は rangeEnabled の override を渡さないので buildScalpPlan 側と完全に同値になる。
  const rangeEnabled = resolveEffectiveRangeEnabled(overrides.profile);
  // 技術文脈の末尾に勢い1行を追記(バー不足でも算出可・null は「—」表示)。buildNikkeiTechnical が null でも注入する。
  const baseTech = buildNikkeiTechnical(undefined, price);
  // v0.7.54: 構造化データ(数値の足/節目/ボラ/スイング/アラート結果)＋自分の仮想取引成績を末尾に追記。
  //   DB/足/levels 欠損は '' で省略され、既存挙動(勢い1行+画像)を壊さない。★v0.8.2: 自系統(A/B)の履歴のみ。
  //   ★caller を渡す: 分析用では仮想取引の成績の履歴ブロックを外す(母集団の独立性)。default は不変。
  // ★RECORD-ONLY: 「どの時刻の断面から文脈を組み立てたか」を控える。
  //   値そのものは従来と同じ Date.now() を1回読むだけ(渡す値も回数も変わらない=挙動不変)。
  //   台帳の t(=計画が解決した時刻)は撮影/LLM の待ち時間ぶん後ろにずれるので、**別物として**残す。
  const contextAt = Date.now();
  const richResult = buildRichScalpContextResult(symbol, price ?? 0, contextAt, overrides.profile, caller);
  const rich = richResult.text;
  // ★段5続き(RECORD-ONLY): その回に getNews() を呼んだ結果を1回だけ変数へ控える
  //   (buildScalpPlan への news 入力と、下の contextPresence 判定の両方で同じ値を使う=二重に呼ばない)。
  const newsItems = getNews();
  // ★段5続き(RECORD-ONLY): 文脈の各ブロックが実際に入ったか(旧経路でも無条件に計算する=
  //   buildRichScalpContextResult 自体が分割の有無に関係なく必ず呼ばれるため)。
  const contextPresence = detectContextPresence(rich, newsItems.length);
  if (caller !== DEFAULT_CALLER) {
    // 外したことは server.log にも残す(台帳が読めない状況でも「いつから外したか」が追える)。
    console.log(`[scalp-plan] ${caller}: 文脈から除外=${GENERATOR_OMITTED_CONTEXT.join(',')}(母集団の独立性・両腕とも同一)`);
  }
  const technical = `${baseTech ? `${baseTech}\n` : ''}${formatMomentumLine(regime, rangeEnabled)}${rich ? `\n\n${rich}` : ''}`;
  // veto 無効(0)は trend を渡さない=現行挙動(veto なし)。>0 のときだけ {dir,strong} を渡してコード veto を効かせる。
  const trend = vetoYen > 0 ? { dir: regime.dir, strong: regime.strong } : undefined;

  // ★RECORD-ONLY: buildScalpPlan が組み上げたプロンプトの指紋(本文は受け取らない)。
  let promptFp: string | null = null;
  // ★RECORD-ONLY(段5): A/B 分割の測定材料。onSplitRecord コールバックが
  //   buildScalpPlan の実行中(分割が実際に走った回だけ)に埋める。attachSplitRecord がこれを
  //   最終結果へ additive に載せ、下流(engine → planLedger → signal_plans)へ届く。
  let splitRecord: SplitRecord | null = null;
  // ★版の選択に使う BB スクイーズ判定の生値と、使えなかった理由(既存の判定を読むだけ)。
  const squeeze = resolveSqueezeForPlan();
  // ④ 戦略作成。LC/バイアスは override が無ければ buildScalpPlan 内で monitor 設定を既定に使う。
  // ★v0.9.93: いちばん外側で「版とプロンプトの型」を載せる(ok:true / ok:false のどちらにも付く)。
  return attachContextPresence(attachBuildIdentity(attachTrendDir(attachChartVision(attachGeneratorRecord(attachSplitRecord(attachPlanProvenance(await buildScalpPlan({
    symbol,
    prices,
    news: newsItems,
    // chat と同じく、バー蓄積中でも節目メドを出せるよう fallbackPrice を渡す。勢い1行を末尾に注入済み。
    technical,
    chartImageDataUrl,
    lcFloorYen: overrides.lcFloorYen,
    lcCeilingYen: overrides.lcCeilingYen,
    trend,
    profile: overrides.profile,   // ★v0.8.2: A(既定)は byte 一致 / B は signalB 設定で解決。
    heldPosition: overrides.heldPosition,   // ★ドテン: 保有中の反転評価はプロンプトに held-context を注入(flat-plan は未指定=不変)。
    armedContext: overrides.armedContext,   // ★レンジ再評価: 未約定レンジのブレイク切替評価は armed-context を注入(通常は未指定=不変)。
    caller,                                 // ★プロバイダ・プールの選択のみに効く(プロンプト/parse/enforce は不変)。
    exitVariant: overrides.exitVariant,      // ★未指定(エンジン/既存 route)は undefined = 決済ブロックは従来どおり。
    promptVariant: overrides.promptVariant,  // ★未指定(エンジン/既存 route)は undefined = 質問文は v1 のまま。
    // ★バンドウォーク: 成立中のときだけプロンプトの「距離50円 / 節目起点」を緩める(LC は緩めない)。
    //   AI 文脈(ブロックG)に書いたものと **同じ判定結果** を渡す(画面/文脈/プロンプトで食い違わせない)。
    bandwalk: richResult.bandwalk,
    // ★A/B 分割(段4): A に渡す文脈(節目・アラート・長期高安ぬき)。分割が無効なら undefined=使われない。
    //   ★勢い1行は **事実だけ**(formatMomentumLineForTrend)・★baseTech は **渡さない**
    //     (baseTech の上値メド/下値メド/上昇目途候補が節目そのものだった。振り分け表の履行)。
    //     現値の1行だけ buildTechnicalForTrend が付ける。B と旧経路の technical は従来どおり baseTech 入り。
    technicalForTrend: richResult.trendText === undefined
      ? undefined
      : buildTechnicalForTrend(price, regime, richResult.trendText),
    // ★版の選択に使う BB スクイーズ判定の生値と、使えなかった理由(段5 で台帳に残す)。
    squeezeState: squeeze.state,
    ...(squeeze.unavailable ? { squeezeUnavailable: squeeze.unavailable } : {}),
    // ★RECORD-ONLY: A/B 分割の測定材料(段5 で台帳へ)。
    onSplitRecord: (r) => { splitRecord = r; },
    // ★RECORD-ONLY: 送るプロンプトの指紋を1回だけ受け取る(本文は渡ってこない)。
    onPromptFingerprint: (fp) => { promptFp = fp; },
  }), contextAt, () => promptFp), splitRecord), caller, chartShot), visionDecision), regime.trendDir),
    overrides.promptVariant), contextPresence);
}

/** ★段5(RECORD-ONLY): A/B 分割の測定材料(SplitRecord)を結果に additive で載せる。
 *
 *  ■ なぜここで載せるか(scalpPlan.ts では載せない)
 *    scalpPlan.ts(buildScalpPlan)は onSplitRecord コールバックで record を **呼び出し側へ渡すだけ**
 *    (段4)。段5 でその中身を最終結果へ実際に反映させるのはこの層の責務にする——
 *    aPromptBuild/bPromptBuild の計算(abPromptBuild.ts)を scalpPlan.ts に持ち込まないため
 *    (promptBuild.ts と同じ理由: 層を混ぜない)。
 *  ■ 旧経路(分割 OFF)は record が null のまま(コールバックが1度も呼ばれない)= splitRecord は
 *    結果に乗らない=signal_plans の新列は NULL(段5 の後方互換の要)。
 *  ■ aPromptBuild は record がある回(=A が実際に呼ばれた回)には必ず載せる。
 *    bPromptBuild は bVariant が実際の版(buy/sell/range-fade/range-breakout)のときだけ載せる
 *    (bVariant='none'=B を呼んでいない回に「B の型」を捏造しない)。 */
function attachSplitRecord(result: ScalpPlanResult, record: SplitRecord | null): ScalpPlanResult {
  if (!record) return result;
  const withA: SplitRecord = { ...record, aPromptBuild: aTrendPromptBuildFp() };
  const withB: SplitRecord = record.bVariant === 'none'
    ? withA
    : { ...withA, bPromptBuild: bOrderPromptBuildFp(record.bVariant) };
  return { ...result, splitRecord: withB };
}

/** ★段5続き(RECORD-ONLY): 文脈のどのブロックが実際に入ったかを結果に additive で載せる。
 *
 *  ■ なぜ全経路(A/B=default も分析用=generator も)で載せるか
 *    「本当に帯(55〜160円)しか手がかりが無い回」が何%あるかを測るのが目的なので、
 *    A/B 分割の有無・caller に関係なく **常に** 記録する(buildRichScalpContextResult 自体が
 *    分割の有無と無関係に無条件で呼ばれるため、この関数も同様に無条件で呼ぶ)。
 *  ■ ★旧経路(分割 OFF)でも記録される: contextPresence は分割の分岐より **前** で
 *    (buildRichScalpContextResult の直後に)計算しているので、isPlanSplitEnabled() の値に
 *    一切依存しない。
 *  ■ NULL の意味: この関数を持たない旧版(今回のリリース前)で記録された行だけが NULL になる。
 *    「入った」false と「その版に無い」NULL を混同させないため、ここでは常に値を持つ
 *    ContextPresence オブジェクトを渡す(全部 false の値を返すことはあっても、呼ばないことは無い)。 */
function attachContextPresence(result: ScalpPlanResult, presence: ContextPresence): ScalpPlanResult {
  return { ...result, contextPresence: presence };
}

/** ★v0.9.93(RECORD-ONLY): 「この結果を作ったのはどの版・どの文面か」を載せる。
 *
 *  ■ なぜ要るか(実際に解析が誤った)
 *    書き出しから版が分からず、`collector_status_<host>.txt` の起動ログの時刻や
 *    「機能列がいつ初めて埋まったか」からの **間接推定** に頼るしかなかった
 *    (切り分けの定数を2時間ずらして誤った結論を出しかけた)。
 *  ■ 2つ載せる理由(片方では足りない)
 *    ・app_version … chore リリースでも上がる/開発中は上がらないことがある
 *    ・prompt_build … **文面が変わったときだけ** 動く(データでは動かない)。版と独立の軸。
 *  ■ ★ok:false にも載せる: 計画が得られなかった回こそ「どの版で起きたか」が要る。
 *  ■ ★載せる場所がここな理由: promptBuild.ts は scalpPlan.ts の描画関数を import するので、
 *    scalpPlan.ts 側で載せると循環参照になる(モジュール初期化順で undefined を踏む)。 */
function attachBuildIdentity(result: ScalpPlanResult, variant?: PromptVariant): ScalpPlanResult {
  // ★葉(buildIdentity)から読む: ここで promptBuild.ts を静的 import すると、openai.js の barrel を
  //   モックしている既存テストの脇をすり抜けて LLM スタックの実体が読み込まれる(実際に15ファイルが落ちた)。
  //   ★未登録(publish 前 / 別プロセス)なら promptBuild は載せない = 列は NULL(捏造しない)。
  const fp = promptBuildFor(variant ?? DEFAULT_PROMPT_VARIANT);
  const out: ScalpPlanResult = { ...result, appVersion: currentBuildIdentity().appVersion };
  if (fp !== null) out.promptBuild = fp;
  return out;
}

/** ★v0.9.88: そのサイクルで **コードが測った** トレンドの向きを結果に載せる(ADD-ONLY)。
 *  画面の「順張り/逆張り」はこれを基準に決める(core/entryLabel.ts の entryStance)。
 *  ★同じ regime を (a)技術文脈への注入と (b)コードの trend veto と (c)ここ の3つで共有する
 *    = AI に見せた勢いの行と画面のラベルが食い違わない。
 *  ★ok:false(計画が得られなかった回)には載せない: 描くプランが無いので使い道が無く、
 *    ok:false の形を変えると既存の台帳/テストの byte 一致が崩れる。 */
function attachTrendDir(result: ScalpPlanResult, trendDir: EntryTrendDir): ScalpPlanResult {
  return result.ok ? { ...result, trendDir } : result;
}

/** ★RECORD-ONLY(v0.9.70): そのサイクルの **チャート画像の群** を結果に載せる。
 *  mode      … その時の設定('off' / 'ab')。
 *  requested … その回に画像を撮って送ろうとしたか(A/B のコイン投げの結果)。
 *  sent      … ★**実際に送ったか**。ビジョン非対応プロバイダへフォールバックした回・撮影に失敗して
 *              テキスト縮退した回・LLM を1回も呼べなかった回は false になる。
 *  ★A/B の群として使ってよいのは sent だけ(requested は「送るつもりだった」に過ぎない)。
 *    両方載せるのは「撮ろうとしたのに送れなかった」回を後から数えられるようにするため。 */
function attachChartVision(
  result: ScalpPlanResult, decision: { mode: ChartVisionMode; wantImage: boolean },
): ScalpPlanResult {
  return { ...result, chartVision: { mode: decision.mode, requested: decision.wantImage, sent: result.imageSent === true } };
}

/** ★RECORD-ONLY: 計画の出所(文脈を組み立てた時刻・プロンプトの指紋)を結果に additive で載せる。
 *
 *  ■ なぜ **全経路**(A/B=default も)で載せるか
 *    凍結した入力からの再生を突き合わせたいのは、まさに実取引につながる A/B の計画サイクルだから。
 *    分析用だけの記録(chartShot / contextOmitted)と違い、この2点は A/B でこそ要る。
 *  ■ 何を壊さないか
 *    足すのは記録用の2フィールドだけ。plan・noneReason・legDrops・価格・error は一切触らない。
 *    HTTP 応答は route 側が列挙で組み立てるので、この2つが勝手に外へ出ることも無い。
 *  ■ 値が無いときはフィールドを作らない
 *    「値が無い」と「そのフィールドを持たない版で記録された」を混同させないため。
 *    ★文脈を組む前に見送った回(chart-not-generated)は **この関数を通らずに** 早期 return するので、
 *      contextAt を持たない=「まだ何も組み立てていない」ことが記録の形から読める。
 *    ★promptFp は refPrice の鮮度落ち等で **プロンプトを組む前に** 失敗した回では null のまま。
 *  promptFp は buildScalpPlan の実行中に確定するので、確定後に読む getter で受け取る。 */
function attachPlanProvenance(
  result: ScalpPlanResult, contextAt: number, promptFp: () => string | null,
): ScalpPlanResult {
  const fp = promptFp();
  const out: ScalpPlanResult = { ...result, contextAt };
  if (fp !== null) out.promptFp = fp;
  return out;
}

/** ★分析用の記録専用フィールドを結果に additive で載せる。
 *  caller==='default'(実取引 A につながる既存の全経路)では **元のオブジェクトをそのまま返す**
 *  =フィールドが1つも増えない=engine/route/既存テストから見て byte 不変。
 *  分析用(caller!=='default')のときだけ:
 *    ・chartShot      … その提案がどの1枚を見たか(identity が取れた時だけ)
 *    ・contextOmitted … ★プロンプトから外した文脈ブロック(母集団の独立性のため外した事実の記録)。
 *      これが応答に無い版で記録された標本は「外していない(＝A の仮想取引の成績を見ている)」ことを意味する。 */
function attachGeneratorRecord(
  result: ScalpPlanResult, caller: LlmCaller, identity: ChartShotIdentity | null,
): ScalpPlanResult {
  if (caller === DEFAULT_CALLER || !result.ok) return result;
  const out: ScalpPlanResult = { ...result, contextOmitted: GENERATOR_OMITTED_CONTEXT };
  if (identity === null) return out;
  return { ...out, chartShot: identity };
}
