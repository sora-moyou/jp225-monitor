// アラート発火頻度の事前監査ツール(リリース前ゲート)。
//
// 目的: コードレビューでは分からない「実データに対する発火量(乱発/無発火)」を、蓄積済みの実バーで
// リプレイして数える。パラメータ較正ミス(例 v0.6.1 の reclaim 過小、v0.6.2 の trend/ma_sr 乖離≈0 乱発)を
// リリース前に検知するための恒久ツール。
//
// 使い方: npx tsx scripts/alert-audit.mts [日数=3]
//   alertEngine(shock/ma_sr/trend)は evaluateBarsNiy を実関数でリプレイ(=本番と完全一致)。
//   levelsLoop(break/level_sr/pivot/double)は実検知関数 + LEVELS_TUNING(本番定数)でリプレイ。
//
// 目安(NIY=F・通常時): 各シグナル概ね 数件/時 以下。特定シグナルが >5/h なら乱発を疑い較正する。

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { evaluateBarsNiy, _resetShockCooldown, _resetGranvilleDedup, _resetMaCrossDedup, _resetL2Cooldown } from '../server/alertEngine.js';
import { DEFAULT_PARAMS } from '../server/alertDetector.js';
import { INSTRUMENTS } from '../server/config.js';
import { extractSwingPivots } from '../server/swingPivots.js';
import { detectLevelBreak, type BreakSignal } from '../server/levelBreak.js';
import { detectLevelHold } from '../server/levelHold.js';
import { detectSwingDouble, DEFAULT_SWING_DOUBLE } from '../server/swingDouble.js';
import { detectNWave } from '../server/nwave.js';
import { aggregateSignals, DEFAULT_AGGREGATE, recentMomentumDir } from '../server/signals/aggregate.js';
import { computeLevels } from '../server/levels.js';
import { getSessionOHLC } from '../server/db/store.js';
import { computeDailyBands, dailyCloseSeries } from '../server/dailyBand.js';
import { classifySession } from '../core/session.js';
import { LEVELS_TUNING as T, yenPct } from '../server/loops/levelsLoop.js';
import {
  buildBandwalkSamples, evaluateBandwalk, describeBandwalk, shouldFireBandwalk,
  createBandwalkFireState, DEFAULT_BANDWALK,
} from '../server/bandwalk.js';
import { createLevelDetectState, squeezeFire, describeSqueeze } from '../server/detect/registry.js';
import { aggregate5m, buildSqueezeSnapshot, type OHLCBar } from '../server/indicators.js';
import { SQUEEZE_BW_LOOKBACK } from '../core/indicatorSpec.js';
import { resolveShockParams, resolveEffectiveScalpBias } from '../server/configStore.js';
import type { AlertSignal } from '../server/signals/types.js';

const SYMBOL = 'NIY=F';
const DAYS = Number(process.argv[2] ?? 3);
const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const META = INSTRUMENTS.find(i => i.symbol === SYMBOL)!;
const JST = 9 * 3600000, hm = (t: number): string => new Date(t + JST).toISOString().slice(5, 16).replace('T', ' ');
const latest = db.prepare('SELECT t FROM bars_1m WHERE symbol=? ORDER BY t DESC LIMIT 1').get(SYMBOL) as { t: number };
const start = latest.t - DAYS * 86400000;
const counts: Record<string, number> = {}, samples: Record<string, string[]> = {};
const bump = (k: string, s: string): void => { counts[k] = (counts[k] ?? 0) + 1; (samples[k] ??= []).push(s); };

// ── alertEngine(本番関数で完全一致リプレイ)──
const ebars = (db.prepare('SELECT t,c FROM bars_1m WHERE symbol=? AND t>=? ORDER BY t').all(SYMBOL, start) as Array<{ t: number; c: number }>).map(r => ({ t: r.t, close: r.c }));
_resetShockCooldown(); _resetGranvilleDedup(); _resetMaCrossDedup(); _resetL2Cooldown();
for (let n = 66; n <= ebars.length; n++) {
  const s = ebars.slice(0, n);
  evaluateBarsNiy(s as never, META, DEFAULT_PARAMS, s[n - 1]!.t, (e) => bump(e.detectionKind, `${hm(e.triggeredAt)} ${e.direction === 'up' ? '▲' : '▼'} ${(e.note ?? '').slice(0, 44)}`));
}

// ── levelsLoop(実検知関数 + 本番定数 LEVELS_TUNING でリプレイ)──
const all = db.prepare('SELECT t,h,l,c FROM bars_1m WHERE symbol=? AND t>=? ORDER BY t').all(SYMBOL, start - 90 * 60000) as Array<{ t: number; h: number; l: number; c: number }>;
const lastBreakDir: Record<string, number> = {}, lastEmit: Record<string, number> = {};
const lastNwaveFire: Record<string, number> = {};   // ★N波動: 方向×round(B) の 30分クールダウン(別 B のみ再発火)。
let lastPivotT = 0, hlCacheT = 0; let hlCache: { price: number; label: string }[] = [];
// 日足バンド(dailyband): v0.6.22 リアルタイム化。確定済み夜間終値は約60秒キャッシュだが、現在値を進行中
// 日足の終値として append しバンドは毎ティック再計算する。20分のゾーン(40円)×方向クールダウン。
const lastBandEmit: Record<string, number> = {}; let bandCacheT = 0;
let confirmedCloses: number[] = [];
let bandLevels: { price: number; label: string; refKind: string }[] = [];
const BAND_COOLDOWN = 20 * 60000;
for (let i = all.findIndex(b => b.t >= start); i < all.length; i++) {
  const now = all[i]!.t, price = all[i]!.c;
  const recent = all.filter(b => b.t >= now - T.recentBarsMin * 60000 && b.t <= now).map(b => ({ t: b.t, h: b.h, l: b.l }));
  if (recent.length < 5) continue;
  const raw = extractSwingPivots(recent, yenPct(price, T.pivotReclaimPct));
  const pivots = raw.map(p => ({ price: p.price, label: p.kind === 'low' ? 'スイング安値' : 'スイング高値' }));
  if (now - hlCacheT > 30 * 60000) {
    try {
      // 反応水準も levelsLoop と同様に算出(1H/3Hスイング)。本番の tier≥1 集合と一致させる。
      const rb = all.filter(b => b.t >= now - 5 * 86400000 && b.t <= now).map(b => ({ t: b.t, h: b.h, l: b.l }));
      const resHL = (tf: number): { t: number; h: number; l: number }[] => { const m = new Map<number, { t: number; h: number; l: number }>(); for (const b of rb) { const k = Math.floor(b.t / tf) * tf; const e = m.get(k); if (e) { if (b.h > e.h) e.h = b.h; if (b.l < e.l) e.l = b.l; } else m.set(k, { t: k, h: b.h, l: b.l }); } return [...m.values()].sort((a, b) => a.t - b.t); };
      const rp = [...extractSwingPivots(resHL(3600000), yenPct(price, T.reactionReclaim1hPct)), ...extractSwingPivots(resHL(10800000), yenPct(price, T.reactionReclaim3hPct))].map(p => p.price).sort((a, b) => a - b);
      const rcl: { price: number; reactions: number }[] = [];
      for (const p of rp) { const c = rcl.find(x => Math.abs(x.price - p) <= 30); if (c) { c.price = (c.price * c.reactions + p) / (c.reactions + 1); c.reactions++; } else rcl.push({ price: p, reactions: 1 }); }
      const rl = rcl.filter(c => c.reactions >= 2).map(c => ({ price: Math.round(c.price), reactions: c.reactions }));
      const r = computeLevels(getSessionOHLC(db, SYMBOL, 24), price, now, classifySession(now), [], rl);
      hlCache = [...r.up, ...r.down].filter(l => l.tier >= 1).map(l => ({ price: l.price, label: l.labels[0] ?? '水準' }));
    } catch { hlCache = []; }
    hlCacheT = now;
  }
  const kept: number[] = [];
  const hl = [...hlCache, ...pivots].filter(l => { if (!(l.price > 0) || kept.some(k => Math.abs(k - l.price) <= T.levelMergeYen)) return false; kept.push(l.price); return true; });
  const sig: AlertSignal[] = [];
  const breaks = detectLevelBreak(hl, recent, price); const outer = new Map<'up' | 'down', BreakSignal>();
  for (const b of breaks) { const c = outer.get(b.kind); if (!c || (b.kind === 'up' ? b.level > c.level : b.level < c.level)) outer.set(b.kind, b); }
  // ★本番ミラー(40日ライブ): break 単独スコア 1.2→0.9(minScore1未満で単独は出さずコンフルエンスのみ)。
  for (const b of outer.values()) { if (now - (lastBreakDir[b.kind] ?? -1e15) <= T.breakDirCooldownMs) continue; sig.push({ type: 'break', direction: b.kind, reference: { kind: 'level', price: b.level }, stage: 'confirmed', score: 0.9, triggeredAt: now, text: `${Math.round(b.level)} ${b.label}抜け` }); }
  for (const h of detectLevelHold(hl, recent, price)) sig.push({ type: 'level_sr', direction: h.kind === 'support' ? 'up' : 'down', reference: { kind: 'level', price: h.level }, stage: 'confirmed', score: 1.1, triggeredAt: now, text: `${Math.round(h.level)} ${h.label}${h.kind === 'support' ? 'サポート' : 'レジ'}` });
  const nw = raw[raw.length - 1], pv = raw[raw.length - 2];
  if (nw && nw.t > lastPivotT && (!pv || Math.abs(nw.price - pv.price) >= yenPct(price, T.pivotFormedMinPct))) { lastPivotT = nw.t; sig.push({ type: 'pivot', direction: nw.kind === 'low' ? 'up' : 'down', reference: { kind: 'swing', price: nw.price }, stage: 'confirmed', score: 1.0, triggeredAt: now, text: `${Math.round(nw.price)} 形成` }); }
  { // ★主要スイング(4日・5分足・reclaim0.8%)を毎バー抽出。本番(computeLevelAnalytics)は double/nwave を約60秒=
    //   毎バー相当で評価する。double はまれ+高コストのため hourly サンプルのまま、nwave は本番同様に毎バー評価する。
    const lb = all.filter(b => b.t >= now - T.swingLookbackDays * 86400000).map(b => ({ t: b.t, h: b.h, l: b.l })); const tf = T.swingDoubleTfMs; const lm = new Map<number, { t: number; h: number; l: number }>(); for (const b of lb) { const k = Math.floor(b.t / tf) * tf; const e = lm.get(k); if (e) { if (b.h > e.h) e.h = b.h; if (b.l < e.l) e.l = b.l; } else lm.set(k, { t: k, h: b.h, l: b.l }); } const lb5 = [...lm.values()].sort((a, b) => a.t - b.t); const piv5 = extractSwingPivots(lb5, yenPct(price, T.swingPivotReclaimPct));
    // ★本番ミラー(40日ライブ): double は形成(forming)を出さず breakout のみ・スコア 1.0(旧 breakout1.5)。
    if (i % 60 === 0) { const sd = detectSwingDouble(piv5, price, DEFAULT_SWING_DOUBLE); if (sd && sd.stage === 'breakout') sig.push({ type: 'double', direction: sd.kind === 'bottom' ? 'up' : 'down', reference: { kind: 'neck', price: sd.neck }, stage: 'confirmed', score: 1.0, triggeredAt: now, text: `${sd.kind} ${sd.stage}` }); }
    // ★本番ミラー(N波動 nwave): 同じ主要スイングから A→B→C を判定。確認済み(B 抜け)なら目標=V値 を直接 bump
    //   (集約は通さない)。方向×round(B) の 30分クールダウンで同一波の連発を抑え、別 B のときだけ再発火。既定 minSwing=300。
    const nwv = detectNWave(piv5, price, 300);
    if (nwv) { const nk = `${nwv.direction}@${Math.round(nwv.b)}`; if (now - (lastNwaveFire[nk] ?? -1e15) > 30 * 60000) { lastNwaveFire[nk] = now; bump('nwave', `${hm(now)} ${nwv.direction === 'up' ? '▲' : '▼'} ${nwv.direction === 'up' ? '上昇' : '下降'}N波 目標V値${Math.round(nwv.targets.V)}`); } } }
  // 日足バンド(dailyband): v0.6.22 リアルタイム化。確定済み夜間終値は60秒キャッシュ(進行中夜間足は除外)。
  // 現在値を進行中日足の終値として append し、バンドは毎ティック再計算 → break/hold を直接 bump(集約なし)。
  if (now - bandCacheT >= 60000 || confirmedCloses.length === 0) {
    bandCacheT = now;
    const nights = getSessionOHLC(db, SYMBOL, 60).filter(s => s.session === 'Night').sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
    const inNight = classifySession(now)?.session === 'Night';
    confirmedCloses = (inNight ? nights.slice(0, -1) : nights).slice(-30).map(s => s.close);
  }
  bandLevels = confirmedCloses.length >= 24
    ? computeDailyBands(dailyCloseSeries(confirmedCloses, price)).map(b => ({ price: b.price, label: 'daily ' + b.label, refKind: b.refKind }))
    : [];
  if (bandLevels.length > 0) {
    const emitBand = (price: number, dir: 'up' | 'down', text: string): void => {
      const key = `${dir}@${Math.round(price / 40) * 40}`;
      if (now - (lastBandEmit[key] ?? -1e15) <= BAND_COOLDOWN) return;
      lastBandEmit[key] = now; bump('dailyband', `${hm(now)} ${dir === 'up' ? '▲' : '▼'} ${text}`);
    };
    for (const b of detectLevelBreak(bandLevels, recent, price)) emitBand(Math.round(b.level), b.kind, `${b.label.replace(/^daily /, '')}${b.kind === 'up' ? '上抜け' : '下抜け'}`);
    for (const h of detectLevelHold(bandLevels, recent, price)) emitBand(Math.round(h.level), h.kind === 'support' ? 'up' : 'down', `${h.label.replace(/^daily /, '')}${h.kind === 'support' ? 'サポート' : 'レジ'}`);
  }
  // ★本番ミラー: slope 方向一致ボーナス(+0.5)。直近~15分の1分足 close からモメンタム向きを算出して渡す。
  const momBars = all.filter(b => b.t >= now - 15 * 60000 && b.t <= now).map(b => ({ t: b.t, c: b.c }));
  const momDir = recentMomentumDir(momBars);
  for (const a of aggregateSignals(sig, { ...DEFAULT_AGGREGATE, slopeConfluenceBonus: 0.5 }, momDir)) {
    const ck = a.type === 'double' ? `double@${Math.round(a.reference.price / 5) * 5}#${a.stage ?? ''}` : `${a.direction}@${Math.round(a.reference.price / T.levelMergeYen) * T.levelMergeYen}`;
    const cd = a.type === 'double' ? T.doubleCooldownMs : T.zoneCooldownMs;
    if (now - (lastEmit[ck] ?? -1e15) <= cd) continue;
    lastEmit[ck] = now; if (a.types.includes('break')) lastBreakDir[a.direction] = now;
    bump(a.type, `${hm(now)} ${a.direction === 'up' ? '▲' : '▼'} ${a.text}`);
  }
}

// ── バンドウォーク(bandwalk): 本番の純関数(server/bandwalk.ts)をそのまま使ってリプレイ ──
// ★目線(scalpBias)は設定値であって時系列に残らない。**実効の目線**での発火(=実際に鳴る数)を主として数え、
//   参考として 'long'/'short' に設定した場合も併記する('none'=上下とも成立しうる)。
{
  const bw1m = (db.prepare('SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? AND t>=? ORDER BY t')
    .all(SYMBOL, start - 7 * 3600000) as Array<{ t: number; o: number; h: number; l: number; c: number }>);
  const samples = buildBandwalkSamples(bw1m, Number.MAX_SAFE_INTEGER, resolveShockParams());
  const effBias = resolveEffectiveScalpBias();
  const biasJa = { none: '目線なし=上下とも', long: '買い目線=上のみ', short: '売り目線=下のみ' } as const;
  const replay = (bias: 'none' | 'long' | 'short', label: string): void => {
    const st = createBandwalkFireState();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      if (s.t < start) continue;
      const bw = evaluateBandwalk(samples.slice(0, i + 1), bias, DEFAULT_BANDWALK);
      if (shouldFireBandwalk(st, bw, DEFAULT_BANDWALK) && bw) {
        bump(label, `${hm(bw.t)} ${bw.direction === 'up' ? '▲' : '▼'} ${describeBandwalk(bw).slice(0, 44)}`);
      }
    }
  };
  replay(effBias, 'bandwalk');   // ← 実効設定での実発火(合計にも入る)
  console.log(`\n[bandwalk] 実効の目線(scalpBias)=${effBias}(${biasJa[effBias]})。以下 bandwalk は この設定での実発火。`);
  for (const b of ['none', 'long', 'short'] as const) {
    if (b === effBias) continue;
    replay(b, `(参考)bandwalk[目線=${biasJa[b]}]`);
  }
}

// ── スクイーズ/バルジ(squeeze/bulge): 本番の純関数(buildSqueezeSnapshot + squeezeFire)でリプレイ ──
// 本番(server/detect/registry.ts)は「5分の枠が変わったら7日窓の1分足を読み直し、形成中の最後の1本を
// 落として確定足だけで判定」する。ここでは 5分足が1本閉じるたびに同じことをする(= 同じ評価回数)。
// ★窓は末尾 SQUEEZE_BW_LOOKBACK+40 本に切る: BWhigh/low は末尾 lookback 本の BW、その各 BW は直前20本の
//   close にしか依存しないので、lookback+19 本より多く与えれば結果は7日ぶん全部与えたのと **完全に同じ**
//   (O(n²) の再計算だけを避ける)。
{
  const sq1m = db.prepare('SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? AND t>=? ORDER BY t')
    .all(SYMBOL, start - 8 * 86400000) as OHLCBar[];
  const bars5 = aggregate5m(sq1m);
  const st = createLevelDetectState();
  for (let i = 0; i < bars5.length; i++) {
    const bar = bars5[i]!;
    const now = bar.t + 5 * 60000;                       // その足が閉じた直後に評価される
    const win = bars5.slice(0, i + 1).filter(b => b.t >= now - 7 * 86400000).slice(-(SQUEEZE_BW_LOOKBACK + 40));
    const snap = buildSqueezeSnapshot(win.map(b => b.c), win.map(b => b.t));
    // ★集計期間の手前も評価する(=状態と30分クールダウンを温める)。数えるのは start 以降だけ:
    //   温めないと「起動直後の prev=null」で期間先頭に必ず1回鳴る偽の発火が混ざる。
    const fired = squeezeFire(st, snap, now);
    if (fired && now >= start) bump(fired, `${hm(now)} ${describeSqueeze(fired, snap, bar.c)}`);
  }
}

const hours = (all[all.length - 1]!.t - start) / 3600000;
console.log(`\n=== アラート発火監査(${SYMBOL}, 直近${DAYS}日 ≒ ${hours.toFixed(0)}h)===`);
let total = 0;
for (const k of Object.keys(counts).sort((a, b) => counts[b]! - counts[a]!)) {
  total += counts[k]!;
  const rate = counts[k]! / hours;
  console.log(`${rate > 5 ? '⚠️ ' : '  '}${k}: ${counts[k]} 件 (${rate.toFixed(2)}/h)${rate > 5 ? '  ← 乱発の疑い' : ''}`);
  for (const s of samples[k]!.slice(0, 2)) console.log(`     ${s}`);
}
console.log(`  ── 合計 ${total} 件 (${(total / hours).toFixed(1)}/h)`);
db.close();
