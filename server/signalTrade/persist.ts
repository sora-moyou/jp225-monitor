// トレードシグナル紙エンジンの「永続化ビルダー」。
//
// 決済記録(signal_trades)の DB 挿入行・meta(JSON)・実効設定スナップショットを組み立てる。
// SignalEngine インスタンスには依存しない(instance state を閉包しない)ため engine.ts から
// 切り出せる。ただし buildSettingsSnapshot/knobSnapshot は configStore(resolveScalp*)を読むので
// 「純関数」ではない(config 依存)。DB への実書込(openDb/insert)は engine.ts が担う。

import type { SignalSettingsSnapshot, KnobSettingSnapshot } from '../types.js';
import type { PlanMeta, RecordedTrade, SignalHold } from './decisions.js';
import {
  resolveScalpCooldownDirective,
  resolveScalpLcFloorDirective, resolveScalpLcCeilingDirective, resolveScalpTrendVetoDirective,
  resolveScalpBiasDirective, resolveScalpRangeDirective, resolveScalpLcHardMax,
  resolveScalpDotenEnabled, resolveScalpRangeEnabled, resolveScalpRangeReevalEnabled,
  type KnobDirective, type SignalProfile,
} from '../configStore.js';
import type { SignalTradeInsert, SignalExitStopInsert } from '../db/store.js';

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
  const snap: SignalSettingsSnapshot = {
    lcFloor: knobSnapshot(resolveScalpLcFloorDirective(profile), realizedLcYen),
    lcCeiling: knobSnapshot(resolveScalpLcCeilingDirective(profile), realizedLcYen),
    lcHardMax: { enabled: hardMax.enabled, value: hardMax.value },
    trendVeto: knobSnapshot(resolveScalpTrendVetoDirective(profile)),
    cooldown: knobSnapshot(resolveScalpCooldownDirective(profile)),
    bias: knobSnapshot(resolveScalpBiasDirective(profile)),
    range: knobSnapshot(resolveScalpRangeDirective(profile)),
  };
  // ★ドテン(反転)許可の委任状態(ADD-ONLY): 許可 ON の時だけ載せる。OFF(既定)では欠落=既存 meta JSON と byte 一致。
  if (resolveScalpDotenEnabled(profile)) snap.dotenEnabled = true;
  // ★レンジ再評価(未約定→ブレイク)の許可状態(ADD-ONLY): レンジ使用時のみ載せる。レンジOFF(既定)では欠落=既存 meta JSON と byte 一致。
  if (resolveScalpRangeEnabled(profile)) snap.rangeReevalEnabled = resolveScalpRangeReevalEnabled(profile);
  return snap;
}

/** ★v0.8.2: RecordedTrade + 系統タグ(A=null/B='B')から DB 挿入行を組み立てる純関数(テスト可能)。
 *  A(system=null)は従来と byte 一致の行を作る。mode/meta の付与規約も従来どおり。
 *  ★検証用: signalId(ARM 采番)を渡すと signal_id 列に載せる(trade2 と equijoin する結合キー)。
 *    A のみ非 null / B(currentSignal 無し)は undefined→NULL。省略時も従来と byte 一致(signalId 未指定=NULL)。 */
export function buildSignalTradeInsert(t: RecordedTrade, system: 'A' | 'B' | null, signalId?: number | null): SignalTradeInsert {
  const ins: SignalTradeInsert = {
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
  // ★検証用: 結合キー。渡された時だけ載せる(未指定は従来どおり signal_id=NULL)。
  if (signalId != null) ins.signalId = signalId;
  // ★遡り解析用: ARM(武装)時刻と ARM 時点で monitor が見ていた価格。在るときだけ載せる(旧行/取得不能は NULL)。
  //   armed_t があれば entry_t − armed_t で「武装から約定までの経過」が、armed_price があれば
  //   「武装時点でエントリー価格を通過済みだったか」が事後に判定できる(ticks 代用では一致しないため必須)。
  if (t.armedAt != null) ins.armedT = t.armedAt;
  if (t.armedPrice != null) ins.armedPrice = t.armedPrice;
  return ins;
}

/** exit-stop(決済逆指値)遷移の記録タイプ。engine が「前回記録値」を保持し、この純関数で
 *  「今 tick は記録すべきか(変化したか)」を判定して挿入行を組み立てる。RECORD-ONLY(engine の決定は不変)。 */
export interface ExitStopTracker { openedAt: number | null; value: number | null; }

/** hold(保有中の意図)から exit-stop 遷移の挿入行を作る純関数。変化なしなら null(=記録しない)。
 *  - hold が無い(flat/armed/B)・exitStop が null/非有限 → null。
 *  - 前回と「同一建玉(opened_at)かつ同一 exitStop」→ null(dedupe: 毎tickではなく変化時のみ)。
 *  - 新規建玉(opened_at 変化)や exitStop 変化 → 挿入行を返す(初回=initial も1行になる)。
 *  phase は rangeTp があれば 'range'(固定LC建玉)/ 無ければ null(通常の phase-exit)。 */
export function buildExitStopRecord(
  hold: SignalHold | null, prev: ExitStopTracker, now: number,
): SignalExitStopInsert | null {
  if (!hold || hold.exitStop == null || !Number.isFinite(hold.exitStop)) return null;
  if (prev.openedAt === hold.at && prev.value === hold.exitStop) return null;
  return {
    t: now,
    signalId: hold.signalId,
    openedAt: hold.at,
    direction: hold.direction,
    exitStop: hold.exitStop,
    phase: hold.rangeTp != null ? 'range' : null,
  };
}
