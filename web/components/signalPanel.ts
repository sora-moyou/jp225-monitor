import { beep } from './soundPlayer.js';
// ★画面に出す直前にだけ LC幅の検算を落とす(生成側のプロンプトは1文字も変えない=符号の保持に効いているため)。
//   落とす/落とさないの境界と、語彙の出所(server/llm/rationaleLc.ts)は core/rationaleDisplay.ts の冒頭に書いてある。
import { stripLcArithmetic } from '../../core/rationaleDisplay.js';

// ─── SSE state 契約 (backend→frontend の唯一のIF) ───────────────────────
// server 側 broadcast({ type: 'signalTrade', payload: SignalTradeState }) を購読する。
// ★別枠表示: シグナル枠は s.signal(現在シグナル・保有中も保持)を描き、保有枠は s.position を描く。
//   → 保有に入ってもシグナルは消えない(2枠が独立)。
// レンジ両面ストラドルの1レッグ(表示用)。side/type/entry/stopLoss。
export interface SignalRangeLeg {
  side: 'buy' | 'sell';
  type: 'limit' | 'stop';
  entry: number;
  stopLoss: number;
}

// 現在シグナル(保有中も保持される・シグナル枠が描く)。server SignalTradeState.signal と対応。
export interface SignalCurrent {
  signalId?: number;
  direction: 'buy' | 'sell';
  limitEntry?: number;
  stopEntry?: number;
  stopLossForLimit?: number;
  stopLossForStop?: number;
  rationale?: string;
  at?: number;
  mode?: 'range';
  range?: { upper?: SignalRangeLeg; lower?: SignalRangeLeg };
  // ★ドテン(反転)シグナル。true のとき「決済+反対新規」の反転指示=パネルに明示表示する。
  doten?: boolean;
}

export interface SignalTradeState {
  phase: 'flat' | 'armed' | 'filled';
  // armed (エントリー注文中)。後方互換で残す(現在は signal を優先して描く)。
  entry?: {
    direction: 'buy' | 'sell';
    limitEntry?: number;
    stopEntry?: number;
    initialStop?: number;
    stopLossForLimit?: number; stopLossForStop?: number;
    rationale?: string;
    at: number;
    mode?: 'range';
    range?: { upper?: SignalRangeLeg; lower?: SignalRangeLeg };
  };
  // ★現在シグナル(保有中も保持)。シグナル枠はこれを描く=保有に入っても消えない。
  signal?: SignalCurrent;
  // filled (保有中)。保有枠が描く。決済逆指値は非表示。建値と含みのみ。
  position?: {
    direction: 'buy' | 'sell';
    entryPrice: number;
    qty: number;
    unrealized: number;
    at: number;
  };
  // 直近決済 (保有枠に「決済79000」を一時表示するため)
  lastExit?: { exitPrice: number; pnl: number; at: number };
  // ★未約定失効(armed-timeout)。「武装したのに一度も約定せず失効した」回数。
  //   monitor が武装 → trade2 が受信後ずっと拒否 → 黙って失効、という乖離の終着点。
  //   count  = 累計(機体の生涯・約定でも減らない=無音の失敗を数える指標。表示には使わない)。
  //   streak = 連続(約定のたびに 0 へ戻る)。★待機表示はこちらを出す。
  //   waitMin= 直前に失効したブラケットで **実際に使われた** 待ち時間[分](距離とボラで可変なので固定文字列にしない)。
  //   bias   = 直前に失効したブラケットの向き(=いまどっち向きで待っているか)。不明なら欠落。
  armedTimeout?: { count: number; streak?: number; lastAt: number; waitMin?: number; bias?: 'buy' | 'sell' | 'range' };
  // ★待機理由(なぜいまシグナルが無いのか)。server(engine)の抑止ゲートをそのまま載せたもの。
  //   closed=取引時間外 / cooldown=決済後のクールダウン(untilMs=解除時刻の絶対時刻) / level=見送り後の節目クロス待ち。
  //   理由が無いとき(通常の間隔待ち等)はフィールドごと欠落する=従来と同じ「シグナル待機」表示。
  waitReason?: { kind: 'closed' } | { kind: 'cooldown'; untilMs: number } | { kind: 'level' };
  updatedAt: number;
}

// 直近決済を「決済 xxxx」と表示し続ける時間 (数十秒)。以降は「保有なし」。
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
// 決済一時表示の自動クリアタイマ(保有枠)。
const clearTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export interface PanelView {
  cls: 'flat' | 'armed' | 'filled' | 'exit';
  bias?: string;     // 目線行 (買い目線/売り目線/レンジ)。シグナルがある時だけ。メイン行と同サイズ・同色・左詰め。
  main: string;      // メイン行 (安全な固定文言のみ・価格/数値)
  rationale: string; // AI生成文字列 (呼び出し側で textContent 描画)
}

// 目線ラベル。**新しい語彙を作らない**: 既存の目線行(buildSignalView の bias)と同じ言い回しを使う。
const BIAS_JA: Record<'buy' | 'sell' | 'range', string> = { buy: '買い目線', sell: '売り目線', range: 'レンジ目線' };

/** 純関数: 待機中(シグナル無し)のメイン行。
 *  ・連続失効 0 回(またはフィールド欠落)…… 従来どおり「シグナル待機」(既存表示は不変)。
 *  ・連続失効 N 回 ……「シグナル待機（連続失効 15分2回 / 現在買い目線）」
 *      - 「15分」は **そのとき実際に使われた待ち時間**(waitMin)。距離とボラで可変なので固定文字列にしない。
 *        waitMin が無い(古い server / 材料欠落)ときは分数を出さず「連続失効 2回」に縮退する。
 *      - 目線(bias)が無い/不明なら、その部分ごと出さない(空括弧や「不明」を作らない)。
 *  ★累計(count)は表示しない。累計は「無音の失敗を数える」ための別指標として state に残る。
 *  ・待機理由(waitReason)…… server(engine)が実際に再計画を抑止しているゲートを併記する。
 *      「シグナル待機（取引時間外）」/「シグナル待機（10:30までクールダウン）」/「シグナル待機（節目クロス待ち）」。
 *      連続失効と両方あるときは併記=「シグナル待機（10:30までクールダウン / 連続失効 15分2回 / 現在買い目線）」。
 *      理由が無い(通常の間隔待ち等)ときはフィールドごと欠落し、従来の表示に戻る。 */
export function buildWaitMain(
  at?: { count: number; streak?: number; lastAt: number; waitMin?: number; bias?: 'buy' | 'sell' | 'range' } | null,
  waitReason?: SignalTradeState['waitReason'] | null,
): string {
  const parts: string[] = [];
  // ★待機理由(server の抑止ゲート)を先頭に置く。ユーザーが最初に知りたいのは「なぜ止まっているか」。
  const reason = waitReasonLabel(waitReason);
  if (reason) parts.push(reason);
  const n = at?.streak ?? 0;
  if (n > 0) {
    const w = at?.waitMin;
    const wLabel = typeof w === 'number' && Number.isFinite(w) && w > 0 ? `${Math.round(w)}分` : '';
    parts.push(`連続失効 ${wLabel}${n}回`);
    const bias = at?.bias ? BIAS_JA[at.bias] : undefined;
    if (bias) parts.push(`現在${bias}`);
  }
  if (parts.length === 0) return 'シグナル待機';
  return `シグナル待機（${parts.join(' / ')}）`;
}

/** 純関数: 時刻[ms] を JST の HH:MM にする(表示は常に日本時間=取引時間の語彙に揃える)。 */
export function fmtJstHm(ms: number): string {
  return new Date(ms).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** 純関数: 待機理由の表示文。語彙は既存に揃える(新しい言い回しを作らない)。
 *  ・closed ……「取引時間外」= 価格ボード/指標パネル/API状態が既に使っている語をそのまま使う。
 *  ・cooldown …「(engine) cooldown 決済後の再ARM抑止」→ 解除時刻を添えて「HH:MMまでクールダウン」。
 *  ・level ………「(engine) plan-rearm 節目クロス」→「節目クロス待ち」。
 *  理由が無い/解除時刻が読めないときは空文字(=その部分ごと出さない。空括弧や「不明」を作らない)。 */
export function waitReasonLabel(r?: SignalTradeState['waitReason'] | null): string {
  if (!r) return '';
  if (r.kind === 'closed') return '取引時間外';
  if (r.kind === 'cooldown') {
    const until = r.untilMs;
    if (typeof until !== 'number' || !Number.isFinite(until)) return '';
    return `${fmtJstHm(until)}までクールダウン`;
  }
  if (r.kind === 'level') return '節目クロス待ち';
  return '';
}

/** 純関数: シグナル枠の表示モデル。現在シグナル(s.signal)を優先し、無ければ armed の entry、
 *  それも無ければ「シグナル待機」。★保有(filled)でも s.signal がある限りシグナルを描き続ける。 */
export function buildSignalView(s: SignalTradeState | null): PanelView {
  const waitMain = (): string => buildWaitMain(s?.armedTimeout, s?.waitReason);
  const sig: SignalCurrent | undefined = s?.signal ?? (s?.entry ? { ...s.entry } : undefined);
  if (!sig) return { cls: 'flat', main: waitMain(), rationale: '' };

  // ★A案: 決済で即クリア。直近決済(lastExit)がこのシグナル発生後(sig.at <= lastExit.at)なら、
  //   その建玉は既に決済済み=シグナルは役目を終えたので「シグナル待機」に戻す。
  //   armed/filled 中は lastExit が前トレードの古いもの(sig.at > lastExit.at)なので描き続ける。
  //   決済後に来る新シグナル(sig.at > lastExit.at)は再び描く。sig.at 欠落時は抑制しない(安全側=表示)。
  if (s?.lastExit && sig.at != null && s.lastExit.at != null && sig.at <= s.lastExit.at) {
    return { cls: 'flat', main: waitMain(), rationale: '' };
  }

  // ★レンジ両面ストラドル: 上下の各レッグを side/type/entry で明示表示。
  if (sig.mode === 'range' && sig.range) {
    const legStr = (leg: SignalRangeLeg, pos: '上' | '下'): string =>
      `${dirJa(leg.side)}${fmtPrice(leg.entry)}${leg.type === 'limit' ? '指値' : '逆指値'}(${pos})${leg.stopLoss != null ? ` (LC ${fmtPrice(leg.stopLoss)})` : ''}`;
    const parts: string[] = [];
    if (sig.range.upper) parts.push(legStr(sig.range.upper, '上'));
    if (sig.range.lower) parts.push(legStr(sig.range.lower, '下'));
    if (parts.length === 0) return { cls: 'flat', main: waitMain(), rationale: '' };
    return { cls: 'armed', bias: 'レンジ', main: `🎯 レンジ：${parts.join(' / ')}`, rationale: stripLcArithmetic(sig.rationale) };
  }

  const lcTag = (lc?: number): string => (lc != null ? ` (LC ${fmtPrice(lc)})` : '');
  const legs: string[] = [];
  if (sig.limitEntry != null) legs.push(`${dirJa(sig.direction)} ${fmtPrice(sig.limitEntry)} 指値${lcTag(sig.stopLossForLimit)}`);
  if (sig.stopEntry != null) legs.push(`${dirJa(sig.direction)} ${fmtPrice(sig.stopEntry)} 逆指値${lcTag(sig.stopLossForStop)}`);
  if (legs.length === 0) return { cls: 'flat', main: waitMain(), rationale: '' };
  // ★ドテン(反転)シグナルは目線行に明示(通常の決済→別の新規と区別できるように)。
  const dirBias = sig.direction === 'buy' ? '買い目線' : '売り目線';
  const bias = sig.doten ? `🔃 ドテン(反転)・${dirBias}` : dirBias;
  return { cls: 'armed', bias, main: `🎯 シグナル：${legs.join(' / ')}`, rationale: stripLcArithmetic(sig.rationale) };
}

/** 純関数: 保有枠の表示モデル。保有中は建値+含み、直近決済は一時表示、それ以外は「保有なし」。
 *  ★シグナル枠とは独立。途中の決済逆指値は出さない(建値と含みのみ)。 */
export function buildPositionView(s: SignalTradeState | null, now: number = Date.now()): PanelView {
  if (s?.position) {
    const p = s.position;
    return {
      cls: 'filled',
      main: `● 保有：${dirJa(p.direction)} @${fmtPrice(p.entryPrice)}（含み ${fmtPnl(p.unrealized)}）`,
      rationale: '',
    };
  }
  const ex = s?.lastExit;
  if (ex && now - ex.at < EXIT_DISPLAY_MS) {
    return { cls: 'exit', main: `✔ 決済 ${fmtPrice(ex.exitPrice)}（${fmtPnl(ex.pnl)}）`, rationale: '' };
  }
  return { cls: 'flat', main: '保有なし', rationale: '' };
}

/** 純関数: 理由文(AI 生成文 + コード側の脚 drop 注記)を表示行に分解する。
 *  注記は `${rationale}\n※上部(売り指値)は不採用: …` の形で `\n` 連結されるが、1要素に textContent で
 *  入れると CSS(white-space:normal)で改行が潰れ、本文に埋もれて「なぜ片側だけなのか」が読めなくなる。
 *  行に分けて別要素で描くための分解(空行・前後の空白は落とす)。 */
export function splitRationaleLines(text: string): string[] {
  return (text ?? '').split('\n').map(s => s.trim()).filter(s => s.length > 0);
}

function paintPanel(el: HTMLElement, view: PanelView, extraCls = ''): void {
  el.className = `signal-panel signal-${view.cls}${extraCls ? ' ' + extraCls : ''}`;
  const nodes: HTMLElement[] = [];
  // ★目線行(買い目線/売り目線/レンジ)。シグナルがある時だけメイン行の上に出す(同サイズ・同色・左詰め)。
  if (view.bias) {
    const biasEl = document.createElement('div');
    biasEl.className = 'signal-bias';
    biasEl.textContent = view.bias;
    nodes.push(biasEl);
  }
  const mainEl = document.createElement('div');
  mainEl.className = 'signal-main';
  mainEl.textContent = view.main;
  nodes.push(mainEl);
  el.replaceChildren(...nodes);
  // ★理由文は行ごとに別要素で描く。コード側が足す脚 drop 注記(`※上部(売り指値)は不採用: …`)は
  //   `\n` 区切りなので、1要素に入れると改行が潰れて本文と繋がり読めなくなる(片面になった理由が伝わらない)。
  const lines = splitRationaleLines(view.rationale);
  if (lines.length) {
    const r = document.createElement('div');
    r.className = 'signal-rationale';
    for (const line of lines) {
      const lineEl = document.createElement('div');
      lineEl.textContent = line;   // AI生成文字列は必ず textContent で描画
      r.appendChild(lineEl);
    }
    el.appendChild(r);
  }
}

/** シグナル枠を描く。毎 tick 呼ぶ。phase 遷移で音を鳴らす(armed/filled/exit)。 */
export function renderSignalPanel(el: HTMLElement, s: SignalTradeState | null): void {
  // ── 音の遷移判定(phase ベース。保有枠ではなくここで一括して鳴らす) ──
  if (s) {
    if (prevPhase !== 'armed' && s.phase === 'armed') signalBeep('armed');
    if (prevPhase !== 'filled' && s.phase === 'filled') signalBeep('filled');
    if (s.lastExit && s.lastExit.at > prevExitAt) { signalBeep('exit'); prevExitAt = s.lastExit.at; }
    prevPhase = s.phase;
  }
  paintPanel(el, buildSignalView(s));
}

/** 保有枠を描く。決済の一時表示は数十秒後に「保有なし」へ自動で戻す(SSE が来なくても消えるよう保険)。 */
export function renderPositionPanel(el: HTMLElement, s: SignalTradeState | null): void {
  const view = buildPositionView(s);
  paintPanel(el, view, 'position-panel');

  const existing = clearTimers.get(el);
  if (existing) { clearTimeout(existing); clearTimers.delete(el); }
  if (view.cls === 'exit' && s?.lastExit) {
    const remain = EXIT_DISPLAY_MS - (Date.now() - s.lastExit.at);
    clearTimers.set(el, setTimeout(() => renderPositionPanel(el, s), Math.max(500, remain + 100)));
  }
}
