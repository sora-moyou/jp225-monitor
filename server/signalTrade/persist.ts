// トレードシグナル紙エンジンの「永続化ビルダー」。
//
// 決済記録(signal_trades)の DB 挿入行・meta(JSON)・実効設定スナップショットを組み立てる。
// SignalEngine インスタンスには依存しない(instance state を閉包しない)ため engine.ts から
// 切り出せる。ただし buildSettingsSnapshot/knobSnapshot は configStore(resolveScalp*)を読むので
// 「純関数」ではない(config 依存)。DB への実書込(openDb/insert)は engine.ts が担う。

import type { SignalSettingsSnapshot, KnobSettingSnapshot } from '../types.js';
import type { PlanMeta, RecordedTrade } from './decisions.js';
import {
  resolveScalpCooldownDirective,
  resolveScalpLcFloorDirective, resolveScalpLcCeilingDirective, resolveScalpTrendVetoDirective,
  resolveScalpBiasDirective, resolveScalpRangeDirective, resolveScalpLcHardMax,
  type KnobDirective, type SignalProfile,
} from '../configStore.js';
import type { SignalTradeInsert } from '../db/store.js';

/** 決済記録の meta(JSON文字列)を組み立てる純関数。v0.7.54: AI 自己レジーム/確信度/veto発火 + ctxV。
 *  planMeta が空/欠落でも ctxV:'rich' は常に記録する(rich文脈で生成された世代の印)。 */
export function buildTradeMetaJson(planMeta?: PlanMeta, settings?: SignalSettingsSnapshot): string {
  const meta: Record<string, unknown> = { ctxV: 'rich' };
  if (planMeta?.regime !== undefined) meta.regime = planMeta.regime;
  if (planMeta?.confidence !== undefined) meta.confidence = planMeta.confidence;
  if (planMeta?.vetoFired !== undefined) meta.vetoFired = planMeta.vetoFired;
  // ★v0.7.56: 実効設定スナップショットを meta にマージ(在るときだけ・後方互換)。history/分析で「どの設定か」を残す。
  if (settings) meta.settings = settings;
  return JSON.stringify(meta);
}

/** ★v0.7.56: KnobDirective を1 knob 分のスナップショットへ整形する純関数。
 *  manual は設定値を value に載せる / ai は原則 value 省略(mode のみ)。ただし realizedLc を渡した LC 系
 *  (lcFloor/lcCeiling)は ai でも実測 LC 幅を value に入れる(AI委任項目の実現値を計測できるように)。 */
export function knobSnapshot<T>(d: KnobDirective<T>, realizedLcYen?: number): KnobSettingSnapshot {
  if (d.mode === 'manual') return { mode: 'manual', value: d.value as unknown as (number | string | boolean) };
  return typeof realizedLcYen === 'number' && Number.isFinite(realizedLcYen)
    ? { mode: 'ai', value: realizedLcYen }
    : { mode: 'ai' };
}

/** ★v0.7.56: 現在の設定(config)から実効設定スナップショットを組み立てる(config 読みのみ)。
 *  realizedLcYen(採用/約定レッグの |entry−SL|)を渡すと、AI委任の LC(lcFloor/lcCeiling)の value に実測を入れる。
 *  ★v0.8.2: profile を渡すと B(signalB→A フォールバック)の実効設定を反映。省略/'A'=グローバル(現行と byte 一致)。 */
export function buildSettingsSnapshot(realizedLcYen?: number, profile?: SignalProfile): SignalSettingsSnapshot {
  const hardMax = resolveScalpLcHardMax(profile);
  return {
    lcFloor: knobSnapshot(resolveScalpLcFloorDirective(profile), realizedLcYen),
    lcCeiling: knobSnapshot(resolveScalpLcCeilingDirective(profile), realizedLcYen),
    lcHardMax: { enabled: hardMax.enabled, value: hardMax.value },
    trendVeto: knobSnapshot(resolveScalpTrendVetoDirective(profile)),
    cooldown: knobSnapshot(resolveScalpCooldownDirective(profile)),
    bias: knobSnapshot(resolveScalpBiasDirective(profile)),
    range: knobSnapshot(resolveScalpRangeDirective(profile)),
  };
}

/** ★v0.8.2: RecordedTrade + 系統タグ(A=null/B='B')から DB 挿入行を組み立てる純関数(テスト可能)。
 *  A(system=null)は従来と byte 一致の行を作る。mode/meta の付与規約も従来どおり。 */
export function buildSignalTradeInsert(t: RecordedTrade, system: 'A' | 'B' | null): SignalTradeInsert {
  return {
    entryT: t.entryT, entryPrice: t.entryPrice, dir: t.dir,
    exitT: t.exitT, exitPrice: t.exitPrice, pnl: t.pnl, qty: t.qty,
    rationale: t.rationale,
    // range 由来のみ 'range' タグ、それ以外は 'directional'(別枠集計・後方互換)。
    mode: t.mode === 'range' ? 'range' : 'directional',
    // v0.7.54: AI 自己レジーム/確信度/veto発火 + v0.7.56: 実効設定スナップショット を JSON で記録(後の A/B 実測用)。
    meta: buildTradeMetaJson(t.planMeta, t.settings),
    // ★v0.8.2: 系統タグ。A は null(=既存挙動と同一) / B は 'B'。
    system: system ?? undefined,
  };
}
