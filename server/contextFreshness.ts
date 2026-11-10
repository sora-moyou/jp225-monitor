// ★文脈の「鮮度」判定の唯一の置き場所(AI チャットと取引系=仮想取引の計画・エンジンの再武装が同じ判定を使う)。
//
// ■ なぜ要るか(2026-10-28〜11-10 の実例)
//   collector が止まり ticks が 10/28 05:59 のまま。levelsLoop は古いティック(64,395)を基準に重要価格を
//   計算し続け、AI チャットにも仮想取引の計画にも、ライブ現値 61,0xx と並んで渡っていた。
//   v0.9.114 でチャットだけ止めた。取引系も **同じ判定** で止める(判定を2つに複製しない)。
//
// ■ ★ここに置くのは判定と、止まっている事実を書く文言だけ。止めたときに何を落とすかは各読み手が決める。

import { classifySession, sessionOpenMs, prevSessionCloseMs } from '../core/session.js';
import { isHeartbeatFresh } from './collectorHeartbeat.js';
import { DETECT_FRESH_MS } from './detect/registry.js';
import type { LevelsResult } from './levels.js';
import type { SessionOHLC } from './db/store.js';

/** MM/DD HH:MM(JST)。止まった時刻を AI と人に読ませる用。 */
export function fmtJstMinute(t: number): string {
  const d = new Date(t + 9 * 3600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** ★重要価格が「古いティックから作られている」か(純関数)。古ければ最終ティックの時刻、そうでなければ null。
 *
 *  ■ 判定(立会中のみ。時間外は判定しない=引け後・週末はティックが来ないのが正常)
 *   ・最終ティックが今のセッション内 → `now − latestTickAt > DETECT_FRESH_MS` で古い。
 *   ・最終ティックが寄りより前 → ★それが **直前のセッションの終わり際**(その引けの DETECT_FRESH_MS 以内)まで
 *     届いているときだけ、寄りから DETECT_FRESH_MS は「前のセッションの最後の価格」を正当とみなす。
 *     届いていなければ(何時間・何日も前で止まっている)寄りの瞬間から古い。
 *   ・latestTickAt が無い(古いペイロード/未計算)は判定できないので従来どおり。
 *
 *  ■ なぜ2段か(エバリュエーター実測の2つの欠陥)
 *   ① 08:45:00 / 17:00:00 で立会中になった瞬間、新しいティックが届いて levelsLoop(8秒周期)が回るまで
 *      latestTickAt は前のセッションの最後(06:00 / 15:44:59)のまま。これを「収集停止中」と取り違えると、
 *      寄り直後の計画(実測: 寄り+0.3〜4.7秒に62件)から重要価格が消えた。
 *   ② 逆に寄りの猶予を無条件に与えると、本当に止まっているとき(10/27: collector は 08:01 に死亡、
 *      818A/819B=最終ティックから約9,900秒・878A/879B=約39,600秒)も寄りから90秒は古い数値が渡った。
 *   ★寄り・直前の引けの時刻は core/session.ts(sessionOpenMs / prevSessionCloseMs)から取る
 *     (祝日・週末・夜間の日付またぎは既存の分類に従う。時刻を自前で書かない)。
 *
 *  ■ ★inPollWindow ではなく立会中(classifySession が非 null)で判定する理由
 *   ticks 表は collector/record.ts が classifySession で **場外ティックを捨てて** 書く。
 *   inPollWindow は寄り5分前〜引け10分後まで true なので、その帯では collector が健全でも
 *   ティックは書かれず「古い」と判定してしまう(=引け後10分間「収集停止中」と誤報する)。 */
export function staleLevelsTickAt(r: LevelsResult | null | undefined, now: number): number | null {
  if (!r || r.latestTickAt === undefined) return null;
  const open = sessionOpenMs(now);
  if (open === null) return null;   // 立会外
  const t = r.latestTickAt;
  let ref = t;
  if (t < open) {
    const prevClose = prevSessionCloseMs(open);
    // 健全な寄り待ち = 直前のセッションの末尾まで届いている **かつ collector が生きている**(心拍が新しい)。
    //   ★818A/819B(10/27 08:45): 最終ティックは直前の夜間の末尾(05:59:58)だが collector は 08:01 に死んでいた。
    //     ティックだけでは健全な寄り待ちと区別できないので心拍で見る。読めない心拍は猶予を認めない。
    if (prevClose !== null && t <= prevClose && prevClose - t <= DETECT_FRESH_MS
      && isHeartbeatFresh(r.collectorHeartbeatAt, now)) ref = open;
  }
  return now - ref > DETECT_FRESH_MS ? t : null;
}

/** 古ければ null(=「重要価格が無い」と同じ扱い)、新しければ **同じ参照** をそのまま返す。
 *  ★通常時に別のオブジェクトを作らない(読み手の判定を1バイトも変えないため)。 */
export function freshLevelsOrNull<T extends LevelsResult>(r: T | null | undefined, now: number): T | null {
  if (!r) return r ?? null;
  return staleLevelsTickAt(r, now) === null ? r : null;
}

/** 止まっている事実の1行(チャット/取引系で文言の趣旨を揃える)。 */
export function staleLevelsNote(tickAt: number): string {
  return `収集停止中のため算出できません(最終ティック ${fmtJstMinute(tickAt)} JST)`;
}

/** 現在のセッションの足がこれより古ければ「以降の足なし」とみなす。足は collector が毎ティック upsert するので、
 *  健全なら最終足の t(分の頭)は 60秒+数秒以内に収まる。90秒(DETECT_FRESH_MS)+1分足の幅で 3分。 */
export const SESSION_BAR_STALE_MS = 3 * 60_000;

/** セッション OHLC を「本日高安/本日の日経」としてそのまま出してよいか。
 *  ・asIs          … そのまま出す(従来どおり)
 *  ・staleBars     … 今のセッションの OHLC だが、最終足が SESSION_BAR_STALE_MS より古い(収集停止)
 *  ・staleSession  … 最新のセッション OHLC が今のセッションでも「健全に終わった直前のセッション」でもない
 *                    (収集停止で古いセッションが残っている) */
export type SessionFreshness = 'asIs' | 'staleBars' | 'staleSession';

/** s が「直前に引けたセッション」で、その最終足が引けの近く(SESSION_BAR_STALE_MS 以内)まであるか。 */
function endedHealthily(s: SessionOHLC, closeMs: number | null, lastBarT: number | null): boolean {
  if (closeMs === null || lastBarT === null) return false;
  const prev = classifySession(closeMs - 1);
  if (!prev || prev.sessionDate !== s.sessionDate || prev.session !== s.session) return false;
  return lastBarT <= closeMs && closeMs - lastBarT <= SESSION_BAR_STALE_MS;
}

/** ★「本当に収集が止まっている」ときだけ asIs 以外を返す(純関数)。
 *  ・立会外: 最新セッションが **直前に引けたセッション** で、末尾まで足があれば asIs(引け後・週末に直近セッションが
 *    残っているのは正常)。それより古ければ staleSession(数日前のセッションを「本日」と書かない)。
 *  ・立会中・今のセッションの OHLC: 最終足(寄りの時刻と比べて新しい方)が SESSION_BAR_STALE_MS より古ければ staleBars。
 *  ・立会中・今のセッションではない: 寄りから SESSION_BAR_STALE_MS 以内で、かつ直前のセッションが末尾まで足を
 *    持って終わっているときだけ asIs(新しい足がまだ無いのは正常)。それ以外は staleSession。
 *  ★寄り・直前の引けの時刻は core/session.ts から取る。 */
export function sessionFreshness(
  s: SessionOHLC, now: number, lastBarT: number | null, heartbeatAt: number | null | undefined = null,
): SessionFreshness {
  const open = sessionOpenMs(now);
  if (open === null) {
    if (lastBarT === null) return 'asIs';   // 判定材料が無い(DB 無し等)
    return endedHealthily(s, prevSessionCloseMs(now), lastBarT) ? 'asIs' : 'staleSession';
  }
  const cs = classifySession(now);
  const isCurrent = cs !== null && cs.sessionDate === s.sessionDate && cs.session === s.session;
  if (isCurrent) {
    if (lastBarT === null) return 'asIs';
    return now - Math.max(lastBarT, open) > SESSION_BAR_STALE_MS ? 'staleBars' : 'asIs';
  }
  // 寄りの猶予: 直前のセッションが末尾まで足を持って終わっている **かつ collector が生きている** ときだけ。
  //   ★心拍は「寄りの猶予」だけに使う。立会外には使わない: 引けたセッションの OHLC が完全かどうかは
  //     「末尾まで足があるか」で決まり、引けの後に collector が死んでも、その完結したセッションの値は正しい。
  if (now - open <= SESSION_BAR_STALE_MS && endedHealthily(s, prevSessionCloseMs(open), lastBarT)
    && isHeartbeatFresh(heartbeatAt, now)) return 'asIs';
  return 'staleSession';
}
