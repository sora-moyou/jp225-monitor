// システムにインストール済みの Google Chrome をヘッドレスで起動し、/chart-shot を PNG 撮影する。
// chromedriver/Selenium は使わない(バージョン不整合の元凶)。外部 exe を spawn するだけなので
// パッケージ化(SEA)されたサイドカーからも動く(バイナリ自身は Node、Chrome はOS側)。
// すべての失敗経路(Chrome 不在・タイムアウト・撮影失敗)は null を返し、呼び出し側はテキストのみへフォールバックする。

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { loadConfig } from '../configStore.js';

const CAPTURE_TIMEOUT_MS = 8000;
const WINDOW = '1280,760';

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
  // 1) レジストリの User Shell Folders → Desktop(REG_EXPAND_SZ・%USERPROFILE% 等を含む)。
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
        { encoding: 'utf-8', timeout: 3000 },
      );
      const m = out.match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      if (m && m[1]) candidates.push(expandEnv(m[1].trim(), env));
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
  // 存在する最初のディレクトリを採用。
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* 次へ */ }
  }
  // どれも無ければ homedir\Desktop を作成対象として返す。
  return join(homedir(), 'Desktop');
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
    console.log(`[chart-shot] Desktop 保存OK: ${target} (${buf.length}B)`);
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

/** chrome --version の出力(ログ用)。取得失敗/非バージョン応答は null。
 *  既存 Chrome セッションがあると「別のブラウザセッションで開いています」等の別メッセージが返るため、
 *  "Chrome" と数字を含む行だけを採用する(ログの誤情報を避ける)。 */
export function chromeVersion(chromePath: string): string | null {
  try {
    const out = execFileSync(chromePath, ['--version'], { encoding: 'utf-8', timeout: 3000 }).trim();
    if (/chrome/i.test(out) && /\d+\.\d+/.test(out)) return out;
    return null;
  } catch {
    return null;
  }
}

/** ヘッドレス Chrome の起動引数を組み立てる(テスト可能な純関数)。 */
export function buildChromeArgs(url: string, outPng: string, userDataDir: string): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${WINDOW}`,
    '--no-sandbox',
    '--disable-extensions',
    '--disable-background-networking',
    `--user-data-dir=${userDataDir}`,
    '--virtual-time-budget=5000',
    `--screenshot=${outPng}`,
    url,
  ];
}

export interface CaptureResult {
  buffer: Buffer | null;
  chromePath: string | null;
  chromeVersion: string | null;
  reason: string | null;   // null=成功 / それ以外=フォールバック理由
}

/**
 * /chart-shot を撮影して PNG バッファを返す。失敗時は reason 付きで buffer=null。
 * port: サーバが実際に待ち受けているポート。
 */
export async function captureChartPng(port: number): Promise<CaptureResult> {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    return { buffer: null, chromePath: null, chromeVersion: null, reason: 'chrome-not-found' };
  }
  const ver = chromeVersion(chromePath);

  let tmpDir: string;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'jp225-shot-'));
  } catch (e) {
    return { buffer: null, chromePath, chromeVersion: ver, reason: `tmpdir: ${e instanceof Error ? e.message : String(e)}` };
  }
  const outPng = join(tmpDir, 'chart.png');
  const userDataDir = join(tmpDir, 'ud');
  const url = `http://127.0.0.1:${port}/chart-shot`;
  const args = buildChromeArgs(url, outPng, userDataDir);

  const reason = await new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (r: string | null): void => { if (!done) { done = true; resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(chromePath, args, { windowsHide: true });
    } catch (e) {
      finish(`spawn: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish('timeout');
    }, CAPTURE_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); finish(`proc: ${err.message}`); });
    child.on('exit', () => { clearTimeout(timer); finish(existsSync(outPng) ? null : 'no-png'); });
  });

  let buffer: Buffer | null = null;
  let readReason = reason;
  if (reason === null) {
    try {
      buffer = readFileSync(outPng);
      if (buffer.length === 0) { buffer = null; readReason = 'empty-png'; }
      else { saveShotToDesktop(buffer); }   // 確認用: 最新1枚を Desktop に上書き保存。
    } catch (e) {
      readReason = `read: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 一時ファイル/ディレクトリを掃除(失敗は無視)。user-data-dir にロックが残ることがあるので best-effort。
  try { unlinkSync(outPng); } catch { /* ignore */ }
  try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* ignore */ }

  return { buffer, chromePath, chromeVersion: ver, reason: buffer ? null : readReason };
}
