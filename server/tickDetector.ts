import type { Price } from './types.js';
import { computeContext, type AlertEvent } from './alertDetector.js';
import { getCachedBars } from './loops/alertLoop.js';
import { emitAlert } from './alertHistory.js';
import { INSTRUMENTS } from './config.js';
import { resolveFlashYen } from './configStore.js';

// v0.3.17: 超短期 (5s/10s) フラッシュ検知。NIY=F (日経 225) 専用。
// v0.3.33: 価格がリアルタイム取得できるようになったので「値幅(円)」ベースに変更 (ユーザ要望)。
// 5〜10 秒窓で |値幅| >= flashYen(円・config 即反映) で発火。率ではなく円なので、ボード表示
// (超短期=+50円) と発火基準の単位が一致する。バッファは短期検知のローリング窓にも使うため拡大。

const TARGETS = new Set(['NIY=F']);
const BUFFER_MS = 6 * 60 * 1000;          // 6 min 保持 (超短期5/10s + 短期ローリング60s/5分の両用)

interface Tick { t: number; price: number; }
const buffers = new Map<string, Tick[]>();

function findBaselinePrice(buf: Tick[], targetT: number): Tick | null {
  // buf は昇順時刻、targetT 以下で最大の t を持つエントリを返す (≒ 5s/10s 前のサンプル)
  let candidate: Tick | null = null;
  for (const t of buf) {
    if (t.t <= targetT) candidate = t;
    else break;
  }
  return candidate;
}

export function feedPrice(prices: Price[]): void {
  for (const price of prices) {
    if (!TARGETS.has(price.symbol)) continue;
    if (price.stale) continue;
    handleOne(price);
  }
}

function handleOne(price: Price): void {
  const now = price.timestamp;
  let buf = buffers.get(price.symbol) ?? [];
  buf.push({ t: now, price: price.price });
  const cutoff = now - BUFFER_MS;
  buf = buf.filter(t => t.t >= cutoff);
  buffers.set(price.symbol, buf);

  if (buf.length < 3) return;

  const threshold = resolveFlashYen();      // 5〜10秒で threshold円 以上の値幅で発火 (要調整ノブ・即反映)
  // 5s と 10s 双方を評価、より大きい |値幅(円)| を採用
  const candidates: { window: number; ret: number; yen: number }[] = [];
  for (const win of [5, 10]) {
    const baseline = findBaselinePrice(buf, now - win * 1000);
    if (!baseline || baseline.price <= 0) continue;
    if (baseline.t === now) continue;       // 同一サンプル
    const yen = price.price - baseline.price;
    const ret = yen / baseline.price;
    if (Math.abs(yen) >= threshold) candidates.push({ window: win, ret, yen });
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => Math.abs(b.yen) - Math.abs(a.yen));
  const fired = candidates[0]!;
  // 超短期はクールダウンを完全無視(常に発火・ユーザー指定):自身はブロックされず、共有クールダウンも
  // 発生させない(クールダウンシグナルを出すのは急変のみ)。
  const bars = getCachedBars(price.symbol);
  const ctx = computeContext(bars);
  const meta = INSTRUMENTS.find(i => i.symbol === price.symbol);
  const alert: AlertEvent = {
    symbol: price.symbol,
    symbolLabel: (meta?.labelJa ?? price.symbol),
    changePercent: fired.ret * 100,
    windowSeconds: fired.window,
    detectionKind: 'slope',
    direction: fired.ret >= 0 ? 'up' : 'down',
    triggeredAt: now,
    change15min: ctx.change15min,
    pa15min: ctx.pa15min,
    range1h: ctx.range1h,
    zscore: 0,    // 絶対閾値方式のため未使用 (alertLoop の z-score 検知と区別)
    // 表示は価格を先頭に。価格=動きの起点(baseline=現値−値幅)。方向は「急上昇/急落」、値幅は符号付き(円)。
    // 「超短期/フラッシュ」の語は使わない。
    note: `${Math.round(price.price - fired.yen).toLocaleString('ja-JP')} ${fired.yen >= 0 ? '急上昇' : '急落'} / ${fired.yen >= 0 ? '+' : ''}${Math.round(fired.yen)}円（${fired.window}秒）`,
  };
  console.log(`[tickDetector] ${price.symbol} ${fired.window}s ${fired.yen >= 0 ? '+' : ''}${Math.round(fired.yen)}円 (threshold ${threshold}円)`);
  emitAlert(alert);
}

// v0.3.33/34: 価格ボード表示用。NIY=F の直近の動きを期間固定で返す。
//   ultraShortYen = 超短期(10秒窓の値幅・円) … カードのラベル「10秒」に対応
//   shortPct      = 短期(60秒窓の変化率 %)   … カードのラベル「1分」に対応
// 既存の tick バッファを再利用。窓に十分なサンプルが無ければ各値 null。
export function getMomentum(symbol: string = 'NIY=F'): { ultraShortYen: number | null; shortPct: number | null } | null {
  const buf = buffers.get(symbol);
  if (!buf || buf.length < 2) return null;
  const last = buf[buf.length - 1]!;
  const now = last.t, cur = last.price;
  const base10 = findBaselinePrice(buf, now - 10_000);
  const ultraShortYen = base10 && base10.t !== now ? cur - base10.price : null;
  const base60 = findBaselinePrice(buf, now - 60_000);
  const shortPct = base60 && base60.price > 0 && base60.t !== now
    ? ((cur - base60.price) / base60.price) * 100
    : null;
  return { ultraShortYen, shortPct };
}

/** DB ウォームアップ用。NIY=F の tick バッファを種付け。既存があれば上書きしない。 */
export function seedBuffer(symbol: string, ticks: Tick[]): void {
  if (ticks.length === 0) return;
  if ((buffers.get(symbol)?.length ?? 0) > 0) return;
  buffers.set(symbol, ticks.map(t => ({ t: t.t, price: t.price })));
}

// テスト用
export function _reset(): void { buffers.clear(); }
