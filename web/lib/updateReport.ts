// 更新チェックの結末を **ローカルサーバへ送って記録させる**(表示は一切変えない)。
//
// ■ なぜフロントから送るのか
//   更新チェックは Tauri の updater プラグインが webview 側で走る。サーバは
//   「アプリが何と言ったか」を知る手段が無い。2026-09-09 の事故(画面は
//   `✅ 最新です (0.9.109)` と言ったが、配信側は 0.9.110・curl では取れた)で
//   証拠が1つも残らなかったのは、この結末がプロセスの外へ出ていなかったから。
//   → 判定を投げれば、サーバが受けて **自分でも同じ URL を叩き**、HTTP ステータスと
//     latest.json の version を同じ1件に並べて meta と serverlog に残す
//     (server/routes/updateCheck.ts)。
//
// ■ ★呼ぶ場所は2つとも(片方だけにしない)
//   ①起動時のトースト経路(web/components/updateToast.ts)
//   ②設定の「更新をチェック」ボタン(web/components/settings/update.ts)
//
// ■ 送信失敗はここで console に出して終わる(サーバに届かないなら記録のしようがない)。
//   ただし **黙って return しない**: 何も起きていないことと、送れなかったことを区別する。
//
// ■ ★記録が本体(更新の通知)を止めない(v0.9.111 の差し戻しで判明した欠陥)
//   起動時トーストは `await reportUpdateCheck(...)` で待っていたため、**解決しない fetch**
//   (サーバが受けたまま応答しない・プロキシで吊られる等)を食わせると 5 秒経ってもトーストが
//   出なかった(実測)。記録は監視の道具であって、更新の通知より優先されてはならない。
//   → 二重に守る:
//     ①呼び出し側は待たない(updateToast.ts は設定経路と同じく `void` で撃つ)。
//     ②この関数自身が REPORT_TIMEOUT_MS で必ず決着する。①だけだと解決しない fetch が
//       ページに溜まり続け、将来 `await` する呼び出しが増えた瞬間に同じ欠陥が戻る。

import { apiUrl } from './apiBase.js';
import type { UpdateStatus } from './updater.js';

export type UpdateCheckSource = 'startup' | 'settings';

/**
 * 記録の送信を諦めるまで。
 *
 * ★**サーバ側の probe 予算(server/updater/probe.ts の UPDATER_PROBE_TIMEOUT_MS = 10000)より
 *   必ず長くする**。サーバはこの POST を受けてから GitHub を最大10秒叩き、そのあと DB に書いて
 *   応答する。ここを 10 秒より短くすると、**正常に完走している応答を待ちきれずに中断**し、
 *   クライアントだけが「失敗した」と思い込む(記録は成立しているのに)。
 *   実測(差し戻し3周目): 5000 のとき probe が 7 秒かかると、クライアントは AbortError で
 *   「送れなかった」と出しつつ、meta には正しい記録が入っていた = **ログが嘘をついた**。
 *   この版はまさに「取得成功なのに失敗と書くログ」で原因にたどり着けなかった事故の後始末なので、
 *   同じ形を新しく作らない。
 *
 * 余裕分(10秒)は probe 以外(DB 書き込み・応答)のぶん。呼び出し側は `void` で撃つので、
 * 長くしても本体(更新の通知)は1ミリ秒も待たない。
 * ★この大小関係は updateReport.test.ts が両方の定数を実際に読んで固定する(コメントだけにしない)。
 */
export const REPORT_TIMEOUT_MS = 20_000;

/** UpdateStatus → サーバが受ける形。**判定の取りこぼしを作らないため switch を網羅する**。 */
export function updateCheckPayload(
  source: UpdateCheckSource, status: UpdateStatus, clientVersion: string | null,
): { source: UpdateCheckSource; verdict: UpdateStatus['state']; pluginVersion: string | null; message: string | null; clientVersion: string | null } {
  return {
    source,
    verdict: status.state,
    pluginVersion: status.state === 'available' ? status.info.version : null,
    message: status.state === 'error' ? status.message : null,
    clientVersion,
  };
}

/** 画面に出ている 'v0.9.110' 形式から 'v' を落とす(未取得/'v?' は null)。 */
export function normalizeDisplayedVersion(text: string | null | undefined): string | null {
  const s = (text ?? '').trim().replace(/^v/i, '');
  return s === '' || s === '?' || s === '…' ? null : s;
}

export async function reportUpdateCheck(
  source: UpdateCheckSource, status: UpdateStatus, displayedVersion?: string | null,
): Promise<void> {
  const body = updateCheckPayload(source, status, normalizeDisplayedVersion(displayedVersion));
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), REPORT_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl('/api/update-check'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    // サーバが応答した = 届いている。拒否/失敗はサーバの結論なのでそのまま書ける。
    if (!res.ok) console.warn(`[updater] 更新チェックの記録がサーバに拒否された: HTTP ${res.status}`);
  } catch (err) {
    // ★ここで「送れなかった」と断定しない。クライアントからは
    //   「届かなかった」のか「届いて記録は成立したが応答を読めなかった」のかを **区別できない**。
    //   区別できないことを、区別できるかのように書かない(それが今回の事故の入口だった)。
    const aborted = err instanceof Error && err.name === 'AbortError';
    console.warn(
      aborted
        ? `[updater] 更新チェックの記録の応答を ${REPORT_TIMEOUT_MS}ms 待てなかった。`
          + '★記録が成立したかはここからは判定できない(サーバ側の meta update_check / serverlog を見ること)'
        : '[updater] 更新チェックの記録でエラー(届いたかどうかはここからは判定できない・上と同じ確認先):',
      aborted ? '' : (err instanceof Error ? err.message : err),
    );
  } finally {
    clearTimeout(timer);
  }
}
