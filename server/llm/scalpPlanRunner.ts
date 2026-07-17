import { buildScalpPlan, firstAvailableVisionProvider, type ScalpPlanResult } from './openai.js';
import { getPrices, getNews } from '../cache.js';
import { buildNikkeiTechnical } from '../chatContext.js';
import { captureChartPng } from '../chart/chartShot.js';
import { resolvePort, resolveScalpTrendVetoYen } from '../configStore.js';
import { barsFor } from '../loops/alertLoop.js';
import { computeRegime, formatMomentumLine } from '../signalTrade/regime.js';
import { openDb, resolveDbPath, getRecentBars, getRecentAlerts, getSessionOHLC, getSignalTrades } from '../db/store.js';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';
import { buildScalpMarketData, buildScalpTradeHistory } from './scalpContext.js';

// 構造化データブロックに使う実 OHLC の取得窓(直近6時間ぶんの1分足)。
const RICH_BARS_WINDOW_MS = 6 * 60 * 60_000;

/** 構造化データ(数値主軸)＋自分の紙トレード成績を組み立てる(DB 読み・欠損は各ブロック省略)。
 *  DB/足/levels 不在(取引時間外など)は '' を返し、scalp-plan は従来どおり動く(壊さない)。 */
function buildRichScalpContext(symbol: string, currentPrice: number, now: number): string {
  if (!(typeof currentPrice === 'number' && currentPrice > 0)) return '';
  try {
    const db = openDb(resolveDbPath());
    try {
      const bars = getRecentBars(db, symbol, now - RICH_BARS_WINDOW_MS);
      const levels = getLevelsSnapshot();
      const alerts = getRecentAlerts(db, 8);
      const session = getSessionOHLC(db, symbol, 1)[0] ?? null;
      const trades = getSignalTrades(db, 30);
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
    // ② 画像生成(オンデマンド新規撮影)。
    const shot = await captureChartPng(resolvePort());
    // ③ 画像生成確認。生成できなければ AI を一切呼ばず見送る(戦略を作らせない)。
    if (!shot.buffer) {
      console.log('[scalp-plan] vision: 画像生成できず → 見送り(AI呼ばない) reason=' + (shot.reason ?? 'unknown'));
      return { ok: false, error: 'chart-not-generated' };
    }
    // 画像あり → 添付して④戦略作成へ。
    chartImageDataUrl = `data:image/png;base64,${shot.buffer.toString('base64')}`;
    console.log(`[scalp-plan] vision: 画像生成OK (${(shot.buffer.length / 1024).toFixed(0)}kB) → 戦略作成 `
      + `provider=${vision.name}`);
  } else if (!visionOn) {
    console.log('[scalp-plan] vision: disabled (SCALP_CHART_VISION=0) → text-only');
  } else {
    console.log('[scalp-plan] vision: skip (no vision-capable provider available) → text-only');
  }

  // ── レジーム/勢いを1回だけ算出し、(a)技術文脈への注入 と (b)コードの trend veto の両方へ同じ値を渡す(一貫)。
  //   リアルタイム足は close のみ(o/h/l/c 無し)なので close を OHLC 全てに写像する(swing=close の高安)。
  const vetoYen = resolveScalpTrendVetoYen();
  const ohlc = barsFor(symbol).map(b => ({ t: b.t, o: b.close, h: b.close, l: b.close, c: b.close }));
  const regime = computeRegime(ohlc, Date.now(), vetoYen > 0 ? vetoYen : 100);
  // 技術文脈の末尾に勢い1行を追記(バー不足でも算出可・null は「—」表示)。buildNikkeiTechnical が null でも注入する。
  const baseTech = buildNikkeiTechnical(undefined, price);
  // v0.7.54: 構造化データ(数値の足/節目/ボラ/スイング/アラート結果)＋自分の紙トレード成績を末尾に追記。
  //   DB/足/levels 欠損は '' で省略され、既存挙動(勢い1行+画像)を壊さない。
  const rich = buildRichScalpContext(symbol, price ?? 0, Date.now());
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
  });
}
