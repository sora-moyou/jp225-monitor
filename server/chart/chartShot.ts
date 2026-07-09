// システムにインストール済みの Google Chrome をヘッドレスで起動し、/chart-shot を PNG 撮影する。
// chromedriver/Selenium は使わない(バージョン不整合の元凶)。外部 exe を spawn するだけなので
// パッケージ化(SEA)されたサイドカーからも動く(バイナリ自身は Node、Chrome はOS側)。
// すべての失敗経路(Chrome 不在・タイムアウト・撮影失敗)は null を返し、呼び出し側はテキストのみへフォールバックする。

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { loadConfig } from '../configStore.js';

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
// 同時撮影は想定しないが、user-data-dir は毎回隔離するので衝突しても致命的でない。
const DEBUG_PORT_BASE = 47800;

/** '%USERPROFILE%\\OneDrive\\Desktop' のような文字列の %ENV% を展開する。 */
function expandEnv(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s.replace(/%([^%]+)%/g, (_, name) => env[name] ?? env[String(name).toUpperCase()] ?? `%${name}%`);
}

/**
 * 実際のデスクトップ フォルダを解決する。OneDrive リダイレクト(既定のデスクトップが
 * %USERPROFILE%\OneDrive\Desktop になっている環境)に対応するため、まず User Shell Folders
 * レジストリの Desktop 値を見る。ダメなら OneDrive/通常の候補を順に試し、存在する最初のものを返す。
 */
function resolveDesktopDir(env: NodeJS.ProcessEnv = process.env): string {
  const candidates: string[] = [];
  let regVal = '(none)';
  // 1) レジストリの User Shell Folders → Desktop(REG_EXPAND_SZ・%USERPROFILE% 等を含む)。
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
        { encoding: 'utf-8', timeout: 3000 },
      );
      const m = out.match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
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
  const detail = candidates.map(c => { let ex = false; try { ex = existsSync(c); } catch { /* noop */ } return `${ex ? '○' : '×'}${c}`; }).join(' | ');
  console.log(`[chart-shot] Desktop解決 reg=${regVal} 候補=[${detail}]`);
  // 存在する最初のディレクトリを採用。
  for (const c of candidates) {
    try { if (existsSync(c)) { console.log(`[chart-shot] Desktop採用(既存): ${c}`); return c; } } catch { /* 次へ */ }
  }
  // どれも無ければ homedir\Desktop を作成対象として返す(=幻フォルダになりうるので明示ログ)。
  const fb = join(homedir(), 'Desktop');
  console.warn(`[chart-shot] Desktop候補が全て不在 → フォールバック作成対象: ${fb}`);
  return fb;
}

// 撮影した最新1枚を実デスクトップに上書き保存する(確認用)。実弾ロジックには無関係。
// 書込の実パスと成否を必ずログに出す(サイレント失敗の撲滅=自己診断)。失敗しても throw しない。
function saveShotToDesktop(buf: Buffer): void {
  let target = '(unresolved)';
  try {
    const dir = resolveDesktopDir();
    try { mkdirSync(dir, { recursive: true }); } catch { /* 既存 or 作成不可 → 書込側で判定 */ }
    target = join(dir, 'jp225-chart-shot.png');
    writeFileSync(target, buf);
    // 書込直後にファイルを stat して「本当にディスク上に存在するか+サイズ」を確認する。
    // writeFileSync が例外なしでも、リダイレクト/同期/AV 等で直後に消えるケースを捕捉する。
    let onDisk = -1;
    try { onDisk = statSync(target).size; } catch { /* stat 不可 = 直後に実在せず */ }
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

/** 単純な sleep(deadline は呼び出し側で管理)。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** GET http://127.0.0.1:port/json/list をポーリングし、type==='page' のターゲットの ws URL を得る。 */
async function findPageWebSocketUrl(debugPort: number, deadline: number): Promise<string | null> {
  const stepDeadline = Math.min(deadline, Date.now() + WS_TARGET_TIMEOUT_MS);
  while (Date.now() < stepDeadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const list = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        const page = Array.isArray(list) ? list.find((t) => t.type === 'page' && !!t.webSocketDebuggerUrl) : undefined;
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch { /* Chrome 起動直後は接続拒否 → リトライ */ }
    await sleep(300);
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

  static connect(wsUrl: string, deadline: number): Promise<CdpClient | null> {
    return new Promise((resolve) => {
      let ws: WebSocket;
      try { ws = new WebSocket(wsUrl); } catch { resolve(null); return; }
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve(null); }, Math.max(0, deadline - Date.now()));
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpClient(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); resolve(null); }, { once: true });
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

/**
 * /chart-shot を撮影して PNG バッファを返す。失敗時は reason 付きで buffer=null。
 * CDP(Chrome DevTools Protocol)で実時間 window.__chartReady を待ってから撮影する。
 * どの段階の失敗/タイムアウトでも throw せず null を返す(呼び出し側はテキストのみへフォールバック)。
 * port: サーバが実際に待ち受けているポート。
 */
export async function captureChartPng(port: number): Promise<CaptureResult> {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    return { buffer: null, chromePath: null, chromeVersion: null, reason: 'chrome-not-found' };
  }
  const ver = chromeVersion(chromePath);

  // グローバル WebSocket が無い Node ではフォールバック(テキストのみ)。
  if (typeof WebSocket === 'undefined') {
    return { buffer: null, chromePath, chromeVersion: ver, reason: 'no-websocket' };
  }

  let tmpDir: string;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'jp225-shot-'));
  } catch (e) {
    return { buffer: null, chromePath, chromeVersion: ver, reason: `tmpdir: ${e instanceof Error ? e.message : String(e)}` };
  }
  const userDataDir = join(tmpDir, 'ud');
  const debugPort = DEBUG_PORT_BASE + (port % 100);   // 撮影サーバのポートから派生(隔離 user-data-dir なので衝突許容)。
  const url = `http://127.0.0.1:${port}/chart-shot`;
  const args = buildChromeArgs(url, debugPort, userDataDir);

  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;   // 全 await を縛る全体デッドライン。
  let child: ReturnType<typeof spawn> | null = null;
  let cdp: CdpClient | null = null;
  let buffer: Buffer | null = null;
  let reason: string | null = null;

  try {
    // (a) launch
    try {
      child = spawn(chromePath, args, { windowsHide: true });
      child.on('error', () => { /* 監視するが throw させない。以降の CDP 接続失敗で reason 化。 */ });
    } catch (e) {
      reason = `spawn: ${e instanceof Error ? e.message : String(e)}`;
      throw new Error(reason);
    }

    // (b) get ws target(~10s cap)
    const wsUrl = await findPageWebSocketUrl(debugPort, deadline);
    if (!wsUrl) { reason = 'ws-target'; throw new Error(reason); }

    cdp = await CdpClient.connect(wsUrl, deadline);
    if (!cdp) { reason = 'ws-connect'; throw new Error(reason); }

    // (c) Page.enable / Runtime.enable
    try {
      await cdp.send('Page.enable', undefined, deadline);
      await cdp.send('Runtime.enable', undefined, deadline);
    } catch { reason = 'cdp-enable'; throw new Error(reason); }

    // (d) wait window.__chartReady(実時間・~18s cap)
    const readyDeadline = Math.min(deadline, Date.now() + CHART_READY_TIMEOUT_MS);
    let ready = false;
    while (Date.now() < readyDeadline) {
      try {
        const r = await cdp.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: '!!window.__chartReady', returnByValue: true },
          deadline,
        );
        if (r?.result?.value === true) { ready = true; break; }
      } catch { /* 評価失敗は次のポーリングで再試行 */ }
      await sleep(READY_POLL_INTERVAL_MS);
    }
    if (!ready) { reason = 'chart-ready-timeout'; throw new Error(reason); }

    // (e) settle
    await sleep(SETTLE_AFTER_READY_MS);

    // (f) screenshot
    try {
      const shot = await cdp.send<{ data?: string }>('Page.captureScreenshot', { format: 'png' }, deadline);
      if (!shot?.data) { reason = 'screenshot-empty'; throw new Error(reason); }
      const buf = Buffer.from(shot.data, 'base64');
      if (buf.length === 0) { reason = 'empty-png'; throw new Error(reason); }
      buffer = buf;
      saveShotToDesktop(buffer);   // 確認用: 最新1枚を Desktop に上書き保存。
    } catch (e) {
      if (!reason) reason = `screenshot: ${e instanceof Error ? e.message : String(e)}`;
      throw new Error(reason);
    }
  } catch (e) {
    // 全経路 null フォールバック。reason 未設定なら例外メッセージから。
    if (!reason) reason = e instanceof Error ? e.message : String(e);
    buffer = null;
  } finally {
    // 後始末(失敗は無視)。ws → chrome kill → user-data-dir 掃除。
    try { cdp?.close(); } catch { /* ignore */ }
    try { child?.kill('SIGKILL'); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* ignore */ }
  }

  // TradingView チャートが実際に描画・撮影できたかを明示ログ(トレード PC のログで自己診断)。
  if (buffer) {
    console.log(`[chart-shot] TradingView 撮影 ok (${(buffer.length / 1024).toFixed(0)}KB)`);
  } else {
    console.warn(`[chart-shot] TradingView 撮影 失敗: ${reason ?? 'unknown'} → テキストのみへフォールバック`);
  }

  return { buffer, chromePath, chromeVersion: ver, reason: buffer ? null : reason };
}
