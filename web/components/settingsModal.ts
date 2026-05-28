// API キー設定モーダル

interface SettingsResponse {
  geminiSet: boolean; groqSet: boolean; openaiSet: boolean;
  geminiFromEnv: boolean; groqFromEnv: boolean; openaiFromEnv: boolean;
  providers: Array<{ name: string; enabled: boolean; paused: boolean; pausedUntil: number }>;
  configFile: string;
}

async function fetchSettings(): Promise<SettingsResponse | null> {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return null;
    return await res.json() as SettingsResponse;
  } catch { return null; }
}

async function saveSettings(keys: {
  geminiKey?: string | null;
  groqKey?: string | null;
  openaiKey?: string | null;
}): Promise<boolean> {
  try {
    const res = await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keys),
    });
    return res.ok;
  } catch { return false; }
}

function renderStatus(s: SettingsResponse | null): string {
  if (!s) return '<div class="settings-status err">設定取得失敗</div>';
  const items = s.providers.map(p => {
    const dot = p.enabled
      ? (p.paused ? '🟡' : '🟢')
      : '⚪';
    const note = p.paused
      ? ` (${Math.max(0, Math.round((p.pausedUntil - Date.now()) / 1000))}秒待機中)`
      : p.enabled ? '' : ' 未設定';
    return `<div>${dot} ${p.name}${note}</div>`;
  }).join('');
  return `<div class="settings-status">${items}</div>`;
}

export function initSettingsModal(
  openBtn: HTMLButtonElement,
  modal: HTMLElement,
  closeBtn: HTMLButtonElement,
  saveBtn: HTMLButtonElement,
  inputGemini: HTMLInputElement,
  inputGroq: HTMLInputElement,
  inputOpenai: HTMLInputElement,
  statusArea: HTMLElement,
  backdrop: HTMLElement,
): void {
  let current: SettingsResponse | null = null;

  async function refresh() {
    current = await fetchSettings();
    statusArea.innerHTML = renderStatus(current);
    inputGemini.placeholder = current?.geminiSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.geminiFromEnv ? '環境変数から読込中 (上書きするにはここに入力)' : 'AIza...';
    inputGroq.placeholder = current?.groqSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.groqFromEnv ? '環境変数から読込中' : 'gsk_...';
    inputOpenai.placeholder = current?.openaiSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.openaiFromEnv ? '環境変数から読込中' : 'sk-...';
  }

  async function open() {
    modal.classList.remove('hidden');
    await refresh();
    inputGemini.focus();
  }
  function close() {
    modal.classList.add('hidden');
    inputGemini.value = '';
    inputGroq.value = '';
    inputOpenai.value = '';
  }

  openBtn.addEventListener('click', () => void open());
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    const payload: { geminiKey?: string; groqKey?: string; openaiKey?: string } = {};
    if (inputGemini.value.trim()) payload.geminiKey = inputGemini.value.trim();
    if (inputGroq.value.trim()) payload.groqKey = inputGroq.value.trim();
    if (inputOpenai.value.trim()) payload.openaiKey = inputOpenai.value.trim();
    const ok = await saveSettings(payload);
    saveBtn.disabled = false;
    saveBtn.textContent = '保存';
    if (ok) {
      inputGemini.value = '';
      inputGroq.value = '';
      inputOpenai.value = '';
      await refresh();
    } else {
      alert('保存失敗');
    }
  });

  // 初回起動時にプロバイダ未設定なら自動オープン
  void (async () => {
    const s = await fetchSettings();
    if (s && !s.providers.some(p => p.enabled)) {
      void open();
    }
  })();
}
