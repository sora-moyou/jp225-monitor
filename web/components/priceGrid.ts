import type { Price, AlertEvent } from '../types.js';
import { INSTRUMENTS } from '../../server/config.js';

// 日経カード用。短期 = 変化率(%, 直近60秒) / 超短期 = 値幅(円, 5〜10秒) を値だけ描画。
// 期間ラベル(1分/10秒)はヘッダ行(日経225先物の行)側に置き、grid で各値の真上に揃える。
function momSpan(text: string, v: number | null): string {
  const cls = v === null ? 'flat' : v >= 0 ? 'up' : 'down';
  return `<span class="${cls}">${text}</span>`;
}
function renderMomentum(m: NonNullable<Price['momentum']>): string {
  const pct = momSpan(
    m.shortPct === null ? '—' : `${m.shortPct >= 0 ? '+' : ''}${m.shortPct.toFixed(2)}%`,
    m.shortPct,
  );
  const yen = momSpan(
    m.ultraShortYen === null ? '—' : `${m.ultraShortYen >= 0 ? '+' : ''}${Math.round(m.ultraShortYen)}円`,
    m.ultraShortYen,
  );
  return `<span class="change mom">${pct}${yen}</span>`;
}

// NIY=F(実際に建てる大阪日経先物)が stale のときのカード内容を組み立てる純関数(DOM 非依存・テスト容易化)。
// 「取引時間外(市場が閉まっている=正常)」と「取得不能(取引時間中のフィード障害)」を明確に区別する:
//   ・marketOpen=false → 「取引時間外」(中立表示。異常ではない・数字は出さない)
//   ・marketOpen=true(取引時間中の stale)→ 「取得不能 / 停止」(実際の障害。従来どおり赤=down)
export function buildNiyStaleCard(labelJa: string, marketOpen: boolean): { classes: string[]; html: string } {
  if (!marketOpen) {
    return {
      classes: ['stale', 'offhours'],
      html: `
          <div class="label"><span>${labelJa}</span><span class="source-badge offhours">取引時間外</span></div>
          <div class="value"><span class="num offhours-num">取引時間外</span></div>
        `,
    };
  }
  return {
    classes: ['down', 'stale', 'unavailable'],
    html: `
          <div class="label"><span>${labelJa}</span><span class="source-badge unavail">取得不能</span></div>
          <div class="value"><span class="num unavail-num">停止</span></div>
        `,
  };
}

export function renderPriceGrid(container: HTMLElement, prices: Price[], showOnly?: Set<string>, marketOpen = true): void {
  const priceMap = new Map(prices.map(p => [p.symbol, p]));
  container.innerHTML = '';
  const visible = showOnly
    ? INSTRUMENTS.filter(i => showOnly.has(i.symbol))
    : INSTRUMENTS;
  for (const meta of visible) {
    const p = priceMap.get(meta.symbol);
    const card = document.createElement('div');
    card.className = 'price-card';
    card.dataset.symbol = meta.symbol;
    if (p) {
      // 実弾安全(NIY=F): 実際に建てる大阪日経先物が取得不能(stale)のとき。数字は捏造しない。
      // 「取引時間外」/「取得不能」の出し分けは buildNiyStaleCard(純関数)に集約(テスト対象)。
      if (meta.symbol === 'NIY=F' && p.stale) {
        const { classes, html } = buildNiyStaleCard(meta.labelJa, marketOpen);
        card.classList.add(...classes);
        card.innerHTML = html;
        container.appendChild(card);
        continue;
      }
      const mom = meta.symbol === 'NIY=F' ? p.momentum : undefined;
      // 日経は「短期(率)」の符号でカード方向を決める(日中の値動きと一致させる)。
      // それ以外/momentum 未取得時は従来どおり前日終値比で判定。
      const dirBasis = mom && mom.shortPct !== null ? mom.shortPct : p.changePercent;
      card.classList.add(dirBasis >= 0 ? 'up' : 'down');
      if (p.stale) card.classList.add('stale');
      const sourceBadge = p.stale ? '<span class="source-badge">INV</span>' : '';
      // 日経は値幅が大きく小数点以下は不要 → 整数表示。
      const decimals = meta.symbol === 'NIY=F' ? 0 : meta.unit === 'bp' ? 3 : 2;
      const sign = p.changePercent >= 0 ? '+' : '';
      const formattedPrice = p.price.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      const changeHtml = mom
        ? renderMomentum(mom)
        : `<span class="change">${sign}${p.changePercent.toFixed(2)}%</span>`;
      // 日経のみ: ヘッダ行(label)の右に期間ラベルを置き、値の真上に揃える。
      const periods = mom ? '<span class="periods"><span>1分</span><span>10秒</span></span>' : '';
      card.innerHTML = `
        <div class="label"><span>${meta.labelJa}</span>${sourceBadge}${periods}</div>
        <div class="value">
          <span class="num">${formattedPrice}</span>
          ${changeHtml}
        </div>
      `;
    } else {
      card.innerHTML = `<div class="label"><span>${meta.labelJa}</span></div><div class="value"><span class="num">---</span></div>`;
    }
    container.appendChild(card);
  }
}

export function flashCard(container: HTMLElement, alert: AlertEvent): void {
  const card = container.querySelector(`[data-symbol="${alert.symbol}"]`);
  if (!(card instanceof HTMLElement)) return;
  const cls = alert.direction === 'up' ? 'flash-up' : 'flash-down';
  card.classList.remove('flash-up', 'flash-down');
  void card.offsetWidth; // reflow でアニメ再実行
  card.classList.add(cls);
}
