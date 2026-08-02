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

import { spawn } from 'node:child_process';
import { isAnalysisEnabled } from '../analysisGate.js';
import { resolveGeneratorEnabled } from '../configStore.js';
import {
  openGeneratorDb, resolveGeneratorDbPath, insertGeneratorHalt,
} from '../db/generatorStore.js';
import { runGenerator, GeneratorHalt } from './run.js';

/** 有効/無効の設定を見に行く間隔[ms]。config.json の stat だけなので軽い。 */
export const ENABLE_POLL_MS = 15_000;

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
      log(`再生が終了しました code=${code} (${Math.round((Date.now() - started) / 1000)}秒)`);
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

// ─── 主処理 ──────────────────────────────────────────────────────────────────

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
    log('このビルドは分析用の経路を持ちません(公開版 lite) — 何もしません');
    return;
  }

  const pollMs = ENABLE_POLL_MS;
  const stopSchedule = startReplaySchedule(makeReplaySpawner(), resolveGeneratorEnabled);
  try {
    for (;;) {
      await waitUntil(true, pollMs);
      try {
        // 走っている最中に無効へ戻されたら、サイクルの先頭で普通に戻ってくる(停止ではない)。
        await runGenerator({ shouldContinue: resolveGeneratorEnabled });
      } catch (e) {
        if (!(e instanceof GeneratorHalt)) throw e;
        // ★前提が崩れた/崩れていた = 意図的な停止。挙動は変えない(再試行で溜め続けない)。
        //   理由だけは画面に届ける。再開は **明示的に 無効→有効** に切り替えたときだけ。
        recordHalt(e);
        await waitUntil(false, pollMs);
      }
    }
  } finally {
    stopSchedule();
  }
}
