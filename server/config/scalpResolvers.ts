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
  return v === 'long' || v === 'short' ? v : 'none';
}

// AIエントリー: レンジ両面ストラドルの許可。★実験終了(v0.7.53)により既定OFF。
// 未設定/非boolean は false(実験終了・紙計測で不利=フェードを既定で出さない)。true で再有効化可(コード温存)。
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

/** バイアス directive。value='long'|'short'|'none'。ai=方向veto無効(自由方向)。 */
export function resolveScalpBiasDirective(profile?: SignalProfile): KnobDirective<ScalpBias> {
  return { mode: parseKnobSource(readKnobRaw(profile, 'scalpBiasSource')), value: resolveScalpBias(profile) };
}

/** レンジ両面 directive。value=on/off(bool)。ai=range 採用可否を AI が決める(range許可)。 */
export function resolveScalpRangeDirective(profile?: SignalProfile): KnobDirective<boolean> {
  return { mode: parseKnobSource(readKnobRaw(profile, 'scalpRangeSource')), value: resolveScalpRangeEnabled(profile) };
}

/** ★LC安全上限(policy とは独立の安全系)。enabled のとき手動/AI とも超過レッグを落とす。
 *  enabled 未設定は true(既定で安全網ON)。value 未設定は PARAM_BOUNDS 既定(159)。 */
export function resolveScalpLcHardMax(profile?: SignalProfile): { enabled: boolean; value: number } {
  const v = readKnobRaw(profile, 'scalpLcHardMaxEnabled');
  return { enabled: typeof v === 'boolean' ? v : true, value: resolveNumericProfile(profile, 'scalpLcHardMaxYen') };
}
