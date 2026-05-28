// TradingView 埋め込みチャート
// 銘柄変更: CHART_SYMBOL を編集（例: 'CME:NK1!', 'TVC:NI225', 'OANDA:JP225USD'）
// 足変更: CHART_INTERVAL を編集（'1','5','15','60','240','D' など）

declare global {
  interface Window {
    TradingView?: { widget: new (config: Record<string, unknown>) => unknown };
  }
}

const TV_SCRIPT_URL = 'https://s3.tradingview.com/tv.js';
const CHART_SYMBOL = 'FOREXCOM:JPN225';   // FOREXCOM Japan 225 CFD
const CHART_INTERVAL = '15';              // 15分足

let scriptPromise: Promise<void> | null = null;

function loadTVScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TV_SCRIPT_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load TradingView script'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export async function mountChart(containerId: string): Promise<void> {
  const container = document.getElementById(containerId);
  if (!container) return;
  try {
    await loadTVScript();
    if (!window.TradingView) throw new Error('TradingView global not present');
    new window.TradingView.widget({
      autosize: true,
      symbol: CHART_SYMBOL,
      interval: CHART_INTERVAL,
      timezone: 'Asia/Tokyo',
      theme: 'dark',
      style: '1',
      locale: 'ja',
      enable_publishing: false,
      hide_top_toolbar: false,
      hide_legend: false,
      hide_volume: true,                           // 出来高ペインを非表示
      save_image: false,
      container_id: containerId,
      allow_symbol_change: true,
      withdateranges: true,
      disabled_features: ['create_volume_indicator_by_default'],
    });
  } catch (err) {
    console.error('[chart] mount failed:', err);
    container.textContent = '(チャート読み込み失敗 — インターネット接続を確認)';
    container.style.padding = '20px';
    container.style.color = 'var(--muted)';
  }
}
