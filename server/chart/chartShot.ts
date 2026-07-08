// システムにインストール済みの Google Chrome をヘッドレスで起動し、/chart-shot を PNG 撮影する。
// chromedriver/Selenium は使わない(バージョン不整合の元凶)。外部 exe を spawn するだけなので
// パッケージ化(SEA)されたサイドカーからも動く(バイナリ自身は Node、Chrome はOS側)。
// すべての失敗経路(Chrome 不在・タイムアウト・撮影失敗)は null を返し、呼び出し側はテキストのみへフォールバックする。

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../configStore.js';

const CAPTURE_TIMEOUT_MS = 8000;
const WINDOW = '1280,760';

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
    } catch (e) {
      readReason = `read: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 一時ファイル/ディレクトリを掃除(失敗は無視)。user-data-dir にロックが残ることがあるので best-effort。
  try { unlinkSync(outPng); } catch { /* ignore */ }
  try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* ignore */ }

  return { buffer, chromePath, chromeVersion: ver, reason: buffer ? null : readReason };
}
