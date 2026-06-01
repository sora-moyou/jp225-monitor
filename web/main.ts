import { INSTRUMENTS } from '../server/config.js';
import { connectStream } from './lib/stream.js';
import { fetchExplanation } from './lib/api.js';
import { renderPriceGrid, flashCard } from './components/priceGrid.js';
import { renderNews } from './components/newsFeed.js';
import { addBanner, setExplanation, restoreSavedBanners } from './components/alertBanner.js';
import { enableSound, alertBeep } from './components/soundPlayer.js';
import { mountChart } from './components/chart.js';
import { initChat } from './components/chatBoard.js';
import { initSettingsModal } from './components/settingsModal.js';
import { initParamsModal } from './components/paramsModal.js';
import { initApiStatusPane } from './components/apiStatusPane.js';
import { initLogsModal } from './components/logsModal.js';
import { maybeShowUpdateToast } from './components/updateToast.js';
import { startCorrelationPolling, getCorrelationTop, getAnchorSymbol, getCurrentLeader } from './lib/correlationClient.js';
import { initLevelsPanel, setLevels, setLevelsPrice } from './components/levelsPanel.js';
import { labelOf } from './lib/i18n.js';
import { UI } from './lib/i18n.js';
import { apiUrl } from './lib/apiBase.js';

// v0.3.17: アラート検知はサーバ側 (alertLoop + tickDetector) に移管。クライアントは SSE で受信のみ。

// TradingView チャートをマウント（非同期、失敗してもUIは継続）
void mountChart('tradingview-chart');

// AI チャットボードを初期化
initChat(
  document.getElementById('chat-messages')!,
  document.getElementById('chat-form') as HTMLFormElement,
  document.getElementById('chat-input') as HTMLTextAreaElement,
  document.getElementById('chat-send') as HTMLButtonElement,
  document.getElementById('chat-clear') as HTMLButtonElement,
  Array.from(document.querySelectorAll('.chat-preset')) as HTMLButtonElement[],
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

// 左右の幅: 中央のハンドルを左右ドラッグで left:right 比率を変更 (既定 1:2)
function setupColResize(handleId: string, gridSelector: string, storageKey: string) {
  const handle = document.getElementById(handleId);
  const grid = document.querySelector<HTMLElement>(gridSelector);
  if (!handle || !grid) return;

  // 左比率 frac (0<frac<1) を grid の fr 変数に反映
  const apply = (frac: number) => {
    grid.style.setProperty('--left-fr', `${frac}fr`);
    grid.style.setProperty('--right-fr', `${1 - frac}fr`);
  };
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    const f = parseFloat(saved);
    if (f > 0 && f < 1) apply(f);
  }

  let dragging = false;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = grid.getBoundingClientRect();
    // どちらも潰れないよう 15%〜60% にクランプ
    const frac = Math.max(0.15, Math.min(0.6, (e.clientX - rect.left) / rect.width));
    apply(frac);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const cur = parseFloat(grid.style.getPropertyValue('--left-fr'));
    if (cur > 0 && cur < 1) localStorage.setItem(storageKey, cur.toString());
  });
  // ダブルクリックで初期比率 (1:2) に戻す
  handle.addEventListener('dblclick', () => {
    grid.style.removeProperty('--left-fr');
    grid.style.removeProperty('--right-fr');
    localStorage.removeItem(storageKey);
  });
}

// チャット高さ: ハンドルはチャットの上にある (上ドラッグでチャット拡大)
setupResize('chat-resize', '.chat-board', 'chat-height', 120);
// アラート高さ: ハンドルはアラートの下にある (下ドラッグでアラート拡大)
setupResize('alerts-resize', '.alerts-pane', 'alerts-height', 100);
// 主要レベル高さ: ハンドルはレベルパネルの下にある (下ドラッグで拡大)
setupResize('levels-resize', '.levels-panel', 'levels-height', 60);
// 左右の幅: 中央線を左右ドラッグ
setupColResize('col-resize', '.main-grid', 'main-split');

// 設定モーダル
initSettingsModal({
  openBtn:        document.getElementById('settings-btn') as HTMLButtonElement,
  modal:          document.getElementById('settings-modal') as HTMLElement,
  closeBtn:       document.getElementById('settings-close') as HTMLButtonElement,
  saveBtn:        document.getElementById('settings-save') as HTMLButtonElement,
  inputGemini:    document.getElementById('key-gemini') as HTMLInputElement,
  inputGroq:      document.getElementById('key-groq') as HTMLInputElement,
  inputOpenai:    document.getElementById('key-openai') as HTMLInputElement,
  statusArea:     document.getElementById('settings-status-area') as HTMLElement,
  backdrop:       document.getElementById('settings-backdrop') as HTMLElement,
  checkUpdateBtn: document.getElementById('settings-check-update') as HTMLButtonElement,
  updateResult:   document.getElementById('settings-update-result') as HTMLElement,
  currentVersion: document.getElementById('settings-current-version') as HTMLElement,
  basedataCheckBtn: document.getElementById('settings-basedata-check') as HTMLButtonElement,
  basedataResult:   document.getElementById('settings-basedata-result') as HTMLElement,
});

// 詳細パラメータ モーダル (定期ポーリング / クールダウン等。設定とは別ボタン 🎛️)
initParamsModal({
  openBtn:     document.getElementById('params-btn') as HTMLButtonElement,
  modal:       document.getElementById('params-modal') as HTMLElement,
  backdrop:    document.getElementById('params-backdrop') as HTMLElement,
  closeBtn:    document.getElementById('params-close') as HTMLButtonElement,
  saveBtn:     document.getElementById('params-save') as HTMLButtonElement,
  portWarning: document.getElementById('params-port-warning') as HTMLElement,
  status:      document.getElementById('params-status') as HTMLElement,
});

// ③ Ctrl + / Ctrl - / Ctrl 0 でチャート以外のUI文字サイズを可変 (zoom)。localStorage 永続。
// body 全体を zoom し、チャート(.chart-panel)だけ逆 zoom で実寸を維持する。
(function setupUiZoom() {
  const KEY = 'ui-zoom';
  let zoom = parseFloat(localStorage.getItem(KEY) ?? '1') || 1;
  const apply = () => {
    document.documentElement.style.setProperty('--ui-zoom', String(zoom));
    document.documentElement.style.setProperty('--ui-zoom-inv', String(1 / zoom));
    localStorage.setItem(KEY, String(zoom));
  };
  apply();
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return;
    if (e.key === '+' || e.key === '=' || e.key === ';') {        // Ctrl + (= キーや日本語配列の ; も）
      zoom = Math.min(2, Math.round((zoom + 0.1) * 10) / 10); apply(); e.preventDefault();
    } else if (e.key === '-') {
      zoom = Math.max(0.6, Math.round((zoom - 0.1) * 10) / 10); apply(); e.preventDefault();
    } else if (e.key === '0') {
      zoom = 1; apply(); e.preventDefault();
    }
  });
})();

// v0.3.37: ウィンドウ×/終了時、設定の「完全終了」チェックが入っていれば collector も停止する。
// 既定(未チェック)はモニターのみ終了し、collector はデタッチ済みでバックグラウンド収集を継続。
// チェック状態は永続させない(起動時は常に未チェック=収集継続が既定)。非Tauri環境では何もしない。
void (async () => {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.onCloseRequested(async (event) => {
      // 常に preventDefault して明示的に exit する(preventDefault せずに自動クローズが
      // 効かない環境があり×で閉じられないため)。チェックありのときだけ collector も停止。
      event.preventDefault();
      const fullExit = (document.getElementById('settings-full-exit') as HTMLInputElement | null)?.checked ?? false;
      if (fullExit) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('stop_collector');
        } catch (err) {
          console.warn('[exit] stop_collector failed:', err);
        }
      }
      const p = await import('@tauri-apps/plugin-process');
      await p.exit(0);   // どちらの場合もアプリ終了。未チェックなら collector はデタッチ済みで生存。
    });
  } catch { /* 非Tauri(ブラウザ)では無視 */ }
})();

const apiStatusEl = document.getElementById('api-status');
if (apiStatusEl) initApiStatusPane(apiStatusEl);

const logsOpenBtn = document.getElementById('open-logs') as HTMLButtonElement | null;
if (logsOpenBtn) {
  initLogsModal({
    openBtn: logsOpenBtn,
    modal: document.getElementById('logs-modal') as HTMLElement,
    closeBtn: document.getElementById('logs-close') as HTMLButtonElement,
    backdrop: document.getElementById('logs-backdrop') as HTMLElement,
    contentEl: document.getElementById('logs-content') as HTMLElement,
    autoCheckbox: document.getElementById('logs-auto') as HTMLInputElement,
    clearBtn: document.getElementById('logs-clear') as HTMLButtonElement,
  });
}

const priceGridEl = document.getElementById('price-grid')!;
const newsListEl = document.getElementById('news-list')!;
const bannerEl = document.getElementById('alert-banner')!;
const levelsBodyEl = document.getElementById('levels-body');
if (levelsBodyEl) initLevelsPanel(levelsBodyEl);
// 当面、再起動後も直近アラートを残す（localStorage から復元）。
restoreSavedBanners(bannerEl);
const statusEl = document.getElementById('connection-status')!;
const clockEl = document.getElementById('clock')!;
const enableSoundBtn = document.getElementById('enable-sound') as HTMLButtonElement;
const leaderInfoEl = document.getElementById('leader-info')!;

function updateLeaderInfo() {
  const top = getCorrelationTop(3);
  const anchor = getAnchorSymbol();
  if (top.length === 0) {
    leaderInfoEl.innerHTML = `相関 (vs ${labelOf(anchor as never)}): <span style="opacity:0.6">取得中 / 市場休場の可能性</span>`;
    return;
  }
  const parts = top.map((r, i) => {
    const label = labelOf(r.symbol as never);
    const v = r.absCorr.toFixed(2);
    const n = r.samples;
    const body = `${label} ${v} <span style="opacity:0.55;font-size:11px">n=${n}</span>`;
    return i === 0 ? `<strong>${body}</strong>` : body;
  });
  leaderInfoEl.innerHTML = `相関 (vs ${labelOf(anchor as never)}): ${parts.join(' / ')}`;
}
updateLeaderInfo();
startCorrelationPolling(updateLeaderInfo);

setInterval(() => {
  const d = new Date();
  clockEl.textContent = `JST ${d.toLocaleTimeString('ja-JP', { hour12: false })}`;
}, 1000);

// バージョン表示 (起動時に1回取得) + Tauri内なら更新チェック
const versionEl = document.getElementById('app-version');
if (versionEl) {
  fetch(apiUrl('/api/version'))
    .then(r => r.json())
    .then((d: { version: string }) => { versionEl.textContent = `v${d.version}`; })
    .catch(() => { versionEl.textContent = 'v?'; });
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
    const displayed = new Set([getAnchorSymbol(), getCurrentLeader()]);
    renderPriceGrid(priceGridEl, prices, displayed);
    const niy = prices.find(p => p.symbol === 'NIY=F');
    if (niy) setLevelsPrice(niy.price);
  },
  onLevels: (levels) => setLevels(levels),
  onAlert: (alert) => {
    flashCard(priceGridEl, alert);
    alertBeep(alert.direction);
    const banner = addBanner(bannerEl, alert);
    scheduleExplanation(alert, banner);
  },
  onNews: (news) => renderNews(newsListEl, news),
});

const updateToastEl = document.getElementById('update-toast');
if (updateToastEl) void maybeShowUpdateToast(updateToastEl, 5000);
