import type { Request, Response } from 'express';
import { buildScalpPlan, firstAvailableVisionProvider } from '../llm/openai.js';
import { getPrices, getNews } from '../cache.js';
import { buildNikkeiTechnical } from '../chatContext.js';
import { captureChartPng } from '../chart/chartShot.js';
import { resolvePort } from '../configStore.js';

// 兄弟アプリ jp225-trade2(AI トレーダー)向け。monitor の LLM を固定のスキャル戦略質問で走らせ、
// buildMonitorContext + データツール + 既存プロバイダ/キーを再利用して構造化プラン(AiPlan)を返す。
// v0.7.22: ビジョン対応プロバイダ(Gemini/OpenAI)時は当日チャートのスクリーンショットを添付し、
// AI が「実際にチャートを見て」方向・指値/逆指値を決められるようにする。
//
// 逐次オンデマンドゲート(ユーザー指定の厳密順序 ①建玉なし確認[trade2]→②画像生成→③画像生成確認→④戦略作成):
//   チャートを使う設定(vision 対応プロバイダあり かつ SCALP_CHART_VISION 有効)の時は、
//   このリクエスト内で②新規撮影→③生成確認を行い、③で画像が生成できなければ AI を一切呼ばず見送る。
//   画像が生成できた時だけ④ buildScalpPlan を呼ぶ(「生成→確認→(OKなら)戦略」)。
//   一方「チャートを使わない設定」(vision プロバイダ無し / SCALP_CHART_VISION 無効)はゲート対象外=
//   従来どおり画像なしテキストのみで判断する(既存エンドポイントを決して壊さない)。

const NIKKEI_SYMBOL = 'NIY=F';

interface Body {
  symbol?: string;
  /** 初期 LC(損切り)幅の下限[円]。未指定は buildScalpPlan 側の既定(45)。数値化して optional で受理する。 */
  lcFloorYen?: number;
  /** 初期 LC(損切り)幅の上限[円]。未指定は buildScalpPlan 側の既定(65)。これを超える損切りは出さない。 */
  lcCeilingYen?: number;
}

/** body/query から数値を optional に受理する(文字列でも数値化)。非有限は undefined を返し、既定に委ねる。
 *  範囲/floor<=ceiling のクランプは buildScalpPlan 側 resolveLcRange が担う(単一責務)。 */
function optionalNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** チャートビジョンを無効化する env(既定は有効)。SCALP_CHART_VISION=0/false でオフ。 */
function chartVisionEnabled(): boolean {
  const v = process.env.SCALP_CHART_VISION;
  if (v === undefined) return true;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

export async function scalpPlanHandler(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Body;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const symbol = typeof body.symbol === 'string' && body.symbol ? body.symbol : NIKKEI_SYMBOL;
  // 初期 LC 幅の下限/上限を optional で受理(body 優先・なければ query)。範囲/整合クランプは buildScalpPlan 側。
  const lcFloorYen = optionalNumber(body.lcFloorYen ?? query.lcFloorYen);
  const lcCeilingYen = optionalNumber(body.lcCeilingYen ?? query.lcCeilingYen);
  try {
    const prices = getPrices();
    const price = prices.find(p => p.symbol === symbol)?.price;

    // ── チャートビジョン + 逐次オンデマンドゲート(②生成→③確認→④戦略)。
    // チャートを使う設定(vision 対応プロバイダあり かつ SCALP_CHART_VISION 有効)の時だけゲートをかける。
    let chartImageDataUrl: string | null = null;
    const visionOn = chartVisionEnabled();
    const vision = visionOn ? firstAvailableVisionProvider() : null;
    if (visionOn && vision) {
      // ② 画像生成(オンデマンド新規撮影)。captureChartPng 内の saveShotToDesktop が
      //    最新1枚を Desktop(kabu- 機なら C:\Users\kabu-\Desktop\jp225-chart-shot.png)へ上書き保存する。
      const shot = await captureChartPng(resolvePort());
      // ③ 画像生成確認。生成できなければ AI を一切呼ばず見送る(戦略を作らせない)。
      if (!shot.buffer) {
        console.log('[scalp-plan] vision: 画像生成できず → 見送り(AI呼ばない) reason=' + (shot.reason ?? 'unknown'));
        res.json({ ok: false, error: 'chart-not-generated' });
        return;
      }
      // 画像あり → 添付して④戦略作成へ。
      chartImageDataUrl = `data:image/png;base64,${shot.buffer.toString('base64')}`;
      console.log(`[scalp-plan] vision: 画像生成OK (${(shot.buffer.length / 1024).toFixed(0)}kB) → 戦略作成 `
        + `provider=${vision.name}`);
    } else if (!visionOn) {
      // チャートを使わない設定(明示的に無効)→ ゲート対象外。テキストのみで判断。
      console.log('[scalp-plan] vision: disabled (SCALP_CHART_VISION=0) → text-only');
    } else {
      // vision 対応プロバイダが無い → ゲート対象外。テキストのみで判断。
      console.log('[scalp-plan] vision: skip (no vision-capable provider available) → text-only');
    }

    // ④ 戦略作成。
    const result = await buildScalpPlan({
      symbol,
      prices,
      news: getNews(),
      // chat と同じく、バー蓄積中でも節目メドを出せるよう fallbackPrice を渡す。
      technical: buildNikkeiTechnical(undefined, price),
      chartImageDataUrl,
      lcFloorYen,
      lcCeilingYen,
    });
    if (result.ok) {
      res.json({ ok: true, plan: result.plan });
    } else {
      // キー無し/パース失敗/LLM 失敗は 200 + ok:false で返す(キーは決して漏らさない)。
      res.json({ ok: false, error: result.error });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scalp-plan] error:', msg);
    res.status(500).json({ ok: false, error: msg.slice(0, 200) });
  }
}
