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
import { aggregateSignals, DEFAULT_AGGREGATE } from '../server/signals/aggregate.js';
import { computeLevels } from '../server/levels.js';
import { getSessionOHLC } from '../server/db/store.js';
import { computeDailyBands, dailyCloseSeries } from '../server/dailyBand.js';
import { classifySession } from '../collector/session.js';
import { LEVELS_TUNING as T } from '../server/loops/levelsLoop.js';
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
  const raw = extractSwingPivots(recent, T.pivotReclaimYen);
  const pivots = raw.map(p => ({ price: p.price, label: p.kind === 'low' ? 'スイング安値' : 'スイング高値' }));
  if (now - hlCacheT > 30 * 60000) {
    try {
      // 反応水準も levelsLoop と同様に算出(1H/3Hスイング)。本番の tier≥1 集合と一致させる。
      const rb = all.filter(b => b.t >= now - 5 * 86400000 && b.t <= now).map(b => ({ t: b.t, h: b.h, l: b.l }));
      const resHL = (tf: number): { t: number; h: number; l: number }[] => { const m = new Map<number, { t: number; h: number; l: number }>(); for (const b of rb) { const k = Math.floor(b.t / tf) * tf; const e = m.get(k); if (e) { if (b.h > e.h) e.h = b.h; if (b.l < e.l) e.l = b.l; } else m.set(k, { t: k, h: b.h, l: b.l }); } return [...m.values()].sort((a, b) => a.t - b.t); };
      const rp = [...extractSwingPivots(resHL(3600000), 120), ...extractSwingPivots(resHL(10800000), 200)].map(p => p.price).sort((a, b) => a - b);
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
  for (const b of outer.values()) { if (now - (lastBreakDir[b.kind] ?? -1e15) <= T.breakDirCooldownMs) continue; sig.push({ type: 'break', direction: b.kind, reference: { kind: 'level', price: b.level }, stage: 'confirmed', score: 1.2, triggeredAt: now, text: `${Math.round(b.level)} ${b.label}抜け` }); }
  for (const h of detectLevelHold(hl, recent, price)) sig.push({ type: 'level_sr', direction: h.kind === 'support' ? 'up' : 'down', reference: { kind: 'level', price: h.level }, stage: 'confirmed', score: 1.1, triggeredAt: now, text: `${Math.round(h.level)} ${h.label}${h.kind === 'support' ? 'サポート' : 'レジ'}` });
  const nw = raw[raw.length - 1], pv = raw[raw.length - 2];
  if (nw && nw.t > lastPivotT && (!pv || Math.abs(nw.price - pv.price) >= T.pivotFormedMinYen)) { lastPivotT = nw.t; sig.push({ type: 'pivot', direction: nw.kind === 'low' ? 'up' : 'down', reference: { kind: 'swing', price: nw.price }, stage: 'confirmed', score: 1.0, triggeredAt: now, text: `${Math.round(nw.price)} 形成` }); }
  if (i % 60 === 0) { const lb = all.filter(b => b.t >= now - T.swingLookbackDays * 86400000).map(b => ({ t: b.t, h: b.h, l: b.l })); const sd = detectSwingDouble(extractSwingPivots(lb, T.swingPivotReclaimYen), price, DEFAULT_SWING_DOUBLE); if (sd) sig.push({ type: 'double', direction: sd.kind === 'bottom' ? 'up' : 'down', reference: { kind: 'neck', price: sd.neck }, stage: sd.stage === 'breakout' ? 'confirmed' : 'forming', score: sd.stage === 'breakout' ? 1.5 : 1.0, triggeredAt: now, text: `${sd.kind} ${sd.stage}` }); }
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
  for (const a of aggregateSignals(sig, DEFAULT_AGGREGATE)) {
    const ck = a.type === 'double' ? `double@${Math.round(a.reference.price / 5) * 5}#${a.stage ?? ''}` : `${a.direction}@${Math.round(a.reference.price / T.levelMergeYen) * T.levelMergeYen}`;
    const cd = a.type === 'double' ? T.doubleCooldownMs : T.zoneCooldownMs;
    if (now - (lastEmit[ck] ?? -1e15) <= cd) continue;
    lastEmit[ck] = now; if (a.types.includes('break')) lastBreakDir[a.direction] = now;
    bump(a.type, `${hm(now)} ${a.direction === 'up' ? '▲' : '▼'} ${a.text}`);
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
