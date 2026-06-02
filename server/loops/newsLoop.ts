import { fetchAllNews } from '../sources/rssAggregator.js';
import { broadcast } from '../sse/broker.js';
import { setNews, getNews } from '../cache.js';
import { resolveNewsPollMs } from '../configStore.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
let intervalMs = resolveNewsPollMs();

async function tick(): Promise<void> {
  try {
    const news = await fetchAllNews();
    // 全フィードが失敗すると fetchAllNews は [] を返す。既存ニュースがあるなら
    // 空で上書きしてボードを消さず、前回分を保持する(一時的なネットワーク失敗対策)。
    if (news.length === 0 && getNews().length > 0) {
      console.warn('[newsLoop] fetched 0 items; keeping previous news');
      return;
    }
    setNews(news);
    broadcast({ type: 'news', payload: news });
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
