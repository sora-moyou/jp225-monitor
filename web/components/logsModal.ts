interface LogEntry { ts: number; level: 'log' | 'warn' | 'error'; msg: string; }
interface LogsResponse { logs: LogEntry[]; }

function fmtTs(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

function renderLine(e: LogEntry): string {
  const cls = e.level === 'warn' ? 'log-warn' : e.level === 'error' ? 'log-error' : '';
  return `<span class="log-ts">${fmtTs(e.ts)}</span><span class="${cls}">${escapeHtml(e.msg)}</span>\n`;
}

export interface LogsModalElements {
  openBtn: HTMLButtonElement;
  modal: HTMLElement;
  closeBtn: HTMLButtonElement;
  backdrop: HTMLElement;
  contentEl: HTMLElement;
  autoCheckbox: HTMLInputElement;
  clearBtn: HTMLButtonElement;
}

export function initLogsModal(el: LogsModalElements): void {
  let pollTimer: number | null = null;
  let lastTs = 0;
  let followBottom = true;

  el.contentEl.addEventListener('scroll', () => {
    const atBottom = el.contentEl.scrollTop + el.contentEl.clientHeight >= el.contentEl.scrollHeight - 5;
    followBottom = atBottom;
  });

  async function fetchAndAppend(initial: boolean): Promise<void> {
    try {
      const url = initial ? '/api/logs' : `/api/logs?since=${lastTs}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json() as LogsResponse;
      if (initial) {
        el.contentEl.innerHTML = data.logs.map(renderLine).join('');
      } else if (data.logs.length > 0) {
        el.contentEl.innerHTML += data.logs.map(renderLine).join('');
      }
      if (data.logs.length > 0) {
        lastTs = data.logs[data.logs.length - 1]!.ts;
      }
      if (followBottom) {
        el.contentEl.scrollTop = el.contentEl.scrollHeight;
      }
    } catch { /* ignore */ }
  }

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(() => { void fetchAndAppend(false); }, 2000);
  }
  function stopPolling() {
    if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
  }

  async function open() {
    el.modal.classList.remove('hidden');
    lastTs = 0;
    followBottom = true;
    await fetchAndAppend(true);
    if (el.autoCheckbox.checked) startPolling();
  }
  function close() {
    el.modal.classList.add('hidden');
    stopPolling();
  }

  el.openBtn.addEventListener('click', () => { void open(); });
  el.closeBtn.addEventListener('click', close);
  el.backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modal.classList.contains('hidden')) close();
  });
  el.autoCheckbox.addEventListener('change', () => {
    if (el.autoCheckbox.checked) startPolling(); else stopPolling();
  });
  el.clearBtn.addEventListener('click', () => {
    el.contentEl.innerHTML = '';
    lastTs = Date.now();
  });
}
