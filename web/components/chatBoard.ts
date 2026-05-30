// シンプルなAIチャット (セッション内のみ、ページリロードで消える)

import { apiUrl } from '../lib/apiBase.js';

interface Message { role: 'user' | 'assistant'; content: string; display?: string; }

interface Preset { key: string; label: string; prompt: string; }

const PRESETS: Preset[] = [
  { key: '1',
    label: '現在のトレンド方向と上値/下値のメド',
    prompt: '今の日経225先物のトレンド方向(上昇/下降/レンジ)と根拠、当面の上値メド・下値メドを、直近の値動き・1時間高安・節目から具体的に。' },
  { key: '2',
    label: '急変の理由を詳しく',
    prompt: '直近で起きた急変の理由を、ニュース・他資産の動き・テクニカルの観点から、結論→根拠の順で詳しく説明して。' },
];

const history: Message[] = [];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c] as string));
}

function renderMessages(messagesEl: HTMLElement, hintEl: HTMLElement | null): void {
  if (hintEl) hintEl.style.display = history.length === 0 ? '' : 'none';
  Array.from(messagesEl.children).forEach(c => {
    if (!c.classList.contains('chat-hint')) c.remove();
  });
  for (const m of history) {
    const div = document.createElement('div');
    div.className = `chat-msg ${m.role}`;
    if (m.content === '__thinking__') {
      div.classList.add('thinking');
      div.textContent = '考え中...';
    } else {
      div.innerHTML = escapeHtml(m.display ?? m.content);
    }
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendToServer(messages: Message[]): Promise<string> {
  const res = await fetch(apiUrl('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messages.map(m => ({ role: m.role, content: m.content })) }),
  });
  const data = (await res.json().catch(() => ({} as { reply?: string }))) as { reply?: string };
  if (data.reply) return data.reply;
  throw new Error(`chat ${res.status}`);
}

export function initChat(
  messagesEl: HTMLElement,
  formEl: HTMLFormElement,
  inputEl: HTMLTextAreaElement,
  sendBtn: HTMLButtonElement,
  clearBtn: HTMLButtonElement,
  presetButtons: HTMLButtonElement[],
): void {
  const hintEl = messagesEl.querySelector('.chat-hint') as HTMLElement | null;

  function setBusy(busy: boolean): void {
    sendBtn.disabled = busy;
    presetButtons.forEach(b => { b.disabled = busy; });
  }

  async function send(userMsg: Message): Promise<void> {
    setBusy(true);
    history.push(userMsg);
    history.push({ role: 'assistant', content: '__thinking__' });
    renderMessages(messagesEl, hintEl);
    try {
      const realMessages = history.slice(0, -1);
      const reply = await sendToServer(realMessages);
      history[history.length - 1] = { role: 'assistant', content: reply };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      history[history.length - 1] = { role: 'assistant', content: `(エラー: ${msg})` };
    } finally {
      renderMessages(messagesEl, hintEl);
      setBusy(false);
      inputEl.focus();
    }
  }

  function submitFromInput(): void {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    const preset = PRESETS.find(p => p.key === text);
    if (preset) {
      void send({ role: 'user', content: preset.prompt, display: preset.label });
    } else {
      void send({ role: 'user', content: text });
    }
  }

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    submitFromInput();
  });

  // Enter送信、Shift+Enter改行
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitFromInput();
    }
  });

  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.preset;
      const preset = PRESETS.find(p => p.key === key);
      if (!preset) return;
      void send({ role: 'user', content: preset.prompt, display: preset.label });
    });
  });

  clearBtn.addEventListener('click', () => {
    history.length = 0;
    renderMessages(messagesEl, hintEl);
  });
}
