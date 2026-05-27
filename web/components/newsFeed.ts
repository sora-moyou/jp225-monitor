import type { NewsItem } from '../types.js';

export function renderNews(listEl: HTMLElement, items: NewsItem[]): void {
  listEl.innerHTML = '';
  for (const n of items.slice(0, 50)) {
    const li = document.createElement('li');
    const t = new Date(n.publishedAt);
    const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    li.innerHTML = `
      <div class="meta">[${n.lang.toUpperCase()}] ${n.source} ${time}</div>
      <a href="${n.url}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>
    `;
    listEl.appendChild(li);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c] as string));
}
