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
import { initAlertsHistoryModal } from './components/alertsHistoryModal.js';
import { maybeShowUpdateToast } from './components/updateToast.js';
import { startCorrelationPolling, getCorrelationTop, getAnchorSymbol, getCurrentLeader, getTopSymbolChange1m } from './lib/correlationClient.js';
import { initLevelsPanel, setLevels, setLevelsPrice } from './components/levelsPanel.js';
import { renderSignalPanel, initSignalSoundToggle } from './components/signalPanel.js';
import { initSignalTradesModal, initSignalClearButton } from './components/signalTradesModal.js';
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
  // ダブルクリックで初期比率 (1:1) に戻す
  handle.addEventListener('dblclick', () => {
    grid.style.removeProperty('--left-fr');
    grid.style.removeProperty('--right-fr');
    localStorage.removeItem(storageKey);
  });
}

// アラート高さ: ハンドルはアラートの下にある (下ドラッグでアラート拡大)
setupResize('alerts-resize', '.alerts-pane', 'alerts-height', 100);
// ニュース高さ: ハンドルはニュースの上(チャートとの境界)にある (上ドラッグでニュース拡大)
setupResize('news-resize', '.news-feed', 'news-height', 80);
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
  inputWebSearch:      document.getElementById('key-websearch') as HTMLInputElement,
  inputWebSearchModel: document.getElementById('key-websearch-model') as HTMLInputElement,
  inputWebSearchOpenaiModel: document.getElementById('key-websearch-openai-model') as HTMLInputElement,
  inputScalpLcCeiling: document.getElementById('scalp-lc-ceiling') as HTMLInputElement,
  selectScalpBias:     document.getElementById('scalp-bias') as HTMLSelectElement,
  inputScalpCooldown:  document.getElementById('scalp-cooldown') as HTMLInputElement,
  statusArea:     document.getElementById('settings-status-area') as HTMLElement,
  backdrop:       document.getElementById('settings-backdrop') as HTMLElement,
  checkUpdateBtn: document.getElementById('settings-check-update') as HTMLButtonElement,
  updateResult:   document.getElementById('settings-update-result') as HTMLElement,
  currentVersion: document.getElementById('settings-current-version') as HTMLElement,
  mergeDbBtn:     document.getElementById('settings-merge-db') as HTMLButtonElement,
  mergeResult:    document.getElementById('settings-merge-result') as HTMLElement,
  exportDbBtn:    document.getElementById('settings-export-db') as HTMLButtonElement,
  exportResult:   document.getElementById('settings-export-result') as HTMLElement,
  replaceDbBtn:   document.getElementById('settings-replace-db') as HTMLButtonElement,
  replaceResult:  document.getElementById('settings-replace-result') as HTMLElement,
  testKeysBtn:    document.getElementById('settings-test-keys') as HTMLButtonElement,
  testResult:     document.getElementById('settings-test-result') as HTMLElement,
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

initAlertsHistoryModal({
  openBtn:  document.getElementById('alerts-history-btn') as HTMLButtonElement,
  modal:    document.getElementById('alerts-history-modal') as HTMLElement,
  backdrop: document.getElementById('alerts-history-backdrop') as HTMLElement,
  closeBtn: document.getElementById('alerts-history-close') as HTMLButtonElement,
  summary:  document.getElementById('alerts-history-summary') as HTMLElement,
  body:     document.getElementById('alerts-history-body') as HTMLElement,
});

// トレードシグナル履歴・収益曲線モーダル
const signalTradesModalEl = document.getElementById('signal-trades-modal') as HTMLElement | null;
if (signalTradesModalEl) {
  initSignalTradesModal({
    openBtn:  document.getElementById('signal-trades-btn') as HTMLButtonElement,
    modal:    signalTradesModalEl,
    backdrop: document.getElementById('signal-trades-backdrop') as HTMLElement,
    closeBtn: document.getElementById('signal-trades-close') as HTMLButtonElement,
    summary:  document.getElementById('signal-trades-summary') as HTMLElement,
    body:     document.getElementById('signal-trades-body') as HTMLElement,
    canvas:   document.getElementById('signal-trades-equity') as HTMLCanvasElement,
  });
}

// 設定モーダル内: シグナル音トグル + 履歴消去ボタン
const signalSoundToggle = document.getElementById('settings-signal-sound') as HTMLInputElement | null;
if (signalSoundToggle) initSignalSoundToggle(signalSoundToggle);
const clearSignalBtn = document.getElementById('settings-clear-signal') as HTMLButtonElement | null;
const clearSignalResult = document.getElementById('settings-clear-signal-result') as HTMLElement | null;
if (clearSignalBtn && clearSignalResult) {
  initSignalClearButton(clearSignalBtn, clearSignalResult, () => {
    (signalTradesModalEl as unknown as { _reloadSignalTrades?: () => void } | null)?._reloadSignalTrades?.();
  });
}

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
const signalPanelEl = document.getElementById('signal-panel');
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
  // v0.7.20: 最も相関の高い銘柄には直近1分の変化率(急落率)を付記する。
  const { symbol: topSym, change1mPct } = getTopSymbolChange1m();
  const chg1m = (sym: string): string => {
    if (sym !== topSym || change1mPct === null) return '';
    const cls = change1mPct >= 0 ? '#4caf50' : '#e53935';
    const sign = change1mPct >= 0 ? '+' : '';
    return ` <span style="color:${cls};font-size:11px">1分 ${sign}${change1mPct.toFixed(2)}%</span>`;
  };
  const parts = top.map((r, i) => {
    const label = labelOf(r.symbol as never);
    const v = r.absCorr.toFixed(2);
    const n = r.samples;
    const body = `${label} ${v} <span style="opacity:0.55;font-size:11px">n=${n}</span>${chg1m(r.symbol)}`;
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

// チャートパターン由来(グランビル/ダブルトップ・ボトム)はニュースAI説明ではなく固定文を表示。
function isTechnicalPattern(alert: import('./types.js').AlertEvent): boolean {
  const k = alert.detectionKind;
  return k === 'granville' || k === 'dtb' || k === 'break' || k === 'ma' || k === 'swingdtb'
    || k === 'double' || k === 'ma_sr' || k === 'level_sr' || k === 'pivot' || k === 'trend';
}
// テクニカル系の固定文。ダブル=「価格xxxでダブルトップ/ボトムの可能性あり」、
// グランビル=「価格xxxで押し目買い/戻り売り/買い転換/売り転換」。それ以外は「テクニカル要因」。
function technicalExplanation(alert: import('./types.js').AlertEvent): string {
  const yen = (p?: number): string => (p ? `${p.toLocaleString('ja-JP')}で` : '');
  if (alert.detectionKind === 'dtb') {
    const kind = alert.direction === 'down' ? UI.ja.doubleTopMaybe : UI.ja.doubleBottomMaybe;
    return `${yen(alert.level)}${kind}`;
  }
  if (alert.detectionKind === 'granville') {
    const sig = (alert.note ?? '').replace(/^グランビル/, '') || UI.ja.technicalReason;   // 押し目買い/戻り売り/買い転換/売り転換
    return `${yen(alert.level)}${sig}`;
  }
  if (alert.detectionKind === 'break') {
    // サーバ note が「{価格} {ラベル}を{上抜け/下抜け}(水準抜けの可能性あり)」。無ければ level から組み立て。
    return alert.note ?? `${(alert.level ?? 0).toLocaleString('ja-JP')}${UI.ja.levelBreakMaybe}`;
  }
  if (alert.detectionKind === 'ma') {
    // サーバ note が「25MA上抜け/下抜けの可能性あり」(固定価格は出さない=MAは動く基準のため)。
    return alert.note ?? UI.ja.technicalReason;
  }
  if (alert.detectionKind === 'swingdtb') {
    // サーバ note が「ダブルボトム成立/形成 — ネック…」(長周期スイングのW/M反転)。
    return alert.note ?? UI.ja.technicalReason;
  }
  // v0.6.0 再設計の現行種別はサーバ note が明確文(「{基準名}{動作}の可能性」)。そのまま表示。
  if (alert.detectionKind === 'double' || alert.detectionKind === 'ma_sr'
      || alert.detectionKind === 'level_sr' || alert.detectionKind === 'pivot'
      || alert.detectionKind === 'trend') {
    return alert.note ?? UI.ja.technicalReason;
  }
  return UI.ja.technicalReason;
}

function scheduleExplanation(alert: import('./types.js').AlertEvent, banner: ReturnType<typeof addBanner>) {
  // テクニカル系は LLM を呼ばず固定文。🔄 でも同じ文を出す(API消費なし)。
  if (isTechnicalPattern(alert)) {
    const text = technicalExplanation(alert);
    banner.refresh = () => setExplanation(banner, text);
    setExplanation(banner, text);
    return;
  }

  // 🔄ボタン: クールダウンを無視して即LLM
  banner.refresh = () => callLLM(alert, banner);

  // 暴落(crash)は重大イベント。スロットルを無視して即座にAI原因分析を取得する(ユーザー指定)。
  if (alert.detectionKind === 'crash') { callLLM(alert, banner); return; }

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

// v0.7.24: 市場開場フラグ。閉場(取引時間外)なら価格ボードで NIY=F を「取引時間外」と表示する。
// 既定 true(未受信のうちは従来どおり)。最新の prices を保持して market 変化時に再描画する。
let marketOpen = true;
let lastPrices: Parameters<typeof renderPriceGrid>[1] = [];
function paintPrices(): void {
  const displayed = new Set([getAnchorSymbol(), getCurrentLeader()]);
  renderPriceGrid(priceGridEl, lastPrices, displayed, marketOpen);
}

connectStream({
  onStatusChange: setStatus,
  onPrices: (prices) => {
    lastPrices = prices;
    paintPrices();
    const niy = prices.find(p => p.symbol === 'NIY=F');
    // stale(socket 停止/取得不能)フラグも渡す。stale の凍結値をライブ風に見せず、
    // 水準パネルの現値マーカーを「取得不能」にする(価格カードと整合)。
    if (niy) setLevelsPrice(niy.price, niy.stale === true);
  },
  onMarket: (open) => {
    if (open === marketOpen) return;
    marketOpen = open;
    paintPrices();   // 市場開閉が切り替わったら再描画(取引時間外↔取得不能の表示を更新)
  },
  onLevels: (levels) => setLevels(levels),
  onAlert: (alert) => {
    flashCard(priceGridEl, alert);
    alertBeep(alert.direction);
    const banner = addBanner(bannerEl, alert);
    scheduleExplanation(alert, banner);
  },
  onNews: (news) => renderNews(newsListEl, news),
  onSignalTrade: (s) => { if (signalPanelEl) renderSignalPanel(signalPanelEl, s); },
});

const updateToastEl = document.getElementById('update-toast');
if (updateToastEl) void maybeShowUpdateToast(updateToastEl, 5000);
