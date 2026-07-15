import { apiUrl } from '../lib/apiBase.js';

// GET /api/signal-trades → { trades: [...], equity: [...] }
// DB: signal_trades(id, entry_t, entry_price, dir, exit_t, exit_price, pnl, qty, rationale, meta)
interface SignalTradeRow {
  id: number;
  entry_t: number; entry_price: number; dir: 'buy' | 'sell';
  exit_t: number | null; exit_price: number | null; pnl: number | null;
  qty: number | null; rationale?: string | null; meta?: string | null;
}
// equity 点列: 数値配列でも { t, equity|cum|value } 配列でも受ける。
type EquityPoint = number | { t?: number; equity?: number; cum?: number; value?: number };
interface SignalTradesResp { trades?: SignalTradeRow[]; equity?: EquityPoint[]; error?: string }

export interface SignalTradesElements {
  openBtn: HTMLButtonElement; modal: HTMLElement; backdrop: HTMLElement;
  closeBtn: HTMLButtonElement; summary: HTMLElement; body: HTMLElement;
  canvas: HTMLCanvasElement;
}

const fmtTime = (t: number | null): string => t == null ? '—'
  : new Date(t).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtPrice = (v: number | null): string => v == null ? '—' : Math.round(v).toLocaleString('en-US');
const fmtPnl = (v: number | null): string => v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('en-US')}`;
const pnlCls = (v: number | null): string => v == null ? '' : v >= 0 ? 'up' : 'down';
const dirJa = (d: 'buy' | 'sell'): string => (d === 'buy' ? '買い' : '売り');

/** equity 点列を実現損益の累積値の配列へ正規化する。 */
export function normalizeEquity(equity: EquityPoint[] | undefined, trades: SignalTradeRow[] | undefined): number[] {
  if (equity && equity.length) {
    return equity.map(p => {
      if (typeof p === 'number') return p;
      return p.equity ?? p.cum ?? p.value ?? 0;
    });
  }
  // フォールバック: trades の pnl を古い→新しい順で累積。
  if (trades && trades.length) {
    const sorted = [...trades].filter(t => t.pnl != null).sort((a, b) => (a.exit_t ?? a.entry_t) - (b.exit_t ?? b.entry_t));
    let cum = 0;
    return sorted.map(t => (cum += t.pnl ?? 0));
  }
  return [];
}

/** 収益曲線を canvas に描画 (既存 UI 配色に合わせた素朴なライン + ゼロ基準線)。 */
export function drawEquityCurve(canvas: HTMLCanvasElement, points: number[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 160;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const css = getComputedStyle(document.documentElement);
  const cMuted = css.getPropertyValue('--muted').trim() || '#8b949e';
  const cUp = css.getPropertyValue('--up').trim() || '#5cf08a';
  const cDown = css.getPropertyValue('--down').trim() || '#ff7d75';
  const cBorder = css.getPropertyValue('--border').trim() || '#30363d';

  if (points.length === 0) {
    ctx.fillStyle = cMuted;
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.fillText('まだトレードシグナル履歴がありません', 12, cssH / 2);
    return;
  }

  const pad = { l: 8, r: 8, t: 10, b: 16 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;
  const series: number[] = points.length === 1 ? [0, points[0] ?? 0] : points;
  let min = Math.min(0, ...series);
  let max = Math.max(0, ...series);
  if (min === max) { min -= 1; max += 1; }
  const x = (i: number): number => pad.l + (series.length === 1 ? w / 2 : (i / (series.length - 1)) * w);
  const y = (v: number): number => pad.t + (1 - (v - min) / (max - min)) * h;

  // ゼロ基準線
  ctx.strokeStyle = cBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, y(0));
  ctx.lineTo(pad.l + w, y(0));
  ctx.stroke();

  // ライン (最終値の符号で色分け)
  const last = series[series.length - 1] ?? 0;
  ctx.strokeStyle = last >= 0 ? cUp : cDown;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  series.forEach((v, i) => { const px = x(i), py = y(v); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); });
  ctx.stroke();

  // 最終累積損益ラベル
  ctx.fillStyle = last >= 0 ? cUp : cDown;
  ctx.font = 'bold 12px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(fmtPnl(last), pad.l + w, Math.min(cssH - 4, Math.max(12, y(last) - 4)));
  ctx.textAlign = 'left';
}

function summarize(trades: SignalTradeRow[], equity: number[]): string {
  const done = trades.filter(t => t.pnl != null);
  const n = done.length;
  if (n === 0) return '<div class="ah-empty">まだトレードシグナル履歴がありません</div>';
  const wins = done.filter(t => (t.pnl ?? 0) > 0).length;
  const total = equity.length ? (equity[equity.length - 1] ?? 0) : done.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const hit = n ? Math.round((wins / n) * 100) : 0;
  return `<div class="signal-stats">`
    + `<span>件数 <b>${n}</b></span>`
    + `<span>勝率 <b>${hit}%</b></span>`
    + `<span>累積損益 <b class="${pnlCls(total)}">${fmtPnl(total)}</b></span>`
    + `</div>`;
}

export function initSignalTradesModal(el: SignalTradesElements): void {
  async function load() {
    el.summary.innerHTML = '読み込み中…';
    el.body.innerHTML = '';
    try {
      const res = await fetch(apiUrl('/api/signal-trades'));
      const data = await res.json() as SignalTradesResp;
      if (data.error) { el.summary.innerHTML = `取得失敗: ${data.error}`; return; }
      const trades = data.trades ?? [];
      const equity = normalizeEquity(data.equity, trades);
      el.summary.innerHTML = summarize(trades, equity);
      drawEquityCurve(el.canvas, equity);
      // 新しい順に一覧表示
      const rows = [...trades].sort((a, b) => (b.exit_t ?? b.entry_t) - (a.exit_t ?? a.entry_t));
      el.body.innerHTML = rows.length
        ? '<table class="ah-table"><thead><tr><th>エントリー時刻</th><th>方向</th><th>建値</th><th>決済時刻</th><th>決済値</th><th>損益</th></tr></thead><tbody>'
          + rows.map(t => `<tr><td>${fmtTime(t.entry_t)}</td>`
            + `<td class="${t.dir === 'buy' ? 'up' : 'down'}">${dirJa(t.dir)}</td>`
            + `<td>${fmtPrice(t.entry_price)}</td>`
            + `<td>${fmtTime(t.exit_t)}</td><td>${fmtPrice(t.exit_price)}</td>`
            + `<td class="${pnlCls(t.pnl)}">${fmtPnl(t.pnl)}</td></tr>`).join('')
          + '</tbody></table>'
        : '';
    } catch (err) {
      el.summary.innerHTML = `取得失敗: ${err instanceof Error ? err.message : 'unknown'}`;
    }
  }
  function open() { el.modal.classList.remove('hidden'); void load(); }
  function close() { el.modal.classList.add('hidden'); }
  el.openBtn.addEventListener('click', open);
  el.closeBtn.addEventListener('click', close);
  el.backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modal.classList.contains('hidden')) close();
  });
  // 履歴消去後などに外部から再読込できるよう公開。
  (el.modal as unknown as { _reloadSignalTrades?: () => void })._reloadSignalTrades = load;
}

/** 設定モーダルの「トレードシグナル履歴を消去」ボタンを配線する。 */
export function initSignalClearButton(
  btn: HTMLButtonElement,
  result: HTMLElement,
  onCleared?: () => void,
): void {
  btn.addEventListener('click', async () => {
    if (!window.confirm('トレードシグナル履歴をすべて消去します。よろしいですか?')) return;
    btn.disabled = true;
    result.className = 'update-result';
    result.textContent = '消去中…';
    try {
      const res = await fetch(apiUrl('/api/signal-trades/clear'), { method: 'POST' });
      const data = await res.json() as { ok?: boolean; cleared?: number; error?: string };
      if (res.ok && data.ok) {
        result.className = 'update-result ok';
        result.textContent = `✅ 消去しました (${data.cleared ?? 0}件)`;
        onCleared?.();
      } else {
        result.className = 'update-result err';
        result.textContent = `❌ 失敗: ${data.error ?? `HTTP ${res.status}`}`;
      }
    } catch (err) {
      result.className = 'update-result err';
      result.textContent = `❌ 失敗: ${err instanceof Error ? err.message : 'unknown'}`;
    } finally {
      btn.disabled = false;
    }
  });
}
