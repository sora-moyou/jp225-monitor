// 提案生成器(別プロセス)。**取引しない**。AI にエントリー計画を要求し、提案を全数記録するだけ。
//
//   npm run generator:dev        (接続先は既定 localhost / GENERATOR_MONITOR_URL で変更)
//
// ■ ★ライブでは約定判定をしない
//   別プロセスの生成器は「その瞬間のライブ価格」を持てないので、ライブで判定すると A と違う価格で
//   判定することになる。記録だけに絞れば経路が1本になり、実弾へのリスクもゼロになる。
//   約定判定・影の決済模擬は **オフラインの再生**(記録済み提案 + 保管ティック)で後から行う。
//   → このプロセスは ShadowSim を呼ばない。取引経路にも一切触らない。
//
// ■ 止まったことに気づく仕組み
//   「1年後に、実は3か月動いていなかった」が最悪の失敗形。だから
//     ・取引日ごとの件数(腕別・見送り理由別)を専用 DB に **追記**(いつ止まったかが必ず読める)
//     ・monitor の /api/status に「生成器 最終記録 N分前」を出す(ユーザーが見る画面に出す)
//   生成器側だけの死活監視は、生成器が死んだら一緒に死ぬ。

import { randomUUID } from 'node:crypto';
import { isAnalysisEnabled } from '../analysisGate.js';
import { resolvePort } from '../configStore.js';
import { classifySession } from '../../core/session.js';
import {
  openGeneratorDb, resolveGeneratorDbPath, insertProposal, insertRun, appendDailyTally,
  type ProposalRow,
} from '../db/generatorStore.js';
import { resolveGeneratorConfig, epochGeneratorConfig } from './config.js';
import { buildEpochInput, computeEpoch, canonicalJson } from './epoch.js';
import { runPreflight } from './preflight.js';
import { makeCycleId, runCycle, type CycleDeps } from './cycle.js';

/** 400(caller/exitVariant の拒否)が続いたら止める回数。1回目は一過性の可能性があるが、
 *  続くのは前提が崩れたということ。測っていない標本を溜め続けるより止める方がよい。 */
const FATAL_BAD_REQUEST_STREAK = 3;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 起動を打ち切る合図。**理由は既にログに出ている**ので、上位はこれを普通の終了として扱う。 */
class AbortStartup extends Error {}

/** 理由を明示して終了する(黙って縮退しない)。
 *  ★process.exit() を即時に呼ばない: 前提検証の fetch が張った keep-alive ソケットが生きている最中に
 *    即時終了すると libuv が assert して異常終了コードになり、「わざと止めた」のか「落ちた」のかが
 *    ログから区別できなくなる。exitCode を立てて畳み、イベントループが空になったら自然終了させる。 */
function die(reason: string, phase = '起動しません'): never {
  console.error(`[generator] ★${phase}: ${reason}`);
  process.exitCode = 1;
  throw new AbortStartup(reason);
}

async function main(): Promise<void> {
  // ── 公開版(lite)では走らない。唯一のゲート isAnalysisEnabled() で判断する。
  if (!isAnalysisEnabled()) {
    die('このビルドは分析用の経路を持ちません(公開版 lite) — server/analysisGate.ts');
  }

  const cfg = resolveGeneratorConfig(process.env, resolvePort());
  console.log(`[generator] 接続先 ${cfg.monitorUrl} / 間隔 ${cfg.intervalMs / 1000}s / 対照 ${cfg.controlEvery || '(なし)'}サイクルに1回`);

  // ── ① 起動時の検証。満たさなければ走らない。
  const pre = await runPreflight(cfg.monitorUrl, fetch, 10_000);
  if (!pre.ok) die(pre.reason);
  console.log(`[generator] 前提OK: 決済実装=${pre.exit.impl} 変種実装=${pre.exit.variantImpl} `
    + `決済設定 版=${pre.exit.configVersion ?? '(未採番)'} 指紋=${pre.exit.configHash}`);

  // ── epoch。凍結設定 + 決済指紋 + 生成器設定のハッシュ。★入力が動けば自動で変わる。
  const epochInput = buildEpochInput(pre.settings, pre.exit, epochGeneratorConfig(cfg));
  const epoch = computeEpoch(epochInput);
  console.log(`[generator] epoch=${epoch}`);

  const dbPath = resolveGeneratorDbPath();
  const db = openGeneratorDb(dbPath);
  const startedAt = Date.now();
  insertRun(db, {
    startedAt, epoch, monitorUrl: cfg.monitorUrl,
    exitImpl: pre.exit.impl, exitVariantImpl: pre.exit.variantImpl,
    exitConfigVersion: pre.exit.configVersion, exitConfigHash: pre.exit.configHash,
    // ★凍結設定は /api/settings の生スナップショットをそのまま(取引記録から推測しない)。
    settingsJson: JSON.stringify(pre.settings),
    epochInputJson: canonicalJson(epochInput),
    generatorConfigJson: JSON.stringify(cfg),
  });
  console.log(`[generator] 台帳 ${dbPath}`);

  const dep: CycleDeps = { fetcher: fetch, now: Date.now, sleep, random: Math.random };
  const prefix = randomUUID().slice(0, 8);
  let cycleIndex = 0;
  let lastTallyAt = 0;
  let lastTallyDay: string | null = null;
  let badRequestStreak = 0;
  let stopping = false;

  /** 取引日ごとの件数を追記する(取引日が変わったとき、または間隔経過で)。 */
  const tally = (now: number, force = false): void => {
    const day = classifySession(now)?.sessionDate ?? '(closed)';
    if (!force && day === lastTallyDay && now - lastTallyAt < cfg.tallyIntervalMs) return;
    try {
      const n = appendDailyTally(db, now);
      lastTallyAt = now; lastTallyDay = day;
      console.log(`[generator] 件数を追記(${n}行) 取引日=${day}`);
    } catch (e) {
      console.error('[generator] 件数の追記に失敗:', e instanceof Error ? e.message : String(e));
    }
  };

  const shutdown = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[generator] ${sig} — 件数を追記して終了します`);
    tally(Date.now(), true);
    try { db.close(); } catch { /* close 失敗は無視 */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── 主ループ。1サイクルは【直列】(①→①'→②)。次の起動は経過時間を差し引いてドリフトさせない。
  for (;;) {
    if (stopping) return;
    const cycleStart = Date.now();
    const cycleId = makeCycleId(prefix, cycleStart, cycleIndex);
    let rows: ProposalRow[];
    try {
      rows = await runCycle(cfg, dep, { epoch, cycleId, cycleIndex });
    } catch (e) {
      // runCycle 自身は結末を値で返す設計なので、ここに来るのは想定外。無音にしない。
      console.error('[generator] サイクルが例外で終了:', e instanceof Error ? e.message : String(e));
      rows = [];
    }
    for (const row of rows) {
      try {
        if (!insertProposal(db, row)) console.warn(`[generator] 重複のため記録せず ${row.cycleId}/${row.arm}`);
      } catch (e) {
        console.error('[generator] 記録に失敗:', e instanceof Error ? e.message : String(e));
      }
    }
    const summary = rows.map(r => `${r.arm}=${r.status}${r.skipReason ? `(${r.skipReason})` : ''}${r.direction ? `:${r.direction}` : ''}`).join(' ');
    const shots = new Set(rows.map(r => r.shotId).filter((s): s is string => s !== null));
    console.log(`[generator] サイクル ${cycleIndex} ${summary}`
      + (shots.size > 0 ? ` 画像=${shots.size === 1 ? '同一' : `別 (${shots.size}枚)`}` : ''));

    // ★400 が続く = caller/変種が拒否されている = 測っていない標本を溜め続ける状態。止める。
    if (rows.length > 0 && rows.every(r => r.skipReason === 'bad-request')) badRequestStreak += 1;
    else badRequestStreak = 0;
    if (badRequestStreak >= FATAL_BAD_REQUEST_STREAK) {
      tally(Date.now(), true);
      try { db.close(); } catch { /* ignore */ }
      die(`monitor が要求を ${FATAL_BAD_REQUEST_STREAK} サイクル連続で 400 拒否しました`
        + `(${rows[0]?.error ?? '理由不明'})。前提が崩れたまま溜め続けません`, '停止します');
    }

    tally(Date.now());
    cycleIndex += 1;
    const wait = Math.max(0, cfg.intervalMs - (Date.now() - cycleStart));
    await sleep(wait);
  }
}

main().catch((e) => {
  if (e instanceof AbortStartup) return;   // 理由は die() が既に出している(異常終了ではない)。
  console.error('[generator] 異常終了:', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
