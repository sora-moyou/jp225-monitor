import { buildScalpPlan, firstAvailableVisionProvider, type ScalpPlanResult } from './openai.js';
import { getPrices, getNews } from '../cache.js';
import { buildNikkeiTechnical } from '../chatContext.js';
import { captureChartPng } from '../chart/chartShot.js';
import { resolvePort, resolveScalpTrendVetoYen, resolveScalpChartFallbackText, type SignalProfile } from '../configStore.js';
import { barsFor } from '../loops/alertLoop.js';
import { computeRegime, formatMomentumLine } from '../signalTrade/regime.js';
import { openDb, resolveDbPath, getRecentBars, getRecentAlerts, getSessionOHLC, getSignalTrades } from '../db/store.js';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';
import { buildScalpMarketData, buildScalpTradeHistory } from './scalpContext.js';

// 構造化データブロックに使う実 OHLC の取得窓(直近6時間ぶんの1分足)。
const RICH_BARS_WINDOW_MS = 6 * 60 * 60_000;

/** 構造化データ(数値主軸)＋自分の紙トレード成績を組み立てる(DB 読み・欠損は各ブロック省略)。
 *  DB/足/levels 不在(取引時間外など)は '' を返し、scalp-plan は従来どおり動く(壊さない)。 */
function buildRichScalpContext(symbol: string, currentPrice: number, now: number, profile?: SignalProfile): string {
  if (!(typeof currentPrice === 'number' && currentPrice > 0)) return '';
  try {
    const db = openDb(resolveDbPath());
    try {
      const bars = getRecentBars(db, symbol, now - RICH_BARS_WINDOW_MS);
      const levels = getLevelsSnapshot();
      const alerts = getRecentAlerts(db, 8);
      const session = getSessionOHLC(db, symbol, 1)[0] ?? null;
      // ★v0.8.2: 自系統の紙成績のみを文脈に入れる(A は 'A'=NULL含む / B は 'B')。
      //   A は自分の履歴だけを見る=B の紙トレードに汚染されない(=A の提案が B の存在で変わらない)。
      const trades = getSignalTrades(db, 30, profile === 'B' ? 'B' : 'A');
      const marketData = buildScalpMarketData({ bars, levels, alerts, now, currentPrice, session });
      const history = buildScalpTradeHistory(trades, now);
      return [marketData, history].filter(Boolean).join('\n\n');
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn('[scalp-plan] rich context 構築失敗(省略):', e instanceof Error ? e.message : String(e));
    return '';
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
  const symbol =
    typeof overrides.symbol === 'string' && overrides.symbol ? overrides.symbol : NIKKEI_SYMBOL;
  const prices = getPrices();
  const price = prices.find(p => p.symbol === symbol)?.price;

  // ── チャートビジョン + 逐次オンデマンドゲート(②生成→③確認→④戦略)。
  let chartImageDataUrl: string | null = null;
  const visionOn = chartVisionEnabled();
  const vision = visionOn ? firstAvailableVisionProvider() : null;
  if (visionOn && vision) {
    // ② 画像生成(オンデマンド新規撮影)。ws-error 等の一過性に備え、失敗したら1回だけ即リトライ(vision 回復狙い)。
    let shot = await captureChartPng(resolvePort());
    if (!shot.buffer) {
      console.warn(`[scalp-plan] vision: 画像生成失敗 → 1回リトライ reason=${shot.reason ?? 'unknown'}`);
      shot = await captureChartPng(resolvePort());
    }
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
  //   リアルタイム足は close のみ(o/h/l/c 無し)なので close を OHLC 全てに写像する(swing=close の高安)。
  const vetoYen = resolveScalpTrendVetoYen(overrides.profile);
  const ohlc = barsFor(symbol).map(b => ({ t: b.t, o: b.close, h: b.close, l: b.close, c: b.close }));
  const regime = computeRegime(ohlc, Date.now(), vetoYen > 0 ? vetoYen : 100);
  // 技術文脈の末尾に勢い1行を追記(バー不足でも算出可・null は「—」表示)。buildNikkeiTechnical が null でも注入する。
  const baseTech = buildNikkeiTechnical(undefined, price);
  // v0.7.54: 構造化データ(数値の足/節目/ボラ/スイング/アラート結果)＋自分の紙トレード成績を末尾に追記。
  //   DB/足/levels 欠損は '' で省略され、既存挙動(勢い1行+画像)を壊さない。★v0.8.2: 自系統(A/B)の履歴のみ。
  const rich = buildRichScalpContext(symbol, price ?? 0, Date.now(), overrides.profile);
  const technical = `${baseTech ? `${baseTech}\n` : ''}${formatMomentumLine(regime)}${rich ? `\n\n${rich}` : ''}`;
  // veto 無効(0)は trend を渡さない=現行挙動(veto なし)。>0 のときだけ {dir,strong} を渡してコード veto を効かせる。
  const trend = vetoYen > 0 ? { dir: regime.dir, strong: regime.strong } : undefined;

  // ④ 戦略作成。LC/バイアスは override が無ければ buildScalpPlan 内で monitor 設定を既定に使う。
  return buildScalpPlan({
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
  });
}
