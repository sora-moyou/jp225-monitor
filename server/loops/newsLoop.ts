import type { NewsItem } from '../../core/types.js';
import { fetchAllNews } from '../sources/rssAggregator.js';
import { inPollWindow } from '../../core/session.js';
import { broadcast } from '../sse/broker.js';
import { setNews, getNews } from '../cache.js';
import { resolveNewsPollMs } from '../configStore.js';
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

let timer: NodeJS.Timeout | null = null;
let running = false;
let intervalMs = resolveNewsPollMs();

async function tick(): Promise<void> {
  if (!inPollWindow(Date.now())) return;   // 取引時間外は何もしない(軽量化)
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
    await tick();
    if (running) {
      timer = setTimeout(schedule, intervalMs);
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
