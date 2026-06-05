import type { Bar } from './correlation.js';
import {
  computeContext,
  type DetectorParams,
} from './alertDetector.js';
import { detectGranvilleReversal, detectGranvilleContinuation, detectMaCross,
  DEFAULT_GRANVILLE, DEFAULT_GRANVILLE_CONT, type GranvilleSignal } from './granville.js';
import { canFire, markFired } from './alertCooldown.js';
import { detectShock } from './shockDetector.js';
import { resolveShockParams, resolveShockCooldownBars,
  resolveGranvilleMaMid, resolveGranvilleMaLong } from './configStore.js';
import { aggregateSignals, DEFAULT_AGGREGATE } from './signals/aggregate.js';
import type { AlertSignal } from './signals/types.js';
import type { InstrumentMeta, AlertEventPayload } from './types.js';

export type AlertSink = (e: AlertEventPayload) => void;

// 急変専用のバー数クールダウン(直近ラベルの分インデックスから cooldownBars 本超で再発火可)。
// alertCooldown(共有・時間ベース)とは別系統。プロセスごとに独立。
const lastShockBar = new Map<string, number>();
function shockCanFire(symbol: string, bar: number): boolean {
  const prev = lastShockBar.get(symbol);
  return prev === undefined || bar - prev > resolveShockCooldownBars();
}
function shockMarkFired(symbol: string, bar: number): void { lastShockBar.set(symbol, bar); }
export function _resetShockCooldown(): void { lastShockBar.clear(); }

// グランビルのエッジ抑制: 前 tick でも出ていた同一シグナル(同 note)は「過去の転換/継続の再表示」=
// エコーなので発火しない。シグナルが一旦消えてから再度現れた時だけ発火する(立ち上がりエッジ)。
// クールダウンとは別物(時間で抑えるのでなく「状態変化」で1回化する)。
let lastGranvilleNotes = new Set<string>();
export function _resetGranvilleDedup(): void { lastGranvilleNotes = new Set(); }

// 25MA抜け(素のMAクロス)のエッジ抑制。前 tick でも同じクロスが出ていたら(同一分内の再評価=エコー)
// 発火しない。クロスが一旦消えてから再度現れた時だけ1回発火する。グランビルの note dedup と同系統。
let lastMaCrossKeys = new Set<string>();
export function _resetMaCrossDedup(): void { lastMaCrossKeys = new Set(); }

// v0.6.2: ma_sr/trend の過剰発火対策(実データ監査で trend 5.4/h・ma_sr 4.7/h、多くが乖離≈0%=MAに触れただけ)。
// ①乖離ゲート: |乖離| が小さい(MA上をなぞっているだけ/フラットMAのチョップ)ものは出さない。
//   監査の実値分布(本物=0.11/0.20/0.48% vs ノイズ=0.00〜0.04%)から 0.08% で明瞭に分離できる。
// ②方向別クールダウン: 同種・同方向の連発を抑制(グランビルは従来 un-gated だったが監査により導入)。
const L2_MIN_DEV_PCT = 0.08;
const L2_COOLDOWN_MS = 15 * 60_000;
const lastL2Emit = new Map<string, number>();
export function _resetL2Cooldown(): void { lastL2Emit.clear(); }

/** Bar-confirmed detection for NIY=F: Granville (reversal/continuation) first, then shock (完成1分足).
 *  Routes events to `sink`. */
export function evaluateBarsNiy(
  bars: Bar[], meta: InstrumentMeta, params: DetectorParams, now: number, sink: AlertSink,
): void {
  if (!bars || bars.length < 65) return;
  const sym = 'NIY=F';

  // グランビル: 中期(既定25)・長期(既定75)の2本MAを併用(🎛️ で可変)。両MAで検知し、
  // 同一シグナル(同 note=同方向・同種別)が両方で出たら「中期・長期」一致として1本にまとめる。
  const closes = bars.map(b => b.close);
  const maMid = resolveGranvilleMaMid();
  const maLong = resolveGranvilleMaLong();
  const periods: { ma: number; label: string }[] = [
    { ma: maMid, label: '中期' }, { ma: maLong, label: '長期' },
  ].filter((p, i, a) => a.findIndex(q => q.ma === p.ma) === i);   // 中期==長期なら1本に
  const byNote = new Map<string, { sig: GranvilleSignal; note: string; labels: string[] }>();
  for (const { ma, label } of periods) {
    const rev = detectGranvilleReversal(closes, { ...DEFAULT_GRANVILLE, maPeriod: ma });
    const cont = detectGranvilleContinuation(closes, { ...DEFAULT_GRANVILLE_CONT, maPeriod: ma });
    // 転換=価格がMAをクロス(MA上抜け/下抜け)、継続=MA手前で支持/抵抗。MA本数(25/75)は表示しない
    // (中期/長期は出さない既存方針)が、「MAの抜け/支持」であることは明示する(ユーザー指定: MA基準を明示)。
    const g = rev
      ? { sig: rev, note: `グランビル${rev.dir === 'up' ? '買い' : '売り'}転換(MA${rev.dir === 'up' ? '上' : '下'}抜け)` }
      : cont
        ? { sig: cont, note: cont.dir === 'up' ? 'グランビル押し目買い(MA上で支持)' : 'グランビル戻り売り(MA下で抵抗)' }
        : null;
    if (!g) continue;
    const e = byNote.get(g.note);
    if (e) e.labels.push(label);
    else byNote.set(g.note, { sig: g.sig, note: g.note, labels: [label] });
  }
  // グランビルはクールダウンを完全無視(ユーザー指定):ブロックされず、共有クールダウンも発生させない。
  // ただしエコー(前tickと同一シグナルが出続ける=過去の転換/継続の再表示)はエッジ抑制で1回化する。
  // L2 シグナル化(v0.6.0): グランビル転換→trend(トレンド転換)、グランビル継続→ma_sr(MAサポレジ)。
  // 内部の g.note("グランビル…")は edge-dedup と log にのみ使い、emit は新 type/明確文へ写像する。
  const tBar = bars[bars.length - 1]!.t;
  const signals: AlertSignal[] = [];
  // 乖離ゲートを通った「発火可能」なシグナルだけを edge-dedup の対象にする。
  // (乖離不足のものを dedup 集合に入れると、後で乖離が十分になった時にエコー扱いで消えてしまうため)
  const currentNotes = new Set<string>();
  for (const g of byNote.values()) {
    if (Math.abs(g.sig.deviation) < L2_MIN_DEV_PCT) continue;   // 乖離が小さい=MAをなぞる/フラットMAのチョップ→出さない
    currentNotes.add(g.note);
    if (lastGranvilleNotes.has(g.note)) continue;   // 前tickでも(発火可能で)出ていた→エコー、発火しない
    const dir = g.sig.dir;
    const maVal = Math.round(g.sig.ma);
    const yen = maVal.toLocaleString('ja-JP');
    console.log(`[alertEngine] ${sym} ${g.note}(${g.labels.join('・')}) dev=${g.sig.deviation.toFixed(2)}%`);
    if (g.note.includes('転換')) {
      signals.push({
        type: 'trend', direction: dir, reference: { kind: 'ma', price: maVal }, stage: 'confirmed', score: 1.3,
        text: dir === 'up' ? `${yen} MA上抜け、上昇転換の可能性` : `${yen} MA下抜け、下降転換の可能性`,
        triggeredAt: tBar,
      });
    } else {
      const word = dir === 'up' ? 'サポート' : 'レジスタンス';
      signals.push({
        type: 'ma_sr', direction: dir, reference: { kind: 'ma', price: maVal }, stage: 'confirmed', score: 1.1,
        text: `${yen} MAが${word}の可能性`, triggeredAt: tBar,
      });
    }
  }
  lastGranvilleNotes = currentNotes;   // 次tickのエッジ判定用に今tickのシグナル集合を記録

  // 素のMAクロス → trend(トレンド転換)。グランビルが同方向の転換/継続を既に出していれば重複なので抑制。
  const granvilleDirs = new Set([...byNote.values()].map(v => v.sig.dir));
  const maCross = detectMaCross(closes, maMid);
  const maOk = !!maCross && Math.abs(maCross.deviation) >= L2_MIN_DEV_PCT;   // 乖離不足は dedup を汚さない
  const maKey = maOk ? `ma-${maCross!.dir}` : '';
  if (maOk && maCross && !granvilleDirs.has(maCross.dir) && !lastMaCrossKeys.has(maKey)) {
    const maVal = Math.round(maCross.ma);
    const dirWord = maCross.dir === 'up' ? '上抜け' : '下抜け';
    console.log(`[alertEngine] ${sym} ${maCross.period}MA${dirWord} ma=${maVal} dev=${maCross.deviation.toFixed(2)}%`);
    signals.push({
      type: 'trend', direction: maCross.dir, reference: { kind: 'ma', price: maVal }, stage: 'confirmed', score: 1.0,
      text: `${maVal.toLocaleString('ja-JP')} ${maCross.period}MA${dirWord}、トレンド転換の可能性`, triggeredAt: tBar,
    });
  }
  lastMaCrossKeys = maKey ? new Set([maKey]) : new Set();   // クロスが消えるまで同方向を抑制

  // 集約(同方向・近接基準を1本化)→ 方向別クールダウン(v0.6.2: 監査で過剰発火のため導入)→ emit。
  const tNow = bars[bars.length - 1]!.t;
  for (const a of aggregateSignals(signals, DEFAULT_AGGREGATE)) {
    const ck = `${a.type}#${a.direction}`;
    if (tNow - (lastL2Emit.get(ck) ?? -Infinity) <= L2_COOLDOWN_MS) continue;
    lastL2Emit.set(ck, tNow);
    sink({
      symbol: sym, symbolLabel: meta.labelJa, changePercent: 0, windowSeconds: 75 * 60,
      detectionKind: a.type, direction: a.direction, triggeredAt: a.triggeredAt,
      change15min: null, pa15min: null, range1h: null, zscore: 0,
      level: Math.round(a.reference.price), note: a.text,
      referenceKind: a.reference.kind, referencePrice: Math.round(a.reference.price),
    });
  }

  // 急変(価格変化スコア方式)。完成足のみ(末尾=進行中バーを除外)。バー数クールダウンで間引く。
  const completed = bars.slice(0, -1).map(b => b.close);
  const shock = detectShock(completed, resolveShockParams());
  if (shock) {
    const lastCompleted = bars[bars.length - 2]!;        // 評価対象の完成足
    const bar = Math.floor(lastCompleted.t / 60_000);    // 「バーインデックス」=分インデックス
    // クールダウンシグナルを出すのは急変のみ。発火時に markFired で共有クールダウンを発生させ、
    // 自身のバー数クールダウンと併せて連続表示を抑制する(テクニカル系は一切関与しない)。
    if (shockCanFire(sym, bar) && canFire(sym, shock.dir, lastCompleted.close, now)) {
      shockMarkFired(sym, bar);
      markFired(sym, shock.dir, lastCompleted.close, now);
      const ctx = computeContext(bars);
      const prevClose = completed[completed.length - 2] ?? lastCompleted.close;
      console.log(`[alertEngine] ${sym} shock ${shock.dir} d1=${Math.round(shock.d1)}円 score=${shock.score}/6`);
      // 表示は価格を先頭に(グランビル/ダブルと統一)。方向は「急上昇/急落」で示し、値幅は符号付き。
      // 「急変」の語は使わない(ユーザー指定)。価格=動きの起点(1分前の終値=prevClose)。
      const price = Math.round(prevClose).toLocaleString('ja-JP');
      const word = shock.dir === 'up' ? '急上昇' : '急落';
      const sgn = (n: number): string => `${n >= 0 ? '+' : ''}${Math.round(n)}`;
      sink({
        symbol: sym, symbolLabel: meta.labelJa,
        changePercent: prevClose > 0 ? (shock.d1 / prevClose) * 100 : 0,
        windowSeconds: 60, detectionKind: 'shock', direction: shock.dir,
        triggeredAt: lastCompleted.t,
        change15min: ctx.change15min, pa15min: ctx.pa15min, range1h: ctx.range1h,
        zscore: 0,
        note: `${price} からの${word} / ${sgn(shock.d1)}円 (1分) / 2分 ${sgn(shock.d2)}円 / score ${shock.score}/6`,
      });
    }
  }
}
