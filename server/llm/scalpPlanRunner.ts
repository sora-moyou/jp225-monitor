import type { DatabaseSync } from 'node:sqlite';
import { buildScalpPlan, firstAvailableVisionProvider, resolveEffectiveRangeEnabled, type ScalpPlanResult } from './openai.js';
import { getPrices, getNews } from '../cache.js';
import { buildNikkeiTechnical } from '../chatContext.js';
import { captureChartPngCached, type ChartShotIdentity } from '../chart/chartShot.js';
import { resolvePort, resolveScalpTrendVetoYen, resolveScalpChartFallbackText, resolveIndicatorsEnabled, type SignalProfile } from '../configStore.js';
import { getRealtimeOHLCBars } from '../feedBars.js';
import { computeRegime, formatMomentumLine } from '../signalTrade/regime.js';
import { openDb, resolveDbPath, getRecentAlerts, getSessionOHLC, getSignalTrades } from '../db/store.js';
import { collectRecentBars } from '../barsSource.js';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';
import { buildScalpMarketData, buildScalpTradeHistory } from './scalpContext.js';
import { DEFAULT_CALLER, type LlmCaller } from './caller.js';
import type { ExitVariant } from '../signalTrade/exit/index.js';
import { beginScalpPlan, endScalpPlan } from './generatorGate.js';

// 構造化データブロックに使う実 OHLC の取得窓(直近6時間ぶんの1分足)。
const RICH_BARS_WINDOW_MS = 6 * 60 * 60_000;

/** 構造化データ(数値主軸)＋自分の紙トレード成績を組み立てる(DB 読み・欠損は各ブロック省略)。
 *  DB/足/levels 不在(取引時間外など)は '' を返し、scalp-plan は従来どおり動く(壊さない)。 */
function buildRichScalpContext(symbol: string, currentPrice: number, now: number, profile?: SignalProfile): string {
  if (!(typeof currentPrice === 'number' && currentPrice > 0)) return '';
  // ★DB が開けなくても止めない: メモリ内ライブ足だけで足/ボラ/スイング/テクニカルは組める。
  //   indicatorsLoop(DB無しでも継続)と挙動を揃える=DB 一発で AI 文脈をゼロにしない。
  //   DB 依存のブロック(アラート履歴/セッションOHLC/紙成績)だけが欠落し、各ブロックは元々欠損で省略される。
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
    // ★v0.8.2: 自系統の紙成績のみを文脈に入れる(A は 'A'=NULL含む / B は 'B')。
    //   A は自分の履歴だけを見る=B の紙トレードに汚染されない(=A の提案が B の存在で変わらない)。
    const trades = db ? getSignalTrades(db, 30, profile === 'B' ? 'B' : 'A') : [];
    // ★テクニカル指標(ブロックG)は indicatorsEnabled=false のとき省略(AIへ供給しない)。
    const marketData = buildScalpMarketData({ bars, levels, alerts, now, currentPrice, session, indicatorsEnabled: resolveIndicatorsEnabled() });
    const history = buildScalpTradeHistory(trades, now);
    return [marketData, history].filter(Boolean).join('\n\n');
  } catch (e) {
    console.warn('[scalp-plan] rich context 構築失敗(省略):', e instanceof Error ? e.message : String(e));
    return '';
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
  /** 初期 LC(損切り)幅の下限[円]。未指定は buildScalpPlan 側の既定(45)。 */
  lcFloorYen?: number;
  /** 初期 LC(損切り)幅の上限[円]。未指定は monitor 設定(resolveScalpLcCeiling・既定65)。 */
  lcCeilingYen?: number;
  /** ★v0.8.2: 設定プロファイル。未指定/'A'=グローバル(実売買A・現行と byte 一致) / 'B'=System B(紙専用・signalB 設定)。
   *  trend veto 閾値・LC/バイアス・自系統の紙成績文脈が profile で切り替わる。 */
  profile?: SignalProfile;
  /** ★ドテン(保有中の反転評価=held-eval)。渡すとプロンプトに保有中の建玉(方向・建値)を注入し、反転可否を AI に問う。
   *  未指定(flat-plan)は従来どおり注入なし=byte 一致。 */
  heldPosition?: { dir: 'buy' | 'sell'; entry: number };
  /** ★レンジ再評価(未約定→ブレイク)。渡すとプロンプトにレンジ両指値の未約定経過を注入し、ブレイク切替可否を AI に問う。
   *  未指定(通常)は注入なし=byte 一致。 */
  armedContext?: { mode: 'range-fade'; ageMs: number; avgMs: number };
  /** ★呼び出し元。未指定は 'default'(シグナルエンジン・既存 route = 実弾につながる経路。挙動不変)。
   *  'generator' のときだけ LLM プロバイダ・プールが generator に切り替わる。 */
  caller?: LlmCaller;
  /** ★決済仕様の「名前付き変種」。未指定は従来どおり(プロンプトの決済ブロックは byte 不変)。
   *  指定するとその変種の決済仕様を AI に教える(実数値は非公開側が解決=数値は HTTP に載らない)。
   *  ★実際の決済(computeExitStop)には一切影響しない=提案の入力が変わるだけ。 */
  exitVariant?: ExitVariant;
}

/** チャートビジョンを無効化する env(既定は有効)。SCALP_CHART_VISION=0/false でオフ。 */
function chartVisionEnabled(): boolean {
  const v = process.env.SCALP_CHART_VISION;
  if (v === undefined) return true;
  return !/^(0|false|off|no)$/i.test(v.trim());
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
  //   生成器からは A/B の起動条件(lastPlanAt + flat + 抑止アンカーの合成)が外部から予測不能なため、
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
  // ★「その提案がどの1枚を見たか」。生成器の①と②が同じ画像を見たことを **仮定でなく記録** にする。
  let chartShot: ChartShotIdentity | null = null;
  const visionOn = chartVisionEnabled();
  // ★プールを渡す: 「画像を撮るべきか」は **自分が使うプールの** ポーズ状態で判断する
  //   (default 経路は引数 'default' = 従来と同じ判定)。
  const vision = visionOn ? firstAvailableVisionProvider(caller) : null;
  if (visionOn && vision) {
    // ② 画像生成(A/B共有キャッシュ+進行中相乗り=同時2起動を防ぐ)。ws-error 等の一過性に備え失敗時は1回リトライ。
    //   ★キャッシュ/相乗りは caller ごとに隔離する(第4引数)。生成器の撮影が A のキャッシュを温めて
    //     「A は毎サイクル撮り直す」不変条件を壊すことも、生成器の進行中撮影に A が相乗りして
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
        return { ok: false, error: 'chart-not-generated' };
      }
    } else {
      // 画像あり → 添付して④戦略作成へ。
      chartImageDataUrl = `data:image/png;base64,${shot.buffer.toString('base64')}`;
      console.log(`[scalp-plan] vision: 画像生成OK (${(shot.buffer.length / 1024).toFixed(0)}kB) → 戦略作成 `
        + `provider=${vision.name}`);
    }
  } else if (!visionOn) {
    console.log('[scalp-plan] vision: disabled (SCALP_CHART_VISION=0) → text-only');
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
  // v0.7.54: 構造化データ(数値の足/節目/ボラ/スイング/アラート結果)＋自分の紙トレード成績を末尾に追記。
  //   DB/足/levels 欠損は '' で省略され、既存挙動(勢い1行+画像)を壊さない。★v0.8.2: 自系統(A/B)の履歴のみ。
  const rich = buildRichScalpContext(symbol, price ?? 0, Date.now(), overrides.profile);
  const technical = `${baseTech ? `${baseTech}\n` : ''}${formatMomentumLine(regime, rangeEnabled)}${rich ? `\n\n${rich}` : ''}`;
  // veto 無効(0)は trend を渡さない=現行挙動(veto なし)。>0 のときだけ {dir,strong} を渡してコード veto を効かせる。
  const trend = vetoYen > 0 ? { dir: regime.dir, strong: regime.strong } : undefined;

  // ④ 戦略作成。LC/バイアスは override が無ければ buildScalpPlan 内で monitor 設定を既定に使う。
  return attachChartShot(await buildScalpPlan({
    symbol,
    prices,
    news: getNews(),
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
  }), caller, chartShot);
}

/** ★画像の同一性を結果に additive で載せる(記録専用)。
 *  caller==='default'(実弾 A につながる既存の全経路)では **元のオブジェクトをそのまま返す**
 *  =フィールドが1つも増えない=engine/route/既存テストから見て byte 不変。
 *  生成器(caller!=='default')のときだけ、その提案がどの1枚を見たかを載せる。 */
function attachChartShot(
  result: ScalpPlanResult, caller: LlmCaller, identity: ChartShotIdentity | null,
): ScalpPlanResult {
  if (caller === DEFAULT_CALLER || identity === null || !result.ok) return result;
  return { ...result, chartShot: identity };
}
