import type { Request, Response } from 'express';
import { openDb, resolveDbPath } from '../db/store.js';
import { resolveVariant } from '../variant.js';
import { APP_VERSION } from '../appVersion.js';
import { resolveUpdaterEndpoint } from '../updater/endpoints.js';
import { probeUpdaterEndpoint, type UpdaterProbe } from '../updater/probe.js';
import {
  buildUpdateCheckHeartbeat, formatUpdateCheckStatus, writeUpdateCheckHeartbeat,
  type UpdateCheckSource, type UpdateCheckVerdict,
} from '../db/updateCheckHeartbeat.js';

// POST /api/update-check — 更新チェックの結末を **サーバ側に残す** 経路(RECORD-ONLY)。
//
// ■ なぜフロントから POST させるのか(経路の理由。消すとまた無音に戻る)
//   更新チェックは Tauri の updater プラグインが webview 側で行う。サーバは
//   「アプリが何と言ったか」を知る手段を持たない。逆に webview は HTTP ステータスを
//   取れない(プラグインは成否しか返さない)。**両方を1件に並べる**には、
//   画面が判定を投げ、サーバが受けて自分でも同じ URL を叩くしかない。
//
// ■ この経路は更新の実行に一切関与しない
//   ダウンロード/インストールは従来どおり webview 側(installUpdate)。ここは記録だけ。
//   したがって失敗しても更新は壊れない(そして失敗自体も 500 で声を出す)。

/** フロントが送ってくる形。**未知は黙って既定に倒さず 400 で声を出す**
 *  (倒すと「別の判定で書かれた記録」が正しい顔で残る = 最悪の壊れ方)。 */
export interface UpdateCheckReport {
  source: UpdateCheckSource;
  verdict: UpdateCheckVerdict;
  pluginVersion: string | null;
  message: string | null;
  clientVersion: string | null;
}

export type ParseUpdateCheckResult =
  | { ok: true; report: UpdateCheckReport }
  | { ok: false; error: string };

const SOURCES: readonly string[] = ['startup', 'settings'];
const VERDICTS: readonly string[] = ['available', 'latest', 'error', 'unsupported'];

/** 文字列項目の正規化。長すぎる値を meta に流し込まない(エラー文言は上流の生文なので上限を掛ける)。 */
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s.slice(0, max);
}

export function parseUpdateCheckRequest(body: unknown): ParseUpdateCheckResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body が JSON オブジェクトではありません' };
  const b = body as Record<string, unknown>;
  const source = b.source;
  if (typeof source !== 'string' || !SOURCES.includes(source)) {
    return { ok: false, error: `source は ${SOURCES.join(' | ')} のみ(受信: ${typeof source === 'string' ? source.slice(0, 32) : typeof source})` };
  }
  const verdict = b.verdict;
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict)) {
    return { ok: false, error: `verdict は ${VERDICTS.join(' | ')} のみ(受信: ${typeof verdict === 'string' ? verdict.slice(0, 32) : typeof verdict})` };
  }
  return {
    ok: true,
    report: {
      source: source as UpdateCheckSource,
      verdict: verdict as UpdateCheckVerdict,
      pluginVersion: str(b.pluginVersion, 64),
      message: str(b.message, 500),
      clientVersion: str(b.clientVersion, 64),
    },
  };
}

/** 記録の本体(HTTP から切り離した形)。テストが実ファイル SQLite で直接叩ける。
 *  ★probe は必ず走らせる(ここが今回取れなかった証拠)。probe が失敗しても記録は残す。 */
export async function recordUpdateCheck(
  report: UpdateCheckReport,
  opts: {
    now?: number;
    dbPath?: string;
    endpoint?: string;
    probe?: (url: string) => Promise<UpdaterProbe>;
    appVersion?: string;
    log?: (line: string) => void;
    warn?: (line: string) => void;
  } = {},
): Promise<{ status: string; mismatch: boolean; probe: UpdaterProbe | null }> {
  const now = opts.now ?? Date.now();
  const variant = resolveVariant();
  const endpoint = opts.endpoint ?? resolveUpdaterEndpoint();
  // ★verdict='unsupported'(開発ブラウザ = Tauri 外)では更新チェック自体が走っていない。
  //   probe は「画面の判定と配信側を突き合わせる」ためのものなので、突き合わせる相手が
  //   無い以上ここで叩くのは **判定に使わない外向き通信**(ページを開くたび GitHub へ1回)。
  //   記録そのものは残す(開発ブラウザだったことが分かるのは有用)が、通信はしない。
  const probe = report.verdict === 'unsupported'
    ? null
    : await (opts.probe ?? (url => probeUpdaterEndpoint(url)))(endpoint);

  const hb = buildUpdateCheckHeartbeat({
    now,
    source: report.source,
    appVersion: opts.appVersion ?? APP_VERSION,
    clientVersion: report.clientVersion,
    variant,
    verdict: report.verdict,
    pluginVersion: report.pluginVersion,
    message: report.message,
    probe,
  });
  const status = formatUpdateCheckStatus(hb);

  // ★出力先は2つとも: serverlog(console 経由)と meta。片方だけだと片方の書き出しから消える。
  const log = opts.log ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.warn(l));
  const line = `[update-check] ${status}`;
  if (hb.mismatch || hb.verdict === 'error') warn(line); else log(line);

  const db = openDb(opts.dbPath ?? resolveDbPath());
  try {
    writeUpdateCheckHeartbeat(db, hb);
  } finally {
    db.close();
  }
  return { status, mismatch: hb.mismatch, probe };
}

export async function updateCheckHandler(req: Request, res: Response): Promise<void> {
  const parsed = parseUpdateCheckRequest(req.body);
  if (!parsed.ok) {
    res.status(400).json({ ok: false, error: parsed.error });
    return;
  }
  try {
    const r = await recordUpdateCheck(parsed.report);
    res.json({ ok: true, status: r.status, mismatch: r.mismatch, probe: r.probe });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'update-check の記録に失敗';
    console.error(`[update-check] ★記録に失敗: ${msg}`);
    res.status(500).json({ ok: false, error: msg });
  }
}
