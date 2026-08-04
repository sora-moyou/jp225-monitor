import { describe, it, expect } from 'vitest';
import { buildIndicatorHtml, rsiClass } from './indicatorPanel.js';
import type { IndicatorSnapshot } from '../types.js';

// buildIndicatorHtml / rsiClass は DOM 非依存の純関数。表示整形と RSI 色分類を検証する。
// 表示仕様(ユーザー指定)は「ヘッダ1行 + データ1行」の4列表:
//   RSI   0.7σ    14MA    -0.7σ
//   64.1  72,310  72,010  71,810
// ★列の並びは「上バンド → 中央(14MA) → 下バンド」= 値の大小と並びが一致する(ユーザー指定・v0.9.61)。

const base: IndicatorSnapshot = {
  rsi: 62, sma: 41230, bbUpper: 41410, bbMid: 41230, bbLower: 41050,
  price: 41300, pctB: 0.78, series: [],
};

/** class 出現数(行/セルの構造を数で確かめる)。 */
function count(html: string, cls: string): number {
  return (html.match(new RegExp(`class="[^"]*\\b${cls}\\b`, 'g')) ?? []).length;
}

describe('buildIndicatorHtml', () => {
  it('ヘッダは指定どおり RSI / 0.7σ / 14MA / -0.7σ の4列(この順)', () => {
    const html = buildIndicatorHtml(base);
    expect(count(html, 'ind-th')).toBe(4);
    for (const c of ['RSI', '0.7σ', '14MA', '-0.7σ']) expect(html).toContain(`>${c}<`);
    // ★並び順そのものを固定する(列名だけ直して値の順を直し忘れる事故を防ぐ)。
    const heads = [...html.matchAll(/class="ind-th"[^>]*>(?:<span class="ind-mark">[^<]*<\/span>)?<span>([^<]+)<\/span>/g)].map(m => m[1]);
    expect(heads).toEqual(['RSI', '0.7σ', '14MA', '-0.7σ']);
  });

  it('データ行は RSI=小数第1位 / 他3列=桁区切り整数(0.7σ=上限, 14MA=中央, -0.7σ=下限)', () => {
    const html = buildIndicatorHtml(base);
    expect(count(html, 'ind-td')).toBe(4);
    const tds = html.split('class="ind-td').slice(1);
    expect(tds[0]).toContain('62.0');       // RSI(小数第1位)
    expect(tds[1]).toContain('41,410');     // 0.7σ(上限)
    expect(tds[2]).toContain('41,230');     // 14MA(中央)
    expect(tds[3]).toContain('41,050');     // -0.7σ(下限)
    expect(html).not.toContain('蓄積中');
  });

  it('見出し「テクニカル(5分)」と %B / 価格位置は出さない(ユーザー指定の2行のみ)', () => {
    const html = buildIndicatorHtml(base);
    expect(html).not.toContain('テクニカル');
    expect(html).not.toContain('%B');
    expect(html).not.toContain('上寄り');
    expect(html).not.toContain('中央');
  });

  it('RSI の色分け(70以上=赤 / 30以下=緑)はデータセルに残す', () => {
    expect(buildIndicatorHtml({ ...base, rsi: 71.4 })).toContain('ind-rsi-ob');
    expect(buildIndicatorHtml({ ...base, rsi: 28.6 })).toContain('ind-rsi-os');
    expect(buildIndicatorHtml(base)).toContain('ind-rsi-neutral');
  });

  it('個別に欠けた値は — で埋め、列数(4)は崩さない', () => {
    const html = buildIndicatorHtml({ ...base, sma: null });
    expect(count(html, 'ind-td')).toBe(4);
    expect(html).toContain('—');
  });

  it('データ未到達(null)は「蓄積中…」', () => {
    expect(buildIndicatorHtml(null)).toContain('蓄積中');
    const empty: IndicatorSnapshot = { ...base, rsi: null, sma: null, bbUpper: null, bbLower: null, bbMid: null, pctB: null };
    expect(buildIndicatorHtml(empty)).toContain('蓄積中');
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
    expect(count(html, 'ind-td')).toBe(4);
    expect(html).toContain('62.0');
    expect(html).toContain('41,410');            // 0.7σ は残る
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
    expect(html).toContain('62.0');
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

// 価格ボード右隣の空き枠(旧・相関カード位置)に収める。列がずれないよう
// 「ヘッダ4セル + データ4セル」を1つのグリッド(.ind-grid)に入れる構造を守る。
describe('buildIndicatorHtml — 2行4列の表構造', () => {
  const nulls: IndicatorSnapshot = {
    ...base, rsi: null, sma: null, bbUpper: null, bbMid: null, bbLower: null, pctB: null, price: 0,
  };

  it('ヘッダとデータは同一グリッドに入れる(列位置を一致させるため)', () => {
    const html = buildIndicatorHtml(base);
    expect(count(html, 'ind-grid')).toBe(1);
    expect(html.indexOf('ind-th')).toBeLessThan(html.indexOf('ind-td'));   // ヘッダが先
  });

  it('値が無い状態でもヘッダ行(4列)は残し、理由は列をまたぐ1行(.ind-note)に出す', () => {
    for (const snap of [
      null,
      nulls,
      { ...nulls, progress: { state: 'warming', remaining: 7 } } as IndicatorSnapshot,
      { ...nulls, progress: { state: 'no-bars', remaining: 14 } } as IndicatorSnapshot,
      { ...nulls, progress: { state: 'closed', remaining: 14 } } as IndicatorSnapshot,
      { ...nulls, progress: { state: 'disabled', remaining: 14 } } as IndicatorSnapshot,
    ]) {
      const html = buildIndicatorHtml(snap);
      expect(count(html, 'ind-th')).toBe(4);
      expect(count(html, 'ind-note')).toBe(1);
      expect(count(html, 'ind-td')).toBe(0);
    }
  });

  it('値あり＋停止理由(取引時間外/OFF)の印はヘッダ行に置く(行を増やさない=2行のまま)', () => {
    const closed = buildIndicatorHtml({ ...base, progress: { state: 'closed', remaining: 0 } });
    expect(closed).toContain('ind-mark');
    expect(closed.indexOf('取引時間外')).toBeLessThan(closed.indexOf('ind-td'));   // ヘッダ行側にある
    expect(count(closed, 'ind-note')).toBe(0);
    const off = buildIndicatorHtml({ ...base, progress: { state: 'disabled', remaining: 0 } });
    expect(off).toContain('ind-mark');
    expect(off.indexOf('OFF')).toBeLessThan(off.indexOf('ind-td'));
  });

  // U+301C(WAVE DASH)は cp932 環境で '?' に化ける。範囲は列に分割したので区切り文字自体が不要に
  // なったが、再び範囲表記に戻したときのために U+301C の混入を禁止しておく。
  it('U+301C(〜)を含まない(cp932 文字化け対策)', () => {
    expect(buildIndicatorHtml(base)).not.toContain('〜');
    expect(buildIndicatorHtml(null)).not.toContain('〜');
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
