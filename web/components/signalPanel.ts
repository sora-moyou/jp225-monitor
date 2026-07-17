import { beep } from './soundPlayer.js';

// ─── SSE state 契約 (backend→frontend の唯一のIF) ───────────────────────
// server 側 broadcast({ type: 'signalTrade', payload: SignalTradeState }) を購読する。
// 既存フィールドは不変。backend 実装完了前でも、この契約に対して frontend を実装する。
// レンジ両面ストラドルの1レッグ(表示用)。side/type/entry/stopLoss。
export interface SignalRangeLeg {
  side: 'buy' | 'sell';
  type: 'limit' | 'stop';
  entry: number;
  stopLoss: number;
}

export interface SignalTradeState {
  phase: 'flat' | 'armed' | 'filled';
  // armed (エントリー注文中)。limitEntry=direction 側の指値 / stopEntry=反対側の逆指値 (OCO)。
  // mode==='range' の時は range(上下2レッグ・片レッグ落ちも可)を両面表示する。
  entry?: {
    direction: 'buy' | 'sell';
    limitEntry?: number;
    stopEntry?: number;
    initialStop?: number;   // 後方互換: 単一正規化値(指値優先)
    stopLossForLimit?: number; stopLossForStop?: number; // レッグ別 LC(指値/逆指値それぞれ)
    rationale?: string;
    at: number;
    mode?: 'range';
    range?: { upper?: SignalRangeLeg; lower?: SignalRangeLeg };
  };
  // filled (保有中)。決済逆指値は非表示。建値と含みのみ。
  position?: {
    direction: 'buy' | 'sell';
    entryPrice: number;
    qty: number;
    unrealized: number;
    at: number;
  };
  // 直近決済 (決済時に「決済79000」を一時表示するため)
  lastExit?: { exitPrice: number; pnl: number; at: number };
  updatedAt: number;
}

// 直近決済を「決済 xxxx」と表示し続ける時間 (数十秒)。以降は「シグナル待機」。
const EXIT_DISPLAY_MS = 40_000;

const SOUND_KEY = 'signal-sound';
function soundOn(): boolean {
  return (localStorage.getItem(SOUND_KEY) ?? '1') !== '0';
}
export function setSignalSound(on: boolean): void {
  localStorage.setItem(SOUND_KEY, on ? '1' : '0');
}
export function isSignalSoundOn(): boolean { return soundOn(); }

/** 設定モーダルの ON/OFF チェックボックスを配線する (既定ON)。 */
export function initSignalSoundToggle(checkbox: HTMLInputElement): void {
  checkbox.checked = soundOn();
  checkbox.addEventListener('change', () => setSignalSound(checkbox.checked));
}

// ─── 音: phase 遷移 (armed / filled / 決済) で短いビープ ────────────────
function signalBeep(kind: 'armed' | 'filled' | 'exit'): void {
  if (!soundOn()) return;
  // それぞれ違う音色。armed=中高音の合図 / filled=二段上げ / exit=下げ。
  if (kind === 'armed') { beep(784, 160); }
  else if (kind === 'filled') { beep(880, 120); setTimeout(() => beep(1175, 160), 130); }
  else { beep(659, 130); setTimeout(() => beep(440, 220), 140); }
}

const dirJa = (d: 'buy' | 'sell'): string => (d === 'buy' ? '買い' : '売り');
const fmtPrice = (v: number): string => Math.round(v).toLocaleString('en-US');
const fmtPnl = (v: number): string => `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('en-US')}`;

// 遷移検知用の直前状態。
let prevPhase: SignalTradeState['phase'] | null = null;
let prevExitAt = 0;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 純関数: パネル本文を組み立てるための表示モデルを返す (DOM 非依存=テスト可能)。
 */
export interface PanelView {
  cls: 'flat' | 'armed' | 'filled' | 'exit';
  main: string;      // メイン行 (安全な固定文言のみ・価格/数値)
  rationale: string; // AI生成文字列 (呼び出し側で textContent 描画)
}
export function buildSignalView(s: SignalTradeState | null, now: number = Date.now()): PanelView {
  if (!s || s.phase === 'flat') {
    const ex = s?.lastExit;
    if (ex && now - ex.at < EXIT_DISPLAY_MS) {
      return { cls: 'exit', main: `✔ 決済 ${fmtPrice(ex.exitPrice)}（${fmtPnl(ex.pnl)}）`, rationale: '' };
    }
    return { cls: 'flat', main: 'シグナル待機', rationale: '' };
  }
  if (s.phase === 'filled' && s.position) {
    const p = s.position;
    return {
      cls: 'filled',
      main: `● 保有：${dirJa(p.direction)} @${fmtPrice(p.entryPrice)}（含み ${fmtPnl(p.unrealized)}）`,
      rationale: '',
    };
  }
  if (s.phase === 'armed' && s.entry) {
    const e = s.entry;
    // ★レンジ両面ストラドル: 上下の各レッグを side/type/entry で明示表示(実験・紙で別枠計測)。
    if (e.mode === 'range' && e.range) {
      const legStr = (leg: SignalRangeLeg, pos: '上' | '下'): string =>
        `${dirJa(leg.side)}${fmtPrice(leg.entry)}${leg.type === 'limit' ? '指値' : '逆指値'}(${pos})${leg.stopLoss != null ? ` (LC ${fmtPrice(leg.stopLoss)})` : ''}`;
      const parts: string[] = [];
      if (e.range.upper) parts.push(legStr(e.range.upper, '上'));
      if (e.range.lower) parts.push(legStr(e.range.lower, '下'));
      return { cls: 'armed', main: `🎯 レンジ：${parts.join(' / ')}`, rationale: e.rationale ?? '' };
    }
    const legs: string[] = [];
    // 両レッグとも実トレード方向(entry.direction)。stopEntry は同方向のブレイク追随エントリー
    // (backend AiPlan 意味論)なので、指値/逆指値で区別し方向は反転させない。
    // ★LC はレッグ別に表示(指値=stopLossForLimit / 逆指値=stopLossForStop)。逆指値レッグの LC も出す。
    const lcTag = (lc?: number): string => (lc != null ? ` (LC ${fmtPrice(lc)})` : '');
    if (e.limitEntry != null) legs.push(`${dirJa(e.direction)} ${fmtPrice(e.limitEntry)} 指値${lcTag(e.stopLossForLimit)}`);
    if (e.stopEntry != null) legs.push(`${dirJa(e.direction)} ${fmtPrice(e.stopEntry)} 逆指値${lcTag(e.stopLossForStop)}`);
    let main = `🎯 シグナル：${legs.join(' / ')}`;
    // 後方互換: レッグ別 LC が無い(旧server)ときだけ従来の単一 LC を末尾に出す。
    if (e.stopLossForLimit == null && e.stopLossForStop == null && e.initialStop != null) main += ` ・ LC ${fmtPrice(e.initialStop)}`;
    return { cls: 'armed', main, rationale: e.rationale ?? '' };
  }
  return { cls: 'flat', main: 'シグナル待機', rationale: '' };
}

/** 既存描画パイプラインから毎 tick 呼ぶ。DOM を安全に (rationale は textContent) 更新する。 */
export function renderSignalPanel(el: HTMLElement, s: SignalTradeState | null): void {
  // ── 音の遷移判定 ──
  if (s) {
    if (prevPhase !== 'armed' && s.phase === 'armed') signalBeep('armed');
    if (prevPhase !== 'filled' && s.phase === 'filled') signalBeep('filled');
    if (s.lastExit && s.lastExit.at > prevExitAt) { signalBeep('exit'); prevExitAt = s.lastExit.at; }
    prevPhase = s.phase;
  }

  const view = buildSignalView(s);
  el.className = `signal-panel signal-${view.cls}`;

  const mainEl = document.createElement('div');
  mainEl.className = 'signal-main';
  mainEl.textContent = view.main;

  el.replaceChildren(mainEl);
  if (view.rationale) {
    const r = document.createElement('div');
    r.className = 'signal-rationale';
    r.textContent = view.rationale;   // AI生成文字列は必ず textContent で描画
    el.appendChild(r);
  }

  // 直近決済の一時表示は数十秒後に「待機」へ自動で戻す (SSE が来なくても消えるよう保険)。
  if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
  if (view.cls === 'exit' && s?.lastExit) {
    const remain = EXIT_DISPLAY_MS - (Date.now() - s.lastExit.at);
    clearTimer = setTimeout(() => renderSignalPanel(el, s), Math.max(500, remain + 100));
  }
}
