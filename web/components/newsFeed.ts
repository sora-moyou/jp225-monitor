import type { NewsItem } from '../types.js';
import { apiUrl } from '../lib/apiBase.js';

// 同じセッション内で訳済みのタイトルを保持 (再表示時に再翻訳しない)
const translationCache = new Map<string, string>();

export function renderNews(listEl: HTMLElement, items: NewsItem[]): void {
  listEl.innerHTML = '';
  for (const n of items.slice(0, 50)) {
    const li = document.createElement('li');
    li.dataset.lang = n.lang;
    li.dataset.title = n.title;
    const t = new Date(n.publishedAt);
    const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const cached = translationCache.get(n.title);
    const titleHtml = cached ?? escapeHtml(n.title);
    const translateBtn = n.lang === 'en' && !cached
      ? '<button class="news-translate-btn" type="button" title="日本語に翻訳">訳</button>'
      : '';
    li.innerHTML = `
      <div class="meta">[${n.lang.toUpperCase()}] ${escapeHtml(n.source)} ${time} ${translateBtn}</div>
      <a class="news-title" href="${escapeAttr(n.url)}" target="_blank" rel="noopener">${titleHtml}</a>
    `;
    listEl.appendChild(li);

    const btn = li.querySelector<HTMLButtonElement>('.news-translate-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        void translateItem(li, n.title, btn);
      });
    }
  }
}

async function translateItem(li: HTMLElement, original: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch(apiUrl('/api/translate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: original }),
    });
    const data = (await res.json().catch(() => ({} as { translated?: string; error?: string }))) as { translated?: string; error?: string };
    if (!res.ok || !data.translated) {
      btn.textContent = '訳';
      btn.disabled = false;
      btn.title = data.error ?? '翻訳失敗';
      return;
    }
    translationCache.set(original, escapeHtml(data.translated));
    const titleEl = li.querySelector<HTMLAnchorElement>('.news-title');
    if (titleEl) titleEl.textContent = data.translated;
    btn.remove();
  } catch (err) {
    btn.textContent = '訳';
    btn.disabled = false;
    btn.title = err instanceof Error ? err.message : '翻訳失敗';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c] as string));
}

function escapeAttr(s: string): string {
  return s.replace(/["'<>]/g, c => ({
    '"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;'
  }[c] as string));
}
