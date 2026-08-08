import type { NewsItem } from '../types.js';
import { apiUrl } from '../lib/apiBase.js';
import { rankNewsByImpact, relativeTimeLabel, NEWS_CATEGORY_LABELS } from '../../core/newsImpact.js';
import { confidenceBadgeLabel, confidenceTooltip } from '../../core/newsConfidence.js';

// 同じセッション内で訳済みのタイトルを保持 (再表示時に再翻訳しない)。
// ★ここには **エスケープしていない生の訳文** を入れる。描画側が escapeHtml を掛けるので、
//   エスケープ済みを入れると二重に掛かって画面に "AT&amp;T株" と出る(実バグ)。
//   「保持するのは値、エスケープは出す直前に1回だけ」を境界にする。
const translationCache = new Map<string, string>();

/** 手動翻訳の結果を覚える(生の訳文のまま)。 */
export function rememberTranslation(original: string, translated: string): void {
  translationCache.set(original, translated);
}

/** 覚えている訳文(生)。無ければ undefined。 */
export function cachedTranslation(original: string): string | undefined {
  return translationCache.get(original);
}

/** テスト用: セッションキャッシュを空にする。 */
export function clearTranslationCacheForTest(): void {
  translationCache.clear();
}

/**
 * 実際に表示する見出し(生の文字列)を決める純関数。null = 訳が無いので原文を出す。
 * 優先順: サーバが取得時に訳したもの → この画面で手動翻訳したもの → 無し。
 */
export function shownTitle(n: Pick<NewsItem, 'title' | 'titleJa'>): string | null {
  return n.titleJa ?? translationCache.get(n.title) ?? null;
}

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

    // ★表示は訳文。原文(n.title)は捨てない = ツールチップで必ず確認できるようにする。
    //   優先順: サーバが取得時に訳したもの → この画面で手動翻訳したもの → 原文。
    const shown = shownTitle(n);
    const titleHtml = escapeHtml(shown ?? n.title);
    // 訳を出しているときだけ、原文をツールチップに入れる(訳の誤りを原文で確かめられるように)。
    const titleAttr = shown ? ` title="${escapeAttr(`原文: ${n.title}`)}"` : '';
    // ★「訳」ボタンは **まだ訳が無いときだけ** 残す = 手動リトライの手段。
    //   常時翻訳が効いていれば出ないので、ボタンが見えること自体が「訳せていない」の合図になる。
    const translateBtn = n.lang === 'en' && !shown
      ? '<button class="news-translate-btn" type="button" title="日本語に翻訳(再試行)">訳</button>'
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
    // ★訳せなかったことを黙って隠さない。ただし画面は汚さないので、極小の灰色印にとどめる。
    //   (成功していれば何も出ない = 平常時のノイズはゼロ)
    if (!shown && n.translateError) {
      chips.push(`<span class="news-chip news-untranslated" title="${escapeAttr(`翻訳できませんでした: ${n.translateError}（原文のまま表示しています。「訳」で再試行できます）`)}">原文</span>`);
    }

    li.innerHTML = `
      <div class="news-when">${escapeHtml(relativeTimeLabel(n.publishedAt, now))}</div>
      <div class="news-body">
        <div class="news-chips">${chips.join('')}</div>
        <a class="news-title" href="${escapeAttr(n.url)}" target="_blank" rel="noopener"${titleAttr}>${titleHtml}</a>
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
    // ★生のまま覚える(エスケープは描画の直前に 1 回だけ)。
    rememberTranslation(original, data.translated);
    const titleEl = li.querySelector<HTMLAnchorElement>('.news-title');
    if (titleEl) {
      titleEl.textContent = data.translated;
      titleEl.title = `原文: ${original}`;   // 手動翻訳でも原文を失わない
    }
    li.querySelector('.news-untranslated')?.remove();   // 訳せたので「原文」印を外す
    btn.remove();
  } catch (err) {
    btn.textContent = '訳';
    btn.disabled = false;
    btn.title = err instanceof Error ? err.message : '翻訳失敗';
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c] as string));
}

function escapeAttr(s: string): string {
  return s.replace(/["'<>]/g, c => ({
    '"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;'
  }[c] as string));
}
