import { describe, it, expect } from 'vitest';
import { parseAjaxTop, extractOseMini } from './nikkei225jpFeed.js';

// nikkei225jp.com /ajaxindex/ajax_TOP.js の実サンプル断片 (2026-06-01 09:35 JST)。
// 形式: A[code]="値_前日比_騰落率_時刻_フラグ_高値_安値";
const SAMPLE = `A[111]="66604.27_+274.77_+0.41_09:35_1_66823.36_66244.84";
A[136]="66645.00_+195.00_+0.29_09:35_1__";
A[139]="66650.00_+180.00_+0.27_09:35_1__";
A[717]="66560.00_+335.00_+0.51_09:24_1__";
A[511]="159.438_+0.160_+0.10_09:35_1_159.451_159.297";`;

describe('parseAjaxTop', () => {
  it('A[code]="..." 行を code→fields に分解する', () => {
    const map = parseAjaxTop(SAMPLE);
    expect(map.get('136')).toEqual(['66645.00', '+195.00', '+0.29', '09:35', '1', '', '']);
    expect(map.get('511')![0]).toBe('159.438');
  });

  it('該当行が無ければ undefined', () => {
    expect(parseAjaxTop(SAMPLE).get('999')).toBeUndefined();
  });

  it('空文字や壊れた入力でも例外を投げない', () => {
    expect(parseAjaxTop('').size).toBe(0);
    expect(parseAjaxTop('garbage <<>>').size).toBe(0);
  });
});

describe('extractOseMini (code 136 = 日経225先物mini OSE)', () => {
  it('OSE mini を Price(NIY=F) に変換し、timestamp は注入値を使う', () => {
    const now = 1780272900000;
    const p = extractOseMini(SAMPLE, now);
    expect(p).toEqual({
      symbol: 'NIY=F',
      price: 66645,
      changePercent: 0.29,
      timestamp: now,   // feed の HH:MM は使わず wall-clock を注入 (超短期検知の解像度確保)
      stale: false,
    });
  });

  it('code 136 が無ければ null', () => {
    expect(extractOseMini('A[717]="66560_+335_+0.51_09:24_1__";', 1)).toBeNull();
  });

  it('価格が数値でなければ null', () => {
    expect(extractOseMini('A[136]="-_-_-_09:35_1__";', 1)).toBeNull();
  });

  it('騰落率が壊れていても price が有効なら changePercent=0 で返す', () => {
    const p = extractOseMini('A[136]="66645.00___09:35_1__";', 5);
    expect(p).not.toBeNull();
    expect(p!.changePercent).toBe(0);
    expect(p!.price).toBe(66645);
  });
});
