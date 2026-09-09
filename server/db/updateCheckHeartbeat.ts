// 更新チェックの **結末の記録**(RECORD-ONLY・更新の実行には一切関与しない)。
//
// ■ 何のためか(★これは実際に起きた事故 — 2026-09-09)
//   稼働機の monitor が v0.9.109 のまま止まっていた。設定 →「更新をチェック」を押すと
//   `アプリ: ✅ 最新です (0.9.109)` と出た。配信側は両リポとも v0.9.110 が Latest で、
//   **同じ機から curl.exe で同じ URL を叩くと 0.9.110 が返った**(ユーザー実測)。
//   = Tauri の check() が null を返していた。ところが更新チェックは webview 側で走り、
//   失敗は web/lib/updater.ts が console.warn に書いて null を返すだけだったので、
//   **serverlog にも meta にも何も残らなかった**。証拠が「画面がそう言った」しか無く、
//   原因を特定できなかった。v0.9.110 で直した価格フィードの事故と **同じ形**(宣言だけ残って根拠が残らない)。
//
// ■ ★どこに載せるか = 共有DB(jp225.db)の meta テーブル
//   既存の `tick_archive_status`(server/db/tickArchiveHeartbeat.ts)/ `price_feed_status`
//   (server/db/priceFeedHeartbeat.ts)/ `ledger_export_status`(server/db/ledgerExport.ts)と
//   **同じ置き場・同じ流儀**。新しい配管を1つも増やさない。meta は trade2 の 30分ごとの
//   `VACUUM INTO`(prices_<host>.db)にそのまま乗るので、**既存の書き出しに自動で乗り**、
//   別PCからでも「あのとき更新チェックが何と言ったか」が後から読める。
//
// ■ ★これは定期ハートビートではない = 「イベントの記録」
//   価格フィードやティック保管と違い、更新チェックは **押したとき / 起動時にしか起きない**。
//   したがって「値が古い」ことは異常ではない(押していないだけ)。読み手が
//   「古い=壊れている」と誤読しないよう、describeUpdateCheck() は鮮度で赤にせず
//   **いつの1件かを必ず添える**。ここが他の3つと違う唯一の点。
//
// ■ ★決定的な列 = サーバ自身が同じ URL を叩いた結果(probe)
//   webview は Tauri プラグインの結末しか持てない(HTTP ステータスが取れない)。
//   サーバの probe を同じ1件に並べて置くことで
//     「アプリは 0.9.109 で最新と言った / サーバから叩くと HTTP 200 で 0.9.111 が返る」
//   という **食い違いが1行で読める**。これが今回取れなかった証拠そのもの。

import type { DatabaseSync } from 'node:sqlite';
import type { MonitorVariant } from '../variant.js';
import { getMeta, setMeta } from './store.js';
import { jstStamp, fmtDur } from './tickArchiveHeartbeat.js';
import { isNewerVersion, type UpdaterProbe } from '../updater/probe.js';

/** 共有DB(jp225.db)meta のキー。JSON 本体と、人が読む1行の2本(他の3つと同じ作法)。 */
export const UPDATE_CHECK_KEY = 'update_check';
export const UPDATE_CHECK_STATUS_KEY = 'update_check_status';

/** 画面(Tauri の updater プラグイン)が出した判定。web/lib/updater.ts の UpdateStatus と同じ語彙。 */
export type UpdateCheckVerdict = 'available' | 'latest' | 'error' | 'unsupported';

/** どこから呼ばれたか。**両方から呼ぶ**(片方だけだと起動時の無音が残る)。 */
export type UpdateCheckSource = 'startup' | 'settings';

export interface UpdateCheckHeartbeat {
  v: 1;
  /** この記録を書いた時刻。 */
  at: number;
  atJst: string;
  /** 'startup'=起動時のトースト経路 / 'settings'=設定の「更新をチェック」ボタン。 */
  source: UpdateCheckSource;
  /** ★いま動いているアプリの版(サーバの APP_VERSION = 実体)。 */
  appVersion: string;
  /** 画面が名乗った版(/api/version の表示値)。実体と食い違ったらそれ自体が手がかり。 */
  clientVersion: string | null;
  variant: MonitorVariant;
  /** 画面の判定。 */
  verdict: UpdateCheckVerdict;
  /** Tauri プラグインが返した版(verdict='available' のときだけ)。 */
  pluginVersion: string | null;
  /** verdict='error' のときのエラー文言。**消さない**。 */
  message: string | null;
  /** ★サーバ自身が同じ URL を叩いた結果。
   *  null = **未実施**。verdict='unsupported'(開発ブラウザ = Tauri 外)のときは更新チェック自体が
   *  走っていないので、判定に使わない外向き通信を出さない(ページを開くたび GitHub を叩かない)。
   *  ★「叩いて失敗した(ok=false)」と「叩いていない(null)」を同じ値にしない。 */
  probe: UpdaterProbe | null;
  /** ★食い違い: アプリは「更新なし/失敗」なのに、サーバから叩くと **より新しい版** が返る。 */
  mismatch: boolean;
  reason: string;
}

/** 1行の先頭ラベル。★state をそのまま大文字にしない(読み手が取り違える形を残さない)。 */
const VERDICT_LABEL: Record<UpdateCheckVerdict, string> = {
  available: 'UPDATE-AVAILABLE',   // 画面が更新を見つけた
  latest: 'LATEST',                // 画面が「最新」と言った
  error: 'CHECK-FAILED',           // 画面のチェックが失敗した(理由あり)
  unsupported: 'NOT-TAURI',        // 開発モード(パッケージ版でない)= チェックが走らないのが正常
};

export interface BuildUpdateCheckInput {
  now: number;
  source: UpdateCheckSource;
  appVersion: string;
  clientVersion: string | null;
  variant: MonitorVariant;
  verdict: UpdateCheckVerdict;
  pluginVersion: string | null;
  message: string | null;
  probe: UpdaterProbe | null;
}

/** 記録を組み立てる純関数(DB に触らない)。判定はここにしか無い。 */
export function buildUpdateCheckHeartbeat(input: BuildUpdateCheckInput): UpdateCheckHeartbeat {
  const { now, verdict, appVersion, probe, pluginVersion } = input;

  // ★食い違いの定義: 画面が「更新なし」または「失敗」と言ったのに、サーバから叩くと
  //   実行中の版より **新しい** 版が返る。= 2026-09-09 に起きた形そのもの。
  //   'available' のときは画面も気づいているので食い違いではない(ただし版のズレは reason に出す)。
  const serverHasNewer = !!probe && probe.ok && isNewerVersion(probe.version, appVersion);
  const mismatch = serverHasNewer && (verdict === 'latest' || verdict === 'error');

  let reason: string;
  if (mismatch) {
    reason = `★食い違い: アプリは「${verdict === 'latest' ? `最新(${appVersion})` : `確認失敗(${input.message ?? '理由不明'})`}」`
      + `と言ったが、サーバから同じ URL を叩くと ${probe.version} が返る`
      + '(= Tauri の check() が更新を見落としている。ネットワークではない)';
  } else if (verdict === 'available') {
    reason = `更新あり: ${appVersion} → ${pluginVersion ?? '?'}`
      + (probe?.ok && probe.version !== pluginVersion ? `(★配信側は ${probe.version} = プラグインの版と違う)` : '');
  } else if (verdict === 'latest') {
    // ★「一致」と書けるのは実際に等しいときだけ(ここは実測で一度嘘をついた:
    //   app=0.9.111 / 配信側=0.9.110 でも「配信側も 0.9.110 で一致」と書いていた)。
    reason = !probe?.ok
      ? `最新(${appVersion})。ただし★サーバからは配信先を確認できなかった(${probe?.error ?? '理由不明'})`
        + ' = この「最新」は裏が取れていない'
      : probe.version === appVersion
        ? `最新(${appVersion})。サーバから叩いた配信側も ${probe.version} で一致`
        : `最新(${appVersion})。★配信側は ${probe.version} = 実行中のほうが新しい`
          + '(未公開ビルド/ロールバック直後などで起こる。更新チェックの結論としては矛盾しない)';
  } else if (verdict === 'error') {
    reason = `画面のチェックが失敗: ${input.message ?? '理由不明'}`
      + (probe?.ok
        ? `。★ただしサーバからは同じ URL に届いている(HTTP ${probe.httpStatus} / ${probe.version}) = ネットワークではない`
        : `。サーバからも届かない(${probe?.error ?? '理由不明'}) = ネットワーク側の疑い`);
  } else {
    reason = '開発モード(パッケージ版でない)のため更新チェックは走らない = 正常'
      + '(判定に使わないので配信先も叩いていない)';
  }

  return {
    v: 1, at: now, atJst: jstStamp(now),
    source: input.source,
    appVersion, clientVersion: input.clientVersion, variant: input.variant,
    verdict, pluginVersion, message: input.message,
    probe, mismatch, reason,
  };
}

/** probe の所要時間。★fmtDur は秒丸めなので 312ms が '0s' になり「測っていない」ように読める。
 *  1秒未満はミリ秒のまま出す(遅延で切れたのか即答だったのかを後から読み分けるため)。 */
function probeDur(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : fmtDur(ms);
}

/** 人が読む1行(meta の update_check_status / serverlog に出る行)。
 *  JSON と同じ構造体から **この関数だけ** で作るので、2つの表現が食い違うことはない。 */
export function formatUpdateCheckStatus(hb: UpdateCheckHeartbeat): string {
  const label = hb.mismatch ? `★MISMATCH(${VERDICT_LABEL[hb.verdict]})` : VERDICT_LABEL[hb.verdict];
  const probe = hb.probe === null
    // ★「叩いていない」を「失敗」と書かない。読み手が原因を取り違える形を残さない。
    ? 'probe=未実施(Tauri 外なので配信先を叩いていない)'
    : hb.probe.ok
      ? `probe=HTTP ${hb.probe.httpStatus} version=${hb.probe.version} (${probeDur(hb.probe.ms)})`
      : `probe=失敗 ${hb.probe.httpStatus == null ? '' : `HTTP ${hb.probe.httpStatus} `}${hb.probe.error ?? '理由不明'} (${probeDur(hb.probe.ms)})`;
  const client = hb.clientVersion && hb.clientVersion !== hb.appVersion
    ? ` 画面表示=${hb.clientVersion}(★実体と不一致)` : '';
  return [
    `${label} ${hb.atJst} JST`,
    hb.reason,
    `source=${hb.source} variant=${hb.variant} app=${hb.appVersion}${client}`
      + (hb.pluginVersion ? ` plugin=${hb.pluginVersion}` : ''),
    hb.probe === null ? probe : `${probe} ${hb.probe.url}`,
  ].join(' | ');
}

/** 記録を共有DB(jp225.db)の meta に書く。書いた記録を返す。 */
export function writeUpdateCheckHeartbeat(sharedDb: DatabaseSync, hb: UpdateCheckHeartbeat): UpdateCheckHeartbeat {
  setMeta(sharedDb, UPDATE_CHECK_KEY, JSON.stringify(hb));
  setMeta(sharedDb, UPDATE_CHECK_STATUS_KEY, formatUpdateCheckStatus(hb));
  return hb;
}

export function readUpdateCheckHeartbeat(sharedDb: DatabaseSync): UpdateCheckHeartbeat | null {
  const raw = getMeta(sharedDb, UPDATE_CHECK_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as UpdateCheckHeartbeat;
    return (v && typeof v.at === 'number' && (v.probe === null || typeof v.probe?.url === 'string')) ? v : null;
  } catch {
    return null;   // 壊れた値は「無い」扱い(次の記録で上書きされる)
  }
}

/** 読み手側(スナップショットを開いた人)。
 *  ★他の3つと違い **鮮度で赤にしない**: 更新チェックは押したときしか起きないので、
 *    古いのは異常ではない。代わりに「いつの1件か」を必ず添えて、現在の状態と誤読させない。 */
export function describeUpdateCheck(hb: UpdateCheckHeartbeat | null, now: number): string {
  if (!hb) {
    return 'MISSING 更新チェックの記録が無い(一度もチェックしていない/記録を持たない古い版で動いている)';
  }
  return `${formatUpdateCheckStatus(hb)} | ※これは${fmtDur(Math.max(0, now - hb.at))}前の1件(更新チェックは押したときだけ起きる)`;
}
