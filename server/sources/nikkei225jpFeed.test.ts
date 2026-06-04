import { describe, it, expect } from 'vitest';
import { parseAjaxTop, extractOseMini, extractFeedPrices } from './nikkei225jpFeed.js';

// nikkei225jp.com /ajaxindex/ajax_TOP.js の実サンプル断片 (2026-06-01 10:07 JST)。
// 形式: A[code]="値_前日比_騰落率_時刻_フラグ_高値_安値";
const SAMPLE = `A[111]="66604.27_+274.77_+0.41_09:35_1_66823.36_66244.84";
A[136]="66645.00_+195.00_+0.29_09:35_1__";
A[139]="66650.00_+180.00_+0.27_09:35_1__";
A[717]="66560.00_+335.00_+0.51_09:24_1__";
A[731]="51052.90_+120.00_+0.24_10:06_1__";
A[733]="25145.20_+80.00_+0.32_10:06_1__";
A[737]="30468.70_-30.00_-0.10_10:06_1__";
A[921]="89.59_+0.50_+0.56_10:05_1__";
A[811]="4.468_+0.015_+0.34_10:05_1__";
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

describe('extractFeedPrices (複数銘柄一括: NIY=F/NQ=F/YM=F/CL=F/^TNX/JPY=X)', () => {
  it('マッピング済みの全銘柄を Price 配列で返す', () => {
    const now = 1780274820000;
    const prices = extractFeedPrices(SAMPLE, now);
    const bySym = Object.fromEntries(prices.map(p => [p.symbol, p]));
    expect(bySym['NIY=F']!.price).toBe(66645);   // 136
    expect(bySym['YM=F']!.price).toBe(51052.9);  // 731 ダウCFD
    expect(bySym['NQ=F']!.price).toBe(30468.7);  // 737 NAS100 CFD
    expect(bySym['^HSI']!.price).toBe(25145.2);  // 733 香港ハンセン CFD
    expect(bySym['CL=F']!.price).toBe(89.59);    // 921 WTI
    expect(bySym['^TNX']!.price).toBe(4.468);    // 811 10年債
    expect(bySym['JPY=X']!.price).toBe(159.438); // 511 ドル円
    expect(prices.every(p => p.timestamp === now && p.stale === false)).toBe(true);
  });

  it('feed に無いコードの銘柄はスキップ (ES=F/VIX は含まれない)', () => {
    const prices = extractFeedPrices(SAMPLE, 1);
    const syms = prices.map(p => p.symbol);
    expect(syms).not.toContain('ES=F');
    expect(syms).not.toContain('^VIX');
  });

  it('壊れた値の銘柄だけ除外し、残りは返す', () => {
    const broken = 'A[136]="66645_+1_+0.1_10:06_1__";\nA[737]="-_-_-_10:06_1__";';
    const prices = extractFeedPrices(broken, 1);
    const syms = prices.map(p => p.symbol);
    expect(syms).toContain('NIY=F');
    expect(syms).not.toContain('NQ=F');   // 737 が壊れている
  });
});

describe('extractFeedPrices 鮮度(stale)判定', () => {
  it('時刻[3]が HH:MM の取引中は stale=false', () => {
    expect(extractOseMini('A[136]="67580.00_+10_+0.01_15:44_1__";', 1)!.stale).toBe(false);
  });

  it('立会外で時刻[3]が日付("06/04")・フラグ0 の停止中は stale=true(実feed断片)', () => {
    // 15:45-17:00 休憩中に実観測した OSE mini(136)の停止形。値(67640)は last/参照で残るが
    // 約定していないので stale 扱いにする(これを false にすると幽霊バー→誤検知になる)。
    const p = extractOseMini('A[136]="67640.00_-915.00_-1.33_06/04_0__";', 1);
    expect(p).not.toBeNull();
    expect(p!.price).toBe(67640);
    expect(p!.stale).toBe(true);
  });

  it('時刻[3]が空/不正なら安全側で stale=true', () => {
    expect(extractOseMini('A[136]="67640_-1_-0.1__0__";', 1)!.stale).toBe(true);     // 時刻欄が空
    expect(extractOseMini('A[136]="67640_-1_-0.1_-_0__";', 1)!.stale).toBe(true);    // 時刻欄が "-"
  });

  it('混在: 取引中(JPY/NQ=HH:MM)は stale=false、停止中(OSE mini=日付)は stale=true', () => {
    const mixed = 'A[136]="67640.00_-915_-1.33_06/04_0__";\n'
      + 'A[511]="159.891_-0.157_-0.10_16:28_1_160.066_159.585";\n'
      + 'A[737]="30440.90_+8.30_+0.03_16:28_1__";';
    const bySym = Object.fromEntries(extractFeedPrices(mixed, 1).map(p => [p.symbol, p]));
    expect(bySym['NIY=F']!.stale).toBe(true);
    expect(bySym['JPY=X']!.stale).toBe(false);
    expect(bySym['NQ=F']!.stale).toBe(false);
  });
});
