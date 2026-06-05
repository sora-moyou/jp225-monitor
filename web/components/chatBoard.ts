// シンプルなAIチャット (セッション内のみ、ページリロードで消える)

import { apiUrl } from '../lib/apiBase.js';

interface Message { role: 'user' | 'assistant'; content: string; display?: string; }

interface Preset { key: string; label: string; prompt: string; }

const PRESETS: Preset[] = [
  { key: '1',
    label: 'テクニカル分析',
    prompt: '今の日経225先物について、テクニカル中心に、上値と下値の両方を必ず扱い、トレーダー目線で踏み込んで考察して。マークダウンの見出し(#)や太字(**)は使わずプレーンテキストで簡潔に。\n価格はテクニカル要約に出ている上値/下値の水準・フィボ50%転換ラインの数値をそのまま使い(新しい価格を自分で作らない)、水準の羅列ではなく「なぜその水準が効くか・どう動きそうか」の考察を中心にすること(レベル一覧は画面の主要レベルパネルに常時表示されているため)。ニュース等のファンダ材料には触れず、価格・水準・トレンドのテクニカルに絞る。\n構成:\n1行目: 現在の方向観(上昇/下降/レンジ)と根拠を1〜2文(現値とフィボ50%転換ラインの上下関係、近い強レベルの位置)。\n「上値」: 意識すべきレジスタンス(特に強レベル★や直近のもの)を挙げ、そこを上抜けた場合の次の目標と、上昇が続く条件。\n「下値」: 同様にサポート(強レベル★・直近)を挙げ、割れた場合の次の下値と、下落が続く条件。\n「転換の目安」: フィボ50%転換ラインの価格と、現値がその上/下どちらにあるかで、どちらへの転換が意識されるか。\n最後に: 上下どちらにリスク/余地が大きいか、何が起きると見方が変わるかを1〜2文。' },
  { key: '2',
    label: 'ファンダメンタル分析',
    prompt: '今の日経225先物について、ファンダメンタル中心に、ニュースと他資産(米株指数 NQ/YM・香港ハンセン・原油・米10年金利・ドル円)の動きをまとめて方向性を考察して。マークダウンの見出し(#)や太字(**)は使わずプレーンテキストで簡潔に。テクニカルの水準の羅列はしない(それは①や主要レベルパネルで見られる)。材料の解釈と方向観を中心に。\n構成:\n1行目: ファンダ面から見た現在の方向観(上昇/下降/レンジ)と、最も効いている材料を1〜2文。\n「ニュース材料」: 効いている主要ニュース/イベントを「*」始まりで2〜4点。各々が日経にとって買い材料か売り材料かを明記。\n「他資産の示唆」: 米株(NQ/YM)・香港ハンセン・原油・米金利・ドル円の動きから読めるリスクオン/オフ、円安/円高の日経への影響を簡潔に。\n「注目の催し・リスク」: 直近で日経を動かしうる予定や不確実性。\n最後に: ファンダ面で上下どちらに傾きやすいか、何が出ると見方が変わるかを1〜2文。材料が乏しければその旨も述べる。' },
  { key: '3',
    label: 'スイング分析',
    prompt: '今の日経225先物について、1週間程度で手じまいするスイングトレード前提で、上昇・下落・レンジの3シナリオを提示して。マークダウンの見出し(#)や太字(**)は使わずプレーンテキストで簡潔に。価格はテクニカル要約や主要レベルパネルに出ている水準・フィボ等の数値をそのまま使い、新しい価格を自分で作らない。テクニカルと主要ファンダ材料の両面を踏まえること。各シナリオは想定確度の高い順に並べる。\n構成:\n1行目: 現在の地合い(方向観)と、今週の最重要の着目点を1〜2文(テクニカル+主要ファンダ材料)。\n「上昇シナリオ」: きっかけ/条件、上抜けで意識する目標水準(複数段)、想定値幅と日数感、無効化(ここを割れたら否定)する水準。\n「下落シナリオ」: 同様に、きっかけ/条件、下値目標(複数段)、値幅・日数感、無効化(ここを上抜けたら否定)する水準。\n「レンジシナリオ」: 想定レンジの上限/下限水準、レンジ内の立ち回り(逆張りの目安)、レンジを抜けたらどちらのシナリオへ移行するか。\n最後に: 1週間のスイング目線で現時点で最も妥当なシナリオと、手じまい/損切りの目安(具体的な水準)を1〜2文。エントリーは慎重に、と添える。' },
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
