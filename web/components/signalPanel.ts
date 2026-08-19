import { beep } from './soundPlayer.js';
// ★画面に出す直前にだけ LC幅の検算を落とす(生成側のプロンプトは1文字も変えない=符号の保持に効いているため)。
//   落とす/落とさないの境界と、語彙の出所(server/llm/rationaleLc.ts)は core/rationaleDisplay.ts の冒頭に書いてある。
import { stripLcArithmetic, NO_REASON } from '../../core/rationaleDisplay.js';
// ★脚(指値/逆指値)のラベルと、位置の規約の検査。**実体は core/entryLabel.ts が唯一の権威**で、
//   server/llm/scalpPlan.ts の entrySideOk も同じ関数の再輸出=画面と発生源が同じ規約を見る。
import { entryLabel, entryStance, entryStanceUnknownReason, entryPositionOk, type EntryTrendDir } from '../../core/entryLabel.js';

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
  // ★v0.9.86: その計画の「相場の読み」(server SignalTradeState.signal と同じ ADD-ONLY フィールド)。
  //   strategy=ラベル(目線行に添える) / strategyWhy=なぜその読みにしたか(理由の行に出す)。
  //   どちらも AI 生成文字列 = **必ず textContent で描く**。欠落した回は従来どおりの表示に縮退する。
  strategy?: string;
  strategyWhy?: string;
  // ★v0.9.87: **なぜこの価格なのか** の答え=その価格の根拠にした節目(server SignalTradeState.signal と同じ)。
  //   ・limitLevel … 指値の根拠にした節目の価格
  //   ・stopLevel  … ブレイク新規(逆指値)の根拠にした節目の価格
  //   ★内側/外側と距離は **ここで計算する**(AI には書かせない)。節目の生値だけを受け取る。
  limitLevel?: number;
  stopLevel?: number;
  // ★v0.9.88: ARM した瞬間に monitor が見ていた価格(server CurrentSignal.refPrice)。
  //   脚の位置(指値=現在値の手前 / 逆指値=向こう)が規約どおりかを **この値を基準に** 検査する。
  //   ★「今の値段」ではない: 今の値段で当てると、普通に価格が脚を越えただけの回まで不正と表示してしまう。
  //   欠落(取れない/stale・旧 server)なら **検査そのものを出さない**(true を合格として見せない)。
  refPrice?: number;
  // ★v0.9.88: **レッグごとの理由**(server SignalTradeState.signal と同じ ADD-ONLY フィールド)。
  //   どれも AI 生成文字列 = **必ず textContent で描き**、**必ず stripLcArithmetic を通す**。
  directionWhy?: string;
  entryWhyForLimit?: string;
  entryWhyForStop?: string;
  lcWhyForLimit?: string;
  lcWhyForStop?: string;
  // ★v0.9.88: コードが測ったトレンドの向き。順張り/逆張りはこれと売買の向きで決まる。
  //   欠落/'flat'/'conflict'/'stale' の回は **語を出さない**(分からないものを断定しない)。
  trendDir?: EntryTrendDir;
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
    strategy?: string;      // ★v0.9.86: signal と同じ「相場の読み」(entry 経路でもラベルを落とさない)。
    strategyWhy?: string;
    limitLevel?: number;    // ★v0.9.87: signal と同じ「価格の根拠にした節目」(entry 経路でも落とさない)。
    stopLevel?: number;
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
  // ★v0.9.87: 節目の行(「指値 ← 68,700 の 25円内側 ／ 逆指値 ← 68,775 の 5円外側」)。
  //   **コードが計算した文字列**(AI 生成文ではない)。理由の行の最後の1行として描く。
  //   申告が1つも無い回は undefined = 行ごと出さない(= 従来の表示と byte 一致)。
  basis?: string;
  // ★v0.9.88: 脚のラベルの行(「指値 押し目買い・逆張り ／ 逆指値 ブレイク新規・順張り」)。
  //   **コードが導出した文字列**(AI には聞かない)。節目の行の1つ上に描く。
  //   脚が1本も無い回は undefined = 行ごと出さない(= 従来の表示と byte 一致)。
  stance?: string;
  // ★v0.9.88: **レッグごとの理由**の行(「目線: …」「指値: … ／ LC: …」)。
  //   理由のフィールドが **1つも来ていない** 回は undefined = 行ごと出さない
  //   (= 旧版の記録の形を食わせたときに従来の表示と byte 一致になる)。
  whys?: string[];
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

/** 純関数: 目線行に「相場の読み」のラベルを添える(例:「買い目線・トレンド押し目・戻り」)。
 *  ・区切りは **既存の `・`**(ドテン表示 `🔃 ドテン(反転)・買い目線` と同じ文字)。新しい記号を作らない。
 *  ・ラベルが無い/空白だけ のときは **目線行を1バイトも変えない**(空の `・` を絶対に作らない)。
 *  ・★一覧(SCALP_STRATEGY_LABELS)外の生値も **そのまま出す**(台帳と同じ規約=丸めると
 *    「用意した語が現実と合っていない」という一番知りたい事実が画面からも消える)。 */
/*  ★v0.9.87(重複の修正): ラベルが目線行に **既に現れている** ときは足さない。
 *    実害: ドテンのラベル(`ドテン`)が来ると「🔃 ドテン(反転)・買い目線・ドテン」と2回出ていた。
 *    判定は部分一致(`includes`)にする。`・` で割った完全一致では「🔃 ドテン(反転)」と「ドテン」が
 *    別物になり、この事故をちょうど取り逃がすため(=直したい形が直らない)。
 *    副作用として「レンジ目線 + レンジ」のような包含関係でも足さないが、それも重複なので望ましい。 */
/*  ★v0.9.88(2つの修正):
 *   (a) strategy は **AI 生成文字列** なのに stripLcArithmetic を通っていなかった。
 *       parseAiStrategy は一覧外の語も丸めずそのまま残す仕様なので、AI が
 *       `"strategy":"LC幅は60円"` と書けば **目線行に LC の検算がそのまま出る**。cleanAiText を通す。
 *   (b) ★順張り/逆張りの語を含むラベルは、**stance が確定している回に限り** 目線行に出さない
 *       (裁定: コード導出の stance を正とする)。
 *       ■ 何が起きていたか
 *         目線行「買い目線・節目の逆張り」(AI の自己申告) と
 *         脚の行「指値 押し目買い・順張り」(コード導出) が同じパネルに並び、正面から矛盾していた。
 *       ■ なぜ **ラベル全体** を落とすのか(語だけ削らない)
 *         対象は一覧7語のうち「ブレイク順張り」「節目の逆張り」の2つだけで、どちらも
 *         語を抜くと「ブレイク」「節目の」という **意味の残らない断片** になる
 *         (「節目の」は日本語として壊れており、新しい語彙を作ることにもなる)。
 *         しかも落とした情報は画面から消えない: 脚の行が「押し目買い/戻り売り/ブレイク新規」と
 *         「順張り/逆張り」を **両方** 出しているので、この2ラベルの内容は完全に含まれている。
 *       ■ ★トレードオフ(承知の上): AI の申告とコード導出が **食い違った回** は画面から見えなくなる。
 *         その不一致は台帳で測る(signal_plans.strategy = AI の生値 / trend_dir = コードの測定値)。
 *         画面で不安定な自己申告を出すより、台帳で数えるほうがこの2つの比較には適している。
 *       ■ ★落とす条件は「stance が確定していること」(2周目の裁定の修正)。
 *         最初の版は trendDir を見ずに落としていたため、**矛盾しようがない回でも落ちていた**:
 *           trendDir='flat' で AI が「ブレイク順張り」→ 目線行は「買い目線」だけ・
 *           脚の行も「指値 押し目買い ／ 逆指値 ブレイク新規」(stance 未確定で語なし)
 *           = 画面から順張り/逆張りの情報が **純減** していた。
 *         ⇒ stance が確定している(trendDir='up'|'down')回だけ落とす。未確定なら AI のラベルを残す
 *           (不安定な自己申告でも、何も無いよりは読み手の材料になる)。
 *       ■ ★「食い違うときだけ落とす」にしなかった理由(2つ)
 *         ① 一致していても **同じ語が上下2行に重複** するので、落としたほうが読みやすい。
 *         ② 一致/不一致の判定は、AI のラベルから stance を逆算する必要がある。一覧外の生値
 *           (「強い上昇の順張りで攻める」等)では逆算が不安定で、**同じ状況で出たり出なかったり** する。
 *           落とす条件が入力の書き方に依存すると、画面の挙動が説明できなくなる。
 *       ■ 一覧外の生値も同じ規約(語を含むかどうかだけで判定=リストに依存しない)。
 *         「順張り/逆張り」を含まないラベル(トレンド押し目・戻り / レンジ内 / …)は **常に** 従来どおり出る。 */
const STANCE_WORDS = ['順張り', '逆張り'] as const;

/** @param stanceDecided 脚の行に順張り/逆張りが出ているか(=core の entryStance が値を返したか)。
 *   ★呼び出し側が core/entryLabel.ts の entryStance で判定して渡す(規約の権威を web に複製しない)。
 *   レンジ両面は脚のラベル行そのものが無いので **常に false**(=AI のラベルは落とさない)。 */
export function withStrategyLabel(bias: string, strategy?: string, stanceDecided = false): string {
  // ★(a) AI 生成文字列は例外なく検算を落としてから見る(空になったら足さない)。
  const label = cleanAiText(strategy);
  if (!label) return bias;
  // ★(b) stance が確定している回だけ、順張り/逆張りの語を含むラベルを落とす(矛盾/重複を並べない)。
  if (stanceDecided && STANCE_WORDS.some(w => label.includes(w))) return bias;
  if (bias.includes(label)) return bias;   // ★既に出ている語を二度書かない。
  return `${bias}・${label}`;
}

/** 節目の行の区切り(2脚あるとき)。★既存の語彙に無い記号なので、ここでだけ定義する。 */
const BASIS_SEP = ' ／ ';

/** 純関数: そのエントリー価格が節目の「内側」か「外側」か、と距離[円]。★AI には書かせない=ここで計算する。
 *
 *  ■ 定義(★4象限すべてを数直線で確かめたもの。取り違えると画面が嘘をつく)
 *    「内側」= 節目から見て **現在値の側**(まだ節目に届いていない) / 「外側」= 節目を越えた側。
 *    指値(押し目/戻り)は現在値の手前に置くので、節目の内側に置くのが契約。
 *    ブレイク新規(逆指値)は節目を抜けたら乗るので、節目の外側に置くのが契約。
 *
 *      買い・指値      : 節目(支持)は下。現在値は上。 entry > level  → 内側
 *          … 68,700(節目) ── 68,725(指値) ── 現在値 →
 *      買い・逆指値    : 節目(抵抗)は上。現在値は下。 entry > level  → 外側
 *          … ← 現在値 ── 68,775(節目) ── 68,780(逆指値) …
 *      売り・指値      : 節目(抵抗)は上。現在値は下。 entry < level  → 内側
 *          … ← 現在値 ── 68,775(指値) ── 68,800(節目) …
 *      売り・逆指値    : 節目(支持)は下。現在値は上。 entry < level  → 外側
 *          … 68,695(逆指値) ── 68,700(節目) ── 現在値 →
 *
 *    ⇒ 「向きの先へ出ているか」(buy なら entry>level / sell なら entry<level)を beyond とすると、
 *       指値は beyond=内側・ブレイク新規は beyond=外側 で、**脚の種類で反転するだけ**。
 *  ■ 距離が(丸めて)0 のときは内も外も無いので「ちょうど」と書く(嘘の向きを作らない)。
 *    価格は5円刻みなので、実際に起きるのは「節目そのものに置いた」回だけ。 */
export function basisTail(
  direction: 'buy' | 'sell', kind: 'limit' | 'stop', entry: number, level: number,
): string {
  const d = Math.round(Math.abs(entry - level));
  if (d === 0) return 'ちょうど';
  const beyond = direction === 'buy' ? entry > level : entry < level;
  const word = beyond === (kind === 'limit') ? '内側' : '外側';
  return `の ${fmtPrice(d)}円${word}`;
}

/** 純関数: 「なぜこの価格なのか」の行を組み立てる(★依頼の本体)。
 *
 *    指値 ← 68,700 の 25円内側 ／ 逆指値 ← 68,775 の 5円外側
 *
 *  ・この仕組みの価格は必ず節目から導かれる契約(指値=節目の内側 / ブレイク新規=節目の外側)なので、
 *    **どの節目を使ったか** が「なぜこの価格か」の答えになる。節目は AI が数値で申告し(limitLevel/stopLevel)、
 *    内側/外側と距離は **ここで計算する**(AI の文章にはしない=検算に押し出されない・嘘を書けない)。
 *  ・節目の申告が無い脚は **その脚を出さない**(「不明」とは書かない)。
 *  ・両方とも無ければ空文字を返す=呼び出し側は行ごと出さない(従来の表示と byte 一致)。
 *  ・エントリー価格が無い脚も出さない(落ちた脚の節目だけを孤立して見せない)。
 *  ・レンジ両面(mode='range')は対象外: 節目のフィールドは指値/ブレイク新規の2脚に対応しており、
 *    上下2レッグへの対応づけが無いため、憶測で結びつけない。 */
export function buildLevelBasis(
  direction: 'buy' | 'sell',
  legs: { limitEntry?: number; limitLevel?: number; stopEntry?: number; stopLevel?: number },
): string {
  const parts: string[] = [];
  const push = (name: '指値' | '逆指値', kind: 'limit' | 'stop', entry?: number, level?: number): void => {
    if (entry == null || level == null) return;
    if (!Number.isFinite(entry) || !Number.isFinite(level)) return;
    parts.push(`${name} ← ${fmtPrice(level)} ${basisTail(direction, kind, entry, level)}`);
  };
  push('指値', 'limit', legs.limitEntry, legs.limitLevel);
  push('逆指値', 'stop', legs.stopEntry, legs.stopLevel);
  return parts.join(BASIS_SEP);
}

/** 位置の規約に反した脚に付ける印。**無言で正常に見せない**ためのもの(この規範はプロジェクトの決め事)。
 *  ・記号は既存の警告と同じ絵文字を使わない代わりに、`⚠` 1文字だけ足す(新しい語彙を作らない)。
 *  ・文言「エントリーが現在値の逆側」は **server/llm/scalpPlan.ts の legDropReasonText('geometry') の写し**。
 *    web は server を import できないので写しになっている(core/rationaleDisplay.ts と同じ事情)。
 *    ずれると「発生源が落とした理由」と「画面が言う理由」が別の言葉になるので、直すときは両方見ること。 */
const WRONG_SIDE_MARK = '⚠';

/** 順張り/逆張りが出ない回に添える注記の書式(★新しい語彙も新しい書式も作らない)。
 *  書式「（○○なし: 理由）」は既存の脚 drop 注記(server/llm/scalpPlan.ts の legDropPhrase =
 *  「（指値なし: AIが提案せず）」)と同じもの。理由の語は core/entryLabel.ts が
 *  formatMomentumLine から持ってくる(出所はそちらのコメント)。
 *
 *  ■ ★なぜ要るか(実測): 語が出る率は ARM 時刻で 46.4% = **半分の回は語が出ない**。
 *    しかも日ごとのばらつきが大きく「一日中まったく語が出ない日」が実在する(最小 0.0%)。
 *    注記が無いと「なぜ付かないのか」が画面から読めず、ユーザーは表示の不具合と区別できない
 *    (=このプロジェクトが禁じている無言の失敗)。
 *  ■ 位置: **脚の行の末尾に1回だけ**。脚ごとに付けると同じ語が2回出る(理由はシグナル全体のもので、
 *    脚ごとに違う値にはならない)。 */
const stanceNote = (reason: string): string => `（順張り/逆張りなし: ${reason}）`;
const WRONG_SIDE_TEXT = 'エントリーが現在値の逆側';

/** 純関数: 脚のラベルの行を組み立てる(★AI には聞かない=direction と脚の種別だけで一意に決まる)。
 *
 *      指値 押し目買い・逆張り ／ 逆指値 ブレイク新規・順張り
 *
 *  ■ 節目の行との共存(★判断と理由)
 *    **別の行にして、節目の行の1つ上に置く**。理由は3つ:
 *     ① 節目の行(「指値 ← 68,700 の 25円内側」)は **AI が節目を申告した回だけ** 出る。
 *       ラベルは常に導出できるので、同じ行に混ぜると申告の無い回にラベルごと消える。
 *     ② 級が違う: ラベル=「この脚は何か」(定義から一意) / 節目=「なぜこの価格か」(AI の申告が入る)。
 *       混ぜると「どこまでがコードの断定で、どこからが AI の言い分か」が読めなくなる。
 *     ③ 既存の行を **1バイトも変えない**(basisTail / buildLevelBasis は無修正)=退行の危険が無い。
 *    区切りは節目の行と同じ BASIS_SEP、脚名も同じ「指値」「逆指値」(上下で列が揃う)。
 *
 *  ■ 位置が規約に反していたとき(entryPositionOk === false)
 *    その脚を **黙って正常に見せない**。ラベルの後ろに `⚠ エントリーが現在値の逆側（ARM時 68,700）`
 *    を付ける(行ごと消さない: 消すと「なぜ出ないのか」が画面から分からない=同じ無言の失敗)。
 *    ★発生源(scalpPlan の parse/enforce)が同じ規約で既に落としているので、これが出たら
 *      **発生源と画面のどちらかが壊れている**(例: 古い armed を描いている / refPrice の渡し間違い)。
 *
 *  ■ refPrice が無い/非有限の回は **検査を出さない**(ラベルだけ出す)。
 *    entryPositionOk は材料が無いと true を返す(fail-safe)が、それを「合格」として見せるのは嘘。
 *
 *  ■ レンジ両面(mode='range')は対象外。節目の行と同じ線引きに揃える
 *    (上下のレッグはメイン行に `(上)`/`(下)` と side/type が既に出ており、レンジ自体が
 *     実験終了の既定OFF。ここでだけ別の線引きを作らない)。 */
export function buildEntryStance(
  direction: 'buy' | 'sell',
  legs: { limitEntry?: number; stopEntry?: number; refPrice?: number; trendDir?: EntryTrendDir },
): string {
  const parts: string[] = [];
  const ref = legs.refPrice;
  const checkable = typeof ref === 'number' && Number.isFinite(ref);
  const push = (name: '指値' | '逆指値', kind: 'limit' | 'stop', entry?: number): void => {
    if (entry == null || !Number.isFinite(entry)) return;
    // ★順張り/逆張りは **トレンドの向き × 売買の向き** で決まる(core/entryLabel.ts)。
    //   トレンドが取れない/横這い/競合 の回は label.text に語が付かない(断定しない)。
    const label = entryLabel(direction, kind, legs.trendDir);
    let text = `${name} ${label.text}`;
    if (checkable && !entryPositionOk(direction, kind, entry, ref)) {
      text += ` ${WRONG_SIDE_MARK} ${WRONG_SIDE_TEXT}（ARM時 ${fmtPrice(ref)}）`;
    }
    parts.push(text);
  };
  push('指値', 'limit', legs.limitEntry);
  push('逆指値', 'stop', legs.stopEntry);
  if (parts.length === 0) return '';
  // ★語が出なかった回は、なぜ出ないのかを1語だけ添える(無言にしない)。
  //   trendDir 欠落(旧版 server / 凍結再生)では注記も出さない=従来と byte 一致(core 側のコメント参照)。
  const why = entryStanceUnknownReason(legs.trendDir);
  return why ? `${parts.join(BASIS_SEP)} ${stanceNote(why)}` : parts.join(BASIS_SEP);
}

/** ★v0.9.88: AI 生成の理由文を **画面に出す直前の1箇所** で整える(純関数)。
 *  ・LC検算を落とす(生成側のプロンプトは1文字も変えない=符号の保持に効いている)。
 *  ・剪いだ結果が「検算しか無かった」(NO_REASON)なら **空扱い** にして返す
 *    (「無い」をどう見せるかは呼び出し側が決められるようにする)。
 *  ★これが必要な理由: strategyWhy は従来 stripLcArithmetic を **通っていなかった** ので、
 *    目線の行に LC の検算がそのまま出る経路が残っていた。新しい理由の箱も同じ穴を開けないよう、
 *    **AI 生成文は例外なくこの関数を通す**。 */
export function cleanAiText(text?: string | null): string {
  const out = stripLcArithmetic(text);
  return out === NO_REASON ? '' : truncateForDisplay(out);
}

/** 画面に出す1つの理由の長さの上限[文字]。
 *  ★出所: server/signalTrade/planLedger.ts の PLAN_RATIONALE_MAX_CHARS(=2000)の **写し**。
 *    web は server を import できないので写しになっている(core/rationaleDisplay.ts と同じ事情)。
 *  ★台帳と同じ値にする理由: 台帳が 2000 で切るので、画面がそれより長い文字列を受け取ることは
 *    本来ない。ここは「SSE は台帳を経由しない」ぶんの保険で、**台帳と画面で切り方が食い違わない**
 *    ようにする(2つの上限が別の値だと「どちらで切られたのか」が読めなくなる)。
 *  ★★なぜ 2000 のままにしたか(★上限で理由を痩せさせない)
 *    理由の実測は **平均56字・最長でも100字未満**(検証台・「1行」を書かない契約)。
 *    2000 はその **20〜36倍** で、正常な理由には事実上効かない=測りたい量を1文字も削らない。
 *    守っているのは LLM の暴走出力(同じ文の反復・プロンプトの丸写し)だけ。
 *    ★実測に寄せて 100〜200 のような値にはしない: 理由の分布はこれから変わる(箱を分けた直後で
 *      標本が検証台しかない)ので、**測る前に上限で頭を切ると「伸びたのか切られたのか」が
 *      分からなくなる**。新しい数値を作らず既存の安全弁と同じ値を共有するのが、いま最も安全。 */
const DISPLAY_MAX_CHARS = 2000;

/** 切り詰めが起きたときだけ末尾に付く印。
 *  ★出所: server/signalTrade/planLedger.ts の PLAN_RATIONALE_TRUNCATED_MARK の写し(同上)。
 *  ★無言で削らないための印。これが無いと「AI が短く書いた」のか「画面が削った」のか区別できない。 */
export const DISPLAY_TRUNCATED_MARK = '…[切詰]';

/** 上限を超えた理由文を切り詰め、切ったことが分かる印を付ける(純関数)。
 *  ★実害: 上限が無いと 5,000字の理由が1つの div に入り、シグナル枠が画面を埋め尽くす。 */
function truncateForDisplay(text: string): string {
  if (text.length <= DISPLAY_MAX_CHARS) return text;
  return text.slice(0, Math.max(0, DISPLAY_MAX_CHARS - DISPLAY_TRUNCATED_MARK.length)) + DISPLAY_TRUNCATED_MARK;
}

/** 理由の行のラベル(★新しい語彙を作らない)。
 *  「目線」= BIAS_JA(目線行)の語 / 「指値」「逆指値」= メイン行の脚名 /
 *  「LC」= メイン行の (LC 68,665) と同じ語。 */
const WHY_LABEL = { bias: '目線', limit: '指値', stop: '逆指値', lc: 'LC' } as const;

/** ★v0.9.88(今回の本命): **レッグごとの理由** の行を組み立てる純関数。
 *
 *      目線: 直近安値を切り上げ、21日線を上抜けた
 *      指値: 68,650 の支持帯まで引きつける ／ LC: 直近安値の外側
 *      逆指値: 68,775 を抜けたら追随 ／ LC: 節目の内側に戻る幅
 *
 *  ■ なぜ箱を分けるか(★今回の追加の目的そのもの)
 *    本番の rationale は **プラン全体で1本** しか無いのに、脚は2本ある。
 *    実測でその1本は LC の検算に埋め尽くされており(直近 89.5%)、画面に理由が残らない。
 *    箱を分けると理由の量が増えるという実測(1脚あたり 59字 → 107字)に基づく。
 *
 *  ■ ★「無い」の見せ方(無言の失敗を作らない と 従来表示の保存 を両立させる)
 *    ① 理由のフィールドが **1つも来ていない** → **何も出さない**(空配列)。
 *       これは「この版を知らない server / 旧い記録」の形で、従来の表示と byte 一致になる。
 *    ② **1つでも来ているが、実質の中身がどの枠にも無い** → **1行に畳む**(NO_REASON 1本)。
 *       ★実測で理由が書かれない率は 75%。つまり ② は例外ではなく **標準的な見え方** で、
 *         枠ごとに出すと「（理由の記載なし）」が4行連続する(枠名は情報を1ビットも足していない)。
 *       ★畳んでも「書かれていない」という事実は消えない(1行は必ず出る)。
 *    ③ **一部の枠にだけ中身がある** → **畳まず枠ごとに出す**。
 *       このときは「どの枠が書かれていないか」が情報になる(目線は書いたが LC は書かなかった 等)。
 *       畳むとその差が消えるので、②(全部空)と ③(一部空)で扱いを分けている。
 *    ★LC検算しか書かれていない枠も「空」として数える(cleanAiText が空にする)。
 *
 *  ■ 脚の行は **実際に出ている脚だけ** 出す(落ちた脚の理由を孤立して見せない=
 *    節目の行 buildLevelBasis と同じ規約)。台帳側には落ちた脚の理由も残る。
 *
 *  ■ レンジ両面(mode='range')は対象外。理由のフィールドは指値/ブレイク新規の2脚に対応しており、
 *    上下2レッグへの対応づけが無い(節目の行と同じ線引き)。 */
export function buildWhyLines(sig: {
  limitEntry?: number; stopEntry?: number;
  directionWhy?: string; entryWhyForLimit?: string; entryWhyForStop?: string;
  lcWhyForLimit?: string; lcWhyForStop?: string;
}): string[] {
  const raw = [sig.directionWhy, sig.entryWhyForLimit, sig.entryWhyForStop, sig.lcWhyForLimit, sig.lcWhyForStop];
  // ① 1つも来ていない(旧版 server / 旧い記録) → 行ごと出さない。
  if (raw.every(v => v === undefined)) return [];
  // ② 来てはいるが実質の中身がどの枠にも無い → 1行に畳む(4行の「（理由の記載なし）」を作らない)。
  //    ★判定は「画面に出す形」で行う(cleanAiText 後)。検算しか書いていない枠は中身なしと数える。
  const cleaned = raw.map(v => cleanAiText(v));
  if (cleaned.every(v => v === '')) return [NO_REASON];
  const shown = (v?: string): string => cleanAiText(v) || NO_REASON;
  const out: string[] = [WHY_LABEL.bias + ': ' + shown(sig.directionWhy)];
  const leg = (name: string, entry?: number, entryWhy?: string, lcWhy?: string): void => {
    if (entry == null || !Number.isFinite(entry)) return;
    out.push(name + ': ' + shown(entryWhy) + BASIS_SEP + WHY_LABEL.lc + ': ' + shown(lcWhy));
  };
  leg(WHY_LABEL.limit, sig.limitEntry, sig.entryWhyForLimit, sig.lcWhyForLimit);
  leg(WHY_LABEL.stop, sig.stopEntry, sig.entryWhyForStop, sig.lcWhyForStop);
  return out;
}

/** 純関数: 理由の行を組み立てる(strategyWhy + LC検算を落とした rationale)。
 *
 *  ■ 出し方の決定と、その理由(★指示どおりコメントに残す)
 *    **strategyWhy を先に、rationale の残りをその後の行に置く**。理由は3つ:
 *     ① strategyWhy は「何を狙ったか」= 目線行に添えたラベルの直接の説明で、ラベル→説明の順に読める。
 *     ② rationale は LC検算を落とした残りかす(実測で89.5%は検算だけ)なので、先頭に置くと
 *        「読み」に辿り着く前に価格の断片を読まされる。
 *     ③ 別の行にするのは、コード側の注記(`※…は不採用`)と同じ既存の作法(1要素に `\n` を入れると
 *        CSS で改行が潰れて本文に埋もれる)。paintPanel が行ごとに div を作る。
 *    ★重複対策: rationale の行が strategyWhy と(trim して)**完全一致** するときだけ落とす。
 *      部分一致や類似での間引きはしない(AI の判断理由の本文を落とさない、という既存の規範を優先)。
 *
 *  ■ 「（理由の記載なし）」を出す条件(★縮退の要)
 *    strategyWhy が在るなら **決して出さない**(読みは書かれている)。
 *    出るのは「strategyWhy が無く、かつ rationale が LC検算しか含まない」回だけ。
 *    ★strategyWhy が無いときの戻り値は `stripLcArithmetic(rationale)` と **byte 一致**(従来表示に完全縮退)。 */
export function buildRationaleView(rationale?: string, strategyWhy?: string): string {
  const stripped = stripLcArithmetic(rationale);
  // ★v0.9.88(穴を塞ぐ): strategyWhy はこれまで stripLcArithmetic を **通っていなかった**。
  //   つまり「AI の読み」の行に LC の検算がそのまま出る経路が残っていた。
  //   剪いだ結果が空(=検算しか書いていなかった)なら **why は無いものとして扱う**
  //   ⇒ その回は従来どおり rationale 単独の経路(必要なら NO_REASON)へ縮退する。
  const why = cleanAiText(strategyWhy);
  if (!why) return stripped;   // ★従来経路: 1バイトも変えない。
  // 「（理由の記載なし）」は本文ではなく「本文が無い」という印なので、why が在る回では捨てる。
  const body = stripped === NO_REASON ? '' : stripped;
  const rest = splitRationaleLines(body).filter(line => line !== why);
  return [why, ...rest].join('\n');
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
    return {
      cls: 'armed',
      bias: withStrategyLabel('レンジ', sig.strategy),
      main: `🎯 レンジ：${parts.join(' / ')}`,
      rationale: buildRationaleView(sig.rationale, sig.strategyWhy),
    };
  }

  const lcTag = (lc?: number): string => (lc != null ? ` (LC ${fmtPrice(lc)})` : '');
  const legs: string[] = [];
  if (sig.limitEntry != null) legs.push(`${dirJa(sig.direction)} ${fmtPrice(sig.limitEntry)} 指値${lcTag(sig.stopLossForLimit)}`);
  if (sig.stopEntry != null) legs.push(`${dirJa(sig.direction)} ${fmtPrice(sig.stopEntry)} 逆指値${lcTag(sig.stopLossForStop)}`);
  if (legs.length === 0) return { cls: 'flat', main: waitMain(), rationale: '' };
  // ★ドテン(反転)シグナルは目線行に明示(通常の決済→別の新規と区別できるように)。
  const dirBias = sig.direction === 'buy' ? '買い目線' : '売り目線';
  const bias = sig.doten ? `🔃 ドテン(反転)・${dirBias}` : dirBias;
  // ★v0.9.87: 節目の行。**表示に出ている価格**(丸め後の武装値)と AI の申告節目から距離を出すので、
  //   画面の中で辻褄が合う(メイン行の 68,725 と「68,700 の 25円内側」が同じ値を指す)。
  const basis = buildLevelBasis(sig.direction, {
    limitEntry: sig.limitEntry, limitLevel: sig.limitLevel,
    stopEntry: sig.stopEntry, stopLevel: sig.stopLevel,
  });
  // ★v0.9.88: 脚のラベルの行(コードが導出・AI には聞かない)。refPrice が在る回は位置の検査も乗る。
  const stance = buildEntryStance(sig.direction, {
    limitEntry: sig.limitEntry, stopEntry: sig.stopEntry, refPrice: sig.refPrice, trendDir: sig.trendDir,
  });
  // ★v0.9.88: レッグごとの理由の行(本命)。理由が1つも来ていなければ空配列=行ごと出ない。
  const whys = buildWhyLines(sig);
  const view: PanelView = {
    cls: 'armed',
    // ★ドテン表示の書式は壊さない: ラベルは既存の目線行の **後ろ** に同じ `・` で足すだけ。
    //   ただし既に出ている語は足さない(ドテンで「ドテン」が2回出ていた重複を withStrategyLabel が潰す)。
    // ★stance が確定している回だけ AI のラベルから順張り/逆張りを落とす(判定は core が権威)。
    bias: withStrategyLabel(bias, sig.strategy, entryStance(sig.direction, sig.trendDir) !== undefined),
    main: `🎯 シグナル：${legs.join(' / ')}`,
    rationale: buildRationaleView(sig.rationale, sig.strategyWhy),
  };
  // ★申告が1つも無ければ **フィールドごと付けない** = 従来の PanelView と byte 一致(否定対照)。
  if (basis) view.basis = basis;
  // ★脚のラベルも同じ規約(脚が1本も無ければフィールドごと付けない)。
  //   ただし legs.length===0 は上で flat に落ちているので、実際には必ず1本以上入る。
  if (stance) view.stance = stance;
  // ★理由の行も同じ規約(1行も無ければフィールドごと付けない=旧版の記録では従来と byte 一致)。
  if (whys.length) view.whys = whys;
  return view;
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
  // ★v0.9.88: 脚のラベルの行 → 節目の行 の順で、理由の後ろに続ける。
  //   「この脚は何か(定義から一意)」→「なぜこの価格か(AI の申告)」の順に読める。
  // ★v0.9.88: レッグごとの理由 → 脚のラベル → 節目、の順。
  //   「なぜこの目線・この価格・この損切りか」→「この脚は何か」→「どの節目か」。
  // ★理由は AI の自由文なので **改行を含みうる**。1要素に入れると CSS(white-space:normal)で
  //   改行が潰れて1行に繋がる(splitRationaleLines の冒頭が書いている、まさにその事故)。
  //   rationale と同じ扱いにする=行ごとに別要素で描く。
  if (view.whys) lines.push(...view.whys.flatMap(splitRationaleLines));
  if (view.stance) lines.push(view.stance);
  // ★v0.9.87: 節目の行は理由の **最後の行** として同じ枠に描く(専用のスタイルを増やさない)。
  //   これはコードが計算した文字列だが、描き方は他の行と同じ textContent(作法を分岐させない)。
  if (view.basis) lines.push(view.basis);
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
