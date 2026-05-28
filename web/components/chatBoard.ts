// シンプルなAIチャット (セッション内のみ、ページリロードで消える)

interface Message { role: 'user' | 'assistant'; content: string; }

const history: Message[] = [];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c] as string));
}

function renderMessages(messagesEl: HTMLElement, hintEl: HTMLElement | null): void {
  // ヒントは初回のみ表示、メッセージが入ったら隠す
  if (hintEl) hintEl.style.display = history.length === 0 ? '' : 'none';

  // ヒントエレメント以外を全削除して再描画
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
      div.innerHTML = escapeHtml(m.content);
    }
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendToServer(messages: Message[]): Promise<string> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
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
): void {
  const hintEl = messagesEl.querySelector('.chat-hint') as HTMLElement | null;

  async function submit() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    sendBtn.disabled = true;

    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: '__thinking__' });
    renderMessages(messagesEl, hintEl);

    try {
      // 「考え中」プレースホルダを除いて送る
      const realMessages = history.slice(0, -1);
      const reply = await sendToServer(realMessages);
      history[history.length - 1] = { role: 'assistant', content: reply };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      history[history.length - 1] = { role: 'assistant', content: `(エラー: ${msg})` };
    } finally {
      renderMessages(messagesEl, hintEl);
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });

  // Enter送信、Shift+Enter改行
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  });

  clearBtn.addEventListener('click', () => {
    history.length = 0;
    renderMessages(messagesEl, hintEl);
  });
}
