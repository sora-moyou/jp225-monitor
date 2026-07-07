import { io, type Socket } from 'socket.io-client';
import type { Price, Symbol } from '../types.js';
import { parseAjaxTop } from './nikkei225jpFeed.js';

// nikkei225jp.com の socket.io ストリーム(wss2.nikkei225jp.com, node=ch225)から、日経以外の
// リアルタイム価格(NASDAQ100/ダウ/香港ハンセン/WTI原油/米10年債/ドル円)を取得する。
//
// v0.7.18: NIY=F(OSE mini日経)は ajax_cme.js(HTTP・code 136)経由(priceLoop)に移行し、この socket は
// **副銘柄専用**になった。よって NIY=F 用に積んでいた凝った鮮度維持機構(先回り make-before-break 再接続 /
// tsMs 遅延ドリフト再接続 / 各種ルーチンログ)を撤去し、socket を最小限へ簡素化する:
//   - connect + socket.io の透過再接続(reconnection:true)
//   - 「完全沈黙(TICK_WATCHDOG_MS 無 tick)」時のみ強制フル再接続する no-tick watchdog
//   - 通常運転では **一切ログを出さない**(接続エラー/起動失敗のみ warn)
// tsMs ベースの鮮度判定(isStale/buildSocketPrices)は、副銘柄の表示 fresh/stale フラグに引き続き必要なので残す。
//
// 設計: socket I/O は薄く、パース/鮮度判定は純関数(parseTick / isStale / buildSocketPrices)へ分離して
// ネットワーク無しで単体テスト可能にする。socket エラーはアプリへ throw しない。

const SOCKET_URL = 'wss://wss2.nikkei225jp.com';
const SOCKET_ORIGIN = 'https://225225.jp';
/** 無 tick でこの時間経過した銘柄は stale(取得不能)扱い。 */
export const SOCKET_STALE_MS = 30_000;

// 実測でリアルタイムを確認したコード → アプリ Symbol。nikkei225jpFeed の SYMBOL_CODES と同一。
//   136 OSE mini日経 / 737 NAS100 CFD / 731 ダウCFD / 733 香港ハンセン / 921 WTI原油 / 811 米10年債 / 511 ドル円
// 注: 136(NIY=F)も従来どおり受けてキャッシュするが、priceLoop の主経路は ajax_cme(HTTP)。
export const SOCKET_CODE_SYMBOL: ReadonlyMap<string, Symbol> = new Map<string, Symbol>([
  ['136', 'NIY=F'],
  ['737', 'NQ=F'],
  ['731', 'YM=F'],
  ['733', '^HSI'],
  ['921', 'CL=F'],
  ['811', '^TNX'],
  ['511', 'JPY=X'],
]);

/** socket が保持する銘柄別の最新値。price/timestamp は tick 由来、changePercent は priceT 由来。 */
export interface SocketQuote {
  price: number;
  timestamp: number;      // tick の実 epoch-ms(真のリアルタイム)
  changePercent: number;  // 直近 priceT の騰落率(無ければ 0)
}

// ── 純関数(テスト対象) ──────────────────────────────────────────────

/**
 * tick イベント配列 `[code, timestampMs, price]`(全て文字列)を解釈する。
 * 対象コード外/壊れた値は null。timestamp・price は Number 化し有限・正のみ採用。
 */
export function parseTick(arr: unknown): { symbol: Symbol; price: number; timestamp: number } | null {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const [codeRaw, tsRaw, priceRaw] = arr as unknown[];
  const code = String(codeRaw);
  const symbol = SOCKET_CODE_SYMBOL.get(code);
  if (!symbol) return null;   // 対象外コード(732 FTSE / 1001 BTC 等)は無視。
  const timestamp = Number(tsRaw);
  const price = Number(priceRaw);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  return { symbol, price, timestamp };
}

/**
 * priceT バッチ文字列(`A[code]="price_chg_pctchg_HH:MM_flag_high_low";`)から
 * 対象コードの騰落率 changePercent を取り出す(code→pct)。price/timestamp は tick を正とするため使わない。
 */
export function parsePriceTChangePercent(text: string): Map<Symbol, number> {
  const out = new Map<Symbol, number>();
  const map = parseAjaxTop(text);
  for (const [code, symbol] of SOCKET_CODE_SYMBOL) {
    const fields = map.get(code);
    if (!fields) continue;
    const pct = Number(fields[2]);
    if (Number.isFinite(pct)) out.set(symbol, pct);
  }
  return out;
}

/** その quote が stale か(未受信=引数 undefined も stale)。now − timestamp > SOCKET_STALE_MS で stale。 */
export function isStale(quote: SocketQuote | undefined, now: number, staleMs: number = SOCKET_STALE_MS): boolean {
  if (!quote) return true;
  return now - quote.timestamp > staleMs;
}

/**
 * latest マップ → Price[]。各対象銘柄について、鮮度を now で判定して stale フラグを立てる。
 * priceLoop はこの結果を mergeSources へ渡す(副銘柄は feed 優先・stale なら Yahoo フォールバック)。
 * NIY=F は priceLoop 側の実弾安全ルール(v0.7.9)で Yahoo に埋められない扱いだが、価格の主経路は ajax_cme。
 */
export function buildSocketPrices(latest: ReadonlyMap<Symbol, SocketQuote>, now: number, staleMs: number = SOCKET_STALE_MS): Price[] {
  const out: Price[] = [];
  for (const symbol of SOCKET_CODE_SYMBOL.values()) {
    const q = latest.get(symbol);
    if (!q) continue;   // 未受信は返さない(存在しないものは持ち越しに任せる)。
    out.push({
      symbol,
      price: q.price,
      changePercent: q.changePercent,
      timestamp: q.timestamp,   // tick の実 epoch-ms(真のリアルタイム)。
      stale: isStale(q, now, staleMs),
    });
  }
  return out;
}

// ── socket シングルトン(薄い I/O 層) ──────────────────────────────────

/** no-tick watchdog: connected でも tick がこの時間途絶したら「半死(half-dead)」とみなし強制再接続する。
 *  socket.io の透過再接続(reconnection:true)は「transport は生きているが tick が来ない」半死状態からは
 *  復帰しないことがあるため、最低限の liveness 保険として残す。30s の SOCKET_STALE_MS より十分長くして
 *  「市場が静か」での誤再接続 churn を避ける。 */
export const TICK_WATCHDOG_MS = 75_000;
/** watchdog の点検間隔。 */
export const TICK_WATCHDOG_CHECK_MS = 15_000;

/** socket.io の接続を生成するシーム(テストで差し替え可能)。既定は本物の io(...)。 */
export type SocketConnector = () => Socket;
const defaultConnector: SocketConnector = () =>
  io(SOCKET_URL, {
    path: '/socket.io/',
    query: { node: 'ch225' },
    transports: ['websocket', 'polling'],
    reconnection: true,
    extraHeaders: { Origin: SOCKET_ORIGIN },
  });

const latest = new Map<Symbol, SocketQuote>();
let socket: Socket | null = null;
let connected = false;
let connector: SocketConnector = defaultConnector;
let lastTickAt = 0;          // 直近に有効な tick を受けた時刻(0=未受信)。watchdog の鮮度基準。
let watchdogTimer: NodeJS.Timeout | null = null;
let reconnecting = false;    // 強制再接続の多重発火ガード(タイマ/ソケットを積み上げない)。

/** tick を latest へ反映(純 parseTick を使用)。changePercent は既存 quote から引き継ぐ。 */
function applyTick(arr: unknown): void {
  const t = parseTick(arr);
  if (!t) return;
  const prev = latest.get(t.symbol);
  latest.set(t.symbol, { price: t.price, timestamp: t.timestamp, changePercent: prev?.changePercent ?? 0 });
  lastTickAt = Date.now();   // watchdog 用に「有効 tick を受けた壁時計時刻」を更新。
}

/** priceT を latest の changePercent へ反映(price/timestamp は tick を正とするため触らない)。 */
function applyPriceT(text: unknown): void {
  if (typeof text !== 'string') return;
  const pcts = parsePriceTChangePercent(text);
  for (const [symbol, pct] of pcts) {
    const prev = latest.get(symbol);
    if (prev) latest.set(symbol, { ...prev, changePercent: pct });
    // まだ tick 未受信の銘柄は price/timestamp が無いので保留(次の tick で載る)。
  }
}

/** connector で socket を作りリスナを張る(startSocket と forceReconnect で共有)。
 *  通常運転はサイレント(connect/disconnect/reconnect はログしない)。connect_error のみ warn。 */
function createSocket(): void {
  socket = connector();
  socket.on('connect', () => { connected = true; });
  socket.on('disconnect', () => { connected = false; });
  socket.on('connect_error', (err: Error) => {
    connected = false;
    console.warn(`[nikkei225jpSocket] connect_error: ${err.message}`);
  });
  socket.on('tick', (arr: unknown) => applyTick(arr));
  socket.on('priceT', (text: unknown) => applyPriceT(text));
  // 'reconnect' / 'server' 等その他イベントは無視(ログもしない)。
}

/** no-tick watchdog が半死(tick 途絶)を検知したときの強制フル再接続。透過再接続では tick が戻らない
 *  ことがあるため、現ソケットを完全に破棄して io(...) から作り直す。多重発火は reconnecting ガードで防ぐ。 */
function forceReconnect(): void {
  if (reconnecting) return;   // 進行中の再接続にタイマ/ソケットを積み上げない。
  reconnecting = true;
  try {
    if (socket) { socket.removeAllListeners(); socket.disconnect(); }
  } catch { /* noop */ }
  socket = null;
  connected = false;
  try { createSocket(); } catch (err) {
    console.warn(`[nikkei225jpSocket] reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  reconnecting = false;
}

/** watchdog: connected の間、直近 tick 到着が TICK_WATCHDOG_MS を超えた(完全沈黙=半死/停止)なら
 *  強制フル再接続する。disconnected 中は socket.io の透過再接続に任せる。 */
function watchdogCheck(): void {
  if (!connected) return;          // 切断中は透過再接続に任せる(接続の張り直しはしない)。
  if (lastTickAt === 0) return;    // まだ一度も tick が無い(起動直後)。誤発火しない。
  if (Date.now() - lastTickAt > TICK_WATCHDOG_MS) forceReconnect();
}

/** socket を起動(冪等)。socket.io 透過再接続 + no-tick watchdog で tick 途絶からも復帰する。
 *  エラーは throw しない。テスト用に connector を注入できる。 */
export function startSocket(conn?: SocketConnector): void {
  if (socket) return;   // 二重起動ガード。
  connector = conn ?? defaultConnector;
  try {
    createSocket();
  } catch (err) {
    console.warn(`[nikkei225jpSocket] start failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // watchdog を1本だけ張る(冪等)。stopSocket でクリアする。
  if (!watchdogTimer) watchdogTimer = setInterval(watchdogCheck, TICK_WATCHDOG_CHECK_MS);
}

/** socket を停止(冪等)。プロセス終了時に呼ぶ。watchdog も止める。 */
export function stopSocket(): void {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  reconnecting = false;
  lastTickAt = 0;
  connector = defaultConnector;
  if (!socket) { connected = false; return; }
  try { socket.removeAllListeners(); socket.disconnect(); } catch { /* noop */ }
  socket = null;
  connected = false;
}

/** priceLoop が毎ポール読む: 現在の socket キャッシュのスナップショットを Price[] で返す。 */
export function getSocketPrices(now: number): Price[] {
  return buildSocketPrices(latest, now);
}

/** 診断/UI 用: 接続状態と最も新しい tick の年齢(ms)。 */
export function getSocketStatus(now: number = Date.now()): { connected: boolean; lastTickAgeMs: number | null } {
  let newest = -Infinity;
  for (const q of latest.values()) if (q.timestamp > newest) newest = q.timestamp;
  return { connected, lastTickAgeMs: Number.isFinite(newest) ? now - newest : null };
}

/** テスト用: latest キャッシュへ直接注入(socket を張らずに buildSocketPrices 経路を検証する)。 */
export function _setLatestForTest(symbol: Symbol, quote: SocketQuote): void {
  latest.set(symbol, quote);
}
/** テスト用: latest をクリア。 */
export function _clearLatestForTest(): void {
  latest.clear();
}
/** テスト用: watchdog の1回分の点検を直接駆動する(setInterval を待たずに検証する)。 */
export function _runWatchdogForTest(): void {
  watchdogCheck();
}
/** テスト用: connected と直近 tick 時刻を注入して watchdog の分岐を検証する。 */
export function _setConnStateForTest(isConnected: boolean, tickAt: number): void {
  connected = isConnected;
  lastTickAt = tickAt;
}
/** テスト用: watchdog interval が張られているか。 */
export function _hasWatchdogForTest(): boolean {
  return watchdogTimer !== null;
}
