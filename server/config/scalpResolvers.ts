// AIエントリー(scalp-plan)の knob リゾルバ群。
// configStore.ts の純粋な切り出し(挙動・既定・境界は一切変えない)。configStore が re-export するため、
// 既存 importer は従来どおり './configStore.js' から使える。
//
// ★v0.8.2: 各リゾルバは SignalProfile 対応。profile 省略/'A'=グローバル(既存挙動一致) /
//   'B'=signalB 優先→未設定はグローバルへフォールバック(読み取りは readKnobRaw / resolveNumericProfile が担う)。

import { readKnobRaw, resolveNumericProfile } from '../configStore.js';
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

// ★v0.7.56: AIエントリー 初期LC幅の下限(円)。未設定は PARAM_BOUNDS 既定(45)。プロンプトにのみ反映。
export function resolveScalpLcFloorYen(profile?: SignalProfile): number { return resolveNumericProfile(profile, 'scalpLcFloorYen'); }

// ★ドテン(反転)許可。ON=「AIが保有中に反転を判断してよい」(=AI判断)。OFF(既定)=ドテンを出さない=既定で挙動不変。
//   未設定/非boolean は false(既定OFF)。monitor2(full)専用の設定 UI でのみ切り替える(engine は値を読むだけ)。
export function resolveScalpDotenEnabled(profile?: SignalProfile): boolean {
  const v = readKnobRaw(profile, 'dotenEnabled');
  return typeof v === 'boolean' ? v : false;
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

/** 初期LC下限 directive。value=下限(円)。ai=下限を課さない。 */
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
 *  enabled 未設定は true(既定で安全網ON)。value 未設定は PARAM_BOUNDS 既定(150)。 */
export function resolveScalpLcHardMax(profile?: SignalProfile): { enabled: boolean; value: number } {
  const v = readKnobRaw(profile, 'scalpLcHardMaxEnabled');
  return { enabled: typeof v === 'boolean' ? v : true, value: resolveNumericProfile(profile, 'scalpLcHardMaxYen') };
}
