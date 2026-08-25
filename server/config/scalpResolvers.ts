// AIエントリー(scalp-plan)の knob リゾルバ群。
// configStore.ts の純粋な切り出し(挙動・既定・境界は一切変えない)。configStore が re-export するため、
// 既存 importer は従来どおり './configStore.js' から使える。
//
// ★v0.8.2: 各リゾルバは SignalProfile 対応。profile 省略/'A'=グローバル(既存挙動一致) /
//   'B'=signalB 優先→未設定はグローバルへフォールバック(読み取りは readKnobRaw / resolveNumericProfile が担う)。

import { readKnobRaw, resolveNumericProfile, loadConfig } from '../configStore.js';
import type { ScalpBias, KnobSource, SignalProfile } from '../configStore.js';

// AIエントリー: 最大初期LC(円)。未設定は PARAM_BOUNDS 既定(65)。buildScalpPlan の LC 上限既定に使う。
// ★v0.8.2: profile 省略/'A'=グローバル(既存挙動一致) / 'B'=signalB 優先→未設定はグローバルへフォールバック。
export function resolveScalpLcCeiling(profile?: SignalProfile): number { return resolveNumericProfile(profile, 'scalpLcCeilingYen'); }

// AIエントリー: 決済後の再ARM抑止秒数。未設定は PARAM_BOUNDS 既定(90)。0で無効。
export function resolveScalpCooldownSec(profile?: SignalProfile): number { return resolveNumericProfile(profile, 'scalpCooldownSec'); }

// AIエントリー: トレンド veto 閾値(円)。未設定は PARAM_BOUNDS 既定(100)。0で無効(veto しない=現行挙動)。
// 直近10分でこの円以上動いていたらトレンドと見なし、逆行するフェード新規(scalp-plan)を落とす。
export function resolveScalpTrendVetoYen(profile?: SignalProfile): number { return resolveNumericProfile(profile, 'scalpTrendVetoYen'); }

// AIエントリー: バイアス。未設定/不正値は 'none'(両方向)。
export function resolveScalpBias(profile?: SignalProfile): ScalpBias {
  const v = readKnobRaw(profile, 'scalpBias');
  // ★2026-08-25: 'range'(レンジ目線)を選べるようにした。未知/未設定は 'none'(=目線を固定しない)。
  return v === 'long' || v === 'short' || v === 'range' ? v : 'none';
}

/** ★2026-08-25(ユーザー指示): **こちらが決めた目線**(A の答えの語彙 buy/sell/range)。null=決めていない。
 *
 *  ■ ユーザー指示(逐語)
 *    「『手動』については、『買い目線』『売り目線』『レンジ』の3つを選択肢とし、
 *      プロンプトAはAIに渡さず、表示は理由なしで、選択された目線を表示してください。
 *      目線に応じた、プロンプトBのみをAIに渡します。」
 *  ■ これが null でないとき、A(目線を尋ねる呼び出し)は **1度も行われない**。
 *    ★AI の呼び出しが2回→1回になる(課金と待ち時間は減るはずだが、実測は運用後)。
 *  ■ ★★レンジ目線は ①「目線がAI委任の場合、レンジを許可」に **依存しない**(2026-08-25 ユーザー訂正)。
 *    ①は「**AI に** range という選択肢を見せるか」の設定。手動目線では A を1度も呼ばないので、
 *    ①は関係がない。★私は一度 ①に依存させ、①OFF のとき手動レンジが常に見送りになる穴を作った。
 *  ■ ★プロンプトのルートは5つ(ユーザー確定):
 *      ①AI委任+レンジON → A(3択)+B / ②AI委任+レンジOFF → A(2択)+B
 *      ③手動+買い目線 → B(buy)のみ / ④手動+売り目線 → B(sell)のみ
 *      ⑤手動+レンジ目線 → B(range-*)のみ(★レンジON/OFFに依存しない) */
export function resolveForcedTrend(profile?: SignalProfile): 'buy' | 'sell' | 'range' | null {
  const d = resolveScalpBiasDirective(profile);
  return forcedTrendFrom(d.mode, d.value);
}

/** ★判定の本体(純関数・**唯一の実装**)。設定を読む側(resolveForcedTrend)と、
 *  既に解決済みの値を持っている側(buildScalpPlan は override 適用後の bias と実効 rangeEnabled を持つ)の
 *  両方から呼ぶ。★2つ書くと片方だけ直す事故になるのでここに1つだけ置く。 */
export function forcedTrendFrom(mode: KnobSource, bias: ScalpBias): 'buy' | 'sell' | 'range' | null {
  if (mode !== 'manual') return null;
  if (bias === 'long') return 'buy';
  if (bias === 'short') return 'sell';
  // ★レンジ目線は「目線がAI委任の場合、レンジを許可」に依存しない(A を呼ばないので①は無関係)。
  if (bias === 'range') return 'range';
  return null;   // 'none' = 目線を固定しない(レガシー既定)
}

/** ★実効の売買バイアス(=画面で言う「買い目線 / 売り目線」)。
 *  手動(mode='manual')なら保存値をそのまま、AI委任(mode='ai')なら **'none'**(方向の強制なし)を返す。
 *  ★この分岐は buildScalpPlan の `bias = biasD.mode === 'manual' ? … : 'none'` と同じ規則
 *   (AI に委任した項目の保存値は効かない、という既存の約束)。バンドウォーク判定が「システムが実際に
 *   veto に使う向き」と食い違わないよう、同じ規則をこの1関数に名前を付けて置く。 */
export function resolveEffectiveScalpBias(profile?: SignalProfile): ScalpBias {
  const d = resolveScalpBiasDirective(profile);
  return d.mode === 'manual' ? d.value : 'none';
}

// AIエントリー: レンジ両面ストラドルの許可。★実験終了(v0.7.53)により既定OFF。
// 未設定/非boolean は false(実験終了・仮想取引での計測で不利=フェードを既定で出さない)。true で再有効化可(コード温存)。
export function resolveScalpRangeEnabled(profile?: SignalProfile): boolean {
  const v = readKnobRaw(profile, 'scalpRangeEnabled');
  return typeof v === 'boolean' ? v : false;
}

// ★AIエントリー 初期LC幅の下限(円)。未設定は PARAM_BOUNDS 既定(55)。
//   プロンプトに加えて **コードで強制**する(enforcePlanConstraints が下限未満のレッグを落とす)。
export function resolveScalpLcFloorYen(profile?: SignalProfile): number { return resolveNumericProfile(profile, 'scalpLcFloorYen'); }

// ★ドテン(反転)許可。ON=「AIが保有中に反転を判断してよい」(=AI判断)。OFF(既定)=ドテンを出さない=既定で挙動不変。
//   未設定/非boolean は false(既定OFF)。monitor2(full)専用の設定 UI でのみ切り替える(engine は値を読むだけ)。
export function resolveScalpDotenEnabled(profile?: SignalProfile): boolean {
  const v = readKnobRaw(profile, 'dotenEnabled');
  return typeof v === 'boolean' ? v : false;
}

// ★レンジ両指値が平均以上未約定 → ブレイク再評価の許可。既定 ON(レンジ有効時のみ実効=レンジ自体は既定OFF)。
//   未設定/非boolean は true(既定ON)。個別に false で無効化できる(=本経路を完全に不活性=挙動不変)。
export function resolveScalpRangeReevalEnabled(profile?: SignalProfile): boolean {
  const v = readKnobRaw(profile, 'rangeReevalEnabled');
  return typeof v === 'boolean' ? v : true;
}

// ★テクニカル指標(RSI/SMA/BB)パネル + AI へのテクニカル文脈供給。未設定/非boolean は true(既定ON)。
//   false にするとパネル描画・indicatorsLoop の SSE 配信・AI 文脈のテクニカルブロックを止める(表示/文脈のみ・検知は無関係)。
export function resolveIndicatorsEnabled(): boolean {
  const v = loadConfig().indicatorsEnabled;
  return typeof v === 'boolean' ? v : true;
}

// ★AIテクニカル許可。ON=AI が RSI/BB を「エントリーのタイミング」判断に使ってよい(system prompt に許可行を追記)。
//   ★決済(手仕舞い)は既定の決済ロジックが担当する=AI には委ねない。
//   未設定/非boolean は true(既定ON)。false=許可行を出さない(byte-safe=従来の system prompt と一致)。profile 対応(B は A へフォールバック)。
export function resolveScalpAiTechnicalEnabled(profile?: SignalProfile): boolean {
  const v = readKnobRaw(profile, 'aiTechnicalEnabled');
  return typeof v === 'boolean' ? v : true;
}

// ★チャート撮影失敗(ws-error 等)時の縮退運転。既定 ON=撮影が2回失敗しても「テキストのみ」で AI を継続し
//   取引を止めない(2026-07-27 のチャートws-error+429で全停止した事故対策)。false=ストリクト vision
//   (撮影不可なら見送り=従来挙動)。チャートは A/B 共有なのでグローバル設定(profile 非依存)。
export function resolveScalpChartFallbackText(): boolean {
  const v = loadConfig().scalpChartFallbackText;
  return typeof v === 'boolean' ? v : true;
}

// ★v0.9.70: チャート画像を AI に送るか(グローバル・A/B共有)。
//   'off'(既定) … 1枚も送らない。★撮影(ヘッドレスChrome)自体も行わない。
//   'ab'        … サイクルごとにランダムで半分だけ送る(画像の効き目を測るための対照群を作る)。
//   ★「全量」は意図的に用意しない。実測で 1日約1,600回の画像付き呼び出しが OpenAI 課金の主因
//     (1280x760・detail 未指定=高精細・gpt-4o-mini は画像の換算率が極端に高い)。二度と全額を払わない形にする。
//   ★未設定/不正値は必ず 'off'。「知らない値なら安全側(送らない)」に倒す=課金は fail-safe でなければならない。
export type ChartVisionMode = 'off' | 'ab';
export function resolveScalpChartVisionMode(): ChartVisionMode {
  return loadConfig().scalpChartVisionMode === 'ab' ? 'ab' : 'off';
}

/** 設定値を寛容にパースする純関数(HTTP body 用)。'ab' 以外は全て 'off'(安全側)。 */
export function parseChartVisionMode(v: unknown): ChartVisionMode {
  return typeof v === 'string' && v.trim().toLowerCase() === 'ab' ? 'ab' : 'off';
}

// ─── v0.7.56: 委任 directive リゾルバ({mode,value}) ───────────────────────
// 各 knob を「手動(数値/enum を強制)」か「AI委任(該当制約を課さない)」で返す。
// source が 'ai' のときだけ ai。それ以外(未設定/'manual'/不正値)は寛容に manual(=既定で現状の挙動)。

export interface KnobDirective<T> { mode: KnobSource; value: T; }

/** source 文字列を寛容にパース。'ai'(大小文字無視)だけ 'ai'、それ以外は 'manual'。 */
export function parseKnobSource(v: unknown): KnobSource {
  return typeof v === 'string' && v.trim().toLowerCase() === 'ai' ? 'ai' : 'manual';
}

// ★v0.8.2: 各 directive も profile 対応。profile 省略/'A'=グローバル(既存挙動一致) /
//   'B'=signalB の source/値を優先し、未設定はグローバルの source/値へフォールバック。

/** 初期LC下限 directive。value=下限(円)。
 *  ★mode は下限の強制可否を変えない(委任対象外='ai' でもコードは下限を強制する。強制が委任に勝つ)。
 *  'ai' で変わるのはプロンプトの文面だけ(「委任対象外で強制する」と明示する)。 */
export function resolveScalpLcFloorDirective(profile?: SignalProfile): KnobDirective<number> {
  return { mode: parseKnobSource(readKnobRaw(profile, 'scalpLcFloorSource')), value: resolveScalpLcFloorYen(profile) };
}

/** 最大初期LC directive。value=上限(円)。ai=上限で落とさない(hardMax は別に効く)。 */
export function resolveScalpLcCeilingDirective(profile?: SignalProfile): KnobDirective<number> {
  return { mode: parseKnobSource(readKnobRaw(profile, 'scalpLcCeilingSource')), value: resolveScalpLcCeiling(profile) };
}

/** トレンドveto directive。value=閾値(円)。ai=数値veto無効(AI自己判断)。 */
export function resolveScalpTrendVetoDirective(profile?: SignalProfile): KnobDirective<number> {
  return { mode: parseKnobSource(readKnobRaw(profile, 'scalpTrendVetoSource')), value: resolveScalpTrendVetoYen(profile) };
}

/** クールダウン directive。value=秒。ai=ゲート無効。 */
export function resolveScalpCooldownDirective(profile?: SignalProfile): KnobDirective<number> {
  return { mode: parseKnobSource(readKnobRaw(profile, 'scalpCooldownSource')), value: resolveScalpCooldownSec(profile) };
}

/** 目線 directive。value='long'(買い)|'short'(売り)|'range'|'none'(固定しない)。ai=AI が目線を決める。 */
export function resolveScalpBiasDirective(profile?: SignalProfile): KnobDirective<ScalpBias> {
  return { mode: parseKnobSource(readKnobRaw(profile, 'scalpBiasSource')), value: resolveScalpBias(profile) };
}

/** ★「目線がAI委任の場合、レンジを許可」(2026-08-25 にタイトルと意味を変更)。
 *  ★**ON/OFF だけ**。AI委任/手動の選択は廃止した(ユーザー指示)ので mode は常に 'manual'。
 *    ★KnobDirective の形自体は残す: buildStrategySpec / persist.ts / settings.ts が
 *      この形で受け取っており、ここだけ形を変えると呼び出し側に分岐が散る。
 *    ★意味は1つ=「ON なら AI に range を渡す / OFF なら range という語ごと出さない」。 */
export function resolveScalpRangeDirective(profile?: SignalProfile): KnobDirective<boolean> {
  return { mode: 'manual', value: resolveScalpRangeEnabled(profile) };
}

/** ★LC安全上限(policy とは独立の安全系)。enabled のとき手動/AI とも超過レッグを落とす。
 *  enabled 未設定は true(既定で安全網ON)。value 未設定は PARAM_BOUNDS 既定(159)。 */
export function resolveScalpLcHardMax(profile?: SignalProfile): { enabled: boolean; value: number } {
  const v = readKnobRaw(profile, 'scalpLcHardMaxEnabled');
  return { enabled: typeof v === 'boolean' ? v : true, value: resolveNumericProfile(profile, 'scalpLcHardMaxYen') };
}
