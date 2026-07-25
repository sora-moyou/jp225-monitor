// 225labo(XOOPS)へのログイン + 基礎データ xlsx ダウンロード。server 専用(ネットワーク)。
// buildLoginBody / classifyDownload は純関数=単体テスト対象。login/downloadXlsx は実ネット(非単体)。
// creds はログに出さない。

const BASE = 'https://225labo.com';
const LOGIN_URL = `${BASE}/user.php`;
const DOWNLOAD_URL = `${BASE}/modules/downloads_data/index.php?page=visit&cid=3&lid=160`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// ソース xlsx(~14MB)を内包した ZIP を落とすため、遅回線でも切れないよう余裕をもたせる(旧 30s は短すぎ)。
const TIMEOUT_MS = 120_000;

// XOOPS ログインフォームの POST body(op=login/xoops_redirect=//uname/pass)。純関数=テスト対象。
export function buildLoginBody(uname: string, pass: string): string {
  const p = new URLSearchParams();
  p.set('op', 'login');
  p.set('xoops_redirect', '/');
  p.set('uname', uname);
  p.set('pass', pass);
  return p.toString();
}

// ダウンロード応答の分類。zip(=225labo の実配布形式=xlsx を内包する ZIP)/ xlsx(=生 xlsx)/ html(未ログイン)/ unknown。
// 注意: 生 xlsx それ自体も ZIP(PK マジック)なので、マジックバイトだけでは wrapper-zip と xlsx を区別できない。
//   → PK で始まれば 'zip'(コンテナ扱い)として返し、中身の判別は extractXlsxFromZip(エントリ検査)に委ねる。
// 純関数=テスト対象。
export function classifyDownload(contentType: string | null, firstBytes: Buffer): 'zip' | 'xlsx' | 'html' | 'unknown' {
  const head = firstBytes.slice(0, 64).toString('utf-8').trimStart().toLowerCase();
  const ct = (contentType ?? '').toLowerCase();
  if (head.startsWith('<') || ct.includes('html')) return 'html';   // ログインページ/エラー = 未ログイン
  // ZIP マジック(PK\x03\x04)。wrapper-zip か xlsx かはここでは決めない(コンテナ検査は extractXlsxFromZip)。
  if (firstBytes.length >= 2 && firstBytes[0] === 0x50 && firstBytes[1] === 0x4b) return 'zip';
  if (ct.includes('spreadsheet') || ct.includes('octet-stream') || ct.includes('excel')) return 'xlsx';
  return 'unknown';
}

// set-cookie ヘッダ群を name=value; ... の Cookie ヘッダ値へマージする(手動 cookie 管理・XOOPS は PHPSESSID 等)。
function mergeCookies(jar: Map<string, string>, setCookie: string | null): void {
  if (!setCookie) return;
  // fetch の Headers.get('set-cookie') は複数を ", " で連結して返しうる。Expires=..., を誤分割しないよう
  //   「, 」の直後が "name=" の形のときだけ区切る。
  const parts = setCookie.split(/,(?=\s*[^;,\s]+=)/);
  for (const part of parts) {
    const kv = part.split(';')[0]!.trim();
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const name = kv.slice(0, eq).trim();
    const value = kv.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// タイムアウト付き fetch。AbortError(タイムアウト)は日本語メッセージに変換して throw する。
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
      throw new Error('225labo との通信がタイムアウトしました');
    }
    throw err;
  } finally { clearTimeout(id); }
}

/** 225labo にログインし、認証済みセッションの Cookie ヘッダ値を返す。失敗時 throw。 */
export async function login(uname: string, pass: string): Promise<string> {
  const jar = new Map<string, string>();
  // ① GET user.php で初期 PHPSESSID を得る。
  {
    const r = await fetchWithTimeout(LOGIN_URL, { headers: { 'User-Agent': UA }, redirect: 'manual' });
    mergeCookies(jar, r.headers.get('set-cookie'));
  }
  // ② POST user.php でログイン。認証済み cookie を回収。
  {
    const r = await fetchWithTimeout(LOGIN_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(jar.size > 0 ? { Cookie: cookieHeader(jar) } : {}),
      },
      body: buildLoginBody(uname, pass),
      redirect: 'manual',
    });
    mergeCookies(jar, r.headers.get('set-cookie'));
  }
  if (jar.size === 0) throw new Error('ログイン失敗(認証情報を確認してください)');
  return cookieHeader(jar);
}

/** 認証済み cookie で基礎データをダウンロードし、生バイト(zip または xlsx)を返す。HTML(未ログイン)/想定外は throw。
 *  225labo の実配布は xlsx を内包した ZIP。中身の xlsx 抽出は呼び出し側の extractXlsxFromZip が担う。 */
export async function downloadXlsx(cookie: string): Promise<Buffer> {
  const r = await fetchWithTimeout(DOWNLOAD_URL, {
    headers: { 'User-Agent': UA, Cookie: cookie },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`基礎データの取得に失敗(HTTP ${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const kind = classifyDownload(r.headers.get('content-type'), buf.subarray(0, 64));
  if (kind === 'html') throw new Error('基礎データの取得に失敗(未ログインの可能性)');
  if (kind !== 'zip' && kind !== 'xlsx') throw new Error('基礎データの取得に失敗(想定外の応答形式)');
  return buf;
}
