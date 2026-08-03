import { describe, it, expect } from 'vitest';
import {
  buildCollectorWatch, judgeCollectorWork, formatCollectorWatchStatus, formatCollectorStatusFile,
  shouldLogTransition, COLLECTOR_STUCK_MS, MONITOR_FEED_FRESH_MS, COLLECTOR_WORK_SYMBOL,
  COLLECTOR_DEAD_MS, type CollectorPidInfo, type CollectorWorkInfo,
} from './collectorWatch.js';
import { renderCollectorDot } from '../web/components/apiStatusPane.js';
import { shouldReportStreak } from './spawnLog.js';

// ─── ★D: 「生きているが仕事をしていない」を、時間外と取り違えずに検知する ──────────────
//
// 何が抜けていたか(3機構そろって網から漏れていた):
//   ・collectorWatch は **意図的に** ティックの伸びを根拠にしない(時間外と区別できないため)
//   ・collector 自身の poll 例外は catch されて周回が続く(プロセスは生きたまま1件も記録しない)
//   ・心拍は inPollWindow の判定より前で毎周回打たれる = ポーリングが死んでいても正常に見える
//   ⇒ 「心拍は正常・ティックは1件も増えない」が **誰にも検知されない**。
//     1年かけてティックを溜めている最中なので、気づくのは1年後。
//
// ★取り違えないための設計: 判定は **2つの独立した事実の食い違い** だけを根拠にする。
//     ① 収集デーモンのティック(共有DB ticks・書き手は collector だけ)が伸びていない
//     ② それなのに monitor 自身の価格フィード(別プロセス)は新鮮 = 市場は動いている
//   ②が古ければ判定しない(休場日・フィード障害を収集デーモンのせいにしない)。
//
// ★否定対照(修正前 = scratchpad に退避した server/collectorWatch.ts):
//   CollectorWatchState に 'stuck' が無く、buildCollectorWatch は work を受け取らない
//   (= ティックが1件も増えなくても常に 'ok' を返す)。本ファイルは import すら解決しない。

const JST = 9 * 60 * 60_000;
const jst = (y: number, m: number, d: number, hh: number, mm: number): number =>
  Date.UTC(y, m - 1, d, hh, mm, 0) - JST;

// 2026-06-03(水)は平日・先物の非取引日でない。
const MIDDAY = jst(2026, 6, 3, 13, 0);        // Day セッションの真ん中(窓は十分前から開いている)
const PRE_OPEN = jst(2026, 6, 3, 8, 42);      // 寄り前のマージン(窓は開いているがセッションは未開始)
const JUST_OPENED = jst(2026, 6, 3, 8, 47);   // 寄り直後(セッションが開いて2分)
const OUT_SESSION = jst(2026, 6, 3, 16, 20);  // 15:45–17:00 の空白帯
const WEEKEND = jst(2026, 6, 7, 12, 0);       // 日曜
const HOLIDAY = jst(2026, 11, 23, 13, 0);     // 勤労感謝の日(DERIV_NON_TRADING = 先物も休み)

const LIVE_PID: CollectorPidInfo = { file: 'C:/x/collector.pid', pid: 4224, alive: true };

const work = (over: Partial<CollectorWorkInfo> = {}): CollectorWorkInfo => ({
  symbol: COLLECTOR_WORK_SYMBOL, lastTickAt: null, feedAt: null, ...over,
});

/** 心拍は常に新しい(= プロセスは確実に生きている)状態で組み立てる。 */
const watch = (now: number, w: CollectorWorkInfo) => buildCollectorWatch({
  now, heartbeatAt: now - 2_000, pid: LIVE_PID, work: w,
});

describe('★生きているが仕事をしていない(stuck)', () => {
  it('場中・ティックが止まっている・monitor 自身のフィードは新鮮 → stuck', () => {
    const w = watch(MIDDAY, work({
      lastTickAt: MIDDAY - COLLECTOR_STUCK_MS - 60_000,
      feedAt: MIDDAY - 2_000,
    }));
    expect(w.state).toBe('stuck');
    expect(w.reason).toContain('生きていますが記録が止まっています');
    // ★「なぜ時間外では説明できないのか」を判定文そのものに書く(読み手が推測しないで済むように)。
    expect(w.reason).toContain('取引時間外・休場日・フィード障害では説明できません');
  });

  it('ティックが1件も無い場合も同じ(「観測できない」を「異常なし」と読まない)', () => {
    const w = watch(MIDDAY, work({ lastTickAt: null, feedAt: MIDDAY - 2_000 }));
    expect(w.state).toBe('stuck');
    expect(w.reason).toContain('ティックが1件も無い');
  });

  it('ティックが伸びていれば ok(正常)', () => {
    const w = watch(MIDDAY, work({ lastTickAt: MIDDAY - 3_000, feedAt: MIDDAY - 2_000 }));
    expect(w.state).toBe('ok');
  });

  it('境界: 閾値ちょうどは ok・1ms 超で stuck', () => {
    const at = MIDDAY - COLLECTOR_STUCK_MS;
    expect(watch(MIDDAY, work({ lastTickAt: at, feedAt: MIDDAY })).state).toBe('ok');
    expect(watch(MIDDAY, work({ lastTickAt: at - 1, feedAt: MIDDAY })).state).toBe('stuck');
  });

  it('時計のずれ(未来のティック)で異常判定を出さない', () => {
    expect(watch(MIDDAY, work({ lastTickAt: MIDDAY + 60_000, feedAt: MIDDAY })).state).toBe('ok');
  });
});

describe('★取り違えないこと(ここが本丸)', () => {
  it('取引時間外は判定しない(ティックが増えないのは正常)', () => {
    for (const now of [OUT_SESSION, WEEKEND]) {
      const w = watch(now, work({ lastTickAt: now - 6 * 60 * 60_000, feedAt: now - 1_000 }));
      expect(w.state).toBe('idle');
      expect(w.reason).not.toContain('記録が止まっています');
    }
  });

  it('★休場日(先物の非取引日)も判定しない', () => {
    const w = watch(HOLIDAY, work({ lastTickAt: HOLIDAY - 24 * 60 * 60_000, feedAt: HOLIDAY - 1_000 }));
    expect(w.state).toBe('idle');
  });

  it('★寄り直後は判定しない(直前セッション最後のティックは当然古い)', () => {
    for (const now of [JUST_OPENED, PRE_OPEN]) {
      const w = watch(now, work({ lastTickAt: now - 18 * 60 * 60_000, feedAt: now - 1_000 }));
      expect(w.state).toBe('ok');
      expect(w.reason).toContain('セッションが始まって');
    }
  });

  it('★引け後のマージン(15:45-15:55)でも判定しない(ティックは引けで止まるのが正常)', () => {
    const afterClose = jst(2026, 6, 3, 15, 52);
    const w = watch(afterClose, work({ lastTickAt: jst(2026, 6, 3, 15, 44), feedAt: afterClose - 1_000 }));
    expect(w.state).toBe('ok');
    expect(w.reason).toContain('セッションが始まって');
  });

  it('★monitor 自身のフィードも古いなら「収集デーモンの異常」と言い切らない(休場/フィード障害)', () => {
    const w = watch(MIDDAY, work({
      lastTickAt: MIDDAY - 30 * 60_000, feedAt: MIDDAY - MONITOR_FEED_FRESH_MS - 1,
    }));
    expect(w.state).toBe('ok');
    expect(w.reason).toContain('収集デーモンの異常とは判定しません');
    // ★それでも「増えていない」事実は必ず残す(黙ると「観測できない」を「異常なし」と読み替える)。
    expect(w.reason).toContain('止まっている');
  });

  it('★フィードを一度も観測できていない場合も判定しない', () => {
    const w = watch(MIDDAY, work({ lastTickAt: MIDDAY - 30 * 60_000, feedAt: null }));
    expect(w.state).toBe('ok');
    expect(w.reason).toContain('観測できていない');
  });

  it('★材料を渡さない呼び出し(既存の呼び出し)は stuck を一切出さない', () => {
    const w = buildCollectorWatch({ now: MIDDAY, heartbeatAt: MIDDAY - 2_000, pid: LIVE_PID });
    expect(w.state).toBe('ok');
    expect(w.tickAgeMs).toBeNull();
  });

  it('★死亡(dead)が最優先: 心拍が凍っていれば stuck ではなく dead', () => {
    const w = buildCollectorWatch({
      now: MIDDAY, heartbeatAt: MIDDAY - COLLECTOR_DEAD_MS - 1, pid: LIVE_PID,
      work: work({ lastTickAt: MIDDAY - 60 * 60_000, feedAt: MIDDAY }),
    });
    expect(w.state).toBe('dead');
  });
});

describe('judgeCollectorWork(純関数)', () => {
  const base = { stuckMs: COLLECTOR_STUCK_MS, feedFreshMs: MONITOR_FEED_FRESH_MS };
  it('時間外は何も言わない', () => {
    const r = judgeCollectorWork({ ...base, now: WEEKEND, poll: false, work: work({ lastTickAt: 0, feedAt: WEEKEND }) });
    expect(r.verdict).toBe('not-judged');
    expect(r.reason).toBe('');
  });
  it('材料が無ければ判定しない', () => {
    const r = judgeCollectorWork({ ...base, now: MIDDAY, poll: true, work: work() });
    expect(r.verdict).toBe('not-judged');
  });
  it('伸びていれば working', () => {
    const r = judgeCollectorWork({
      ...base, now: MIDDAY, poll: true, work: work({ lastTickAt: MIDDAY - 1_000, feedAt: MIDDAY }),
    });
    expect(r.verdict).toBe('working');
  });
});

describe('外へ出す(別PCから読める・画面に出る)', () => {
  const stuck = watch(MIDDAY, work({ lastTickAt: MIDDAY - 20 * 60_000, feedAt: MIDDAY - 2_000 }));

  it('人が読む1行に、判定の材料(ティック / monitor 自身のフィード)が両方出る', () => {
    const line = formatCollectorWatchStatus(stuck);
    expect(line).toContain('STUCK');
    expect(line).toContain('最終ティック');
    expect(line).toContain('monitor自身のフィード');
  });

  it('書き出しフォルダの状態ファイルにも、判定の根拠が書いてある', () => {
    const body = formatCollectorStatusFile(stuck, 'host');
    expect(body).toContain('状態: STUCK');
    expect(body).toContain('2つの独立した事実の食い違い');
    expect(body).toContain('monitor 自身のフィード');
  });

  it('★共用の1行ログに必ず残す遷移(異常と復帰)', () => {
    expect(shouldLogTransition(null, 'stuck')).toBe(true);
    expect(shouldLogTransition('ok', 'stuck')).toBe(true);
    expect(shouldLogTransition('stuck', 'ok')).toBe(true);
    expect(shouldLogTransition('stuck', 'stuck')).toBe(false);
  });

  it('★画面のドットが「正常(緑)」に紛れない', () => {
    const html = renderCollectorDot({
      state: 'stuck', reason: stuck.reason, heartbeatAt: MIDDAY - 2_000, ageMs: 2_000,
      inPollWindow: true, pidAlive: true, at: MIDDAY,
    });
    expect(html).toContain('🔴');
    expect(html).toContain('記録が止まっています');
    const okHtml = renderCollectorDot({
      state: 'ok', reason: 'x', heartbeatAt: 1, ageMs: 1, inPollWindow: true, pidAlive: true, at: 1,
    });
    expect(html).not.toBe(okHtml);
  });
});

describe('★握りつぶした失敗を無音にしない(collector の poll 例外)', () => {
  it('1回2回では書かない(一時的な失敗で共用ログを埋めない)', () => {
    expect(shouldReportStreak(1)).toBe(false);
    expect(shouldReportStreak(4)).toBe(false);
  });
  it('連続したら1行書き、その後は間隔をあけて書く', () => {
    expect(shouldReportStreak(5)).toBe(true);
    expect(shouldReportStreak(6)).toBe(false);
    expect(shouldReportStreak(155)).toBe(true);
    expect(shouldReportStreak(305)).toBe(true);
  });
});
