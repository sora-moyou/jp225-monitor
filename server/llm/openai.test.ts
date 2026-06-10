import { describe, it, expect } from 'vitest';
import { formatCrossAsset, explain, selectNewsPool } from './openai.js';
import type { Mover } from '../marketSnapshot.js';
import type { NewsItem } from '../types.js';

describe('formatCrossAsset', () => {
  it('returns a "no linkage" line when there are no movers', () => {
    expect(formatCrossAsset([])).toBe('【他資産】同時刻に目立った連動なし。');
  });

  it('formats movers with arrow, signed percent, window and z', () => {
    const movers: Mover[] = [
      { symbol: 'NQ=F', label: 'ナスダック100先物', changePercent: -1.85, windowSeconds: 300, z: 4.3, direction: 'down' },
      { symbol: 'JPY=X', label: 'ドル円', changePercent: 0.42, windowSeconds: 60, z: 4.1, direction: 'up' },
    ];
    const out = formatCrossAsset(movers);
    expect(out).toContain('【同時刻に大きく動いた他資産(z>=4.0)】');
    expect(out).toContain('- ナスダック100先物 ▼ -1.85% (5分, z=4.3)');
    expect(out).toContain('- ドル円 ▲ +0.42% (1分, z=4.1)');
  });
});

const news = (id: string, ageMin: number): NewsItem => ({
  id, title: `news ${id}`, source: 'test', lang: 'ja', url: 'x', publishedAt: Date.now() - ageMin * 60_000,
});

describe('selectNewsPool sinceFloor (①: 直前の急変以降)', () => {
  it('sinceFloor より古いニュースは除外', () => {
    const now = Date.now();
    const items = [news('old', 50), news('new', 5)];
    const since = now - 20 * 60_000;   // 20分前以降のみ
    const pool = selectNewsPool(items, now, since);
    expect(pool.map(n => n.id)).toEqual(['new']);
  });
});

describe('explain ①ファンダ/テクニカル判定', () => {
  it('値動き(急変)で参照窓内にニュースが無ければ、LLMを呼ばず「テクニカル要因の可能性」+L2併記', async () => {
    const { text } = await explain({
      symbol: 'NIY=F', symbolLabel: '日経225先物', changePercent: -0.4, windowSeconds: 60,
      detectionKind: 'shock', direction: 'down', change15min: null, pa15min: null, range1h: null,
      news: [news('old', 300)], newsSince: Date.now() - 10 * 60_000,   // 窓内(10分)にニュース無し
      l2Recent: '水準ブレイク 67,470 ▼',
    });
    expect(text).toContain('テクニカル要因の可能性');
    expect(text).toContain('水準ブレイク 67,470 ▼');
  });
});
