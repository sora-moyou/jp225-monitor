// 更新チェックの **サーバ側の裏取り**(RECORD-ONLY・更新の実行には一切関与しない)。
//
// ■ 何のためか(★これは実際に起きた事故)
//   2026-09-09、稼働機の monitor は v0.9.109 のまま、設定の「更新をチェック」が
//   `アプリ: ✅ 最新です (0.9.109)` と表示した。しかし配信側は v0.9.110 が Latest で、
//   **同じ機から curl.exe で同じ URL を叩くと 0.9.110 が返った**(ユーザー実測)。
//   = Tauri の check() が null を返していた。ところが webview 側は失敗も「更新なし」も
//   同じ null に潰しており(web/lib/updater.ts の旧 checkForUpdate)、
//   serverlog にも meta にも **何も残らなかった**。「画面がそう言った」以外の証拠がゼロ。
//
// ■ ★この probe が決定的な証拠になる理由
//   webview 側は Tauri プラグインの結末しか持てない(HTTP ステータスも本文も取れない)。
//   そこでサーバが **同じ URL を自分で叩き**、HTTP ステータスと latest.json の version を
//   同じ1件の記録に並べて置く。すると
//     「アプリは 0.9.109 で最新と言った / サーバから叩くと HTTP 200 で 0.9.111 が返る」
//   が **記録を1行読むだけ** で分かる。次に同じことが起きたとき、推測が要らなくなる。
//
// ■ 副作用を持たない: 失敗しても例外を外に出さない。結末は必ず戻り値に載る
//   (投げると呼び出し側が握りつぶし得る = また無音に戻る)。

/** 同じ URL をサーバから叩いた結果。**成功も失敗も同じ形で残す**。 */
export interface UpdaterProbe {
  url: string;
  /** HTTP 2xx で latest.json の version が読めたか。 */
  ok: boolean;
  /** 応答があれば HTTP ステータス。接続自体に失敗したら null。 */
  httpStatus: number | null;
  /** latest.json の "version"。読めなければ null。 */
  version: string | null;
  /** 失敗の理由(人が読む文)。成功なら null。**消さない**(消すと無音に戻る)。 */
  error: string | null;
  /** 所要時間(ms)。遅延で切れているのか即断されたのかを後から読み分けるため。 */
  ms: number;
}

/** 既定のタイムアウト。更新チェックはユーザー操作の裏で走るので長く待たない。 */
export const UPDATER_PROBE_TIMEOUT_MS = 10_000;

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean; status: number; text: () => Promise<string>;
}>;

/**
 * 配信先を1回だけ叩いて `{HTTPステータス, version}` を測る。**投げない**。
 * fetchImpl はテストで差し替えるためだけの口(本番は global fetch)。
 */
export async function probeUpdaterEndpoint(
  url: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; now?: () => number } = {},
): Promise<UpdaterProbe> {
  const now = opts.now ?? Date.now;
  const started = now();
  const base = (extra: Partial<UpdaterProbe>): UpdaterProbe => ({
    url, ok: false, httpStatus: null, version: null, error: null, ms: Math.max(0, now() - started), ...extra,
  });
  const doFetch = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  if (typeof doFetch !== 'function') {
    return base({ error: 'fetch が使えない実行環境' });
  }
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    ctrl = new AbortController();
    timer = setTimeout(() => ctrl?.abort(), opts.timeoutMs ?? UPDATER_PROBE_TIMEOUT_MS);
    const res = await doFetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    const status = typeof res.status === 'number' ? res.status : null;
    if (!res.ok) {
      // ★本文は残さない(GitHub のエラーページが丸ごと meta に入ると読めなくなる)。
      return base({ httpStatus: status, error: `HTTP ${status ?? '?'}` });
    }
    const body = await res.text();
    let version: unknown;
    try {
      version = (JSON.parse(body) as { version?: unknown }).version;
    } catch {
      return base({ httpStatus: status, error: `latest.json が JSON として読めない(${body.length}バイト)` });
    }
    if (typeof version !== 'string' || version === '') {
      return base({ httpStatus: status, error: 'latest.json に version が無い' });
    }
    return base({ ok: true, httpStatus: status, version });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return base({ error: ctrl?.signal.aborted ? `タイムアウト(${opts.timeoutMs ?? UPDATER_PROBE_TIMEOUT_MS}ms): ${msg}` : msg });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** '0.9.110' 形式の版比較。a が b より **新しい** なら true。
 *  ★数値として比べる(文字列比較だと '0.9.9' > '0.9.110' になる)。
 *  数字以外が混じる(rc 等)場合は、読めた数値部分までで比べる。 */
export function isNewerVersion(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const parts = (s: string): number[] => s.split(/[.\-+]/).map(x => Number.parseInt(x, 10)).map(n => Number.isFinite(n) ? n : 0);
  const pa = parts(a), pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
