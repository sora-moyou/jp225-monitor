import { checkForUpdate, installUpdate, type UpdateInfo } from '../lib/updater.js';

const DISMISS_KEY = 'jp225_update_dismissed_until';
const DISMISS_DURATION_MS = 24 * 3600 * 1000;

function isDismissed(version: string): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw) as { version: string; until: number };
    return obj.version === version && Date.now() < obj.until;
  } catch { return false; }
}

function markDismissed(version: string): void {
  localStorage.setItem(DISMISS_KEY, JSON.stringify({ version, until: Date.now() + DISMISS_DURATION_MS }));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

function render(toast: HTMLElement, info: UpdateInfo): void {
  toast.innerHTML = `
    <div class="update-toast-body">
      🆙 <strong>v${escapeHtml(info.version)}</strong> が利用可能です
      ${info.notes ? `<div class="update-toast-notes">${escapeHtml(info.notes)}</div>` : ''}
      <div class="update-toast-progress hidden"><div class="update-toast-bar"></div></div>
      <div class="update-toast-actions">
        <button id="update-toast-install" class="update-toast-btn primary">更新</button>
        <button id="update-toast-dismiss" class="update-toast-btn">後で</button>
      </div>
    </div>
  `;
  toast.classList.remove('hidden');

  const installBtn = toast.querySelector<HTMLButtonElement>('#update-toast-install')!;
  const dismissBtn = toast.querySelector<HTMLButtonElement>('#update-toast-dismiss')!;
  const progressEl = toast.querySelector<HTMLElement>('.update-toast-progress')!;
  const barEl = toast.querySelector<HTMLElement>('.update-toast-bar')!;

  dismissBtn.addEventListener('click', () => {
    markDismissed(info.version);
    toast.classList.add('hidden');
  });

  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    dismissBtn.disabled = true;
    progressEl.classList.remove('hidden');
    try {
      await installUpdate((dl, total) => {
        if (total && total > 0) {
          const pct = Math.round((dl / total) * 100);
          barEl.style.width = `${pct}%`;
        }
      });
      // installUpdate 内で relaunch されるので通常ここには来ない
    } catch (err) {
      toast.innerHTML = `<div class="update-toast-body err">更新失敗: ${escapeHtml(err instanceof Error ? err.message : 'unknown')}</div>`;
    }
  });
}

export async function maybeShowUpdateToast(toastEl: HTMLElement, delayMs: number = 5000): Promise<void> {
  await new Promise(r => setTimeout(r, delayMs));
  const info = await checkForUpdate();
  if (!info) return;
  if (isDismissed(info.version)) return;
  render(toastEl, info);
}
