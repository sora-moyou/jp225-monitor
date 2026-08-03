// 提案生成器サイドカーの本体(ロジック)。入口は server/generator/sidecar.ts。
//
// ■ なぜ同梱するのか
//   生成器は monitor を HTTP で叩くので **同じ PC に居る必要がある**。運用PCにはインストーラしか
//   入らないので、開発用スクリプト(`tsx server/generator/index.ts`)のままでは提案が1件も記録されない。
//   → コレクタ(binaries/jp225-collector)と **同じ流儀** で SEA バイナリにして同梱する
//     (scripts/build-generator.mjs / scripts/copy-generator.mjs / src-tauri/src/lib.rs の spawn)。
//
// ■ ★既定は停止。明示的に有効化するまで走らない
//   LLM 予算はユーザーの財布なので、インストールしただけで2分ごとに叩き始めてはいけない。
//   設定 generatorEnabled(既定 false・~/.jp225-monitor/config.json)が true になるまで
//   このプロセスは **待機するだけ**:
//     ・LLM を1回も叩かない(monitor へ HTTP を1回も出さない=前提検証すら走らせない)
//     ・台帳 DB を1行も書かない(ファイルを **開きもしない**)
//     ・再生も走らせない(再生は DB を書く)
//   待機中に触るのは config.json の読み取り(loadConfig の mtime キャッシュ)だけ。
//
// ■ ★lite では spawn しない
//   一次ゲートは Rust(variant=='full' のときだけ spawn)。ここは二次ゲート
//   (万一起動されても isAnalysisEnabled() で即座に何もせず終わる)。
//
// ■ 起動時検証で止まったら、理由を **画面に届ける**
//   運用PCではコンソールを見られない。理由がログにしか無ければ「動いていない」ことしか分からず、
//   「なぜ止まったか」は永遠に分からない(この2つは別物)。停止理由は台帳の halts に追記し、
//   monitor の /api/status → 死活ドット(web/components/apiStatusPane.ts)まで運ぶ。
//
// ■ 再生(replay)は **別プロセス** で1日1回
//   再生は日が溜まるほど伸びる(実測3日で7秒)。同じイベントループで回すと生成器の2分サイクルを
//   侵食する。だから自分自身を `--replay` で spawn する(=サイクルは1ミリも待たない)。
//   どの取引日を再生してよいか(取引日の確定＋地平＋猶予)の判定は server/replay/ に既存のものを使う。

import type { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { isAnalysisEnabled } from '../analysisGate.js';
import { resolveGeneratorEnabled } from '../configStore.js';
import {
  openGeneratorDb, resolveGeneratorDbPath, insertGeneratorHalt,
} from '../db/generatorStore.js';
import { openDb, resolveDbPath } from '../db/store.js';
import {
  writeGeneratorSidecarState, GENERATOR_SIDECAR_HEARTBEAT_MS,
  type GeneratorSidecarState, type GeneratorSidecarPhase,
} from '../db/generatorHeartbeat.js';
import { jstStamp } from '../db/tickArchiveHeartbeat.js';
import {
  acquirePidLock, releasePidLock, pidLockPath, inspectPidLock, isAliveAsImage, ownImageName,
  type PidLockHolder,
} from '../pidLock.js';
import { appendSpawnLog, GENERATOR_PID_LOCK_BLOCKED_MARK } from '../spawnLog.js';
import { generatorLogPath } from './sidecarLog.js';
import { runGenerator, GeneratorHalt } from './run.js';

/** ★生成器の pid ファイル名(collector.pid と **同じ流儀・同じ置き場**)。
 *
 *  なぜ要るか: collector は collector.pid を書くので外から死活が読める。生成器は何も残さず、
 *  「起動していない」と「有効化待ちで待機していた」を外から区別できなかった(共有DBの名乗りは
 *  生成器がDBを書けるときしか出ない)。生存の一次証拠は **プロセスが自分で書く pid** に置く。
 *
 *  ついでに単一インスタンスも collector と同じ規律で保証する: 生成器はアプリ終了後も生き残る
 *  設計なので、アプリを2回起動すると生成器が2本走り、LLM 予算と台帳行が二重になる。 */
export const GENERATOR_PID_FILE = 'generator.pid';

// ─── ★自分の状態を名乗る(遠隔診断の一次情報) ────────────────────────────────
//
// 実売買PCで「有効なのに台帳が1行も無い」が起きたとき、**プロセスが居るのかどうかすら** 分からなかった。
// 待機中(設定が無効)の生成器は設計上 台帳に1行も書かないので、台帳の有無では
//   「起動していない」 と 「待機していた」 が区別できない。
// → サイドカー自身が共有DB(jp225.db)の meta に30秒ごとに名乗る。meta は trade2 の30分ごとの
//   `VACUUM INTO` にそのまま乗るので、既存の同期経路で別PCへ届く(新しい配管を作らない)。
// ★ここで書くのは **状態だけ**(キーの値・決済の実数値は含めない)。

/** 名乗りの中身(プロセス内の唯一の真実)。 */
const sidecarState: GeneratorSidecarState = {
  v: 1, at: 0, atJst: '', pid: process.pid, phase: 'starting',
  enabled: false, variant: process.env.MONITOR_VARIANT ?? '(未設定)',
  logPath: null, ledgerPath: '', monitorUrl: null,
  lastCycleAt: null, lastPreflight: null, halt: null, lastReplay: null,
};

let sharedDb: DatabaseSync | null = null;
let beatTimer: NodeJS.Timeout | null = null;

/** 現在の名乗りを共有DBへ書く。**絶対に throw しない**(診断のために生成器を落とさない)。 */
export function beatSidecar(now: number = Date.now()): void {
  sidecarState.at = now;
  sidecarState.atJst = jstStamp(now);
  sidecarState.enabled = safeEnabled();
  sidecarState.logPath = generatorLogPath();
  if (!sidecarState.ledgerPath) {
    try { sidecarState.ledgerPath = resolveGeneratorDbPath(); } catch { /* 解決できなくても名乗る */ }
  }
  try {
    if (!sharedDb) sharedDb = openDb(resolveDbPath());
    writeGeneratorSidecarState(sharedDb, sidecarState);
  } catch (e) {
    warn(`状態を共有DBに書けません: ${e instanceof Error ? e.message : String(e)}`);
    try { sharedDb?.close(); } catch { /* ignore */ }
    sharedDb = null;   // 次回に開き直す
  }
}

/** 局面を変えて即座に名乗る(変わった瞬間が遠隔から読めるように)。 */
export function setSidecarPhase(phase: GeneratorSidecarPhase, now: number = Date.now()): void {
  sidecarState.phase = phase;
  beatSidecar(now);
}

/** 名乗りを定期化する。**プロセスを起こし続けない**(本体のループが主)。 */
export function startSidecarHeartbeat(intervalMs: number = GENERATOR_SIDECAR_HEARTBEAT_MS): () => void {
  beatSidecar();
  beatTimer = setInterval(() => beatSidecar(), intervalMs);
  beatTimer.unref?.();
  return () => { if (beatTimer) { clearInterval(beatTimer); beatTimer = null; } };
}

/** 設定を読む(壊れていても落ちない)。 */
function safeEnabled(): boolean {
  try { return resolveGeneratorEnabled(); } catch { return false; }
}

/** テスト/診断用: いまの名乗りの写し。 */
export function sidecarStateSnapshot(): GeneratorSidecarState { return { ...sidecarState }; }

/** 有効/無効の設定を見に行く間隔[ms]。config.json の stat だけなので軽い。 */
export const ENABLE_POLL_MS = 15_000;

/** ★起動時に monitor へ到達できなかったときの再試行間隔[ms]。
 *
 *  なぜ要るか: サイドカーは monitor 本体と **同時に** spawn される。monitor の HTTP が待ち受けを
 *  始める前に前提検証が走ると 'unreachable' で止まり、従来はそのまま
 *  「設定を無効→有効に切り替えるまで永久待機」だった。ユーザーは何もしていないのに
 *  **アプリを起動するたびに生成器だけが死んでいる** 状態が起こりうる(標本が溜まらない)。
 *  ★'unreachable' は run.ts の稼働中再検証でも「前提が崩れた証拠ではない」と扱っている。
 *    起動時だけ永久停止にする理由は無いので、同じ規律で **再試行** する(黙って縮退はしない=毎回ログ)。
 *  ★前提が崩れた('violated')場合は従来どおり止める。測っていない標本を溜め続けない。 */
export const UNREACHABLE_RETRY_MS = 60_000;

/** ★pid ロックが取れなかったときの再判定間隔[ms]。
 *
 *  なぜ要るか(この分岐は以前 **恒久終了** だった): ロックが取れないと `return` していたので、
 *  一度でも判定を誤れば **アプリを再インストールするまで生成器が二度と上がらない**。
 *  しかも失敗は名乗り(startSidecarHeartbeat)より前に起きるので meta に何も残らず、
 *  別PCからは「起動していない疑い」としか読めなかった。
 *  ★ロックの目的(2本走らせない)は1ミリも緩めない: 取れるまで **待つ** だけで、走り出しはしない。 */
export const PID_LOCK_RETRY_MS = 60_000;

/** 再生の間隔[ms]。1日1回。 */
export const REPLAY_INTERVAL_MS = 24 * 60 * 60_000;

/** ★有効化してから最初の再生までの猶予[ms]。
 *  アプリ起動直後に重い処理を始めると起動が遅く見える(=A の応答も食う)。5分ずらす。 */
export const REPLAY_INITIAL_DELAY_MS = 5 * 60_000;

const log = (m: string): void => console.log(`[generator-sidecar] ${m}`);
const warn = (m: string): void => console.error(`[generator-sidecar] ${m}`);

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── 再生の自己起動 ──────────────────────────────────────────────────────────

/** 再生モードの合図。 */
export const REPLAY_FLAG = '--replay';

/** 「自分自身を --replay で起動する」コマンドを組み立てる(純関数=テストできる)。
 *  ★SEA バイナリでは argv[1] が exe 自身になるので、渡すのはフラグだけ。
 *    node + スクリプト(開発時)では argv[1] がスクリプトのパスなので、それを引き継ぐ。 */
export function replaySelfCommand(
  argv: readonly string[], execPath: string,
): { cmd: string; args: string[] } {
  const script = argv[1];
  const carry = script && script !== execPath ? [script] : [];
  return { cmd: execPath, args: [...carry, REPLAY_FLAG] };
}

/** 再生を **別プロセス** で走らせる。生成器のイベントループを1ミリも占有しない。
 *  ★同時に2本走らせない(前の再生が終わっていなければ見送る=次の周期で拾える)。 */
export function makeReplaySpawner(): () => void {
  let running = false;
  return (): void => {
    if (running) { log('前回の再生がまだ走っています — 今回は見送ります'); return; }
    const { cmd, args } = replaySelfCommand(process.argv, process.execPath);
    running = true;
    const started = Date.now();
    log(`再生を別プロセスで開始: ${cmd} ${args.join(' ')}`);
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      running = false;
      warn(`再生プロセスを起動できませんでした: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // ★出力は必ず読む(読まないとパイプが詰まって子が止まる)。無音の失敗を作らない。
    child.stdout?.on('data', (b: Buffer) => process.stdout.write(String(b)));
    child.stderr?.on('data', (b: Buffer) => process.stderr.write(String(b)));
    child.on('error', (e) => {
      running = false;
      warn(`再生プロセスの起動に失敗: ${e.message}`);
    });
    child.on('close', (code) => {
      running = false;
      const sec = Math.round((Date.now() - started) / 1000);
      // ★再生の最終実行を名乗りに残す(1日1回なので、走っているかどうかは遠隔からは他に読めない)。
      sidecarState.lastReplay = { at: started, code: code ?? null, sec };
      beatSidecar();
      log(`再生が終了しました code=${code} (${sec}秒)`);
    });
  };
}

/** 再生を1日1回スケジュールする。**タイマーだけ**(ここでは何も走らせない)。
 *  ★毎回 enabled を問い直す: 無効に戻したのに再生だけ走り続ける、を作らない。 */
export function startReplaySchedule(
  spawnReplay: () => void,
  enabled: () => boolean,
  initialDelayMs = REPLAY_INITIAL_DELAY_MS,
  intervalMs = REPLAY_INTERVAL_MS,
): () => void {
  const fire = (): void => {
    if (!enabled()) { log('再生: 設定が無効なので走らせません'); return; }
    spawnReplay();
  };
  const first = setTimeout(() => { fire(); }, initialDelayMs);
  const timer = setInterval(fire, intervalMs);
  // タイマーがプロセスを起こし続けないように(生成器のループが本体)。
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ─── 停止理由の記録 ──────────────────────────────────────────────────────────

/** 停止理由を台帳に追記する。**有効化されていて、実際に止まったときだけ** 呼ぶ。
 *  ★ここで台帳が無ければ作る: 一度も成功しなかった PC(専用キーが無い等)でも
 *    「なぜ止まったか」が画面に出るようにするため。記録できなくても落ちない。 */
export function recordHalt(halt: GeneratorHalt, now: number = Date.now()): void {
  try {
    const db = openGeneratorDb(resolveGeneratorDbPath());
    try {
      insertGeneratorHalt(db, { at: now, phase: halt.phase, reason: halt.reason });
    } finally {
      try { db.close(); } catch { /* close 失敗は無視 */ }
    }
    log(`停止理由を台帳に記録しました(画面の死活ドットに出ます): ${halt.phase} — ${halt.reason}`);
  } catch (e) {
    warn(`停止理由を台帳に記録できませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── ★pid ロック(取れなくても終わらない) ────────────────────────────────────
//
// ここが「起動しません」で終わっていたのが致命的だった。ロックは **二重起動を防ぐため** の物であって、
// 「二度と起動しないため」の物ではない。取れないなら取れるまで待ち、待っている理由を外へ出す。
//
// ★理由の届け方は **既存の配管だけ**(新しい機構を作らない):
//   sidecar-spawn.log(Rust が `[generator] spawned pid=…` を書いている共用の1行ログ)へ1行。
//   monitor が readSpawnLogTail でそれを読み、共有DB(jp225.db)meta の
//   generator_heartbeat.spawn / generator_status に載せる → trade2 の30分スナップショットで別PCへ届く。

/** ロックが取れない理由を1行にする(純関数=テストできる)。**キーの値も決済の実数値も含めない**。 */
export function describePidLockBlocked(holder: PidLockHolder, retryMs: number = PID_LOCK_RETRY_MS): string {
  const who = holder.pid === null
    ? 'ロックの中身が読めません'
    : `保持者 pid=${holder.pid}`;
  const image = holder.probe === null
    ? ''
    : holder.probe.ok
      ? ` イメージ=${holder.probe.image ?? '(そのpidは居ない)'}(照合対象=${holder.expectedImage})`
      : ` イメージ照合=できず(${holder.probe.error} — kill(pid,0) の判定に戻しました)`;
  return `★${GENERATOR_PID_LOCK_BLOCKED_MARK}: ${who}${image}`
    + ` — ${Math.round(retryMs / 1000)}秒ごとに再判定します(起動は保留・終了はしません) / ${holder.path}`;
}

/** ロックが取れるまで待つ。**取れるまで返らない**(= 走り出さない)。
 *  @returns 保留した回数(0 = 一度も待たずに取れた) */
export async function acquireGeneratorPidLock(opts: {
  acquire?: () => boolean;
  inspect?: () => PidLockHolder;
  retryMs?: number;
  report?: (line: string) => void;
  wait?: (ms: number) => Promise<void>;
  /** 無限に待たないための上限(既定は無し=常駐プロセスなので待ち続ける)。テスト専用。 */
  maxTries?: number;
} = {}): Promise<number> {
  const retryMs = opts.retryMs ?? PID_LOCK_RETRY_MS;
  const acquire = opts.acquire
    ?? (() => acquirePidLock(GENERATOR_PID_FILE, process.pid, pid => isAliveAsImage(pid, ownImageName())));
  const inspect = opts.inspect ?? (() => inspectPidLock(GENERATOR_PID_FILE));
  const report = opts.report ?? ((line: string) => { appendSpawnLog(`[generator] ${line}`); });
  const wait = opts.wait ?? sleep;
  let tries = 0;
  let reported = false;
  for (;;) {
    if (acquire()) {
      if (reported) {
        const line = `起動を再開しました: pid ロックを取得(保留 ${tries} 回 / 約${Math.round(tries * retryMs / 1000)}秒)`;
        log(line);
        report(line);
      }
      return tries;
    }
    tries += 1;
    const reason = describePidLockBlocked(inspect(), retryMs);
    log(reason);
    // ★共用ログは **最初の1回だけ**(毎分1行積み上げて他プロセスの記録を押し流さない)。
    if (!reported) { report(reason); reported = true; }
    if (opts.maxTries !== undefined && tries >= opts.maxTries) return tries;
    await wait(retryMs);
  }
}

// ─── 主処理 ──────────────────────────────────────────────────────────────────

/** その停止は「前提が崩れた」のか「まだ monitor に繋がらないだけ」か(純関数=テストできる)。
 *  ★到達できないことは前提が崩れた証拠ではない = 止める理由にしない(再試行する)。 */
export function isRetryableHalt(
  lastPreflight: { ok: boolean; kind?: string } | null,
): boolean {
  return lastPreflight !== null && !lastPreflight.ok && lastPreflight.kind === 'unreachable';
}

/** 設定が有効になるまで待つ。★DB も HTTP も触らない(config.json を読むだけ)。 */
async function waitUntil(want: boolean, pollMs: number): Promise<void> {
  if (resolveGeneratorEnabled() === want) return;
  log(want
    ? '設定 generatorEnabled が無効です — 有効化されるまで待機します(LLM も台帳も触りません)'
    : '★停止しました — 設定で一度 無効 に戻してから有効化すると再開します');
  for (;;) {
    await sleep(pollMs);
    if (resolveGeneratorEnabled() === want) {
      if (want) log('設定が有効になりました — 生成器を起動します');
      return;
    }
  }
}

/** サイドカーの主処理。★入口(server/generator/sidecar.ts)から呼ばれる。 */
export async function runSidecar(): Promise<void> {
  // ★--replay: 自分自身が再生モードで起動されたとき。再生本体をそのまま走らせる
  //   (import した時点で走る設計なので、この分岐でだけ読み込む)。
  if (process.argv.includes(REPLAY_FLAG)) {
    await import('../replay/index.js');
    return;
  }

  // ★lite の二次ゲート。一次ゲートは Rust(full のときだけ spawn)。
  if (!isAnalysisEnabled()) {
    // ★lite では共有DBにも触らない(名乗りも書かない)。分析用の機構は1つも動かさないのが約束。
    //   そもそも Rust の一次ゲートで spawn されない = ここに来るのは開発時だけ。
    sidecarState.phase = 'lite';
    log('このビルドは分析用の経路を持ちません(公開版 lite) — 何もしません');
    return;
  }

  // ★pid を残す(collector と同じ流儀)。ここから先は「居ること」が外から1秒で分かる。
  //   既に生きている生成器が居れば **走り出さない**(2本走らせて LLM 予算と台帳を二重にしない)が、
  //   ★取れないまま **終わらない**: 取れるまで待って自力で復帰する(理由は共用ログ経由で meta に出る)。
  //   生存判定は pid 実在 **＋ イメージ名一致**(Rust の相互排他と同じ考え方)= 強制終了で残った
  //   stale pid が別プロセスに再利用されても、それを「生きている生成器」と誤認しない。
  await acquireGeneratorPidLock();
  log(`pid=${process.pid} を ${pidLockPath(GENERATOR_PID_FILE)} に記録しました(イメージ=${ownImageName()})`);
  // 正常終了(process.exit を含む)で自分のロックだけ片付ける。★他人のロックには触らない実装。
  process.on('exit', () => { releasePidLock(GENERATOR_PID_FILE); });

  const pollMs = ENABLE_POLL_MS;
  // ★名乗りを開始する(ここから先はプロセスが居ることが遠隔から分かる)。
  const stopBeat = startSidecarHeartbeat();
  const stopSchedule = startReplaySchedule(makeReplaySpawner(), resolveGeneratorEnabled);
  /** 到達できずに再試行中か(台帳へ理由を積み上げないための1回だけのフラグ)。 */
  let retryingUnreachable = false;
  try {
    for (;;) {
      setSidecarPhase('waiting');
      await waitUntil(true, pollMs);
      setSidecarPhase('running');
      try {
        // 走っている最中に無効へ戻されたら、サイクルの先頭で普通に戻ってくる(停止ではない)。
        await runGenerator({
          shouldContinue: resolveGeneratorEnabled,
          // ★記録専用の通知。挙動には一切影響しない(throw も握りつぶす)。
          onEvent: (e) => {
            if (e.kind === 'config') { sidecarState.monitorUrl = e.monitorUrl; beatSidecar(); return; }
            if (e.kind === 'preflight') {
              sidecarState.lastPreflight = e.ok
                ? { at: e.at, ok: true }
                : { at: e.at, ok: false, kind: e.failKind, reason: e.reason };
              // ★一度でも前提を通れたら、再試行の記録抑止を解除する(次に落ちたら改めて1回残す)。
              if (e.ok) retryingUnreachable = false;
              beatSidecar();
              return;
            }
            // ★サイクルごとに名乗る(2分に1回)。「最後にいつ回ったか」は遠隔診断の主指標。
            sidecarState.lastCycleAt = e.at;
            beatSidecar(e.at);
          },
        });
      } catch (e) {
        if (!(e instanceof GeneratorHalt)) throw e;
        sidecarState.halt = { at: Date.now(), phase: e.phase, reason: e.reason };
        if (isRetryableHalt(sidecarState.lastPreflight)) {
          // ★monitor がまだ立ち上がっていないだけ(同時 spawn の順序)。止める理由が無いので再試行する。
          //   理由は **最初の1回だけ** 台帳に残す(毎分1行積み上げて台帳を汚さない)。ログは毎回出す。
          if (!retryingUnreachable) { recordHalt(e); retryingUnreachable = true; }
          setSidecarPhase('waiting');
          log(`monitor にまだ到達できません(${e.reason}) — ${Math.round(UNREACHABLE_RETRY_MS / 1000)}秒後に再試行します`
            + '(到達できないことは前提が崩れた証拠ではないので止めません)');
          await sleep(UNREACHABLE_RETRY_MS);
          continue;
        }
        // ★前提が崩れた = 意図的な停止。挙動は変えない(再試行で溜め続けない)。
        //   理由だけは画面に届ける。再開は **明示的に 無効→有効** に切り替えたときだけ。
        recordHalt(e);
        setSidecarPhase('halted');
        await waitUntil(false, pollMs);
      }
    }
  } finally {
    stopSchedule();
    stopBeat();
    releasePidLock(GENERATOR_PID_FILE);   // 正常終了の後片付け(強制終了時は次回 stale 判定で拾う)
  }
}
