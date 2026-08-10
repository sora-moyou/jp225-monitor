import type { NewsItem } from '../../core/types.js';
import { fetchAllNews } from '../sources/rssAggregator.js';
import { inPollWindow } from '../../core/session.js';
import { broadcast } from '../sse/broker.js';
import { setNews, getNews } from '../cache.js';
import { resolveNewsPollMs, resolveNewsOffHoursEnabled } from '../configStore.js';
import { persistNews, attachStoredConfidence } from '../newsPersist.js';
import { attachStoredTranslations, translatePass, applyTranslations } from '../newsTranslate.js';

/** 訳せた分を cache と画面へ反映する(失敗しても何も壊さない)。 */
async function runTranslatePass(items: NewsItem[]): Promise<void> {
  try {
    const { updates } = await translatePass(items);
    if (updates.size === 0) return;
    // ★再取得を待たずに画面を更新する。この間に次の取得が走っていた場合は
    //   cache 側(= 最新)に対して当て直す(古い配列で上書きして新着を消さない)。
    const merged = applyTranslations(getNews(), updates);
    setNews(merged);
    broadcast({ type: 'news', payload: merged });
  } catch (err) {
    console.warn('[newsLoop] translate pass failed:', err instanceof Error ? err.message : err);
  }
}

// ─── 取引時間外の取得間隔 ─────────────────────────────────────────────────
// ★**15分 固定(ユーザー指示・2026-08-10)**。設定にはしていないので、勝手に短くしないこと。
//   理由: 取引時間外(週末 + 6:10-8:40 / 15:55-16:55 の谷間)は 1週あたり 65.5時間ある。
//   ここを場中と同じ 60秒で叩くと配信元への要求が週 3,930 tick 増える。
//   ★1 tick = **31 リクエスト**(RSS 26 + nikkei225jp 3 + minkabu 米指標 2・宛先ホストは 23種)。
//   15分なら週 263 tick(平日は +14/日・丸1日が時間外の週末で 96/日)で、場中の負荷に対して十分に小さい。
//   ★取引時間内は従来どおり resolveNewsPollMs()(既定60秒)。ここは 1ミリも変えない。
export const NEWS_OFF_HOURS_POLL_MS = 15 * 60_000;

const MINUTE_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
let intervalMs = resolveNewsPollMs();

/** この時刻に取得してよいか。時間外は設定(既定OFF)が true のときだけ取りに行く。 */
export function newsShouldFetch(now: number, offHoursEnabled: boolean): boolean {
  return inPollWindow(now) || offHoursEnabled;
}

/**
 * 「窓が開くまでの残り時間」[ms]。**15分より先は探索しない**(見つからなければ null)。
 *
 * ★上限を切る理由: 週末・年末年始・BCP休場は窓が開くまで 50時間以上ある。前方探索に上限が無いと
 *   休場を跨ぐたびに何千回も判定を回す(しかも答えは使わない=常に 15分にクランプされる)。
 *   必要なのは「15分以内に開くか」だけなので、15分ぶんだけ見る。
 * ★1分刻みで足りる根拠: セッション境界(8:45/15:45/17:00/6:00)も inPollWindow のマージン(5分/10分)も
 *   すべて **JST の分ちょうど** で、JST=UTC+9(時差が整数時間)なので epoch の分境界とも一致する
 *   (core/session.ts の jstParts は分粒度で判定する)。だから遷移は必ず分境界に起きる。
 */
export function msUntilPollWindowOpens(now: number, limitMs = NEWS_OFF_HOURS_POLL_MS): number | null {
  // 直後の「分ちょうど」から見る(now 自身が窓外なのは呼び出し側が確認済み)。
  for (let t = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS; t <= now + limitMs; t += MINUTE_MS) {
    if (inPollWindow(t)) return t - now;
  }
  return null;
}

/**
 * 次の tick までの待ち時間[ms](純関数)。
 *  - offHoursEnabled=false(既定) … **常に inHoursMs**。= 現行と 1ミリも変わらない。
 *  - 取引時間内 … inHoursMs(=resolveNewsPollMs・既定60秒)。
 *  - 取引時間外 … **min(15分, 窓が開くまでの残り)**。
 *
 * ★なぜ「窓が開くまでの残り」で頭を打つか:
 *   inPollWindow の先行マージンは5分しかないので、素直に 15分待つと窓が開いてから最大14分
 *   何も取りに行かない時間ができる = **ON にした方が寄り付きのニュースが古い**という逆転が起きる
 *   (オプションを入れたのに悪くなる = 無言の劣化)。窓が開く瞬間に起きれば逆転は消え、
 *   しかも余分な tick は **開場あたり1回だけ**で「時間外は15分」の約束を1ミリも破らない。
 */
export function newsNextDelayMs(now: number, inHoursMs: number, offHoursEnabled: boolean): number {
  if (!offHoursEnabled) return inHoursMs;
  if (inPollWindow(now)) return inHoursMs;
  return msUntilPollWindowOpens(now) ?? NEWS_OFF_HOURS_POLL_MS;
}

/** 時間外取得の設定。★読めなくても **ループを殺さない**: 既定(OFF=現行挙動)に倒して理由を残す。 */
function offHoursEnabledSafe(): boolean {
  try {
    return resolveNewsOffHoursEnabled();
  } catch (err) {
    console.warn('[newsLoop] 時間外取得の設定を読めませんでした(既定=OFF で継続):', err instanceof Error ? err.message : err);
    return false;
  }
}

/** 次の待ち[ms]。★ここで投げると再武装できずループが静かに死ぬので、必ず値を返す。 */
function nextDelayMsSafe(): number {
  try {
    return newsNextDelayMs(Date.now(), intervalMs, offHoursEnabledSafe());
  } catch (err) {
    console.warn('[newsLoop] 次の待ちを決められませんでした(場中の間隔で継続):', err instanceof Error ? err.message : err);
    return intervalMs;
  }
}

async function tick(): Promise<void> {
  // 取引時間外は何もしない(軽量化)。★設定 newsOffHoursEnabled が true のときだけ時間外も取得する。
  if (!newsShouldFetch(Date.now(), offHoursEnabledSafe())) return;
  try {
    const news = await fetchAllNews();
    // 全フィードが失敗すると fetchAllNews は [] を返す。既存ニュースがあるなら
    // 空で上書きしてボードを消さず、前回分を保持する(一時的なネットワーク失敗対策)。
    if (news.length === 0 && getNews().length > 0) {
      console.warn('[newsLoop] fetched 0 items; keeping previous news');
      return;
    }
    // ★保存済みの訳文を先に載せる。既知の記事はここで訳付きになり、LLM を一度も呼ばない。
    // ★確度も保存済みを載せ直す。判定は直近200件しか見ないので、裏取り相手が窓から出ると
    //   「確認済み → 未確認」と逆行してしまう。過去に確認済みだった事実は取り消さない。
    const withStored = attachStoredConfidence(attachStoredTranslations(news));
    setNews(withStored);
    // ★DB へ記録(best-effort・例外は投げない)。記録の失敗が表示の停止に化けないよう、
    //   broadcast より前でも後でもよいが、表示を最優先にしたいので配信の後に行う。
    broadcast({ type: 'news', payload: withStored });
    persistNews(withStored);
    // ★翻訳は **取得と表示をブロックしない**。await せず、訳せた分だけ後から追いつかせる
    //   (LLM が落ちていても、上の broadcast で原文のニュースは既に画面へ出ている)。
    void runTranslatePass(withStored);
  } catch (err) {
    console.error('[newsLoop] error:', err instanceof Error ? err.message : err);
  }
}

function schedule(): void {
  if (!running) return;
  void (async () => {
    // ★再武装(setTimeout)は **何があっても走らせる**。ここを素通りするとタイマーが再設定されず、
    //   newsLoop が例外1回で永久に静かに死ぬ(無言の失敗)。tick 内の try/catch とは別に、
    //   ゲート(設定読み)や時計まで含めた外側を finally で囲って再武装を保証する。
    try {
      await tick();
    } catch (err) {
      console.error('[newsLoop] tick threw:', err instanceof Error ? err.message : err);
    } finally {
      if (running) {
        // ★設定は毎回読み直す(loadConfig は mtime キャッシュなので安い)= 保存した瞬間から
        //   次の tick で効く(restart 不要)。長い時間外待機の最中に変えた分は、その待機が明けてから効く。
        timer = setTimeout(schedule, nextDelayMsSafe());
      }
    }
  })();
}

export function startNewsLoop(): void {
  if (running) return;
  running = true;
  intervalMs = resolveNewsPollMs();
  schedule();
}

export function stopNewsLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

export function restartNewsLoop(): void {
  stopNewsLoop();
  startNewsLoop();
}
