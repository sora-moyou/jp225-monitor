import { describe, it, expect } from 'vitest';
import { buildIndicatorHtml, rsiClass } from './indicatorPanel.js';
import type { IndicatorSnapshot } from '../types.js';

// buildIndicatorHtml / rsiClass は DOM 非依存の純関数。表示整形と RSI 色分類を検証する。

const base: IndicatorSnapshot = {
  rsi: 62, sma: 41230, bbUpper: 41410, bbMid: 41230, bbLower: 41050,
  price: 41300, pctB: 0.78, series: [],
};

describe('buildIndicatorHtml', () => {
  it('主指標が揃えば RSI/SMA/BB/価格位置を表示', () => {
    const html = buildIndicatorHtml(base);
    expect(html).toContain('RSI');
    expect(html).toContain('62');
    expect(html).toContain('41,230');            // SMA(桁区切り)
    expect(html).toContain('41,050〜41,410');     // BB
    expect(html).toContain('%B 0.78');
    expect(html).not.toContain('蓄積中');
  });
  it('データ未到達(null)は「蓄積中…」', () => {
    expect(buildIndicatorHtml(null)).toContain('蓄積中');
    const empty: IndicatorSnapshot = { ...base, rsi: null, sma: null, bbUpper: null, bbLower: null, bbMid: null, pctB: null };
    expect(buildIndicatorHtml(empty)).toContain('蓄積中');
  });
  it('%B が高い/低いで位置ラベルが変わる', () => {
    expect(buildIndicatorHtml({ ...base, pctB: 0.9 })).toContain('上寄り');
    expect(buildIndicatorHtml({ ...base, pctB: 0.1 })).toContain('下寄り');
    expect(buildIndicatorHtml({ ...base, pctB: 0.5 })).toContain('中央');
  });
});

// 「蓄積中…」が何も語らないと、別PC(インストール版)で原因(データ未取得 or 単なる本数不足)を
// 画面だけで切り分けられない。progress(ADD-ONLY)で A/B/C の3状態を区別する。
describe('buildIndicatorHtml — 蓄積状況の自己診断表示', () => {
  const nulls: IndicatorSnapshot = {
    ...base, rsi: null, sma: null, bbUpper: null, bbMid: null, bbLower: null, pctB: null, price: 0,
  };

  it('A: 窓内の1分足が0本(no-bars)は「足データ未取得」と分かる文言を出す', () => {
    const html = buildIndicatorHtml({ ...nulls, progress: { state: 'no-bars', remaining: 14 } });
    expect(html).toContain('足データ未取得');
    expect(html).not.toContain('蓄積中');
  });

  it('B: 足はあるが本数不足(warming)は「蓄積中… あと○本(約○分)」= 5分足単位の待ち時間も出す', () => {
    const html = buildIndicatorHtml({ ...nulls, progress: { state: 'warming', remaining: 7 } });
    expect(html).toContain('蓄積中');
    expect(html).toContain('あと7本(約35分)');     // 5分足 × 7本
    expect(html).not.toContain('足データ未取得');
    expect(buildIndicatorHtml({ ...nulls, progress: { state: 'warming', remaining: 13 } }))
      .toContain('あと13本(約65分)');
  });

  // 引け後に「そのセッションが最終的にどこで終わったか(RSI/BB)」を見るのは実用的な用途なので、
  // 値がある限り数値は消さない。理由(取引時間外/OFF)は印として併記する。
  it('D-1: 値あり + closed は「数値 ＋ 取引時間外の印」(数値を消さない)', () => {
    const html = buildIndicatorHtml({ ...base, progress: { state: 'closed', remaining: 0 } });
    expect(html).toContain('RSI');
    expect(html).toContain('62');
    expect(html).toContain('41,050〜41,410');   // BB は残る
    expect(html).toContain('取引時間外');
    expect(html).not.toContain('蓄積中');
  });

  it('E-1: 値あり + disabled は「数値 ＋ OFF の印」', () => {
    const html = buildIndicatorHtml({ ...base, progress: { state: 'disabled', remaining: 0 } });
    expect(html).toContain('41,230');
    expect(html).toContain('OFF');
    expect(html).not.toContain('蓄積中');
  });

  it('D: 値なし + closed は理由のみ(「取引時間外」・蓄積中…で無言にしない)', () => {
    const html = buildIndicatorHtml({ ...nulls, progress: { state: 'closed', remaining: 14 } });
    expect(html).toContain('取引時間外');
    expect(html).not.toContain('蓄積中');
  });

  it('E: 機能OFF(disabled)は設定で切れていることを出す', () => {
    const html = buildIndicatorHtml({ ...nulls, progress: { state: 'disabled', remaining: 14 } });
    expect(html).toContain('OFF');
    expect(html).not.toContain('蓄積中');
  });

  it('C: 算出済みは従来どおり数値表示(progress があっても壊れない)', () => {
    const html = buildIndicatorHtml({ ...base, progress: { state: 'ready', remaining: 0 } });
    expect(html).toContain('RSI');
    expect(html).toContain('41,230');
    expect(html).not.toContain('蓄積中');
    expect(html).not.toContain('あと');
  });

  it('progress が無い(旧世代/未接続)ときは従来どおり「蓄積中…」のみ', () => {
    expect(buildIndicatorHtml(nulls)).toContain('蓄積中');
    expect(buildIndicatorHtml(nulls)).not.toContain('あと');
    expect(buildIndicatorHtml(null)).toContain('蓄積中');
  });
});

describe('rsiClass', () => {
  it('≥70=買われすぎ / ≤30=売られすぎ / それ以外=中立', () => {
    expect(rsiClass(72)).toBe('ind-rsi-ob');
    expect(rsiClass(28)).toBe('ind-rsi-os');
    expect(rsiClass(50)).toBe('ind-rsi-neutral');
    expect(rsiClass(null)).toBe('ind-rsi-neutral');
  });
});
