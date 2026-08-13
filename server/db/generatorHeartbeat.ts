// 分析用の**状態ハートビート**(RECORD-ONLY・取引挙動には一切関与しない)。
//
// ■ 何のためか(実取引PCで起きたこと)
//   別PCへ届く書き出しを見ても、分析用が
//     ・設定で無効なのか / ・有効だが前提検証(preflight)で止まったのか / ・そもそも起動していないのか
//   が **区別できなかった**。台帳DB(generator_proposals.db)が存在しない=「1行も書いていない」しか
//   分からず、無効のときは台帳自体が作られないので遠隔から診断できない。
//   → 「観測できない」を「異常なし」と読み替えてしまう典型で、1年溜める実験では最悪の失敗形。
//
// ■ ★どこに載せるか = 共有DB(jp225.db)の meta(ティック保管・台帳書き出しと同じ流儀)
//   meta は trade2 の30分ごとの `VACUUM INTO`(prices_<host>.db)にそのまま乗るので、
//   **既存の同期経路に自動的に届く**。新しい配管・新しい設定機構はひとつも作らない
//   (server/db/tickArchiveHeartbeat.ts / server/db/ledgerExport.ts と同じ置き場・同じ2キー構成)。
//
// ■ ★何を出すか(遠隔から次の4つが判別できること)
//   ① 設定で有効か            … enabled(resolveGeneratorEnabled)= monitor が知っている設定
//   ② 分析用プロセスが生きているか … ledger.lastRecordAt の古さ。分析用はゲートに弾かれている間も
//                                2分ごとに1行書く(status='skipped')ので、**沈黙は死**を意味する。
//   ③ 直近1時間の提案件数      … ledger.planLastHour(「行が増えているか」ではなく「標本が溜まっているか」)
//   ④ 従属停止の状態          … halt(monitor プロセス内の generatorGate が権威)+ 分析用自身の停止理由
//                                (ledger.halt = preflight/recheck が台帳 halts に書いた理由)
//   ★①〜④は出どころが違う(設定 / 台帳 / メモリ)。畳まずに **別フィールド** のまま出す
//     (畳むと後から「どちらが正か」が読めなくなる)。
//
// ■ ★キーの値・決済の実数値は一切載せない。載るのはキーの **出どころの名前**(own/env/shared/none)だけ。

import type { DatabaseSync } from 'node:sqlite';
import { classifySession } from '../../core/session.js';
import { getMeta, setMeta, openDb, resolveDbPath } from './store.js';
import { jstStamp, fmtDur } from './tickArchiveHeartbeat.js';
import {
  readGeneratorLedgerStatus, readGeneratorLastRun, resolveGeneratorDbPath, type GeneratorLedgerStatus,
} from './generatorStore.js';
import {
  generatorGateSnapshot, generatorHaltInfo, generatorQuotaIgnored,
} from '../llm/generatorGate.js';
import { resolveGeneratorEnabled, resolveGeneratorKeySources, type GeneratorKeySource } from '../configStore.js';
import { isAnalysisEnabled } from '../analysisGate.js';
import { readSpawnLogTail, resolveSpawnLogPath, GENERATOR_PID_LOCK_BLOCKED_MARK } from '../spawnLog.js';

/** 共有DB(jp225.db)meta のキー。JSON 本体と、人が読む1行の2本(ティック保管と同じ作法)。 */
export const GENERATOR_HEARTBEAT_KEY = 'generator_heartbeat';
export const GENERATOR_STATUS_KEY = 'generator_status';
/** ★分析用サイドカー **自身** が書くハートビート(出どころが違うので monitor の物と混ぜない)。
 *  monitor が知っているのは設定と台帳だけで、「プロセスが生きているか」は本人しか知らない。 */
export const GENERATOR_SIDECAR_KEY = 'generator_sidecar';

/** ハートビートを書く間隔。 */
export const GENERATOR_HEARTBEAT_MS = 60_000;
/** 読み手が「ハートビート自体が止まった(monitor 停止)」と判定する猶予(= 3周期)。 */
export const GENERATOR_HEARTBEAT_FRESH_MS = 3 * GENERATOR_HEARTBEAT_MS;
/** 分析用は2分ごとに必ず1行書く(見送りも記録する)。これより長い沈黙は **プロセスが居ない**。
 *  2分周期の5倍。ネットワーク待ちや1サイクルの取りこぼしでは越えない幅にしてある。 */
export const GENERATOR_QUIET_STALE_MS = 10 * 60_000;
/** サイドカー自身のハートビート間隔と、読み手が「居ない」と判定する猶予(= 3周期)。
 *  ★これが「プロセスが生きているか」の唯一の直接証拠: 待機中(設定が無効)の分析用は台帳に
 *    1行も書かないので、台帳からは「起動していない」と区別できない(実取引PCで実際に詰まった点)。 */
export const GENERATOR_SIDECAR_HEARTBEAT_MS = 30_000;
export const GENERATOR_SIDECAR_FRESH_MS = 3 * GENERATOR_SIDECAR_HEARTBEAT_MS;

/** サイドカーの局面。**「何をしているか」を1語で**(「動いていない」と「なぜ」を分けて読むため)。 */
export type GeneratorSidecarPhase =
  /** 起動直後(まだ何も判定していない)。 */
  | 'starting'
  /** 設定が無効なので待機中(LLM も台帳も触らない)。 */
  | 'waiting'
  /** 前提検証を通ってサイクルを回している。 */
  | 'running'
  /** 前提が崩れて止まった(理由は halt に入る)。設定を無効→有効で再開。 */
  | 'halted'
  /** 公開版(lite)なので何もしない。 */
  | 'lite';

/** ★分析用サイドカー自身が書く状態。**キーの値・決済の実数値は一切含めない**。 */
export interface GeneratorSidecarState {
  v: 1;
  at: number;
  atJst: string;
  pid: number;
  phase: GeneratorSidecarPhase;
  /** そのプロセスが見ている設定(monitor が見ているものと食い違えば、それ自体が原因)。 */
  enabled: boolean;
  variant: string;
  /** ファイルログの場所(「どこを見ればよいか」を遠隔に伝える)。 */
  logPath: string | null;
  /** 台帳の場所(読み先の食い違いを遠隔から確認するため)。 */
  ledgerPath: string;
  /** 接続先 monitor(起動順序/ポート違いの切り分け)。まだ解決していなければ null。 */
  monitorUrl: string | null;
  /** 最後にサイクルを回した時刻。 */
  lastCycleAt: number | null;
  /** ★最後の前提検証の結果と理由(成功も失敗も残す)。 */
  lastPreflight: { at: number; ok: boolean; kind?: string; reason?: string } | null;
  /** 最後に止まった理由(phase='halted' のときの中身)。 */
  halt: { at: number; phase: string; reason: string } | null;
  /** ★再生(replay)の最終実行(開始時刻・終了コード・所要秒)。 */
  lastReplay: { at: number; code: number | null; sec: number | null } | null;
}

/** サイドカーの状態を共有DBの meta に書く(サイドカー自身が呼ぶ)。 */
export function writeGeneratorSidecarState(db: DatabaseSync, s: GeneratorSidecarState): void {
  setMeta(db, GENERATOR_SIDECAR_KEY, JSON.stringify(s));
}

/** サイドカーの状態を読む(monitor / スナップショットを開いた人)。壊れた値は「無い」扱い。 */
export function readGeneratorSidecarState(db: DatabaseSync): GeneratorSidecarState | null {
  const raw = getMeta(db, GENERATOR_SIDECAR_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as GeneratorSidecarState;
    return (v && typeof v.at === 'number' && typeof v.phase === 'string') ? v : null;
  } catch {
    return null;
  }
}

/** monitor 側が自分のハートビートに畳み込む「サイドカーの見え方」。
 *  ★出どころが違うので **元の値をそのまま持ちつつ**、読んだ時刻から見た鮮度を添える。 */
export interface GeneratorSidecarView {
  /** サイドカーが一度でも状態を書いたか。false = 一度も起動していない(またはとても古い版)。 */
  present: boolean;
  ageMs: number | null;
  /** 直近のハートビートが新しいか(= プロセスが生きている直接証拠)。 */
  alive: boolean;
  state: GeneratorSidecarState | null;
}

export function viewGeneratorSidecar(
  s: GeneratorSidecarState | null, now: number, freshMs: number = GENERATOR_SIDECAR_FRESH_MS,
): GeneratorSidecarView {
  if (!s) return { present: false, ageMs: null, alive: false, state: null };
  const ageMs = now - s.at;
  return { present: true, ageMs, alive: ageMs <= freshMs, state: s };
}

export type GeneratorHeartbeatState =
  /** 有効で、標本が溜まっている。 */
  | 'ok'
  /** 設定で無効(=止まっているのが正常)。 */
  | 'disabled'
  /** 取引時間外(=標本を取る時間帯ではない)。 */
  | 'idle'
  /** ★従属停止中(default プールが quota を踏んだため分析用を止めている)。 */
  | 'halted'
  /** 有効なのに動いていない/標本が溜まっていない(=人が見るべき状態)。 */
  | 'stalled';

/** 従属停止(monitor プロセス内 generatorGate)の状態。**キーの値は含めない**。 */
export interface GeneratorHaltState {
  /** いま止まっているか。 */
  active: boolean;
  /** 残り秒(0=止まっていない)。 */
  remainingSec: number;
  /** 停止が明ける時刻[epoch ms](0=止まっていない)。 */
  untilAt: number;
  /** 停止を発火させたプロバイダ(止まっていなければ null)。 */
  provider: string | null;
  /** 停止が発火した時のセッションキー(止まっていなければ null)。 */
  sessionKey: string | null;
  /** その取引日に従属停止で見送った回数(通算)。 */
  skipped: number;
  /** ★従属停止を **見送った**(分析用が専用キーなので止めなかった)回数と直近の内訳。
   *  「A は429を踏んでいるのに分析用が止まっていない」を遠隔から説明できるようにするため。 */
  ignored: number;
  lastIgnored: { provider: string; source: string; at: number } | null;
}

/** 分析用の関門(予算・backpressure)の状態。回数のみでキーも決済値も含まない。 */
export interface GeneratorGateState {
  dayKey: string;
  sessionKey: string;
  /** 腕1本あたりの日次予算。 */
  budget: number;
  /** 全腕合計の使用回数。 */
  used: number;
  inFlight: number;
  skipped: { busy: number; budget: number; defaultQuota: number; disabled: number };
}

export interface GeneratorHeartbeat {
  v: 1;
  /** このハートビートを書いた時刻。**読み手はこれの古さで monitor 停止を検出する**。 */
  at: number;
  atJst: string;
  state: GeneratorHeartbeatState;
  reason: string;
  /** ★設定で有効か(monitor が知っている事実。台帳とは出どころが違うので畳まない)。 */
  enabled: boolean;
  sessionOpen: boolean;
  sessionDate: string | null;
  /** 台帳(分析用が書く)の死活。available:false = この PC で一度も書いていない。 */
  ledger: GeneratorLedgerStatus;
  /** 台帳の最終記録からの沈黙[ms]。台帳が空/無ければ null。 */
  quietMs: number | null;
  /** ★最後に前提検証を通って起動した記録(runs の最新行)。null = 一度も起動できていない。
   *  停止理由(ledger.halt)と対で読む: 「一度も起動できていない」と「起動後に崩れた」は別物。 */
  lastRun: { startedAt: number; epoch: string; monitorUrl: string } | null;
  halt: GeneratorHaltState;
  gate: GeneratorGateState;
  /** ★分析用サイドカー自身のハートビート(プロセスが生きているかの直接証拠)。 */
  sidecar: GeneratorSidecarView;
  /** ★プロバイダごとの分析用キーの **出どころだけ**(own/env/shared/none)。値は絶対に載せない。 */
  keySources: Record<string, GeneratorKeySource>;
  /** ★Rust(src-tauri)がサイドカーを spawn できたかの記録(末尾数行)。 */
  spawn: { path: string; lines: string[] };
  /** 台帳ファイルの場所(読み先の食い違いを遠隔から確認するため)。 */
  ledgerPath: string;
}

/** ★共用の1行ログ(sidecar-spawn.log)の末尾から「分析用が pid ロック待ちで **保留中**」を読み取る。
 *
 *  なぜ要るか: ロック待ちの分析用は共有DBに名乗らない(名乗ると、実際に走っている本体の名乗りを
 *  30秒ごとに上書きして pid が交互に入れ替わり、遠隔からはかえって読めなくなる)。
 *  そのため名乗り側だけを見ると「起動していない疑い」としか言えず、**理由が別PCに届かない**。
 *  分析用が書く1行はこの共用ログに載り、それは既に meta(generator_heartbeat.spawn)へ運ばれている
 *  ので、**そこから読む**(新しい配管を作らない)。
 *
 *  ★判断は「分析用が書いた最後の行」だけで決める。復帰すると分析用が「起動を再開しました」を書くので、
 *    その時点で自動的に null に戻る(古い保留の行が残り続けて誤報にならない)。 */
export function pidLockBlockedFromSpawn(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (!line.includes('[generator]')) continue;
    return line.includes(GENERATOR_PID_LOCK_BLOCKED_MARK) ? line : null;
  }
  return null;
}

/** ハートビートを組み立てる純関数(DB にもプロセス状態にも触らない=テストで全経路を通せる)。 */
export function buildGeneratorHeartbeat(input: {
  now: number;
  enabled: boolean;
  ledger: GeneratorLedgerStatus;
  halt: GeneratorHaltState;
  gate: GeneratorGateState;
  sidecar?: GeneratorSidecarView;
  keySources?: Record<string, GeneratorKeySource>;
  spawn?: { path: string; lines: string[] };
  lastRun?: { startedAt: number; epoch: string; monitorUrl: string } | null;
  ledgerPath?: string;
}): GeneratorHeartbeat {
  const { now, enabled, ledger, halt, gate } = input;
  const sidecar = input.sidecar ?? { present: false, ageMs: null, alive: false, state: null };
  const s = classifySession(now);
  const sessionOpen = s !== null;
  const quietMs = ledger.available && ledger.lastRecordAt != null ? Math.max(0, now - ledger.lastRecordAt) : null;

  // ★「生きているか」の判定材料は2つあり、**どちらか一方でも生きていれば生きている**:
  //   ① サイドカー自身のハートビート(待機中=台帳に1行も書かない局面でも唯一これだけは出る)
  //   ② 台帳が実際に増えていること(古い版のサイドカー=①を書かない でも回っていれば分かる)
  //   片方だけを見ると「待機中を止まったと誤認する」/「古い版を全部異常と誤認する」のどちらかになる。
  const ledgerFresh = quietMs !== null && quietMs <= GENERATOR_QUIET_STALE_MS;
  const processAlive = sidecar.alive || ledgerFresh;
  // ★「居ない」の中に「ロック待ちで保留中(理由が分かっている)」が混ざる。共用ログから読み分ける。
  const blockedLine = pidLockBlockedFromSpawn(input.spawn?.lines ?? []);

  let state: GeneratorHeartbeatState;
  let reason: string;
  if (!enabled) {
    // ★「無効だから動いていない」と「止まった」は別物。無効を警告にすると警告が読まれなくなる。
    state = 'disabled';
    reason = '設定で無効(generatorEnabled=false)= 動いていないのが正常';
  } else if (sidecar.alive && sidecar.state?.phase === 'halted') {
    // 本人が「止まった」と言っている。理由は本人の記録が最も正確(台帳より先に読む)。
    state = 'stalled';
    reason = `分析用が自ら停止(${sidecar.state.halt?.phase ?? '?'}): ${sidecar.state.halt?.reason ?? '(理由不明)'}`;
  } else if (ledger.halt) {
    // 台帳に残った停止理由(サイドカーが古い版/既に落ちている場合の受け皿)。
    // ★readGeneratorLedgerStatus は「最後の記録より後の停止」だけを返す = **まだ効いている**理由。
    state = 'stalled';
    reason = `分析用が自ら停止(${ledger.halt.phase}): ${ledger.halt.reason}`;
  } else if (!processAlive && blockedLine !== null) {
    // ★「起動していない」ではなく「**起動を保留している**」= 理由が分かっている状態。
    //   ロックが取れないと以前は恒久終了していたので、遠隔からは「起動していない疑い」としか読めなかった。
    state = 'stalled';
    reason = '分析用が pid ロック待ちで起動を保留中(別インスタンスが保持 — 再判定を続けています)'
      + `: ${blockedLine}`;
  } else if (!processAlive) {
    // ★ここが実取引PCで詰まった点: 「動いていない」の中身を必ず言い分ける。
    state = 'stalled';
    reason = !sidecar.present && !ledger.available
      ? '有効だがサイドカーのハートビートも台帳も無い(分析用プロセスが起動していない疑い'
        + ' — spawn の記録[spawn]とファイルログ[logPath]を確認)'
      : !sidecar.present
        ? `有効だがサイドカーのハートビートが無く、台帳も${quietMs == null ? '空' : `${fmtDur(quietMs)}前で沈黙`}`
          + '(プロセスが落ちている/古い版で動いている疑い)'
        : `有効だがサイドカーのハートビートが${fmtDur(sidecar.ageMs ?? 0)}前で止まっている`
          + `(最後の局面=${sidecar.state?.phase ?? '?'})`;
  } else if (sidecar.alive && sidecar.state?.phase === 'waiting') {
    // ★monitor は「有効」と読んでいるのにサイドカーは「無効」と読んでいる = 設定の読み先の食い違い。
    //   これは今回の症状(有効なのに台帳が1行も無い)の候補そのものなので、必ず名指しで出す。
    state = 'stalled';
    reason = 'monitor は有効と読んでいるのにサイドカーは待機中(設定の読み先が食い違っている疑い'
      + ` / サイドカーが見ている enabled=${String(sidecar.state.enabled)})`;
  } else if (!ledger.available) {
    // プロセスは生きているが台帳がまだ無い(起動直後 or 前提検証の直前)。
    state = 'stalled';
    reason = '有効・プロセスは生きているが台帳がまだ無い(起動直後、または前提検証の途中)';
  } else if (quietMs === null) {
    state = 'stalled';
    reason = '台帳はあるが記録が1件も無い';
  } else if (halt.active) {
    state = 'halted';
    reason = `従属停止中(${halt.provider ?? '?'} の quota・残り${halt.remainingSec}秒 / 発火 ${halt.sessionKey ?? '?'})`;
  } else if (!sessionOpen) {
    // ★場外で標本が 0 なのは正常。ここを異常にすると指標が信用を失う。
    state = 'idle';
    reason = '取引時間外(標本を取る時間帯ではない)';
  } else if ((ledger.planLastHour ?? 0) === 0) {
    state = 'stalled';
    reason = '取引時間内なのに直近1時間の標本が0件'
      + `(見送り busy=${gate.skipped.busy} budget=${gate.skipped.budget} default-quota=${gate.skipped.defaultQuota})`;
  } else {
    state = 'ok';
    reason = `直近1時間の標本 ${ledger.planLastHour} 件`;
  }

  return {
    v: 1, at: now, atJst: jstStamp(now), state, reason,
    enabled, sessionOpen, sessionDate: s?.sessionDate ?? null,
    ledger, quietMs, halt, gate, sidecar,
    lastRun: input.lastRun ?? null,
    keySources: input.keySources ?? {},
    spawn: input.spawn ?? { path: '', lines: [] },
    ledgerPath: input.ledgerPath ?? '',
  };
}

/** 人が読む1行(meta の generator_status)。JSON と同じ構造体から **この関数だけ** で作るので、
 *  2つの表現が食い違うことはない(ティック保管・台帳書き出しと同じ作法)。 */
export function formatGeneratorStatus(hb: GeneratorHeartbeat): string {
  const parts: string[] = [`${hb.state.toUpperCase()} ${hb.atJst} JST`, hb.reason];
  parts.push(`設定=${hb.enabled ? '有効' : '無効'}`);
  // ★サイドカー(プロセス本人)の名乗り。「動いていない」と「なぜ」を分けて読むための一次情報。
  parts.push(hb.sidecar.present && hb.sidecar.state
    ? `サイドカー=${hb.sidecar.alive ? '生存' : `★沈黙${fmtDur(hb.sidecar.ageMs ?? 0)}`}`
      + ` 局面=${hb.sidecar.state.phase} pid=${hb.sidecar.state.pid} variant=${hb.sidecar.state.variant}`
      + ` 本人が見ている設定=${hb.sidecar.state.enabled ? '有効' : '無効'}`
      + ` 接続先=${hb.sidecar.state.monitorUrl ?? '(未解決)'}`
      + ` ログ=${hb.sidecar.state.logPath ?? '(無し)'}`
      + (hb.sidecar.state.lastPreflight
        ? ` 前提検証=${hb.sidecar.state.lastPreflight.ok ? 'OK' : `NG(${hb.sidecar.state.lastPreflight.kind ?? '?'}): ${hb.sidecar.state.lastPreflight.reason ?? ''}`}`
          + `(${jstStamp(hb.sidecar.state.lastPreflight.at)})`
        : ' 前提検証=まだ')
      + (hb.sidecar.state.lastReplay
        ? ` 再生=${jstStamp(hb.sidecar.state.lastReplay.at)} code=${hb.sidecar.state.lastReplay.code ?? '?'}`
        : ' 再生=まだ')
    : '★サイドカー=名乗りなし(起動していない/古い版)');
  parts.push(hb.ledger.available
    ? `台帳=有 最終記録=${hb.ledger.lastRecordAt == null ? '無し' : `${jstStamp(hb.ledger.lastRecordAt)}(${fmtDur(hb.quietMs ?? 0)}前)`}`
      + ` 標本1h=${hb.ledger.planLastHour ?? '?'}件 要求1h(場中)=${hb.ledger.inSessionLastHour ?? '?'}件 通算=${hb.ledger.total}件`
    : '台帳=無し(この PC で1行も書いていない)');
  if (hb.ledger.halt) parts.push(`★分析用の停止理由=${hb.ledger.halt.phase}: ${hb.ledger.halt.reason}`);
  if (hb.lastRun) parts.push(`最終起動(前提OK)=${jstStamp(hb.lastRun.startedAt)} epoch=${hb.lastRun.epoch} 接続先=${hb.lastRun.monitorUrl}`);
  parts.push(hb.halt.active
    ? `★従属停止=中(${hb.halt.provider ?? '?'} / 残り${hb.halt.remainingSec}秒 / 明ける ${jstStamp(hb.halt.untilAt)} / 発火 ${hb.halt.sessionKey ?? '?'})`
    : '従属停止=無し');
  parts.push(`従属停止の見送り(専用キー)=${hb.halt.ignored}回`
    + (hb.halt.lastIgnored ? `(直近 ${hb.halt.lastIgnored.provider}/出どころ=${hb.halt.lastIgnored.source})` : ''));
  parts.push(`予算=${hb.gate.used}/${hb.gate.budget}(腕あたり) 生成中=${hb.gate.inFlight}`
    + ` 見送り busy=${hb.gate.skipped.busy} budget=${hb.gate.skipped.budget}`
    + ` default-quota=${hb.gate.skipped.defaultQuota} disabled=${hb.gate.skipped.disabled}`);
  // ★キーの出どころ(値は絶対に出さない)。専用キーなのに止まる/止まらないの説明に要る。
  const ks = Object.entries(hb.keySources).map(([k, v]) => `${k}=${v}`).join(' ');
  parts.push(`分析用キーの出どころ=${ks || '(観測できず)'}`);
  parts.push(`台帳の場所=${hb.ledgerPath || '(未解決)'}`);
  parts.push(hb.spawn.lines.length > 0
    ? `spawn記録=${hb.spawn.lines.slice(-3).join(' / ')}`
    : `spawn記録=無し(${hb.spawn.path})`);
  return parts.join(' | ');
}

// ─── 共有DB(jp225.db)meta への読み書き ────────────────────

export function readGeneratorHeartbeat(db: DatabaseSync): GeneratorHeartbeat | null {
  const raw = getMeta(db, GENERATOR_HEARTBEAT_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as GeneratorHeartbeat;
    return (v && typeof v.at === 'number' && typeof v.enabled === 'boolean') ? v : null;
  } catch {
    return null;   // 壊れた値は「無い」扱い(次のハートビートで上書きされる)
  }
}

/** いまの分析用の状態を1回測る(設定 + 台帳 + プロセス内ゲート)。
 *  ★台帳は **readOnly** で読むだけ(作らない・書かない)。例外は投げない。 */
export function measureGeneratorHeartbeat(now: number = Date.now(), sharedDb?: DatabaseSync): GeneratorHeartbeat {
  let enabled = false;
  try {
    enabled = resolveGeneratorEnabled();
  } catch { /* 設定が読めない = 無効と同じ扱い(下の reason で台帳側の事実が出る) */ }

  const ledgerPath = (() => { try { return resolveGeneratorDbPath(); } catch { return ''; } })();
  let ledger: GeneratorLedgerStatus = { available: false, lastRecordAt: null, ageMin: null, today: [], total: 0 };
  let lastRun: { startedAt: number; epoch: string; monitorUrl: string } | null = null;
  try {
    ledger = readGeneratorLedgerStatus(ledgerPath, now);
    lastRun = readGeneratorLastRun(ledgerPath);
  } catch { /* 台帳が読めない = available:false のまま(観測できなかったことが状態に残る) */ }

  // ★サイドカー自身のハートビート(= プロセスが生きているかの直接証拠)。共有DBが渡されたときだけ読む。
  let sidecar: GeneratorSidecarView = { present: false, ageMs: null, alive: false, state: null };
  try {
    if (sharedDb) sidecar = viewGeneratorSidecar(readGeneratorSidecarState(sharedDb), now);
  } catch { /* 読めなくても状態は出す(present:false のまま) */ }

  // ★キーの **出どころだけ**(値は絶対に載せない)。専用キーなのに従属停止が効く/効かないの説明に要る。
  let keySources: Record<string, GeneratorKeySource> = {};
  try {
    keySources = { ...resolveGeneratorKeySources() };
  } catch { /* 設定が読めなければ空(観測できなかったことが空で分かる) */ }

  const spawnPath = resolveSpawnLogPath();
  const spawn = { path: spawnPath, lines: readSpawnLogTail(spawnPath) };

  const snap = generatorGateSnapshot(now);
  const ignored = generatorQuotaIgnored(now);
  const info = generatorHaltInfo(now);
  const halt: GeneratorHaltState = {
    active: info.active,
    remainingSec: Math.ceil(info.remainingMs / 1000),
    untilAt: info.untilAt,
    provider: info.provider,
    sessionKey: snap.haltedSessionKey,
    skipped: snap.skipped.defaultQuota,
    ignored: ignored.count,
    lastIgnored: ignored.last ? { ...ignored.last } : null,
  };
  const gate: GeneratorGateState = {
    dayKey: snap.dayKey, sessionKey: snap.sessionKey, budget: snap.budget, used: snap.used,
    inFlight: snap.inFlight, skipped: { ...snap.skipped },
  };
  return buildGeneratorHeartbeat({
    now, enabled, ledger, halt, gate, sidecar, keySources, spawn, lastRun, ledgerPath,
  });
}

/** 状態を1回測って共有DBの meta に書く。書いたハートビートを返す。
 *  共有DBへの書き込み自体が失敗した場合だけ例外を投げる(呼び出し側が必ずログに出す)。 */
export function writeGeneratorHeartbeat(sharedDb: DatabaseSync, now: number = Date.now()): GeneratorHeartbeat {
  const hb = measureGeneratorHeartbeat(now, sharedDb);
  setMeta(sharedDb, GENERATOR_HEARTBEAT_KEY, JSON.stringify(hb));
  setMeta(sharedDb, GENERATOR_STATUS_KEY, formatGeneratorStatus(hb));
  return hb;
}

// ─── 読み手側(スナップショットを開いた人 / 将来の UI) ──────

export interface GeneratorHeartbeatVerdict {
  state: GeneratorHeartbeatState | 'missing';
  /** ハートビートが書かれてからの経過。missing は null。 */
  ageMs: number | null;
  text: string;
}

/** ハートビートを **読む時刻から見て** 評価する。
 *  ★値が更新されなくなった(monitor 停止・古い版で動いている)ときは最後の値が固まる。
 *    `at` の古さを見ないと「OK のまま止まっている」を見逃す。 */
export function describeGenerator(
  hb: GeneratorHeartbeat | null, now: number,
  freshMs: number = GENERATOR_HEARTBEAT_FRESH_MS,
): GeneratorHeartbeatVerdict {
  if (!hb) {
    return {
      state: 'missing', ageMs: null,
      text: 'MISSING 分析用のハートビートが無い(記録が始まっていない/古い版で動いている/公開版 lite)',
    };
  }
  const ageMs = now - hb.at;
  const line = formatGeneratorStatus(hb);
  if (ageMs > freshMs) {
    return {
      state: 'stalled', ageMs,
      text: `STALLED ハートビートが${fmtDur(ageMs)}前で停止(monitor が動いていない疑い) | ${line}`,
    };
  }
  return { state: hb.state, ageMs, text: line };
}

// ─── 定期書き込み(monitor サイドカー) ─────────────────────

let timer: NodeJS.Timeout | null = null;
let db: DatabaseSync | null = null;

/** 1回書く(失敗しても絶対に throw しない=表示のための機構でサーバを落とさない)。 */
function tick(): void {
  try {
    if (!db) db = openDb(resolveDbPath());
    writeGeneratorHeartbeat(db);
  } catch (e) {
    console.warn('[generator-heartbeat] 書き込みに失敗:', e instanceof Error ? e.message : String(e));
    try { db?.close(); } catch { /* ignore */ }
    db = null;   // 次回に開き直す(WAL の一時的な失敗から自力で復帰する)
  }
}

/** 分析用の状態を共有DBの meta に定期記録する。
 *  ★公開版(lite)では起動しない(存在しない機構の状態を書かない)。
 *  ★取引時間でゲートしない: 「時間外で静かなのか」「止まっているのか」を区別するために、
 *    場外でも状態を更新し続ける必要がある(場外は state='idle' として正常と読める)。 */
export function startGeneratorHeartbeat(): void {
  if (!isAnalysisEnabled() || timer) return;
  tick();   // 起動直後に1回(60秒待たずに状態が届く)
  timer = setInterval(tick, GENERATOR_HEARTBEAT_MS);
  timer.unref?.();
}

/** テスト/終了処理用。 */
export function stopGeneratorHeartbeat(): void {
  if (timer) { clearInterval(timer); timer = null; }
  try { db?.close(); } catch { /* ignore */ }
  db = null;
}
