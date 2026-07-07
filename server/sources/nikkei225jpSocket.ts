import { io, type Socket } from 'socket.io-client';
import type { Price, Symbol } from '../types.js';
import { parseAjaxTop } from './nikkei225jpFeed.js';

// v0.8(実弾ルート修正): 大阪取引所(OSE)日経225先物mini(NIY=F)のリアルタイム価格を、
// nikkei225jp.com の socket.io ストリーム(wss2.nikkei225jp.com, node=ch225)から取得する。
//
// 背景: 従来主経路の HTTP ポーリング(ajax_TOP.js)は停止し、priceLoop が Yahoo(CME・約10分
// ディレイ)へ静かにフォールバック → ボットが約10分古い価格で発注し実損した。socket は接続するだけで
// tick が push され、tick の timestamp は実 epoch-ms(≈wall-clock=真のリアルタイム)。この実 timestamp が
// NIY=F に流れることで、下流ボットの遅延ガードが本物のラグを見られる。
//
// 設計: socket I/O は薄く、パース/鮮度判定は純関数(parseTick / isStale / buildSocketPrices)へ分離して
// ネットワーク無しで単体テスト可能にする。socket エラーはアプリへ throw せず、状態変化時に1回だけログする。

const SOCKET_URL = 'wss://wss2.nikkei225jp.com';
const SOCKET_ORIGIN = 'https://225225.jp';
/** 無 tick でこの時間経過した銘柄は stale(取得不能)扱い。priceLoop はこれを Yahoo で埋めない。 */
export const SOCKET_STALE_MS = 30_000;

// 実測でリアルタイムを確認したコード → アプリ Symbol。nikkei225jpFeed の SYMBOL_CODES と同一。
//   136 OSE mini日経 / 737 NAS100 CFD / 731 ダウCFD / 733 香港ハンセン / 921 WTI原油 / 811 米10年債 / 511 ドル円
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
 * priceLoop はこの結果を mergeSources へ渡す。stale=true の NIY=F は下流で Yahoo に埋められず、
 * 前回値を古い timestamp のまま持ち越す(v0.7.9 ルール)。
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

/** watchdog: connected でも tick がこの時間途絶したら「半死(half-dead)」とみなし強制再接続する。
 *  socket.io の透過再接続(reconnection:true)は「transport は生きているが tick が来ない」半死状態や
 *  上流の code 136 配信停止からは復帰しない(2026-07-07 の NIY=F 恒久 stale 事故の実因)。
 *  30s の SOCKET_STALE_MS より十分長くして「市場が静か」での誤再接続 churn を避ける。 */
export const TICK_WATCHDOG_MS = 75_000;
/** watchdog の点検間隔。 */
export const TICK_WATCHDOG_CHECK_MS = 15_000;

/** primary symbol(NIY=F/code 136)の tick timestamp 遅延(now − tick.tsMs)がこれを超える tick が
 *  「届き続けている」なら、接続は生きているが**価格値そのものが遅延した半死セッション**とみなす。
 *  実測(2026-07-07): 起動直後は real-time(lag 数秒)→ 時間経過で同一 socket の**価格値が約10分遅延**へ
 *  ドリフト(225225.jp の実ソースから乖離)→ tsMs もそれに連れて古くなる。再接続(=新規接続)で real-time に
 *  復帰する。real-time は数秒・ドリフト後は数百秒なので 90s は両者を明確に分離する。 */
export const TICK_STALE_LAG_MS = 90_000;
/** stale-lag の一発ノイズで再接続しないため、この回数連続で lag 超過を観測してから強制再接続する。 */
export const TICK_STALE_LAG_STREAK = 2;
/** 強制再接続後の grace(この間は lag 再評価を skip)。新セッションの fresh tick 到着を待つ。
 *  さらに「前回の強制再接続からこの時間が経つまでは次を撃たない」min-interval も兼ねる(rapid thrash 防止)。
 *  v0.7.14: give-up cap を撤去し「ドリフトするたびに何度でも再接続」する方針にしたので、暴走しないよう
 *  この最小間隔だけで抑制する(絶対的な打ち止めはしない=起動直後は必ず real-time に戻るため)。 */
export const RECONNECT_GRACE_MS = 25_000;

/** v0.7.15: 先回り(proactive)再接続の周期。実測(2026-07-07): socket は「初回接続直後は必ず real-time」で、
 *  長時間つなぎ続けた**そのマシンの長寿命セッションだけ**が約10分遅延へ劣化する(私の4分接続は lag 3-12s で劣化せず)。
 *  よって劣化を待って反応(case B)する前に、一定周期で**新しい接続に差し替え続けて常に「初回接続」状態**を保つ。
 *  make-before-break(新 socket が最初の tick を出してから旧 socket を閉じる)でギャップ0にする。 */
export const PROACTIVE_RECONNECT_MS = 60_000;
/** make-before-break で新 socket が「最初の tick を出す」までの猶予。これを過ぎたら新 socket を捨てて旧を維持し、
 *  次周期で再挑戦する(=決して「socket 無し」状態にしない)。 */
export const MAKE_BEFORE_BREAK_TIMEOUT_MS = 10_000;

/** primary(NIY=F)の tick timestamp 遅延を測る対象コード。 */
const PRIMARY_SYMBOL: Symbol = 'NIY=F';

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
let lastLoggedState: string | null = null;
let connector: SocketConnector = defaultConnector;
let lastTickAt = 0;          // 直近に有効な tick を受けた時刻(0=未受信)。watchdog の鮮度基準。
let watchdogTimer: NodeJS.Timeout | null = null;
let reconnecting = false;    // 強制再接続の多重発火ガード(タイマ/ソケットを積み上げない)。
// ── proactive make-before-break(v0.7.15) ──
let proactiveTimer: NodeJS.Timeout | null = null;   // 一定周期で make-before-break を開始するタイマ。
let socketNext: Socket | null = null;               // 差し替え候補の新 socket(旧 socket と並行接続中)。
let swapping = false;                                // make-before-break 進行中フラグ(周期の多重発火ガード)。
let mbbTimeoutTimer: NodeJS.Timeout | null = null;   // 新 socket が tick を出さないときの打ち切りタイマ。
// ── stale-timestamp watchdog(半死セッション: 届き続けるが価格値=tsMs が古い) ──
let primaryLagMs: number | null = null;   // 直近 primary(NIY=F) tick の timestamp 遅延(now − tsMs)。null=未観測。
let primaryLagAt = 0;                      // その lag を観測した壁時計時刻(古い lag を再利用しないため)。
let staleLagStreak = 0;                    // 連続で lag 超過を観測した watchdog 回数(ノイズ耐性)。
let lastForceReconnectAt = 0;             // 直近に強制再接続した時刻(grace / min-interval 判定)。
// v0.7.14: give-up cap(staleLagReconnects / MAX_STALE_LAG_RECONNECTS)は撤去。ドリフトは繰り返し起き、
// 再接続は毎回 real-time を復元する(起動直後は必ず real-time)ので、打ち止めせず何度でも張り直す。
// 暴走は RECONNECT_GRACE_MS の min-interval だけで抑える。

function logState(state: string, detail?: string): void {
  if (lastLoggedState === state) return;   // 状態変化時のみ1回ログ(スパム防止)。
  lastLoggedState = state;
  console.log(`[nikkei225jpSocket] ${state}${detail ? `: ${detail}` : ''}`);
}

/** tick を latest へ反映(純 parseTick を使用)。changePercent は既存 quote から引き継ぐ。 */
function applyTick(arr: unknown): void {
  const t = parseTick(arr);
  if (!t) return;
  const prev = latest.get(t.symbol);
  latest.set(t.symbol, { price: t.price, timestamp: t.timestamp, changePercent: prev?.changePercent ?? 0 });
  const now = Date.now();
  lastTickAt = now;   // watchdog 用に「有効 tick を受けた壁時計時刻」を更新。
  // primary(NIY=F)は tick timestamp の遅延も追う(半死セッション=届くが価格値が古い、の検知用)。
  if (t.symbol === PRIMARY_SYMBOL) {
    primaryLagMs = now - t.timestamp;
    primaryLagAt = now;
  }
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

/** アクティブ socket 用のリスナを張る(tick/priceT は共有 latest に書く)。startSocket / forceReconnect / swap 後で使う。 */
function attachActiveListeners(s: Socket): void {
  s.on('connect', () => { connected = true; logState('connected'); });
  s.on('disconnect', (reason: string) => { connected = false; logState('disconnected', reason); });
  s.on('connect_error', (err: Error) => { connected = false; logState('connect_error', err.message); });
  s.on('tick', (arr: unknown) => applyTick(arr));
  s.on('priceT', (text: unknown) => applyPriceT(text));
  // socket.io マネージャの透過再接続(reconnect)。ログのみ。tick が戻らなければ watchdog が強制再作成する。
  // io() の Socket は Manager イベントを socket.io.on(...) で購読する。
  try { s.io.on('reconnect', (n: number) => logState('io_reconnect', `attempt ${n}`)); } catch { /* manager 無し(テスト mock)は無視 */ }
  // 'server' 等その他イベントは無視。
}

/** connector で socket を作りアクティブリスナを張る(startSocket と forceReconnect で共有)。 */
function createSocket(): void {
  socket = connector();
  attachActiveListeners(socket);
}

/** watchdog が半死(tick 途絶)を検知したときの強制フル再接続。透過再接続では tick が戻らないため
 *  現ソケットを完全に破棄して io(...) から作り直す。多重発火は reconnecting ガードで防ぐ。 */
function forceReconnect(reason: string): void {
  if (reconnecting) return;   // 進行中の再接続にタイマ/ソケットを積み上げない。
  reconnecting = true;
  logState('force_reconnect', reason);
  // 進行中の make-before-break があれば破棄(強制フル再接続が優先。二重 socket を残さない)。
  if (swapping) {
    try { if (socketNext) { socketNext.removeAllListeners(); socketNext.disconnect(); } } catch { /* noop */ }
    socketNext = null;
    endMakeBeforeBreak();
  }
  try {
    if (socket) { socket.removeAllListeners(); socket.disconnect(); }
  } catch { /* noop */ }
  socket = null;
  connected = false;
  // 状態機の logState は「同一状態は1回」なので、再接続後の 'connected' を必ず出せるようリセット。
  lastLoggedState = null;
  // 再接続直後は fresh tick 到着まで lag 再評価を猶予する(grace)。lag streak もリセット。
  lastForceReconnectAt = Date.now();
  staleLagStreak = 0;
  primaryLagMs = null;   // 新セッションの lag を待つ(旧セッションの古い lag を再利用しない)。
  try { createSocket(); } catch (err) {
    logState('start_error', err instanceof Error ? err.message : String(err));
  }
  reconnecting = false;
}

// ── proactive make-before-break(v0.7.15) ─────────────────────────────
// 一定周期で「新しい socket を先に開き、それが最初の tick を出したら旧 socket を閉じて差し替える」。
// 旧 socket は新 socket が実証されるまで active のまま latest を供給し続ける → ギャップ0(価格が途切れない)。
// 目的: 長寿命セッションが約10分遅延へ劣化する前に、常に「初回接続=real-time」状態へ更新し続ける。

/** make-before-break の後始末(成功/失敗/停止で共通)。timeout タイマと swapping フラグを解除する。 */
function endMakeBeforeBreak(): void {
  if (mbbTimeoutTimer) { clearTimeout(mbbTimeoutTimer); mbbTimeoutTimer = null; }
  swapping = false;
}

/** 新 socket(socketNext)が最初の tick を出したとき: 旧 socket を破棄し、新 socket を active に昇格する。 */
function swapToNext(): void {
  if (!socketNext) return;
  const promoted = socketNext;
  socketNext = null;
  // 旧 active socket を閉じる(新が実証済みなので今なら安全=ギャップ0)。
  try { if (socket && socket !== promoted) { socket.removeAllListeners(); socket.disconnect(); } } catch { /* noop */ }
  // 新 socket を active に。probe で張った tick/priceT は既に latest を供給しているので、
  // active 用の connect/disconnect(グローバル connected を扱う)だけ追加で張る。
  socket = promoted;
  connected = true;
  lastLoggedState = null;               // 差し替え後の 'connected' 系ログを必ず出せるように。
  // probe 用の connect_error は外し、active 用の connect/disconnect/connect_error を張る(tick/priceT は流用)。
  try { promoted.removeAllListeners('connect_error'); } catch { /* mock 無視 */ }
  promoted.on('connect', () => { connected = true; logState('connected'); });
  promoted.on('disconnect', (reason: string) => { connected = false; logState('disconnected', reason); });
  promoted.on('connect_error', (err: Error) => { connected = false; logState('connect_error', err.message); });
  // 差し替え=fresh セッション開始。lag 系の状態をリセット(旧セッションの古い lag を持ち越さない)。
  lastForceReconnectAt = Date.now();
  staleLagStreak = 0;
  primaryLagMs = null;
  logState('proactive_swap', 'new socket live, old closed (make-before-break)');
  endMakeBeforeBreak();
}

/** 新 socket 用のリスナ: tick/priceT を latest に供給しつつ、最初の tick で swap を発火する。
 *  グローバル connected は触らない(swap 前に new の disconnect で active を落とさないため)。 */
function attachNextListeners(s: Socket): void {
  s.on('tick', (arr: unknown) => {
    applyTick(arr);                     // 供給は即開始(swap 前でも latest は last-write-wins で fresh)。
    if (socketNext === s && swapping) swapToNext();   // 最初の tick で差し替え。
  });
  s.on('priceT', (text: unknown) => applyPriceT(text));
  s.on('connect_error', (err: Error) => logState('next_connect_error', err.message));
  try { s.io.on('reconnect', (n: number) => logState('io_reconnect', `attempt ${n}`)); } catch { /* mock 無視 */ }
}

/** 差し替え候補の新 socket を開いて make-before-break を開始する(周期タイマから呼ぶ)。 */
function startMakeBeforeBreak(): void {
  // 進行中/強制再接続中/そもそも active socket が無いときは開始しない(周期の多重発火ガード)。
  if (swapping || reconnecting || !socket) return;
  swapping = true;
  try {
    socketNext = connector();
    attachNextListeners(socketNext);
  } catch (err) {
    logState('proactive_start_error', err instanceof Error ? err.message : String(err));
    socketNext = null;
    endMakeBeforeBreak();
    return;
  }
  logState('proactive_open', 'opened next socket (make-before-break)');
  // 猶予内に新 socket が tick を出さなければ捨てて旧を維持(=決して socket 無しにしない)。
  mbbTimeoutTimer = setTimeout(abortMakeBeforeBreak, MAKE_BEFORE_BREAK_TIMEOUT_MS);
}

/** 新 socket が猶予内に tick を出さなかった: 新 socket を破棄し、旧 socket を active のまま維持する。 */
function abortMakeBeforeBreak(): void {
  if (!swapping) return;
  try { if (socketNext) { socketNext.removeAllListeners(); socketNext.disconnect(); } } catch { /* noop */ }
  socketNext = null;
  logState('proactive_abort', 'next socket no tick in time, kept old (retry next interval)');
  endMakeBeforeBreak();
}

/** watchdog: connected の間、以下のいずれかで強制フル再接続する。
 *  (A) 無 tick: 直近 tick 到着が TICK_WATCHDOG_MS を超えた(完全沈黙=半死/停止)。
 *  (B) stale-timestamp: tick は届き続けているが primary(NIY=F)の tsMs 遅延が TICK_STALE_LAG_MS を超え、
 *      それが TICK_STALE_LAG_STREAK 回連続(=価格値が遅延へドリフトした半死セッション。再接続で real-time 復帰)。
 *  disconnected 中は socket.io 透過再接続に任せる。再接続直後の grace / min-interval 中は (B) を評価しない。
 *  v0.7.14: (B) の give-up cap は撤去。ドリフトは再発し、再接続は毎回 real-time を復元するので、
 *  ドリフトを検知するたびに(min-interval を空けて)何度でも張り直す。絶対的な打ち止めはしない。 */
function watchdogCheck(): void {
  if (!connected) return;          // 切断中は透過再接続に任せる(接続の張り直しはしない)。
  if (lastTickAt === 0) return;    // まだ一度も tick が無い(起動直後)。誤発火しない。
  const now = Date.now();

  // (A) 無 tick(完全沈黙)。
  const age = now - lastTickAt;
  if (age > TICK_WATCHDOG_MS) { forceReconnect(`no tick ${age}ms(half-dead socket)`); return; }

  // (B) stale-timestamp(届くが価格値が古い)。再接続直後の grace / min-interval 中は評価しない
  //     (fresh tick 待ち + rapid thrash 防止)。
  if (now - lastForceReconnectAt < RECONNECT_GRACE_MS) return;
  // primary の lag 観測が無い/古すぎる(この点検周期で更新されていない)なら判定しない。
  if (primaryLagMs === null || now - primaryLagAt > TICK_WATCHDOG_CHECK_MS * 2) { staleLagStreak = 0; return; }
  if (primaryLagMs > TICK_STALE_LAG_MS) {
    staleLagStreak++;
    if (staleLagStreak >= TICK_STALE_LAG_STREAK) {
      staleLagStreak = 0;
      // give-up せず毎回張り直す。min-interval(RECONNECT_GRACE_MS)が次発火までの間隔を保証する。
      forceReconnect(`stale tick lag ${Math.round(primaryLagMs / 1000)}s(price drifted delayed, reconnecting)`);
    }
  } else {
    staleLagStreak = 0;   // fresh に戻ったら streak リセット(sustained 判定のため)。
  }
}

/** socket を起動(冪等)。socket.io 透過再接続 + app 層 watchdog で tick 途絶からも復帰する。
 *  エラーは throw せずログのみ。テスト用に connector を注入できる。 */
export function startSocket(conn?: SocketConnector): void {
  if (socket) return;   // 二重起動ガード。
  connector = conn ?? defaultConnector;
  try {
    createSocket();
  } catch (err) {
    logState('start_error', err instanceof Error ? err.message : String(err));
  }
  // watchdog を1本だけ張る(冪等)。stopSocket でクリアする。
  if (!watchdogTimer) watchdogTimer = setInterval(watchdogCheck, TICK_WATCHDOG_CHECK_MS);
  // proactive make-before-break を周期起動(冪等)。常に「初回接続=real-time」状態へ更新し続ける。
  if (!proactiveTimer) proactiveTimer = setInterval(startMakeBeforeBreak, PROACTIVE_RECONNECT_MS);
}

/** socket を停止(冪等)。プロセス終了時に呼ぶ。watchdog も止める。 */
export function stopSocket(): void {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null; }
  if (mbbTimeoutTimer) { clearTimeout(mbbTimeoutTimer); mbbTimeoutTimer = null; }
  reconnecting = false;
  swapping = false;
  lastTickAt = 0;
  primaryLagMs = null; primaryLagAt = 0; staleLagStreak = 0; lastForceReconnectAt = 0;
  connector = defaultConnector;
  // 進行中の make-before-break の新 socket も閉じる。
  try { if (socketNext) { socketNext.removeAllListeners(); socketNext.disconnect(); } } catch { /* noop */ }
  socketNext = null;
  if (!socket) { connected = false; lastLoggedState = null; return; }
  try { socket.removeAllListeners(); socket.disconnect(); } catch { /* noop */ }
  socket = null;
  connected = false;
  lastLoggedState = null;
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
/** テスト用: primary(NIY=F)の tick timestamp lag を注入(半死セッション=届くが価格値が古い の検証用)。
 *  lastTickAt も更新して「tick は届いている(=無 tick watchdog は発火しない)」状態にする。
 *  grace/min-interval を過去化して stale-lag 判定が有効になるようにする。 */
export function _setPrimaryLagForTest(lagMs: number): void {
  const now = Date.now();
  primaryLagMs = lagMs;
  primaryLagAt = now;
  lastTickAt = now;                          // tick は届いている(無 tick 経路には落ちない)。
  lastForceReconnectAt = now - RECONNECT_GRACE_MS - 1;   // grace/min-interval 明け(stale-lag を評価可能に)。
}
/** テスト用: 直近の強制再接続時刻を読む(min-interval の検証用)。0=未再接続。 */
export function _getLastForceReconnectAtForTest(): number {
  return lastForceReconnectAt;
}
/** テスト用: primary の lag を大きく注入するが、grace/min-interval は据え置く(=直近に再接続した想定)。
 *  _setPrimaryLagForTest は grace を過去化してしまうので、min-interval が効いている状況の検証にはこちらを使う。
 *  lastForceReconnectAt=now(min-interval 内)/ primaryLag=lagMs(sustained)を作る。 */
export function _setLagWithinIntervalForTest(lagMs: number): void {
  const now = Date.now();
  primaryLagMs = lagMs;
  primaryLagAt = now;
  lastTickAt = now;                 // tick は届いている(無 tick 経路には落ちない)。
  lastForceReconnectAt = now;       // 直近に再接続した=min-interval 内。
}
/** テスト用: watchdog interval が張られているか。 */
export function _hasWatchdogForTest(): boolean {
  return watchdogTimer !== null;
}
// ── proactive make-before-break のテスト用シーム ──
/** テスト用: proactive make-before-break を1回起動する(setInterval を待たない)。 */
export function _runProactiveForTest(): void {
  startMakeBeforeBreak();
}
/** テスト用: make-before-break の打ち切り(新 socket が tick を出さなかった経路)を駆動する。 */
export function _runMbbTimeoutForTest(): void {
  abortMakeBeforeBreak();
}
/** テスト用: 現在の active socket 参照(差し替え確認用)。 */
export function _getActiveSocketForTest(): Socket | null {
  return socket;
}
/** テスト用: 差し替え候補の新 socket 参照(make-before-break 中のみ非 null)。 */
export function _getSocketNextForTest(): Socket | null {
  return socketNext;
}
/** テスト用: make-before-break 進行中フラグ。 */
export function _isSwappingForTest(): boolean {
  return swapping;
}
/** テスト用: proactive timer が張られているか。 */
export function _hasProactiveTimerForTest(): boolean {
  return proactiveTimer !== null;
}
