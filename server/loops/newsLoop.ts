import { fetchAllNews } from '../sources/rssAggregator.js';
import { broadcast } from '../sse/broker.js';
import { setNews } from '../cache.js';
import { resolveNewsPollMs } from '../configStore.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
let intervalMs = resolveNewsPollMs();

async function tick(): Promise<void> {
  try {
    const news = await fetchAllNews();
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
