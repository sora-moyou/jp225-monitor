import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getRecentAlerts, recordTick, upsertDailyClose } from '../server/db/store.js';
import { _reset as resetCooldown } from '../server/alertCooldown.js';
import { _reset as resetFeed } from '../server/feedBars.js';
import { _resetShockCooldown } from '../server/alertEngine.js';
import { MONITOR_ONLY_KINDS } from '../server/alertHistory.js';
import type { AlertEventPayload } from '../server/types.js';
import { AlertCollector } from './alertCollector.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }

describe('AlertCollector', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); resetCooldown(); resetFeed(); _resetShockCooldown(); });

  it('records a shock alert to the DB when a quiet feed jumps', () => {
    const ac = new AlertCollector(db);
    const t0 = 1_700_000_000_000;
    // 68 quiet minutes (one sample per minute) then a sharp jump — comfortably past the 65-bar
    // requirement so bar detection has a full baseline. Detection reads getRealtimeBars only.
    let price = 30000;
    for (let i = 0; i < 68; i++) {
      price += (i % 2 === 0 ? 1 : -1);
      ac.onPrice('NIY=F', price, t0 + i * 60_000);
      ac.onMinute(t0 + i * 60_000);
    }
    const jumpT = t0 + 68 * 60_000;
    ac.onPrice('NIY=F', price + 120, jumpT);   // ~0.4% jump (in-progress bar)
    ac.onMinute(jumpT);
    // Shock evaluates COMPLETED bars only (bars.slice(0,-1)); the jump above lands in the
    // in-progress bar. Feed one more minute so the jump bar CLOSES, then evaluate.
    ac.onPrice('NIY=F', price + 120, jumpT + 60_000);
    ac.onMinute(jumpT + 60_000);
    const rows = getRecentAlerts(db, 10);
    const shock = rows.find(r => r.detection_kind === 'shock');
    expect(shock).toBeDefined();
    expect(shock!.symbol).toBe('NIY=F');
  });

  it('ignores non-NIY symbols for firing', () => {
    const ac = new AlertCollector(db);
    const t0 = 1_700_000_000_000;
    let price = 20000;
    for (let i = 0; i < 72; i++) { price += i === 68 ? 200 : (i % 2 ? -1 : 1); ac.onPrice('NQ=F', price, t0 + i * 60_000); ac.onMinute(t0 + i * 60_000); }
    expect(getRecentAlerts(db, 10).length).toBe(0);
  });

  /** dailyband(日足MA25 下抜け)が最小構成で成立する DB 状態を作る。戻り値は基準時刻。 */
  function seedDailyBandBreak(database: DatabaseSync): number {
    // 2026-01-15 12:00 JST(=03:00 UTC)= 日中セッション中盤(寄り3本ガードの外)。
    const now = Date.UTC(2026, 0, 15, 3, 0, 0);
    // 24 本の確定取引日終値(±50 の広いばらつき → MA25≈100)。daily_closes に直接シード。
    for (let i = 0; i < 24; i++) upsertDailyClose(database, 'NIY=F', `2026-01-${String(i + 1).padStart(2, '0')}`, i % 2 === 0 ? 150 : 50, now - (30 - i) * 86_400_000);
    // 直近 1 分足: 谷タッチ(≤105)→山形成(≥110)→再下落で MA25(≈100)を下抜け。現値=96。
    const bars: [number, number, number][] = [
      [now - 4 * 60_000, 101, 99], [now - 3 * 60_000, 115, 105],
      [now - 2 * 60_000, 112, 108], [now - 1 * 60_000, 108, 102], [now, 104, 96],
    ];
    for (const [t, h, l] of bars) {
      database.prepare('INSERT OR REPLACE INTO bars_1m (symbol, session_date, session, t, o, h, l, c) VALUES (?,?,?,?,?,?,?,?)')
        .run('NIY=F', '2026-01-15', 'Day', t, l, h, l, l === 96 ? 96 : (h + l) / 2);
    }
    recordTick(database, 'NIY=F', now, 96, '2026-01-15', 'Day');   // 最新 tick(鮮度 OK・sink の価格解決に使用)
    return now;
  }

  // STEP 6(意図した挙動変更): collector が従来出していなかった level 検知(break/level_sr/pivot/double/dailyband)を
  // registry 経由で記録するようになったことの回帰。ここでは日足バンド(dailyband)の水準抜けを最小構成で確認する。
  // ★作業F 以降、level 検知の入口は onMinute ではなく onLevelTick(8秒周期)。
  it('records a dailyband alert via the level detectors it previously omitted', () => {
    const ac = new AlertCollector(db);
    const now = seedDailyBandBreak(db);
    ac.onLevelTick(now);
    const rows = getRecentAlerts(db, 20);
    expect(rows.some(r => r.detection_kind === 'dailyband')).toBe(true);
    // ★二重記録の再発ガード(挙動で検査・文言ではない)。collector が実際に書いた種別が
    //   MONITOR_ONLY_KINDS に入っていたら、monitor 側は collector 稼働中でも同じ検知を書くので
    //   必ず二重行になる。dailyband がこの集合に入ったまま collector が書いていたのが本欠陥。
    for (const r of rows) expect(MONITOR_ONLY_KINDS.has(r.detection_kind ?? '')).toBe(false);
  });

  // ═══ 作業F: level 検知だけを 8秒周期に分離する ═══
  //
  // 記録の主体が collector に一本化された結果、level 系の「記録される解像度」= collector の
  // サンプリング周期になった。実測(実 tick 102,853件・本番検知器のリプレイ・72時間)で
  // 60秒格子は 8秒格子の 0.86 倍(break 0.88 / level_sr 0.83 / dailyband 0.80)しか発火しない。
  // → level 検知だけを monitor の levelsLoop と同じ 8秒に上げる。bar 検知(分境界)・crash・
  //   followup・prune の周期は巻き込まない。

  // ★否定対照: 修正前(onMinute が level 検知も回していた)ではここで dailyband が記録され赤くなる。
  it('作業F: onMinute は bar 検知だけを回す(level 検知を巻き込まない)', () => {
    const ac = new AlertCollector(db);
    const now = seedDailyBandBreak(db);
    ac.onMinute(now);
    expect(getRecentAlerts(db, 20).some(r => r.detection_kind === 'dailyband')).toBe(false);
    ac.onLevelTick(now);   // level の入口は onLevelTick のみ
    expect(getRecentAlerts(db, 20).some(r => r.detection_kind === 'dailyband')).toBe(true);
  });

  it('作業F: onLevelTick は bar 検知を巻き込まない(shock は分境界のまま)', () => {
    const ac = new AlertCollector(db);
    const t0 = 1_700_000_000_000;
    let price = 30000;
    for (let i = 0; i < 68; i++) {
      price += (i % 2 === 0 ? 1 : -1);
      ac.onPrice('NIY=F', price, t0 + i * 60_000);
      ac.onMinute(t0 + i * 60_000);
    }
    const jumpT = t0 + 68 * 60_000;
    ac.onPrice('NIY=F', price + 120, jumpT);
    ac.onMinute(jumpT);
    ac.onPrice('NIY=F', price + 120, jumpT + 60_000);
    // 急変足が確定した分を 8秒刻みで 7 回サンプリングしても bar 検知は動かない。
    for (let k = 0; k < 7; k++) ac.onLevelTick(jumpT + 60_000 + k * 8_000);
    expect(getRecentAlerts(db, 20).some(r => r.detection_kind === 'shock')).toBe(false);
    ac.onMinute(jumpT + 60_000);   // bar 検知の入口は onMinute のみ
    expect(getRecentAlerts(db, 20).some(r => r.detection_kind === 'shock')).toBe(true);
  });

  it('作業F: onLevelTick は 8秒スロットにつき1回だけ検知を回す(2秒ポールで多重実行しない)', () => {
    const now = seedDailyBandBreak(db);
    // DB アクセス回数で「実際に検知が走ったか」を数える(prepare を数える proxy)。
    let prepares = 0;
    const spy = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop === 'prepare') return (...args: unknown[]): unknown => { prepares++; return (v as Function).apply(target, args); };
        return typeof v === 'function' ? (v as Function).bind(target) : v;
      },
    }) as DatabaseSync;
    const ac = new AlertCollector(spy);
    const runs: number[] = [];
    const step = (t: number): void => { const b = prepares; ac.onLevelTick(t); runs.push(prepares - b); };
    step(now);                       // 新スロット → 走る
    for (const dt of [2_000, 4_000, 6_000]) step(now + dt);   // 同一スロット → 走らない
    step(now + 8_000);               // 次スロット → 走る
    expect(runs[0]).toBeGreaterThan(0);
    expect(runs.slice(1, 4)).toEqual([0, 0, 0]);
    expect(runs[4]).toBeGreaterThan(0);
  });

  // ★内部に CHECK_MS=60_000 を持つ検知器(double=SWING_DOUBLE_CHECK_MS / nwave=NWAVE_CHECK_MS)は、
  //   外側の格子を 8秒に上げても実行回数が増えない(= 発火頻度は原理的に変わらず、位相だけ変わる)。
  //   これを「内部チェックが実際に何回走ったか」で検査する。
  it('作業F: 内部 60秒間引きの検知器は 8秒格子でも 60秒格子でも実行回数が同じ', () => {
    const SPAN_MS = 10 * 60_000;
    const runGrid = (gridMs: number): { swing: number; nwave: number } => {
      const d = memDb();
      const now = seedDailyBandBreak(d);
      const ac = new AlertCollector(d);
      const st = (ac as unknown as { levelState: { lastSwingCheck: number; lastNwaveCheck: number } }).levelState;
      const swing = new Set<number>(), nwave = new Set<number>();
      for (let t = now; t <= now + SPAN_MS; t += gridMs) {
        recordTick(d, 'NIY=F', t, 96, '2026-01-15', 'Day');   // 鮮度ゲートを満たし続ける
        ac.onLevelTick(t);
        if (st.lastSwingCheck) swing.add(st.lastSwingCheck);
        if (st.lastNwaveCheck) nwave.add(st.lastNwaveCheck);
      }
      d.close();
      return { swing: swing.size, nwave: nwave.size };
    };
    const g8 = runGrid(8_000), g60 = runGrid(60_000);
    // 8秒に上げても内部チェックは1回も増えない。むしろ格子量子化で実効周期が 64秒(=60秒直後の
    // 8秒スロット)になるぶん、10分で 10回 対 11回 とわずかに減る。どちらにせよ発火頻度は
    // 外格子に依存しない(位相が変わるだけ)。
    expect(g8.nwave).toBeLessThanOrEqual(g60.nwave);
    expect(g8.swing).toBeLessThanOrEqual(g60.swing);
    expect(g60.nwave - g8.nwave).toBeLessThanOrEqual(1);
    expect(g60.swing - g8.swing).toBeLessThanOrEqual(1);
    expect(g8.nwave).toBeLessThanOrEqual(SPAN_MS / 60_000 + 1);   // 60秒に1回まで
    expect(g8.swing).toBeLessThanOrEqual(SPAN_MS / 60_000 + 1);
  });

  // collector が万一 monitor 専用種別(slope 等)を emit するようになっても、黙って二重記録させない。
  it('never persists a monitor-only kind (drift guard)', () => {
    expect(MONITOR_ONLY_KINDS.has('slope')).toBe(true);   // 前提: slope は monitor 専用
    const ac = new AlertCollector(db);
    const now = Date.UTC(2026, 0, 15, 3, 0, 0);
    recordTick(db, 'NIY=F', now, 96, '2026-01-15', 'Day');
    // private sink をテストから直接叩く(collector 内部の記録経路そのもの)。
    const errs: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]): void => { errs.push(a); };
    try {
      (ac as unknown as { sink: (e: AlertEventPayload) => void }).sink({
        symbol: 'NIY=F', symbolLabel: '日経225先物', changePercent: 1, windowSeconds: 5,
        detectionKind: 'slope', direction: 'up', triggeredAt: now,
        change15min: null, pa15min: null, range1h: null, zscore: 0,
      });
    } finally { console.error = orig; }
    expect(getRecentAlerts(db, 20).length).toBe(0);   // 記録しない
    expect(errs.length).toBe(1);                       // 黙殺せず必ずログに残す
  });
});
