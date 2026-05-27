import { INSTRUMENTS } from '../../server/config.js';
import type { Symbol } from '../types.js';

const LABEL_MAP = new Map(INSTRUMENTS.map(i => [i.symbol, i]));

export function labelOf(symbol: Symbol): string {
  return LABEL_MAP.get(symbol)?.labelJa ?? symbol;
}

export function metaOf(symbol: Symbol) {
  return LABEL_MAP.get(symbol);
}

export const UI = {
  ja: {
    news: 'ニュース',
    connecting: '接続中…',
    online: '受信中',
    offline: '切断',
    explanationLoading: '(説明取得中…)',
    explanationFailed: '(説明取得失敗)',
    flash: 'フラッシュ',
    trend: 'トレンド',
    enableSound: '🔔 サウンドを有効化',
  },
};
