import type { Price, NewsItem, AlertEvent, LevelsResult, IndicatorSnapshot } from '../types.js';
import type { SignalTradeState } from '../components/signalPanel.js';
import { apiUrl } from './apiBase.js';

interface StreamHandlers {
  onPrices: (prices: Price[]) => void;
  onNews: (news: NewsItem[]) => void;
  onAlert: (alert: AlertEvent) => void;
  onLevels: (levels: LevelsResult) => void;
  onStatusChange: (status: 'connecting' | 'online' | 'offline') => void;
  // テクニカル指標(RSI/SMA/BB)。backend の broadcast({type:'indicators'}) を受ける。省略可。
  onIndicators?: (snap: IndicatorSnapshot) => void;
  // v0.7.24: 市場開場フラグ。閉場(取引時間外)なら価格ボードが「取引時間外」と表示する。省略可(任意ハンドラ)。
  onMarket?: (open: boolean) => void;
  // トレードシグナル (表示専用・紙トラッキング)。backend の broadcast({type:'signalTrade'}) を受ける。省略可。
  onSignalTrade?: (s: SignalTradeState) => void;
  // ★v0.8.2: System B(紙専用の並走系統)。backend の broadcast({type:'signalTradeB'}) を受ける。省略可。
  onSignalTradeB?: (s: SignalTradeState) => void;
}

export function connectStream(handlers: StreamHandlers): () => void {
  let es: EventSource | null = null;
  let closed = false;

  function open() {
    if (closed) return;
    handlers.onStatusChange('connecting');
    es = new EventSource(apiUrl('/api/stream'));

    es.addEventListener('open', () => handlers.onStatusChange('online'));

    es.addEventListener('prices', (e) => {
      try { handlers.onPrices(JSON.parse((e as MessageEvent).data)); }
      catch (err) { console.error('parse prices', err); }
    });

    es.addEventListener('news', (e) => {
      try { handlers.onNews(JSON.parse((e as MessageEvent).data)); }
      catch (err) { console.error('parse news', err); }
    });

    es.addEventListener('alert', (e) => {
      try { handlers.onAlert(JSON.parse((e as MessageEvent).data)); }
      catch (err) { console.error('parse alert', err); }
    });

    es.addEventListener('levels', (e) => {
      try { handlers.onLevels(JSON.parse((e as MessageEvent).data)); }
      catch (err) { console.error('parse levels', err); }
    });

    es.addEventListener('indicators', (e) => {
      try { handlers.onIndicators?.(JSON.parse((e as MessageEvent).data)); }
      catch (err) { console.error('parse indicators', err); }
    });

    es.addEventListener('signalTrade', (e) => {
      try { handlers.onSignalTrade?.(JSON.parse((e as MessageEvent).data)); }
      catch (err) { console.error('parse signalTrade', err); }
    });

    es.addEventListener('signalTradeB', (e) => {
      try { handlers.onSignalTradeB?.(JSON.parse((e as MessageEvent).data)); }
      catch (err) { console.error('parse signalTradeB', err); }
    });

    es.addEventListener('market', (e) => {
      try {
        const { open } = JSON.parse((e as MessageEvent).data) as { open: boolean };
        handlers.onMarket?.(open === true);
      } catch (err) { console.error('parse market', err); }
    });

    es.addEventListener('error', () => {
      handlers.onStatusChange('offline');
      es?.close();
      es = null;
      // EventSource はブラウザが自動再接続するが、close 後は手動で再オープン
      if (!closed) setTimeout(open, 3000);
    });
  }

  open();
  return () => { closed = true; es?.close(); };
}
