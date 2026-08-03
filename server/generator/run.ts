// 提案生成器の本体(ループそのもの)。**取引しない**。AI にエントリー計画を要求し、提案を全数記録するだけ。
//
// ■ なぜ index.ts から分けたか
//   同じループを2つの入口から走らせるため:
//     ・server/generator/index.ts   … 開発用 CLI(`npm run generator:dev`)
//     ・server/generator/sidecar.ts … 配布物に同梱するサイドカー(第3の externalBin)
//   ★ロジックは1本のまま(入口が増えても「生成器が2つある」状態を作らない)。
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
import { recheck, epochInputDiffKeys } from './recheck.js';
import { makeCycleId, runCycle, type CycleDeps } from './cycle.js';

/** 400(caller/exitVariant の拒否)が続いたら止める回数。1回目は一過性の可能性があるが、
 *  続くのは前提が崩れたということ。測っていない標本を溜め続けるより止める方がよい。 */
const FATAL_BAD_REQUEST_STREAK = 3;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 起動/稼働を打ち切る合図。**理由は既にログに出ている**ので、上位はこれを普通の終了として扱う。
 *  ★理由と局面を **値として** 持たせる: 配布物では運用者がコンソールを見られないので、
 *    上位(サイドカー)が同じ文言を台帳に残して画面まで届ける必要がある。
 *    ログにしか無い理由は、無いのと同じ。 */
export class GeneratorHalt extends Error {
  constructor(readonly reason: string, readonly phase: string) {
    super(reason);
    this.name = 'GeneratorHalt';
  }
}

/** 理由を明示して終了する(黙って縮退しない)。
 *  ★process.exit() を即時に呼ばない: 前提検証の fetch が張った keep-alive ソケットが生きている最中に
 *    即時終了すると libuv が assert して異常終了コードになり、「わざと止めた」のか「落ちた」のかが
 *    ログから区別できなくなる。呼び出し側(CLI)が exitCode を立てて畳み、イベントループが空になったら
 *    自然終了させる。 */
function die(reason: string, phase = '起動しません'): never {
  console.error(`[generator] ★${phase}: ${reason}`);
  throw new GeneratorHalt(reason, phase);
}

export interface GeneratorRunOptions {
  /** ★ループを続けてよいか(サイクルの先頭で毎回問う)。false を返したら件数を追記して普通に戻る。
   *  サイドカーが「設定で無効に戻された」を検知して待機へ帰るために使う。
   *  未指定(CLI)は従来どおり永久ループ=挙動不変。 */
  shouldContinue?: () => boolean;
  /** ★診断用の通知(記録専用・**挙動には一切影響しない**)。未指定(CLI)は従来どおり何も起きない。
   *  サイドカーがこれを共有DBの meta に載せ、別PCから「どこまで進んだか」を読めるようにする
   *  (前提検証の結果・接続先・最後のサイクル時刻はログにしか無く、遠隔からは観測できなかった)。 */
  onEvent?: (e:
    | { kind: 'config'; monitorUrl: string }
    | { kind: 'preflight'; at: number; ok: boolean; failKind?: string; reason?: string }
    | { kind: 'cycle'; at: number }) => void;
}

/** 生成器の本体。前提が崩れたら GeneratorHalt を throw する(黙って縮退しない)。
 *  shouldContinue が false を返したときだけ、停止ではなく **正常に戻る**。 */
export async function runGenerator(opts: GeneratorRunOptions = {}): Promise<void> {
  /** 診断通知。**絶対に throw させない**(記録のために生成器を落とさない)。 */
  const notify: NonNullable<GeneratorRunOptions['onEvent']> = (e) => {
    try { opts.onEvent?.(e); } catch { /* 記録の失敗で本体を止めない */ }
  };
  // ── 公開版(lite)では走らない。唯一のゲート isAnalysisEnabled() で判断する。
  if (!isAnalysisEnabled()) {
    die('このビルドは分析用の経路を持ちません(公開版 lite) — server/analysisGate.ts');
  }

  const cfg = resolveGeneratorConfig(process.env, resolvePort());
  notify({ kind: 'config', monitorUrl: cfg.monitorUrl });
  console.log(`[generator] 接続先 ${cfg.monitorUrl} / 間隔 ${cfg.intervalMs / 1000}s / 対照 ${cfg.controlEvery || '(なし)'}サイクルに1回`);

  // ── ① 起動時の検証。満たさなければ走らない。
  //    ★起動時は unreachable でも走らない(接続先が居ないまま空回りしない)。
  //      稼働中の再検証(下のループ)だけは unreachable を「止める理由」にしない。
  const pre = await runPreflight(cfg.monitorUrl, fetch, 10_000);
  notify(pre.ok
    ? { kind: 'preflight', at: Date.now(), ok: true }
    : { kind: 'preflight', at: Date.now(), ok: false, failKind: pre.kind, reason: pre.reason });
  if (!pre.ok) die(pre.reason);
  console.log(`[generator] 前提OK: 決済実装=${pre.exit.impl} 変種実装=${pre.exit.variantImpl} `
    + `決済設定 版=${pre.exit.configVersion ?? '(未採番)'} 指紋=${pre.exit.configHash}`);

  // ── epoch。凍結設定 + 決済指紋 + 生成器設定のハッシュ。★入力が動けば自動で変わる。
  //    ★「動けば変わる」を本当にするために、**サイクルごとに取り直す**(主ループの先頭)。
  //      起動時1回だと、バイアスや LC 安全上限をライブで切り替えた瞬間から
  //      別条件の標本が同じ期のラベルで積まれ続ける(=静かに嘘になる)。
  const epochInput = buildEpochInput(pre.settings, pre.exit, epochGeneratorConfig(cfg));
  let epoch = computeEpoch(epochInput);
  let currentEpochInput: Record<string, unknown> = epochInput;
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
  const onSigint = (): void => shutdown('SIGINT');
  const onSigterm = (): void => shutdown('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  // ★この関数は(サイドカーから)何度も呼ばれうるので、抜けるときに必ずハンドラを外す。
  //   外さないと 有効/無効 を切り替えるたびに listener が積み上がる(CLI は抜けないので挙動不変)。
  try {
    await mainLoop();
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
  return;

  // ── 主ループ。1サイクルは【直列】(①→①'→②)。次の起動は経過時間を差し引いてドリフトさせない。
  async function mainLoop(): Promise<void> {
  for (;;) {
    if (stopping) return;
    // ★設定で無効に戻された = 「止まった」ではなく「走らせないことにした」。停止理由は残さず、
    //   件数だけ追記して普通に戻る(サイドカーは待機へ帰る)。
    if (opts.shouldContinue && !opts.shouldContinue()) {
      console.log('[generator] 設定が無効になりました — 件数を追記して待機に戻ります');
      tally(Date.now(), true);
      try { db.close(); } catch { /* close 失敗は無視 */ }
      return;
    }
    const cycleStart = Date.now();

    // ── ★サイクルごとの再検証(前提 + 期)。起動時1回では、設定を変えた瞬間から静かに嘘になる。
    const rc = await recheck(cfg, fetch, 10_000, epoch);
    if (rc.kind === 'violated') {
      // 前提が崩れた(専用キーが外れた/決済実装が公開フォールバックに落ちた等)。
      // 測っていない標本を溜め続けるより止める(起動時の判断と同じ規律を稼働中にも適用する)。
      tally(Date.now(), true);
      try { db.close(); } catch { /* ignore */ }
      die(`稼働中に前提が崩れました: ${rc.reason}`, '停止します');
    } else if (rc.kind === 'unreachable') {
      // monitor の再起動でも起きる。前提が崩れた証拠が無いので **止めない**(期も変えない)。
      // サイクル自体は走らせる=結末は network-error として台帳に残り、欠測が無音にならない。
      console.warn(`[generator] 再検証できず(期は据え置き ${epoch}): ${rc.reason}`);
    } else if (rc.kind === 'epoch-changed') {
      // ★止めるのではなく **期を分ける**。ここから先の標本は新しい epoch で積む。
      const changed = epochInputDiffKeys(currentEpochInput, rc.epochInput);
      console.log(`[generator] ★期が変わりました ${rc.prevEpoch} → ${rc.epoch}(変化した入力: ${changed.join(' ') || '(不明)'})`);
      epoch = rc.epoch;
      currentEpochInput = rc.epochInput;
      // 新しい期の開始を台帳(runs)に残す。★1年後に「いつ何が変わって期が割れたか」が差分で読める。
      try {
        insertRun(db, {
          startedAt: Date.now(), epoch, monitorUrl: cfg.monitorUrl,
          exitImpl: rc.pre.exit.impl, exitVariantImpl: rc.pre.exit.variantImpl,
          exitConfigVersion: rc.pre.exit.configVersion, exitConfigHash: rc.pre.exit.configHash,
          settingsJson: JSON.stringify(rc.pre.settings),
          epochInputJson: canonicalJson(rc.epochInput),
          generatorConfigJson: JSON.stringify(cfg),
        });
      } catch (e) {
        console.error('[generator] 期の切替を台帳に残せませんでした:', e instanceof Error ? e.message : String(e));
      }
    }

    notify({ kind: 'cycle', at: cycleStart });
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
}
