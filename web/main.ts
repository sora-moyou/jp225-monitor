import { INSTRUMENTS } from '../server/config.js';
import { ChangeDetector } from './lib/changeDetector.js';
import { connectStream } from './lib/stream.js';
import { fetchExplanation } from './lib/api.js';
import { renderPriceGrid, flashCard } from './components/priceGrid.js';
import { renderNews } from './components/newsFeed.js';
import { addBanner, setExplanation } from './components/alertBanner.js';
import { enableSound, alertBeep } from './components/soundPlayer.js';
import { mountChart } from './components/chart.js';
import { UI } from './lib/i18n.js';

const detector = new ChangeDetector(INSTRUMENTS);

// TradingView チャートをマウント（非同期、失敗してもUIは継続）
void mountChart('tradingview-chart');

const priceGridEl = document.getElementById('price-grid')!;
const newsListEl = document.getElementById('news-list')!;
const bannerEl = document.getElementById('alert-banner')!;
const statusEl = document.getElementById('connection-status')!;
const clockEl = document.getElementById('clock')!;
const enableSoundBtn = document.getElementById('enable-sound') as HTMLButtonElement;

setInterval(() => {
  const d = new Date();
  clockEl.textContent = `JST ${d.toLocaleTimeString('ja-JP', { hour12: false })}`;
}, 1000);

enableSoundBtn.onclick = () => {
  enableSound();
  enableSoundBtn.classList.add('hidden');
};

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
    renderPriceGrid(priceGridEl, prices);
    for (const p of prices) {
      const alerts = detector.feed(p);
      for (const alert of alerts) {
        flashCard(priceGridEl, alert);
        alertBeep(alert.direction);
        const banner = addBanner(bannerEl, alert);
        fetchExplanation(alert)
          .then(text => setExplanation(banner, text))
          .catch(() => setExplanation(banner, UI.ja.explanationFailed));
      }
    }
  },
  onNews: (news) => renderNews(newsListEl, news),
});
