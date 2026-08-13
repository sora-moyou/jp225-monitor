// システムにインストール済みの Google Chrome をヘッドレスで起動し、/chart-shot を PNG 撮影する。
// chromedriver/Selenium は使わない(バージョン不整合の元凶)。外部 exe を spawn するだけなので
// パッケージ化(SEA)されたサイドカーからも動く(バイナリ自身は Node、Chrome はOS側)。
// すべての失敗経路(Chrome 不在・タイムアウト・撮影失敗)は null を返し、呼び出し側はテキストのみへフォールバックする。

import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { promisify } from 'node:util';
import { loadConfig } from '../configStore.js';
import { DEFAULT_CALLER, type LlmCaller } from '../llm/caller.js';

// ★同期の外部プロセス起動はイベントループを止める(= SSE・価格ループ・A の約定判定が全停止する)。
//   実測(この開発PC・実撮影 n=5): 撮影1回あたり 307ms の停止が必ず1回。実取引PCでは 2.24s。
//   停止の中身は「後始末が全部同期」= reg 照会 + Desktop 書込 + taskkill + rmSync が
//   await を1つも挟まず1本の同期ブロックになっていたこと。
//   → 外部プロセス起動もファイル操作も **すべて非同期版**に置き換える。
//     非同期にしても「殺す→消す」の順序は await の直列で保たれ、失敗は必ずログに出す。
const execFileAsync = promisify(execFile);

// TradingView ウィジェット(tv.js + iframe + ローソク描画)はネット依存で 12〜15 秒かかる。
// 旧方式(--headless --screenshot --virtual-time-budget)は widget が描画される前に撮影して
// 真っ黒 PNG になっていた。現方式は CDP(Chrome DevTools Protocol)で実時間 window.__chartReady を
// 待ってから Page.captureScreenshot する。
// ユーザー方針=生成優先・遅延許容。遅い TradingView 描画でも撮り切れるよう延長(トレード PC は
// 撮影が遅いだけで実際には画像生成できていた実績あり=過去に 46948B の PNG が Desktop にあった)。
// 全体 ~42s / ready ~30s。
const CAPTURE_TIMEOUT_MS = 42000;        // 全体のハードキャップ(launch+ws+ready+settle+shot)
const WS_TARGET_TIMEOUT_MS = 10000;      // /json/list で page ターゲット(ws URL)を得るまでの上限
const CHART_READY_TIMEOUT_MS = 30000;    // window.__chartReady が立つまでの上限(実時間)
const READY_POLL_INTERVAL_MS = 500;      // __chartReady ポーリング間隔
const SETTLE_AFTER_READY_MS = 1500;      // ready 後の追加待ち(描画確定用)
const WINDOW = '1280,760';
// CDP デバッグポート: 撮影用サーバのポートと衝突しないよう、固定の高位ポートから派生する。
// ★旧実装は「サーバのポートから派生」= 同じサーバなら **毎回同じデバッグポート** だった。
//   「同時撮影は想定しない」という前提が崩れると(A と分析用が別プールになった時点で崩れていた)、
//   後から起動した Chrome はポートを bind できず、CDP 照会が **先に起きた別の Chrome に当たる**。
//   実測(修正中の overlap 実験): 割込んだ A が中断中の分析用の Chrome に接続し、
//   その Chrome が死んだ後 __chartReady を 30 秒待って chart-ready-timeout。
//   → 撮影ごとにポートをずらし、さらに「掴んだターゲットが自分の URL か」を照合する。
const DEBUG_PORT_BASE = 47800;
const DEBUG_PORT_SPAN = 100;          // 47800..47899 を巡回(直前の撮影と必ず別ポートになる)
let debugPortSeq = 0;

/** '%USERPROFILE%\\OneDrive\\Desktop' のような文字列の %ENV% を展開する。 */
function expandEnv(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s.replace(/%([^%]+)%/g, (_, name) => env[name] ?? env[String(name).toUpperCase()] ?? `%${name}%`);
}

/**
 * 実際のデスクトップ フォルダを解決する。OneDrive リダイレクト(既定のデスクトップが
 * %USERPROFILE%\OneDrive\Desktop になっている環境)に対応するため、まず User Shell Folders
 * レジストリの Desktop 値を見る。ダメなら OneDrive/通常の候補を順に試し、存在する最初のものを返す。
 */
// ★非同期化: この関数の reg 照会(execFileSync)と存在確認は、直後の書込・後始末と合わせて
//   1本の同期ブロックになっていた(実測でその塊が 307ms 停止の一部)。挙動・ログ文言・採用順序は不変のまま
//   外部プロセス起動とファイル I/O を非同期版へ置き換える。
async function resolveDesktopDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidates: string[] = [];
  let regVal = '(none)';
  // 1) レジストリの User Shell Folders → Desktop(REG_EXPAND_SZ・%USERPROFILE% 等を含む)。
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
        { encoding: 'utf-8', timeout: 3000, windowsHide: true },
      );
      const m = String(stdout).match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      if (m && m[1]) { regVal = expandEnv(m[1].trim(), env); candidates.push(regVal); }
    } catch { /* レジストリ取得不可 → 候補で代替 */ }
  }
  // 2) 既知の候補(OneDrive を通常より優先)。
  const up = env.USERPROFILE || homedir();
  const od = env.OneDrive || env.OneDriveConsumer || env.OneDriveCommercial;
  if (od) candidates.push(join(od, 'Desktop'));
  candidates.push(join(up, 'OneDrive', 'Desktop'));
  candidates.push(join(homedir(), 'OneDrive', 'Desktop'));
  candidates.push(join(up, 'Desktop'));
  candidates.push(join(homedir(), 'Desktop'));
  // 判断過程をログ(自己診断): レジストリ値 + 各候補の存在。
  const exists = await Promise.all(candidates.map(async (c) => {
    try { await stat(c); return true; } catch { return false; }
  }));
  const detail = candidates.map((c, i) => `${exists[i] ? '○' : '×'}${c}`).join(' | ');
  console.log(`[chart-shot] Desktop解決 reg=${regVal} 候補=[${detail}]`);
  // 存在する最初のディレクトリを採用(判定は上の一括 stat と同一=順序は従来どおり)。
  for (let i = 0; i < candidates.length; i++) {
    if (exists[i]) { console.log(`[chart-shot] Desktop採用(既存): ${candidates[i]}`); return candidates[i]!; }
  }
  // どれも無ければ homedir\Desktop を作成対象として返す(=幻フォルダになりうるので明示ログ)。
  const fb = join(homedir(), 'Desktop');
  console.warn(`[chart-shot] Desktop候補が全て不在 → フォールバック作成対象: ${fb}`);
  return fb;
}

// 撮影した最新1枚を実デスクトップに上書き保存する(確認用)。実取引ロジックには無関係。
// 書込の実パスと成否を必ずログに出す(サイレント失敗の撲滅=自己診断)。失敗しても throw しない。
// ★非同期化: ログ文言・判定・失敗時の握りつぶしはすべて従来どおり(await を挟むだけ)。
async function saveShotToDesktop(buf: Buffer): Promise<void> {
  let target = '(unresolved)';
  try {
    const dir = await resolveDesktopDir();
    try { await mkdir(dir, { recursive: true }); } catch { /* 既存 or 作成不可 → 書込側で判定 */ }
    target = join(dir, 'jp225-chart-shot.png');
    await writeFile(target, buf);
    // 書込直後にファイルを stat して「本当にディスク上に存在するか+サイズ」を確認する。
    // 書込が例外なしでも、リダイレクト/同期/AV 等で直後に消えるケースを捕捉する。
    let onDisk = -1;
    try { onDisk = (await stat(target)).size; } catch { /* stat 不可 = 直後に実在せず */ }
    if (onDisk >= 0) {
      console.log(`[chart-shot] Desktop 保存OK: ${target} (書込 ${buf.length}B / 実在 ${onDisk}B)`);
    } else {
      console.warn(`[chart-shot] Desktop 書込は成功したが直後に実在せず(リダイレクト/消失の疑い): ${target}`);
    }
  } catch (e) {
    console.warn(`[chart-shot] Desktop 保存失敗: ${target} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** レジストリから chrome.exe のパスを引く(Chrome 自動更新後もインストール場所を追える)。 */
function chromeFromRegistry(): string | null {
  if (process.platform !== 'win32') return null;
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  ];
  for (const key of keys) {
    try {
      // reg query の (Default) 値行から実パスを抜く。REG_SZ の後にパスが続く。
      const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf-8', timeout: 3000 });
      const m = out.match(/REG_SZ\s+(.+\.exe)/i);
      if (m && m[1]) {
        const p = m[1].trim();
        if (existsSync(p)) return p;
      }
    } catch { /* このキーは無い → 次へ */ }
  }
  return null;
}

/** Chrome の実パスを堅牢に解決する(設定/env 上書き → 既知の固定パス → レジストリ)。見つからなければ null。 */
export function resolveChromePath(env: NodeJS.ProcessEnv = process.env): string | null {
  // 1) 明示上書き(設定 chromePath > env CHROME_PATH)。
  try {
    const cfg = (loadConfig() as { chromePath?: string }).chromePath;
    if (cfg && cfg.trim() && existsSync(cfg.trim())) return cfg.trim();
  } catch { /* 設定読めなくても続行 */ }
  const override = env.CHROME_PATH?.trim();
  if (override && existsSync(override)) return override;

  // 2) 既知の固定パス(Program Files / Program Files(x86) / LocalAppData)。
  const candidates: string[] = [];
  const pf = env['ProgramFiles'];
  const pfx86 = env['ProgramFiles(x86)'];
  const local = env['LOCALAPPDATA'];
  const sub = join('Google', 'Chrome', 'Application', 'chrome.exe');
  if (pf) candidates.push(join(pf, sub));
  if (pfx86) candidates.push(join(pfx86, sub));
  if (local) candidates.push(join(local, sub));
  // フォールバックの絶対パス(env 未設定時)。
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // 3) レジストリ。
  return chromeFromRegistry();
}

/** Chrome のバージョン文字列(ログ用のみ)。取得できなければ null。
 *
 *  重要: ここで chrome.exe を絶対に実行しない。Windows では `chrome.exe --version` が
 *  コンソール非接続時に自分自身を GUI 本体として再起動する既知の挙動があり、
 *  既存 Chrome 起動中/複数プロファイル環境では「どなたが使用しますか?」プロファイルピッカーが
 *  表示される事故になる(captureChartPng は /api/scalp-plan の毎回この関数を呼ぶため頻発)。
 *  そのためバージョンは exe を起動せず、以下の順でファイル/レジストリから読み取る:
 *    1) chrome.exe と同じ Application フォルダ内のバージョン名サブフォルダ
 *       (例 ...\Application\126.0.6478.127\)。複数あれば最大版を採用。
 *    2) レジストリ HKCU\Software\Google\Chrome\BLBeacon の version(reg.exe は GUI を出さない)。
 *  診断専用なので全体を try/catch で包み、例外は決して投げない。 */
export function chromeVersion(chromePath: string): string | null {
  // 1) Application フォルダ内の「x.x.x.x」形式のサブフォルダ名からバージョンを得る。
  try {
    const dir = dirname(chromePath);
    const verRe = /^\d+\.\d+\.\d+\.\d+$/;
    const versions = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && verRe.test(e.name))
      .map((e) => e.name);
    if (versions.length > 0) {
      // 数値コンポーネントで降順ソートし、最も新しいバージョンを採用。
      versions.sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 4; i++) {
          const da = pa[i] ?? 0;
          const db = pb[i] ?? 0;
          if (da !== db) return db - da;
        }
        return 0;
      });
      return `Google Chrome ${versions[0]}`;
    }
  } catch { /* フォルダ走査に失敗してもレジストリを試す */ }

  // 2) レジストリ(Windows のみ)。reg.exe は GUI を起動しないので安全。
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Google\\Chrome\\BLBeacon', '/v', 'version'],
        { encoding: 'utf-8', timeout: 3000 },
      );
      // 出力例: "    version    REG_SZ    126.0.6478.127"
      const m = out.match(/version\s+REG_SZ\s+(\d+\.\d+\.\d+\.\d+)/i);
      if (m) return `Google Chrome ${m[1]}`;
    } catch { /* レジストリ未登録/失敗は null へ */ }
  }

  return null;
}

/**
 * CDP 撮影用のヘッドレス Chrome 起動引数を組み立てる(テスト可能な純関数)。
 * --screenshot / --virtual-time-budget の単発撮影は使わず、リモートデバッグを開いて
 * CDP(Page.captureScreenshot)で撮る。URL は末尾の位置引数として渡す(navigate は暗黙)。
 */
export function buildChromeArgs(url: string, debugPort: number, userDataDir: string): string[] {
  return [
    '--headless=new',
    // ★可視ウィンドウ対策(Chrome 版依存の保険): 実機で「白紙のウィンドウが出る」報告あり。
    //   古い Chrome は --headless=new を認識せずヘッドフル起動する / 一部ビルドは new headless でも
    //   ウィンドウを表示する。どの場合でも画面外へ飛ばして不可視化する(-32000 は Windows の
    //   「画面外」慣用値)。画面外ウィンドウは最小化と違い描画スロットルされないので撮影は成立する。
    '--window-position=-32000,-32000',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${WINDOW}`,
    '--no-sandbox',
    '--disable-extensions',
    // 注意: --disable-background-networking は付けない。TradingView は s3.tradingview.com の tv.js と
    // ウィジェット iframe(データ配信含む)へ実ネットワークが必要なため、ネットワークを絞る系のフラグは外す。
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    url,
  ];
}

export interface CaptureResult {
  buffer: Buffer | null;
  chromePath: string | null;
  chromeVersion: string | null;
  reason: string | null;   // null=成功 / それ以外=フォールバック理由
}

// ─── 撮影の中断(preempt)シグナル ──────────────────────────────────────────
// generator の撮影中に default(A)が来たとき、generator は **譲る**。
// 待ち(sleep)と CDP 応答待ちを即座に解くための最小のシグナル。
// ★default の撮影では fire() されない = default の経路は1バイトも挙動が変わらない。
interface AbortRef {
  aborted: boolean;
  reason: string | null;
  promise: Promise<void>;
  fire(reason: string): void;
}
function makeAbortRef(): AbortRef {
  let wake!: () => void;
  const promise = new Promise<void>((r) => { wake = r; });
  const ref: AbortRef = {
    aborted: false, reason: null, promise,
    fire(reason: string) { if (ref.aborted) return; ref.aborted = true; ref.reason = reason; wake(); },
  };
  return ref;
}

/** 単純な sleep(deadline は呼び出し側で管理)。abort 付きなら中断で即座に解ける。 */
function sleep(ms: number, abort?: AbortRef): Promise<void> {
  if (!abort) return new Promise((r) => setTimeout(r, ms));
  if (abort.aborted) return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    void abort.promise.then(() => { clearTimeout(t); r(); });
  });
}

/** GET http://127.0.0.1:port/json/list をポーリングし、type==='page' のターゲットの ws URL を得る。
 *  ★expectUrlMark: 自分が起動した Chrome かを照合する印(URL のクエリ)。
 *    デバッグポートに別の(=前の撮影の)Chrome が残っていた場合に、その Chrome を掴んで
 *    「他人のページで __chartReady を待ち続ける」事故を防ぐ。仮定でなく照合にする。 */
async function findPageWebSocketUrl(
  debugPort: number, deadline: number, abort?: AbortRef, expectUrlMark?: string,
): Promise<string | null> {
  const stepDeadline = Math.min(deadline, Date.now() + WS_TARGET_TIMEOUT_MS);
  while (Date.now() < stepDeadline) {
    if (abort?.aborted) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const list = (await res.json()) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
        const page = Array.isArray(list)
          ? list.find((t) => t.type === 'page' && !!t.webSocketDebuggerUrl
              && (!expectUrlMark || (t.url ?? '').includes(expectUrlMark)))
          : undefined;
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch { /* Chrome 起動直後は接続拒否 → リトライ */ }
    await sleep(300, abort);
  }
  return null;
}

/**
 * CDP over WebSocket で id 対応のリクエスト/レスポンスを回す軽量クライアント。
 * Node グローバルの WebSocket を使う(npm 依存なし)。
 */
class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'cdp-error'));
        else p.resolve(msg.result);
      }
    });
    ws.addEventListener('close', () => { this.closed = true; this.failAll(new Error('ws-closed')); });
    ws.addEventListener('error', () => { this.failAll(new Error('ws-error')); });
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  static connect(wsUrl: string, deadline: number, abort?: AbortRef): Promise<CdpClient | null> {
    return new Promise((resolve) => {
      let ws: WebSocket;
      try { ws = new WebSocket(wsUrl); } catch { resolve(null); return; }
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve(null); }, Math.max(0, deadline - Date.now()));
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpClient(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); resolve(null); }, { once: true });
      // 中断(default への譲り)が来たら接続待ちを即座に打ち切る。
      if (abort) void abort.promise.then(() => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } resolve(null); });
    });
  }

  /** メソッド呼び出し(deadline 内で解決しなければ reject)。 */
  send<T = unknown>(method: string, params: Record<string, unknown> | undefined, deadline: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ws-closed'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`cdp-timeout:${method}`));
      }, Math.max(0, deadline - Date.now()));
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(payload); } catch (e) {
        this.pending.delete(id); clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}

// ═══ ★Chrome 起動スロット: 実際の Chrome 起動を **プロセス全体で直列化** する ═══════════
//
// なぜキャッシュのプール分離だけでは足りないか:
//   キャッシュ/相乗りは caller ごとに分けてある(v0.9.51・実取引の入力汚染を実際に塞いでいるので維持)。
//   しかし「同時2起動で Chrome が資源逼迫し ws-error/クラッシュを誘発する」という実際に起きた問題は
//   **プール間**ではなく **Chrome プロセス間** で起きる。プールを分けた結果、A(default)と分析用は
//   別プールなので同時に Chrome を起動しうる = プール分離が保護を回避していた。
//   → 起動そのものをここで直列化する。キャッシュのプール分離には一切触らない(直交)。
//
// 優先規約(★A を待たせない):
//   ・default(A/B) は **絶対に待たない**。要求した瞬間にスロットを取る。
//     「A が撮りたいときに分析用の撮影(最大42秒)を待つ」のでは、実取引を遅らせる元の問題に戻る。
//   ・generator は **待つ / 譲る**。
//       - 起動前: スロットが空くまで待つ(上限 CHROME_SLOT_WAIT_TIMEOUT_MS。超えたら諦めて縮退)。
//       - 起動後に default が来たら: 即座に中断(preempt)して Chrome を落とし、default に明け渡す。
//   ・default 同士(A/B)は従来どおり **キャッシュ側の相乗り** が同時起動を防ぐ(ここでは待たせない)。
const CHROME_SLOT_WAIT_TIMEOUT_MS = 45_000;   // generator がスロットを待つ上限(撮影1回の上限42秒+α)。

// 撮影1回(=Chrome 起動1回)の識別子。★画像の同一性 shotId とは **別の連番**にする:
// shotId の採番に割り込むと「同じ画像か」の記録が読みにくくなるため、ログ用は独立させる。
let captureSeq = 0;
function nextCaptureId(): string { return `cap${++captureSeq}-${SHOT_ID_RUN}`; }

interface ChromeSlotState {
  caller: LlmCaller;
  id: string;
  preempted: boolean;
  onPreempt: ((reason: string) => void) | null;
}

/** 取得済みスロット。release() するまで「Chrome が生きている」とみなされる。 */
export interface ChromeSlotTicket {
  readonly caller: LlmCaller;
  readonly id: string;
  /** スロット取得までに待った時間[ms](default は常に 0)。 */
  readonly waitedMs: number;
  /** default に割り込まれたか。 */
  readonly preempted: boolean;
  /** 中断されたときに呼ばれるコールバックを登録する(撮影側が Chrome を畳むのに使う)。 */
  onPreempt(cb: (reason: string) => void): void;
  /** 後始末まで終わってから呼ぶ。ここで初めて次の generator が起動できる。 */
  release(): void;
}

export type ChromeSlotResult =
  | { ok: true; ticket: ChromeSlotTicket }
  | { ok: false; reason: string };

const activeSlots = new Set<ChromeSlotState>();
const slotWaiters = new Set<() => void>();

/** テスト/診断用: いま Chrome を起動している撮影の一覧。 */
export function chromeSlotSnapshot(): Array<{ caller: LlmCaller; id: string; preempted: boolean }> {
  return [...activeSlots].map((s) => ({ caller: s.caller, id: s.id, preempted: s.preempted }));
}

/** テスト用: スロット状態を初期化。 */
export function resetChromeSlots(): void {
  activeSlots.clear();
  for (const w of [...slotWaiters]) w();
  slotWaiters.clear();
}

function wakeSlotWaiters(): void {
  const waiters = [...slotWaiters];
  slotWaiters.clear();
  for (const w of waiters) w();
}

/** default が来たので、いま走っている generator の撮影に「譲れ」と伝える。 */
function preemptGeneratorsFor(byId: string): void {
  for (const s of activeSlots) {
    if (s.caller === DEFAULT_CALLER || s.preempted) continue;
    s.preempted = true;
    console.warn(`[chart-shot] ★分析用の撮影を中断(A に譲る) 中断された撮影=${s.id} / 割込んだ撮影=${byId}`);
    try { s.onPreempt?.('preempted-by-default'); } catch { /* 中断通知の失敗で本流を壊さない */ }
  }
}

function makeTicket(caller: LlmCaller, id: string, waitedMs: number): ChromeSlotTicket {
  const state: ChromeSlotState = { caller, id, preempted: false, onPreempt: null };
  activeSlots.add(state);
  let released = false;
  return {
    caller, id, waitedMs,
    get preempted() { return state.preempted; },
    onPreempt(cb) {
      state.onPreempt = cb;
      // 登録前に中断されていた場合の取りこぼしを防ぐ。
      if (state.preempted) { try { cb('preempted-by-default'); } catch { /* ignore */ } }
    },
    release() {
      if (released) return;
      released = true;
      activeSlots.delete(state);
      if (activeSlots.size === 0) wakeSlotWaiters();
    },
  };
}

/**
 * Chrome 起動スロットを取る。
 * default … 即時取得(await で1ターンも待たない)。走っている generator は中断させる。
 * generator … 空くまで待つ(上限あり)。取れなければ ok:false で撮影せず縮退。
 */
export async function acquireChromeSlot(
  caller: LlmCaller,
  id: string,
  now: () => number = Date.now,
  waitTimeoutMs: number = CHROME_SLOT_WAIT_TIMEOUT_MS,
): Promise<ChromeSlotResult> {
  if (caller === DEFAULT_CALLER) {
    // ★A は待たない。走っている generator を蹴ってから、その場でスロットを取る。
    preemptGeneratorsFor(id);
    return { ok: true, ticket: makeTicket(caller, id, 0) };
  }
  const t0 = now();
  let announced = false;
  while (activeSlots.size > 0) {
    const remain = waitTimeoutMs - (now() - t0);
    if (remain <= 0) {
      const busy = [...activeSlots].map((s) => `${s.caller}:${s.id}`).join(',');
      console.warn(`[chart-shot] 分析用の撮影を見送り(${(waitTimeoutMs / 1000).toFixed(0)}秒待っても Chrome スロットが空かず) 使用中=${busy}`);
      return { ok: false, reason: 'chrome-slot-busy' };
    }
    if (!announced) {   // 待機中は1秒ごとに起きるので、告知は最初の1回だけ(ログを埋めない)。
      announced = true;
      const busy = [...activeSlots].map((s) => `${s.caller}:${s.id}`).join(',');
      console.log(`[chart-shot] 分析用は Chrome スロット待ち id=${id} 使用中=${busy} (実取引側の撮影を優先)`);
    }
    await new Promise<void>((resolve) => {
      const wake = () => { slotWaiters.delete(wake); clearTimeout(timer); resolve(); };
      const timer = setTimeout(wake, Math.max(1, Math.min(remain, 1000)));
      slotWaiters.add(wake);
    });
    // ★ここから activeSlots.add(=makeTicket) まで await を挟まない = 取得は不可分。
  }
  return { ok: true, ticket: makeTicket(caller, id, Math.max(0, now() - t0)) };
}

// ═══ ★Chrome の始末: 非同期にしても「確実に殺す」保証を弱めない ═══════════════════════
//
// 弱めないための3点:
//   ① 順序   … 「プロセスツリー kill → user-data-dir 削除」の順を await の直列で保つ
//                (逆だと掴まれているファイルを消せない)。
//   ② 失敗は声を出す … kill/削除の失敗は必ず warn。無音で取り残さない。
//                     kill に失敗した Chrome は登録簿に残し、プロセス終了時にもう一度始末する。
//   ③ プロセス終了時 … 撮影中に落ちても取り残さない(process 'exit' で同期的に一掃)。
//                     'exit' はイベントループが終わった後なので同期 API しか使えない=ここは execFileSync が正解。
interface LiveChrome {
  pid: number;
  tmpDir: string;
  id: string;
  /** spawn した子が既に自然終了したか(taskkill の「見つからない」を誤警報にしないため)。 */
  exited: boolean;
}
const liveChromes = new Map<number, LiveChrome>();

let exitSweeperInstalled = false;
function installExitSweeper(): void {
  if (exitSweeperInstalled) return;
  exitSweeperInstalled = true;
  process.on('exit', () => {
    if (liveChromes.size === 0) return;
    for (const e of liveChromes.values()) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/F', '/T', '/PID', String(e.pid)], { stdio: 'ignore', timeout: 5000 });
        } else {
          process.kill(e.pid, 'SIGKILL');
        }
        console.warn(`[chart-shot] 終了時掃除: 撮影中の Chrome を始末 pid=${e.pid} id=${e.id}`);
      } catch (err) {
        console.warn(`[chart-shot] ★終了時掃除に失敗 pid=${e.pid} id=${e.id} — ${err instanceof Error ? err.message : String(err)}`);
      }
      try { rmSync(e.tmpDir, { recursive: true, force: true, maxRetries: 1 }); } catch { /* 掃除失敗は起動時の temp 掃除に委ねる */ }
    }
    liveChromes.clear();
  });
}

/** テスト/診断用: いま始末待ちの Chrome。 */
export function liveChromeSnapshot(): Array<{ pid: number; id: string }> {
  return [...liveChromes.values()].map((e) => ({ pid: e.pid, id: e.id }));
}

/** テスト用: 登録簿を空にする(実運用では呼ばない=取り残しを忘れることになるため)。 */
export function clearLiveChromesForTest(): void { liveChromes.clear(); }

/** 後始末の依存(テスト注入点)。既定は実プロセス kill / 実ディレクトリ削除。 */
export interface CleanupDeps {
  killTree(pid: number): Promise<void>;
  removeDir(dir: string): Promise<void>;
  /** kill 後に「本当に死んだか」を確かめる(exit code を信用しない)。 */
  isAlive(pid: number): boolean;
}

/** PID がまだ生きているか。Windows/POSIX とも signal 0 は「存在確認だけ」。
 *  EPERM は「居るが触れない」= 生存扱い(安全側)。 */
export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export const defaultCleanupDeps: CleanupDeps = {
  async killTree(pid: number): Promise<void> {
    // ★重要(ws-error 根治): child.kill() は Windows では spawn した親しか殺さず、Chrome が切り離す
    //   子プロセス(レンダラ/GPU/utility/crashpad)が生き残ってリーク蓄積→資源枯渇→次回撮影でレンダラ
    //   クラッシュ(=ws-error)を誘発する。この Chrome インスタンスの **PID ツリーだけ** を taskkill /T で
    //   落とす(/PID 指定なのでユーザーの Chrome は無傷)。非 Windows は従来どおり SIGKILL。
    //   ★同期→非同期にしたのは「起動の仕方」だけで、殺す対象と手段(/F /T /PID)は1バイトも変えていない。
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 5000, windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  },
  async removeDir(dir: string): Promise<void> {
    // 非同期なので待ちがタダ = リトライを厚くできる(Windows は kill 直後にファイルが掴まれたままのことがある)。
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  },
  isAlive: isProcessAlive,
};

export interface CleanupOutcome {
  /** 実行順(必ず kill → rm)。 */
  order: string[];
  killError: string | null;
  rmError: string | null;
  /** kill 未確認のまま残った(=終了時掃除に託した)か。 */
  stillRegistered: boolean;
}

/**
 * 撮影1回分の後始末。**非同期だがイベントループを止めない**。
 * 順序(kill→rm)を保ち、失敗は必ず warn し、kill 未確認なら登録簿に残して終了時掃除に託す。
 */
export async function runCaptureCleanup(
  target: { pid: number | null; tmpDir: string; id: string },
  deps: CleanupDeps = defaultCleanupDeps,
): Promise<CleanupOutcome> {
  const order: string[] = [];
  let killError: string | null = null;
  let rmError: string | null = null;
  const entry = target.pid == null ? undefined : liveChromes.get(target.pid);

  if (target.pid != null) {
    order.push('kill');
    // ★「exit code が 0 か」ではなく「本当に死んだか」で判定する。
    //   taskkill /T はツリーの途中の子が先に消えているだけでも非0で終わる(実測で遭遇)。
    //   exit code だけを見ると健全なケースを誤警報し、逆に本物の残留を見落とす。
    //   1回目が非0なら間を置いて **もう一度殺し**、それでも駄目なら生存確認して結論を出す。
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await deps.killTree(target.pid);
        killError = null;
        break;
      } catch (e) {
        const err = e as NodeJS.ErrnoException & { stderr?: string };
        killError = `${err.message ?? String(e)}${err.stderr ? ` | ${String(err.stderr).trim()}` : ''}`;
        if (attempt === 1) await new Promise((r) => setTimeout(r, 250));
      }
    }
    const alive = deps.isAlive(target.pid);
    if (!alive) {
      liveChromes.delete(target.pid);
      if (killError) {
        // 死んではいる(ツリーの子が先に消えていた等)。無音にはしないが警告でもない。
        console.log(`[chart-shot] Chrome 停止を確認 pid=${target.pid} id=${target.id} `
          + `(taskkill は非0で終了: ${killError.split('\n')[0]}${entry?.exited ? ' / 親は既に自然終了' : ''})`);
      }
    } else {
      // ★無音にしない: 取り残した Chrome が溜まると資源逼迫でクラッシュを誘発する(過去に発生)。
      console.warn(`[chart-shot] ★Chrome を始末できず生存中 pid=${target.pid} id=${target.id} — `
        + `${(killError ?? 'taskkill は成功を返したが生存').split('\n')[0]} `
        + `(登録簿に残して終了時に再度始末する)`);
      // 登録簿に残す = プロセス終了時にもう一度始末される。
      if (!liveChromes.has(target.pid)) {
        liveChromes.set(target.pid, { pid: target.pid, tmpDir: target.tmpDir, id: target.id, exited: entry?.exited ?? false });
        installExitSweeper();
      }
    }
  }

  order.push('rm');
  try {
    await deps.removeDir(target.tmpDir);
  } catch (e) {
    rmError = e instanceof Error ? e.message : String(e);
    console.warn(`[chart-shot] 作業ディレクトリの削除に失敗 ${target.tmpDir} — ${rmError.split('\n')[0]}`);
  }

  return {
    order, killError, rmError,
    stillRegistered: target.pid != null && liveChromes.has(target.pid),
  };
}

/**
 * /chart-shot を撮影して PNG バッファを返す。失敗時は reason 付きで buffer=null。
 * CDP(Chrome DevTools Protocol)で実時間 window.__chartReady を待ってから撮影する。
 * どの段階の失敗/タイムアウトでも throw せず null を返す(呼び出し側はテキストのみへフォールバック)。
 * port: サーバが実際に待ち受けているポート。
 */
export async function captureChartPng(port: number, caller: LlmCaller = DEFAULT_CALLER): Promise<CaptureResult> {
  // ★問題③: これまで「終わったこと」しかログに無く、Chrome 起動〜撮影完了の全体所要が測れなかった。
  //   開始/完了をペアで出し、完了行に段階別の内訳を載せる(後から実測できるようにする)。
  const runId = nextCaptureId();
  const tStart = Date.now();
  const mark: Record<string, number> = {};
  const lap = (name: string, from: number): number => { const d = Date.now() - from; mark[name] = d; return d; };
  console.log(`[chart-shot] 撮影開始 id=${runId} caller=${caller} port=${port}`);

  const finish = (buf: Buffer | null, why: string | null, chromePathV: string | null, verV: string | null): CaptureResult => {
    const total = ((Date.now() - tStart) / 1000).toFixed(1);
    const parts = Object.entries(mark).map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`).join(' ');
    if (buf) {
      // 既存文言(「TradingView 撮影 ok (NNKB)」)は前方一致で保つ。内訳を追記するだけ。
      console.log(`[chart-shot] TradingView 撮影 ok (${(buf.length / 1024).toFixed(0)}KB) id=${runId} 所要=${total}s [${parts}]`);
    } else {
      console.warn(`[chart-shot] TradingView 撮影 失敗: ${why ?? 'unknown'} → テキストのみへフォールバック `
        + `id=${runId} 所要=${total}s [${parts}]`);
    }
    return { buffer: buf, chromePath: chromePathV, chromeVersion: verV, reason: buf ? null : why };
  };

  const chromePath = resolveChromePath();
  if (!chromePath) return finish(null, 'chrome-not-found', null, null);
  const ver = chromeVersion(chromePath);

  // グローバル WebSocket が無い Node ではフォールバック(テキストのみ)。
  if (typeof WebSocket === 'undefined') return finish(null, 'no-websocket', chromePath, ver);

  // ★問題②: 実際の Chrome 起動をプロセス全体で直列化する(キャッシュのプール分離とは独立)。
  //   default は待たない / generator は待つ・譲る。
  const slot = await acquireChromeSlot(caller, runId);
  if (!slot.ok) return finish(null, slot.reason, chromePath, ver);
  const ticket = slot.ticket;
  mark['スロット待ち'] = ticket.waitedMs;

  let tmpDir: string;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'jp225-shot-'));
  } catch (e) {
    ticket.release();
    return finish(null, `tmpdir: ${e instanceof Error ? e.message : String(e)}`, chromePath, ver);
  }
  const userDataDir = join(tmpDir, 'ud');
  // ★撮影ごとに別ポート + 自分のページを見分ける印(cap=<runId>)。前の撮影の Chrome を掴まない。
  const debugPort = DEBUG_PORT_BASE + (debugPortSeq++ % DEBUG_PORT_SPAN);
  const urlMark = `cap=${runId}`;
  const url = `http://127.0.0.1:${port}/chart-shot?${urlMark}`;
  const args = buildChromeArgs(url, debugPort, userDataDir);

  // ★デッドラインはスロット取得**後**に張る(待ち時間で撮影の持ち時間を食い潰さない)。
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;   // 全 await を縛る全体デッドライン。
  let child: ReturnType<typeof spawn> | null = null;
  let cdp: CdpClient | null = null;
  let buffer: Buffer | null = null;
  let reason: string | null = null;

  // 中断(generator が default に譲る)シグナル。default では絶対に fire されない。
  const abort = makeAbortRef();
  ticket.onPreempt((r) => {
    abort.fire(r);
    // 進行中の CDP 待ちを即座に解く(ws を閉じると pending は ws-closed で reject される)。
    try { cdp?.close(); } catch { /* ignore */ }
  });

  try {
    // (a) launch
    try {
      const tLaunch = Date.now();
      child = spawn(chromePath, args, { windowsHide: true });
      child.on('error', () => { /* 監視するが throw させない。以降の CDP 接続失敗で reason 化。 */ });
      if (child.pid != null) {
        // ★起動した瞬間に登録簿へ。以降どこで落ちても(例外・強制終了)始末の対象になる。
        installExitSweeper();
        const entry: LiveChrome = { pid: child.pid, tmpDir, id: runId, exited: false };
        liveChromes.set(child.pid, entry);
        child.on('exit', () => { entry.exited = true; });
      }
      lap('起動', tLaunch);
    } catch (e) {
      reason = `spawn: ${e instanceof Error ? e.message : String(e)}`;
      throw new Error(reason);
    }

    // (b) get ws target(~10s cap)
    const tWs = Date.now();
    const wsUrl = await findPageWebSocketUrl(debugPort, deadline, abort, urlMark);
    if (!wsUrl) { reason = 'ws-target'; throw new Error(reason); }

    cdp = await CdpClient.connect(wsUrl, deadline, abort);
    if (!cdp) { reason = 'ws-connect'; throw new Error(reason); }
    // 接続確立と中断通知が競合した場合の取りこぼしを防ぐ(既に中断済みなら即閉じる)。
    if (abort.aborted) { try { cdp.close(); } catch { /* ignore */ } }
    lap('ws接続', tWs);

    // (c) Page.enable / Runtime.enable
    try {
      await cdp.send('Page.enable', undefined, deadline);
      await cdp.send('Runtime.enable', undefined, deadline);
    } catch { reason = 'cdp-enable'; throw new Error(reason); }

    // (d) wait window.__chartReady(実時間・~18s cap)
    const tReady = Date.now();
    const readyDeadline = Math.min(deadline, Date.now() + CHART_READY_TIMEOUT_MS);
    let ready = false;
    while (!abort.aborted && Date.now() < readyDeadline) {
      try {
        const r = await cdp.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: '!!window.__chartReady', returnByValue: true },
          deadline,
        );
        if (r?.result?.value === true) { ready = true; break; }
      } catch { /* 評価失敗は次のポーリングで再試行 */ }
      await sleep(READY_POLL_INTERVAL_MS, abort);
    }
    lap('ready待ち', tReady);
    if (!ready) { reason = 'chart-ready-timeout'; throw new Error(reason); }

    // (e) settle
    const tShot = Date.now();
    await sleep(SETTLE_AFTER_READY_MS, abort);

    // (f) screenshot
    try {
      const shot = await cdp.send<{ data?: string }>('Page.captureScreenshot', { format: 'png' }, deadline);
      if (!shot?.data) { reason = 'screenshot-empty'; throw new Error(reason); }
      const buf = Buffer.from(shot.data, 'base64');
      if (buf.length === 0) { reason = 'empty-png'; throw new Error(reason); }
      buffer = buf;
      await saveShotToDesktop(buffer);   // 確認用: 最新1枚を Desktop に上書き保存(非同期=ループを止めない)。
      lap('撮影', tShot);
    } catch (e) {
      if (!reason) reason = `screenshot: ${e instanceof Error ? e.message : String(e)}`;
      throw new Error(reason);
    }
  } catch (e) {
    // 全経路 null フォールバック。reason 未設定なら例外メッセージから。
    if (!reason) reason = e instanceof Error ? e.message : String(e);
    // 中断されていたなら真の理由はそれ(ws-closed 等の派生メッセージで覆い隠さない)。
    if (abort.aborted) reason = abort.reason ?? reason;
    buffer = null;
  } finally {
    // ★後始末(問題①)。順序は従来どおり ws → chrome プロセスツリー kill → user-data-dir 掃除。
    //   変えたのは「同期で待つ」のをやめたことだけ。await の直列なので順序は保たれ、
    //   その間イベントループは回り続ける(SSE・価格ループ・A の約定判定が止まらない)。
    //   失敗は runCaptureCleanup が必ずログに出し、kill 未確認なら登録簿に残して終了時掃除へ託す。
    const tClean = Date.now();
    try { cdp?.close(); } catch { /* ignore */ }
    await runCaptureCleanup({ pid: child?.pid ?? null, tmpDir, id: runId });
    lap('後始末', tClean);
    // Chrome が完全に片付いてから初めてスロットを解放する(次の generator が起動できる)。
    ticket.release();
  }

  // TradingView チャートが実際に描画・撮影できたかを明示ログ(トレード PC のログで自己診断)。
  return finish(buffer, reason, chromePath, ver);
}

// ─── A/B(+連続サイクル)でチャート撮影を共有するキャッシュ ───────────────────────
// A系・B系エンジンは各々 runScalpPlanWithChart→captureChartPng を呼ぶため、素だと毎サイクル
// **2つの Chrome を同時起動**して重い TradingView を二重描画=資源逼迫で ws-error/クラッシュを誘発する。
// ここで「成功画像を短時間キャッシュ」+「進行中の撮影に相乗り(二重起動しない)」して起動数を半減する。
//
// ★呼び出し元(caller)ごとに **プールを分ける**(v0.9.51)。
//   分けない実装では、2分間隔で回る分析用(caller='generator')の撮影がキャッシュを常時温めてしまい、
//   TTL 60秒 < plan間隔 180秒 という「A は毎サイクル撮り直す」不変条件が壊れる
//   (=A が二度と自前で撮らず、常に最大60秒前の画像で判断する。refPrice は毎回新鮮に取り直すので
//     「数値だけ新しく画像だけ古い」不整合になり、checkRefDrift/checkStaleLegs は価格しか見ないので誰も気づかない)。
//   さらに in-flight 相乗りも分けないと、分析用の撮影開始41秒後に来た A が1秒後に buffer=null を掴み、
//   リトライでプラン生成が最大84秒遅れ、2回失敗ならテキストのみへ縮退する(=A の入力から画像が消える)。
//   generatorGate の busy ゲートは「A が生成中なら分析用を止める」の片方向しか守っていない。
//
//   **'default'(A と B)は従来どおり1プールを共有する**。A/B の共有は「同時2起動で Chrome が資源逼迫し
//   ws-error/クラッシュを誘発する」という実際に起きた問題への対策なので、絶対に壊さない。
//   分離するのは 'generator' だけ。
const CHART_CACHE_TTL_MS = 60_000;   // 成功画像を最大60秒 共有(plan間隔180sなのでA/B同時要求を吸収しつつ毎サイクルは再撮影)。

// ─── ★「同じ画像を見たか」を **仮定ではなく記録** にするための識別子 ───────────────
//
// 分析用は1サイクルの中で ①現行仕様 → ②候補仕様 を **直列** に問う。①と②が同じ相場・同じ画像を
// 見ていることが対応比較の前提だが、その保証は「キャッシュ TTL が60秒だから間に合うはず」という
// **仮定** でしかなかった。1サイクルが60秒を超えれば②は別の画像を見るが、**誰にも分からない**。
// (齢はログには出るが、分析用の台帳には残らないので1年後の分析者は再構成できない。)
//
// → 撮影1回ごとに識別子を振り、応答に「識別子と齢」を additive に載せる。
//   ①と②の shotId が一致すれば同じ画像、違えば別の画像だったと **記録で** 言える。
//
// ★識別子に画像の中身も決済の数値も含まれない(プロセス起動ごとの乱数 + 連番)。
//   起動をまたいで衝突しないよう、プロセスごとの接頭辞を付ける(連番だけだと再起動後に同じ id が再出現し、
//   「別の日の別の画像」が同一と読めてしまう)。
const SHOT_ID_RUN = randomUUID().slice(0, 8);
let shotSeq = 0;
function nextShotId(): string { return `${SHOT_ID_RUN}-${++shotSeq}`; }

/** その要求がどうやって画像を得たか。'fresh'=新規撮影 / 'cache'=既存画像の流用 / 'joined'=進行中撮影に相乗り。 */
export type ChartShotOrigin = 'fresh' | 'cache' | 'joined';

/** 画像の同一性(記録専用)。同じ shotId = **同じ1枚の PNG** を見たということ。 */
export interface ChartShotIdentity {
  /** 撮影1回ごとの識別子。 */
  shotId: string;
  /** その要求が受け取った時点での画像の齢[ms](0=撮りたて)。 */
  ageMs: number;
  origin: ChartShotOrigin;
}

/** 撮影結果 + 画像の同一性(**additive**)。identity は画像が得られたときだけ付く(失敗時は null)。
 *  ★関数を2本に分けない: 分けると「identity を返す版」と「返さない版」で経路が2本になり、
 *    記録に載る画像と実際に AI が見た画像がずれる余地ができる。既存の呼び出し元は
 *    identity を読まないだけ(挙動不変)。 */
export type TrackedCaptureResult = CaptureResult & { identity: ChartShotIdentity | null };

interface ChartCachePool {
  cache: { at: number; result: CaptureResult; shotId: string } | null;
  inFlight: Promise<{ at: number; result: CaptureResult; shotId: string | null }> | null;
}

/** caller をキーにしたプール。'default' は A/B が共有する1個、'generator' は完全に別物。 */
const chartPools = new Map<LlmCaller, ChartCachePool>();

function poolFor(caller: LlmCaller): ChartCachePool {
  let p = chartPools.get(caller);
  if (!p) { p = { cache: null, inFlight: null }; chartPools.set(caller, p); }
  return p;
}

/** ★共有版: 新鮮な成功キャッシュがあれば即返す / 撮影中なら相乗り / どちらも無ければ1回だけ実撮影。
 *  失敗はキャッシュしない(呼び出し側のリトライ/縮退が効くように)。
 *  キャッシュ/相乗りは **caller ごと**に隔離される(default = A と B の共有プール)。
 *  now/capture はテスト注入用。caller 省略は 'default' = 従来と完全に同一経路。 */
export async function captureChartPngCached(
  port: number,
  // ★caller を撮影関数へも渡す: 実際の Chrome 起動の直列化(スロット)は撮影側で効かせる必要がある
  //   (キャッシュを迂回する直接呼び出し=起動時の1枚 も同じ規約に乗せるため)。
  //   テストが注入するモックは引数を無視するだけで、呼び出し回数の意味は変わらない。
  capture: (p: number, c?: LlmCaller) => Promise<CaptureResult> = captureChartPng,
  now: () => number = Date.now,
  caller: LlmCaller = DEFAULT_CALLER,
): Promise<TrackedCaptureResult> {
  const pool = poolFor(caller);
  if (pool.cache && pool.cache.result.buffer && now() - pool.cache.at < CHART_CACHE_TTL_MS) {
    const ageMs = now() - pool.cache.at;
    // ★無音をやめる: 「新規撮影」と「60秒前の使い回し」を必ず区別してログに出す。
    //   画像の齢が変わったこと(=A の入力の鮮度が落ちたこと)に誰も気づけない状態を作らない。
    console.log(`[chart-shot] キャッシュ流用 caller=${caller} 齢=${(ageMs / 1000).toFixed(1)}s `
      + `(Chrome を起動せず既存画像を再利用)`);
    // 新鮮な成功画像を A/B/連続要求で共有(Chrome を起動しない)。
    return { ...pool.cache.result, identity: { shotId: pool.cache.shotId, ageMs, origin: 'cache' } };
  }
  if (pool.inFlight) {
    console.log(`[chart-shot] 進行中の撮影に相乗り caller=${caller} (同時2起動を防止)`);
    const joined = await pool.inFlight;   // 進行中の撮影に相乗り(同時2起動を防ぐ)。
    return {
      ...joined.result,
      identity: joined.shotId === null
        ? null
        : { shotId: joined.shotId, ageMs: Math.max(0, now() - joined.at), origin: 'joined' },
    };
  }
  console.log(`[chart-shot] 新規撮影 caller=${caller} (キャッシュ無効/期限切れ)`);
  pool.inFlight = (async () => {
    try {
      const r = await capture(port, caller);
      const at = now();
      if (r.buffer) {
        const shotId = nextShotId();
        pool.cache = { at, result: r, shotId };   // 成功のみキャッシュ(失敗は都度再試行)。
        return { at, result: r, shotId };
      }
      return { at, result: r, shotId: null };
    } finally { pool.inFlight = null; }
  })();
  const fresh = await pool.inFlight;
  return {
    ...fresh.result,
    identity: fresh.shotId === null ? null : { shotId: fresh.shotId, ageMs: 0, origin: 'fresh' },
  };
}

/** テスト用: 全プールのキャッシュ/進行中状態をリセット。 */
export function resetChartCache(): void { chartPools.clear(); }
