import { fetchAllNews } from '../sources/rssAggregator.js';
import { broadcast } from '../sse/broker.js';
import { setNews } from '../cache.js';
import { NEWS_POLL_INTERVAL_MS } from '../config.js';

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const news = await fetchAllNews();
    setNews(news);
    broadcast({ type: 'news', payload: news });
  } catch (err) {
    console.error('[newsLoop] error:', err instanceof Error ? err.message : err);
  }
}

export function startNewsLoop(): void {
  const schedule = async () => {
    await tick();
    timer = setTimeout(schedule, NEWS_POLL_INTERVAL_MS);
  };
  void schedule();
}

export function stopNewsLoop(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
