import { apiUrl } from '../lib/apiBase.js';

// 詳細パラメータ (定期ポーリング / アラートクールダウン等)。設定モーダルとは別の専用モーダル。
// 値は /api/settings から取得し、変更分だけ /api/settings/keys に POST する。
// 将来パラメータを追加するときは PARAMS 配列に1行足すだけでよい。

interface ParamSpec { key: string; inputId: string; }

const PARAMS: ParamSpec[] = [
  { key: 'pricePollMs', inputId: 'params-price-poll' },
  { key: 'newsPollMs',  inputId: 'params-news-poll' },
  { key: 'port',        inputId: 'params-port' },
  { key: 'cooldownMin', inputId: 'params-cooldown-min' },
];

export interface ParamsElements {
  openBtn: HTMLButtonElement;
  modal: HTMLElement;
  backdrop: HTMLElement;
  closeBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  portWarning: HTMLElement;
  status: HTMLElement;
}

export function initParamsModal(el: ParamsElements): void {
  let current: Record<string, number> | null = null;

  const inputOf = (id: string): HTMLInputElement | null =>
    document.getElementById(id) as HTMLInputElement | null;

  async function refresh() {
    el.status.textContent = '';
    el.portWarning.classList.add('hidden');
    try {
      const res = await fetch(apiUrl('/api/settings'));
      const s = await res.json() as Record<string, number>;
      current = s;
      for (const p of PARAMS) {
        const input = inputOf(p.inputId);
        if (input && typeof s[p.key] === 'number') input.value = String(s[p.key]);
      }
    } catch {
      el.status.textContent = '取得失敗';
    }
  }

  function open() { el.modal.classList.remove('hidden'); void refresh(); }
  function close() { el.modal.classList.add('hidden'); }

  el.openBtn.addEventListener('click', open);
  el.closeBtn.addEventListener('click', close);
  el.backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modal.classList.contains('hidden')) close();
  });

  el.saveBtn.addEventListener('click', async () => {
    el.saveBtn.disabled = true;
    const orig = el.saveBtn.textContent ?? '保存';
    el.saveBtn.textContent = '保存中...';
    try {
      const body: Record<string, number> = {};
      for (const p of PARAMS) {
        const input = inputOf(p.inputId);
        if (!input) continue;
        const v = Number(input.value);
        if (current && v !== current[p.key]) body[p.key] = v;
      }
      const res = await fetch(apiUrl('/api/settings/keys'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json() as { ok?: boolean; error?: string; portRequiresRestart?: boolean };
      if (res.ok && d.ok !== false) {
        el.status.textContent = '保存しました';
        if (d.portRequiresRestart) el.portWarning.classList.remove('hidden');
        await refresh();
      } else {
        el.status.textContent = `保存失敗: ${d.error ?? `HTTP ${res.status}`}`;
      }
    } catch (err) {
      el.status.textContent = `保存失敗: ${err instanceof Error ? err.message : 'unknown'}`;
    } finally {
      el.saveBtn.disabled = false;
      el.saveBtn.textContent = orig;
    }
  });
}
