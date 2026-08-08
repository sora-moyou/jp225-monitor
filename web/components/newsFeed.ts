import type { NewsItem } from '../types.js';
import { apiUrl } from '../lib/apiBase.js';
import { rankNewsByImpact, relativeTimeLabel, NEWS_CATEGORY_LABELS } from '../../core/newsImpact.js';
import { confidenceBadgeLabel, confidenceTooltip } from '../../core/newsConfidence.js';

// 同じセッション内で訳済みのタイトルを保持 (再表示時に再翻訳しない)
const translationCache = new Map<string, string>();

/** 折りたたみ時の表示件数。「すべて見る →」で全件へ切り替える。 */
export const NEWS_COLLAPSED_COUNT = 30;
const NEWS_MAX_RENDER = 200;

let showAll = false;

/** 「すべて見る →」ボタンを配線する。再描画は onToggle 経由で呼び出し側に任せる(状態は1箇所)。 */
export function wireNewsShowAll(btn: HTMLElement | null, onToggle: () => void): void {
  if (!btn) return;
  btn.addEventListener('click', () => {
    showAll = !showAll;
    btn.textContent = showAll ? '上位のみ ←' : 'すべて見る →';
    onToggle();
  });
}

export function renderNews(listEl: HTMLElement, items: NewsItem[]): void {
  listEl.innerHTML = '';
  // ★並びは「インパクト × 鮮度」。ここで採点し直すのは、鮮度の減衰が時間とともに動くため
  //   (サーバの採点は取得時点のもの。画面は開いたままでも順位が古びないようにする)。
  //   確度(未確認バッジ)はプール全体を見ないと決まらないのでサーバの判定をそのまま使う。
  const now = Date.now();
  const ranked = rankNewsByImpact(items, now);
  const visible = ranked.slice(0, showAll ? NEWS_MAX_RENDER : NEWS_COLLAPSED_COUNT);

  for (const n of visible) {
    const li = document.createElement('li');
    li.dataset.lang = n.lang;
    li.dataset.title = n.title;
    // カード左の縦アクセント線をカテゴリ色で出す(チップの背景色クラスとは別系統の acc-*)。
    if (n.impact?.category) li.classList.add(`acc-${n.impact.category}`);
    // 採点の内訳を DOM に残す(なぜ上位に来たかを画面から辿れるようにする)。
    if (n.impact) {
      li.dataset.impact = String(n.impact.score);
      li.title = n.impact.reasons.map(r => `${r.label}: ${r.points > 0 ? '+' : ''}${r.points}`).join('\n');
    }

    const cached = translationCache.get(n.title);
    const titleHtml = cached ?? escapeHtml(n.title);
    const translateBtn = n.lang === 'en' && !cached
      ? '<button class="news-translate-btn" type="button" title="日本語に翻訳">訳</button>'
      : '';

    const chips: string[] = [];
    const cat = n.impact?.category ?? null;
    if (cat) chips.push(`<span class="news-chip cat-${cat}">${escapeHtml(NEWS_CATEGORY_LABELS[cat])}</span>`);
    if (n.impact?.overseas) chips.push('<span class="news-chip cat-overseas">海外</span>');
    // ★未確認バッジ。警告ではなく **属性** として、控えめな灰色で出す(ユーザー指示)。
    //   赤で大きく出すと「見るな」の意味になるが、意図は逆で「速いから見たい」。
    const badge = confidenceBadgeLabel(n.confidence);
    if (badge) {
      chips.push(`<span class="news-chip news-unconfirmed" title="${escapeAttr(confidenceTooltip(n.confidence))}">${escapeHtml(badge)}</span>`);
    }

    li.innerHTML = `
      <div class="news-when">${escapeHtml(relativeTimeLabel(n.publishedAt, now))}</div>
      <div class="news-body">
        <div class="news-chips">${chips.join('')}</div>
        <a class="news-title" href="${escapeAttr(n.url)}" target="_blank" rel="noopener">${titleHtml}</a>
        <div class="news-foot"><span class="news-source">${escapeHtml(n.source)}</span>${translateBtn}</div>
      </div>
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
