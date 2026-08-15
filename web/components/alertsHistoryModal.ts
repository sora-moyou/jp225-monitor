import { apiUrl } from '../lib/apiBase.js';
import { isDirectionalKind } from '../../core/detectionKinds.js';

interface AlertRow {
  id: number; triggered_at: number; direction: 'up' | 'down'; kind: string;
  /** 検知種別の生値。/api/alerts/history は DB 行をそのまま撒くので常に載っている
   *  (kind は表示ラベルなので、方向の有無の判定には使えない=種別の生値が要る)。
   *  古い応答/未知種別で欠けても isDirectionalKind が true(=従来表示)に落ちる。 */
  detection_kind: string | null;
  price: number | null; change_percent: number | null;
  ret5: number | null; ret15: number | null; ret30: number | null;
}
interface KindStat { label: string; count: number; hitRate: number; revertRate: number; avgRet5: number; avgRet15: number; avgRet30: number; }

export interface AlertsHistoryElements {
  openBtn: HTMLButtonElement; modal: HTMLElement; backdrop: HTMLElement;
  closeBtn: HTMLButtonElement; summary: HTMLElement; body: HTMLElement;
}

const fmtTime = (t: number): string =>
  new Date(t).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtRet = (r: number | null): string => r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}%`;
const retCls = (r: number | null): string => r == null ? '' : r >= 0 ? 'up' : 'down';
const fmtPrice = (v: number | null): string => v == null ? '—' : Math.round(v).toLocaleString('en-US');

/** 履歴テーブル「方向」列の <td>(純関数)。
 *  ★方向を持たない種別(squeeze/bulge)は矢印も色クラスも付けず「—」(このファイルの欠測表記)にする。
 *    alerts.direction は必須列なので方向なし検知にも 'up' が入っているが、それを ▲ + 緑(.ah-table td.up)
 *    で見せると **無い方向を主張** することになる(BB幅の収縮に上向きの意味は無い)。
 *    ★class を落とすだけでよいのはこの表だけの事情: .ah-table td の既定色は通常テキスト色で、
 *      .up/.down を付けたときだけ色が付く(バナー .alert のように既定が赤ではない)。
 *    判定は core/detectionKinds.ts の isDirectionalKind が唯一の真実 — ここに種別名を書かないこと。
 *  ★方向を持つ種別の出力は従来と1バイトも変えない。 */
export function dirCell(a: Pick<AlertRow, 'detection_kind' | 'direction'>): string {
  if (!isDirectionalKind(a.detection_kind)) return '<td>—</td>';
  return `<td class="${a.direction === 'up' ? 'up' : 'down'}">${a.direction === 'up' ? '▲' : '▼'}</td>`;
}

export function initAlertsHistoryModal(el: AlertsHistoryElements): void {
  async function load() {
    el.summary.innerHTML = '読み込み中…';
    el.body.innerHTML = '';
    try {
      const res = await fetch(apiUrl('/api/alerts/history?limit=200'));
      const data = await res.json() as { ok: boolean; alerts: AlertRow[]; stats: KindStat[]; error?: string };
      if (!data.ok) { el.summary.innerHTML = `取得失敗: ${data.error ?? ''}`; return; }
      el.summary.innerHTML = data.stats.length
        ? '<table class="ah-table"><thead><tr><th>種別</th><th>件数</th><th>的中率(15分)</th><th>戻り率(15分)</th><th>順行+5分</th><th>順行+15分</th><th>順行+30分</th></tr></thead><tbody>'
          + data.stats.map(s => `<tr><td>${s.label}</td><td>${s.count}</td><td>${(s.hitRate * 100).toFixed(0)}%</td>`
            + `<td>${(s.revertRate * 100).toFixed(0)}%</td>`
            + `<td class="${retCls(s.avgRet5)}">${fmtRet(s.avgRet5)}</td><td class="${retCls(s.avgRet15)}">${fmtRet(s.avgRet15)}</td>`
            + `<td class="${retCls(s.avgRet30)}">${fmtRet(s.avgRet30)}</td></tr>`).join('')
          + '</tbody></table>'
        : '<div class="ah-empty">まだアラート履歴がありません</div>';
      el.body.innerHTML = data.alerts.length
        ? '<table class="ah-table"><thead><tr><th>時刻</th><th>方向</th><th>種別</th><th>発火価格</th><th>+5分</th><th>+15分</th><th>+30分</th></tr></thead><tbody>'
          + data.alerts.map(a => `<tr><td>${fmtTime(a.triggered_at)}</td>${dirCell(a)}`
            + `<td>${a.kind}</td><td>${fmtPrice(a.price)}</td>`
            + `<td class="${retCls(a.ret5)}">${fmtRet(a.ret5)}</td><td class="${retCls(a.ret15)}">${fmtRet(a.ret15)}</td>`
            + `<td class="${retCls(a.ret30)}">${fmtRet(a.ret30)}</td></tr>`).join('')
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
}
