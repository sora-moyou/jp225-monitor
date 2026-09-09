import { getUpdateStatus, installUpdate, type UpdateInfo } from '../lib/updater.js';
import { reportUpdateCheck } from '../lib/updateReport.js';

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

// 起動時の更新チェック。★v0.9.111: 結末を **必ずサーバへ記録させてから** 表示判断に入る。
//
// 旧実装は checkForUpdate() の null を見るだけで、失敗も「更新なし」も Tauri 外も
// 区別せずそのまま return していた(= 起動時の失敗が完全に無音)。
// ここでは4状態を明示的に場合分けし、どれであっても記録を1件残す。
//
// ★表示は変えていない: 失敗時に出す新しい UI は作らない(既存の表示先が無いため)。
//   失敗は serverlog と meta の update_check_status に残るので、書き出しを見れば分かる。
export async function maybeShowUpdateToast(toastEl: HTMLElement, delayMs: number = 5000): Promise<void> {
  await new Promise(r => setTimeout(r, delayMs));
  const status = await getUpdateStatus();
  // 記録は表示の**手前で撃つ**が、★待たない(設定経路と同じ `void`)。
  //   待つと、記録の送信が詰まっただけで更新の通知そのものが出なくなる
  //   (差し戻しで実測: 解決しない fetch を食わせると 5 秒経ってもトーストが出なかった)。
  //   撃つ場所が早期 return より前なので、どの分岐でも記録は必ず1件送られる。
  void reportUpdateCheck('startup', status);
  if (status.state === 'error') {
    console.warn('[updater] 起動時の更新チェックが失敗:', status.message);
    return;
  }
  if (status.state !== 'available') return;      // latest / unsupported = 出すものが無い
  const info = status.info;
  if (isDismissed(info.version)) return;
  render(toastEl, info);
}
