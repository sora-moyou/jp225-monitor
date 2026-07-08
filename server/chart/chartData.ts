// スクリーンショット用チャートページに埋め込むデータスナップショットの組立(純粋・テスト可能)。
// DB から「当日セッションの1分足 + 主要水準 + 直近アラートマーカー」を読み、描画に必要な最小形へ整形する。
// LLM 非依存・localhost 診断用途。値が欠けても例外を投げず、出せるものだけ返す。

import type { DatabaseSync } from 'node:sqlite';
import { getRecentBars, getRecentAlerts, type AlertRow } from '../db/store.js';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';
import type { LevelsResult } from '../levels.js';

const SYMBOL = 'NIY=F';
// 描画対象の足の窓(直近~この分数)。当日セッションを十分カバーしつつ描画を軽く保つ。
const BARS_WINDOW_MIN = 24 * 60;   // 直近24時間(=当日Day/Night をカバー)
const MAX_BARS = 600;              // 描画本数上限(1280px 幅に対して十分)
const MAX_LEVELS = 12;             // 上下合わせて描く水準数の上限
const ALERTS_WINDOW_MIN = 6 * 60;  // 直近6時間のアラートをマーカー表示
const MAX_ALERTS = 20;

export interface ChartCandle { t: number; o: number; h: number; l: number; c: number; }
export interface ChartLevel { price: number; label: string; side: 'up' | 'down'; tier: number; }
export interface ChartMarker { t: number; price: number | null; direction: 'up' | 'down' | null; kind: string; text: string; }
export interface ChartSnapshot {
  symbol: string;
  symbolLabel: string;
  asOf: number;
  current: number;
  candles: ChartCandle[];
  levels: ChartLevel[];
  markers: ChartMarker[];
  barCount: number;
  range: { from: number; to: number } | null;   // 足の時間範囲(ログ用)
}

/** LevelsResult から描画用の水準配列へ。tier 降順で上下それぞれ選抜し、合計 MAX_LEVELS 本に収める。 */
export function levelsToChart(levels: LevelsResult): ChartLevel[] {
  const pick = (arr: LevelsResult['up'], side: 'up' | 'down'): ChartLevel[] =>
    [...arr]
      .sort((a, b) => b.tier - a.tier || b.score - a.score)
      .map(l => ({ price: l.price, label: l.labels[0] ?? '水準', side, tier: l.tier }));
  const up = pick(levels.up, 'up');
  const down = pick(levels.down, 'down');
  const half = Math.floor(MAX_LEVELS / 2);
  // 上下均等に選抜(片側が少ないともう片側で埋める)。
  const upN = Math.min(up.length, Math.max(half, MAX_LEVELS - down.length));
  const downN = Math.min(down.length, MAX_LEVELS - upN);
  return [...up.slice(0, upN), ...down.slice(0, downN)];
}

/** AlertRow[] を描画用マーカーへ(直近 windowMin 分・最大 MAX_ALERTS 件)。 */
export function alertsToMarkers(rows: AlertRow[], now: number, windowMin = ALERTS_WINDOW_MIN): ChartMarker[] {
  const cutoff = now - windowMin * 60_000;
  return rows
    .filter(a => a.triggered_at >= cutoff)
    .slice(0, MAX_ALERTS)
    .map(a => ({
      t: a.triggered_at,
      price: a.price ?? a.reference_price ?? null,
      direction: a.direction === 'up' || a.direction === 'down' ? a.direction : null,
      kind: a.detection_kind ?? '',
      text: `${a.detection_kind ?? ''}`,
    }));
}

/** 1分足を最大 MAX_BARS 本へ間引き(先頭を落として直近優先)。窓は直近 BARS_WINDOW_MIN 分。 */
function selectCandles(bars: { t: number; o: number; h: number; l: number; c: number }[]): ChartCandle[] {
  const trimmed = bars.length > MAX_BARS ? bars.slice(bars.length - MAX_BARS) : bars;
  return trimmed.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));
}

/** DB からスクショ用スナップショットを組み立てる。DB 読みは try で保護し、失敗しても空配列で返す。 */
export function buildChartSnapshot(db: DatabaseSync, now = Date.now()): ChartSnapshot {
  let candles: ChartCandle[] = [];
  try {
    const bars = getRecentBars(db, SYMBOL, now - BARS_WINDOW_MIN * 60_000);
    candles = selectCandles(bars);
  } catch { /* 足なしは空で続行 */ }

  let levels: ChartLevel[] = [];
  let current = 0;
  let asOf = now;
  try {
    const snap = getLevelsSnapshot();
    levels = levelsToChart(snap);
    current = snap.current || 0;
    asOf = snap.asOf || now;
  } catch { /* 水準なしは空で続行 */ }

  let markers: ChartMarker[] = [];
  try {
    markers = alertsToMarkers(getRecentAlerts(db, Math.max(MAX_ALERTS, 50)), now);
  } catch { /* アラートなしは空で続行 */ }

  // current が水準スナップから取れない時は最終足の終値で代替。
  if (!(current > 0) && candles.length > 0) current = candles[candles.length - 1]!.c;

  const range = candles.length > 0
    ? { from: candles[0]!.t, to: candles[candles.length - 1]!.t }
    : null;

  return {
    symbol: SYMBOL,
    symbolLabel: '日経225先物',
    asOf,
    current,
    candles,
    levels,
    markers,
    barCount: candles.length,
    range,
  };
}
