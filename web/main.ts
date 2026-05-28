import { INSTRUMENTS } from '../server/config.js';
import { ChangeDetector } from './lib/changeDetector.js';
import { connectStream } from './lib/stream.js';
import { fetchExplanation } from './lib/api.js';
import { renderPriceGrid, flashCard } from './components/priceGrid.js';
import { renderNews } from './components/newsFeed.js';
import { addBanner, setExplanation } from './components/alertBanner.js';
import { enableSound, alertBeep } from './components/soundPlayer.js';
import { mountChart } from './components/chart.js';
import { initChat } from './components/chatBoard.js';
import { initSettingsModal } from './components/settingsModal.js';
import { checkForUpdates } from './lib/updater.js';
import { feedSnapshot, getLeader, getLastCorrelation, ANCHOR_SYMBOL } from './lib/correlationTracker.js';
import { labelOf } from './lib/i18n.js';
import { UI } from './lib/i18n.js';

const detector = new ChangeDetector(INSTRUMENTS);

// TradingView チャートをマウント（非同期、失敗してもUIは継続）
void mountChart('tradingview-chart');

// AI チャットボードを初期化
initChat(
  document.getElementById('chat-messages')!,
  document.getElementById('chat-form') as HTMLFormElement,
  document.getElementById('chat-input') as HTMLTextAreaElement,
  document.getElementById('chat-send') as HTMLButtonElement,
  document.getElementById('chat-clear') as HTMLButtonElement,
);

// ─── D&D で高さリサイズ + localStorage 永続化 ──────────
function setupResize(handleId: string, targetSelector: string, storageKey: string, minH = 100) {
  const handle = document.getElementById(handleId);
  const target = document.querySelector<HTMLElement>(targetSelector);
  if (!handle || !target) return;
  const saved = localStorage.getItem(storageKey);
  if (saved) target.style.height = saved;

  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startHeight = target.offsetHeight;
    handle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientY - startY;
    // ハンドルが target の下にある場合: 下にドラッグで拡大 (delta > 0)
    // ハンドルが target の上にある場合: 上にドラッグで拡大 (delta < 0)
    // 判定: target のbottom と handle のtop で判別
    const handleRect = handle.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const sign = handleRect.top < targetRect.top ? -1 : 1;
    const newH = Math.max(minH, Math.min(window.innerHeight - 180, startHeight + sign * delta));
    target.style.height = `${newH}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(storageKey, target.style.height);
  });
}

// チャット高さ: ハンドルはチャットの上にある (上ドラッグでチャット拡大)
setupResize('chat-resize', '.chat-board', 'chat-height', 120);
// アラート高さ: ハンドルはアラートの下にある (下ドラッグでアラート拡大)
setupResize('alerts-resize', '.alerts-pane', 'alerts-height', 100);

// 設定モーダル
initSettingsModal({
  openBtn:        document.getElementById('settings-btn') as HTMLButtonElement,
  modal:          document.getElementById('settings-modal') as HTMLElement,
  closeBtn:       document.getElementById('settings-close') as HTMLButtonElement,
  saveBtn:        document.getElementById('settings-save') as HTMLButtonElement,
  inputGemini:    document.getElementById('key-gemini') as HTMLInputElement,
  inputGroq:      document.getElementById('key-groq') as HTMLInputElement,
  inputOpenai:    document.getElementById('key-openai') as HTMLInputElement,
  inputPricePoll: document.getElementById('settings-price-poll') as HTMLInputElement,
  inputNewsPoll:  document.getElementById('settings-news-poll') as HTMLInputElement,
  inputPort:      document.getElementById('settings-port') as HTMLInputElement,
  portWarning:    document.getElementById('settings-port-warning') as HTMLElement,
  statusArea:     document.getElementById('settings-status-area') as HTMLElement,
  backdrop:       document.getElementById('settings-backdrop') as HTMLElement,
});

const priceGridEl = document.getElementById('price-grid')!;
const newsListEl = document.getElementById('news-list')!;
const bannerEl = document.getElementById('alert-banner')!;
const statusEl = document.getElementById('connection-status')!;
const clockEl = document.getElementById('clock')!;
const enableSoundBtn = document.getElementById('enable-sound') as HTMLButtonElement;
const leaderInfoEl = document.getElementById('leader-info')!;

function updateLeaderInfo() {
  const leader = getLeader();
  const corr = getLastCorrelation();
  const corrText = corr > 0 ? ` (|r|=${corr.toFixed(2)})` : ' (暖機中)';
  leaderInfoEl.innerHTML = `相関リーダー: <strong>${labelOf(leader as never)}</strong>${corrText}`;
}
updateLeaderInfo();

setInterval(() => {
  const d = new Date();
  clockEl.textContent = `JST ${d.toLocaleTimeString('ja-JP', { hour12: false })}`;
}, 1000);

// バージョン表示 (起動時に1回取得) + Tauri内なら更新チェック
const versionEl = document.getElementById('app-version');
if (versionEl) {
  fetch('/api/version')
    .then(r => r.json())
    .then((d: { version: string }) => { versionEl.textContent = `v${d.version}`; })
    .catch(() => { versionEl.textContent = 'v?'; });
  // Tauri環境なら updater で新版チェック (フラグが立てばボタン化)
  void checkForUpdates(versionEl);
}

enableSoundBtn.onclick = () => {
  enableSound();
  enableSoundBtn.classList.add('hidden');
};

// ─── LLM呼び出しスロットル ─────────────────────────
// 0 = OFF (全アラート即LLM)、30_000 = 30秒、5*60*1000 = 5分
// Gemini lite 無料枠 (15 RPM / 1500 RPD) を守るには 30秒以上推奨
const LLM_AUTO_INTERVAL_MS = 30_000;
let lastLLMCallAt = -Infinity;

function callLLM(alert: import('./types.js').AlertEvent, banner: ReturnType<typeof addBanner>) {
  lastLLMCallAt = Date.now();
  setExplanation(banner, '(取得中...)');
  fetchExplanation(alert)
    .then(text => setExplanation(banner, text))
    .catch(() => setExplanation(banner, UI.ja.explanationFailed));
}

function scheduleExplanation(alert: import('./types.js').AlertEvent, banner: ReturnType<typeof addBanner>) {
  // 🔄ボタン: クールダウンを無視して即LLM
  banner.refresh = () => callLLM(alert, banner);

  const now = Date.now();
  const elapsed = now - lastLLMCallAt;
  if (elapsed >= LLM_AUTO_INTERVAL_MS) {
    callLLM(alert, banner);
  } else {
    const waitMs = LLM_AUTO_INTERVAL_MS - elapsed;
    const m = Math.floor(waitMs / 60_000);
    const s = Math.floor((waitMs % 60_000) / 1000);
    setExplanation(banner, `(API節約モード: 自動更新まで ${m}分${s.toString().padStart(2, '0')}秒。🔄ボタンで即更新)`);
  }
}

function setStatus(status: 'connecting' | 'online' | 'offline') {
  statusEl.classList.remove('online', 'offline');
  if (status === 'online') {
    statusEl.textContent = UI.ja.online;
    statusEl.classList.add('online');
  } else {
    statusEl.textContent = status === 'connecting' ? UI.ja.connecting : UI.ja.offline;
    statusEl.classList.add('offline');
  }
}

connectStream({
  onStatusChange: setStatus,
  onPrices: (prices) => {
    const change = feedSnapshot(prices);
    if (change) {
      console.log(`[correlation] leader ${change.prevLeader} → ${change.newLeader} (|r|=${change.absCorrelation.toFixed(2)})`);
      updateLeaderInfo();
    }
    const leader = getLeader();
    const displayed = new Set([ANCHOR_SYMBOL, leader]);
    // 起動5分後の初回再評価でも更新（changeが返らない場合に備えて軽くポーリング表示）
    if (!change && (Date.now() % 30000) < 2100) updateLeaderInfo();

    renderPriceGrid(priceGridEl, prices, displayed);

    for (const p of prices) {
      const alerts = detector.feed(p);
      const meta = INSTRUMENTS.find(i => i.symbol === p.symbol);
      const isHeavyweight = meta?.category === 'heavyweight';
      if (!displayed.has(p.symbol) && !isHeavyweight) continue;
      for (const alert of alerts) {
        flashCard(priceGridEl, alert);
        alertBeep(alert.direction);
        const banner = addBanner(bannerEl, alert);
        scheduleExplanation(alert, banner);
      }
    }
  },
  onNews: (news) => renderNews(newsListEl, news),
});
