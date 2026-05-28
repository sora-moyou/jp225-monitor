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

enableSoundBtn.onclick = () => {
  enableSound();
  enableSoundBtn.classList.add('hidden');
};

// ─── LLM呼び出しスロットル ─────────────────────────
// 5分以上の間隔を保証。バナーの🔄ボタンでクールダウン無視の即時更新可能。
const LLM_AUTO_INTERVAL_MS = 5 * 60 * 1000;
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
