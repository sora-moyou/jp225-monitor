import { describe, it, expect } from 'vitest';
import { buildIndicatorHtml, rsiClass, trendClass } from './indicatorPanel.js';
import type { IndicatorSnapshot, SqueezeSnapshotPayload } from '../types.js';

// buildIndicatorHtml / rsiClass / trendClass は DOM 非依存の純関数。
// 検査は **実際に描画した HTML 文字列** に対して行う(存在確認だけの grep にしない)。
// 表示仕様は「ヘッダ1行 + データ1行」の4列表:
//   RSI   %B    BW     BWhigh/low
//   62.0  0.83  1.42   2.10/0.61
// ★2026-08-15: 列を「バンドの価格3本(0.7σ / 14MA / -0.7σ)」から「バンドの形(%B / BW / 125本の高安)」へ
//   差し替えた。価格そのものは左隣の価格ボードで読めるため、パネルは価格ボードに無い情報だけを持つ。
// ★%B と BW は1本前と比較して 増加=緑(.ind-up)/ 減少=橙(.ind-down)/ 同値=無印。

/** スクイーズ用スナップショット(5分足20本/2σ)。テストごとに値を差し替える。 */
function sq(over: Partial<SqueezeSnapshotPayload> = {}): SqueezeSnapshotPayload {
  return {
    pctB: 0.83, prevPctB: 0.70, bw: 1.42, prevBw: 1.80,
    bwHigh: 2.10, bwLow: 0.61, ready: true, state: null, ...over,
  };
}

const base: IndicatorSnapshot = {
  rsi: 62, sma: 41230, bbUpper: 41410, bbMid: 41230, bbLower: 41050,
  price: 41300, pctB: 0.78, series: [], squeeze: sq(),
};

/** class 出現数(行/セルの構造を数で確かめる)。 */
function count(html: string, cls: string): number {
  return (html.match(new RegExp(`class="[^"]*\\b${cls}\\b`, 'g')) ?? []).length;
}

/** データセルを列ごとに切り出す(セル単位で値と色を検査するため)。 */
function cells(html: string): string[] {
  return html.split('class="ind-td').slice(1);
}

describe('buildIndicatorHtml', () => {
  it('ヘッダは RSI / %B / BW / BWhigh/low の4列(この順)', () => {
    const html = buildIndicatorHtml(base);
    expect(count(html, 'ind-th')).toBe(4);
    for (const c of ['RSI', '%B', 'BW', 'BWhigh/low']) expect(html).toContain(`>${c}<`);
    // ★並び順そのものを固定する(列名だけ直して値の順を直し忘れる事故を防ぐ)。
    const heads = [...html.matchAll(/class="ind-th"[^>]*>(?:<span class="ind-mark">[^<]*<\/span>)?<span>([^<]+)<\/span>/g)].map(m => m[1]);
    expect(heads).toEqual(['RSI', '%B', 'BW', 'BWhigh/low']);
  });

  it('データ行は RSI=小数1桁 / %B・BW=小数2桁 / 高安=「2.10/0.61」', () => {
    const html = buildIndicatorHtml(base);
    expect(count(html, 'ind-td')).toBe(4);
    const td = cells(html);
    expect(td[0]).toContain('62.0');        // RSI
    expect(td[1]).toContain('0.83');        // %B
    expect(td[2]).toContain('1.42');        // BW
    expect(td[3]).toContain('2.10/0.61');   // BWhigh/low
    expect(html).not.toContain('蓄積中');
  });

  // 旧列(バンドの価格)は価格ボードと重複していたので出さない。数値も列名も残っていたら赤。
  it('★旧列(0.7σ / 14MA / -0.7σ と その価格)は出さない', () => {
    const html = buildIndicatorHtml(base);
    for (const gone of ['0.7σ', '-0.7σ', '14MA', '41,410', '41,230', '41,050']) {
      expect(html).not.toContain(gone);
    }
  });

  it('見出し「テクニカル(5分)」や価格位置の言葉は出さない(2行のみ)', () => {
    const html = buildIndicatorHtml(base);
    expect(html).not.toContain('テクニカル');
    expect(html).not.toContain('上寄り');
    expect(html).not.toContain('中央');
  });

  it('RSI の色分け(70以上=赤 / 30以下=緑)はデータセルに残す', () => {
    expect(buildIndicatorHtml({ ...base, rsi: 71.4 })).toContain('ind-rsi-ob');
    expect(buildIndicatorHtml({ ...base, rsi: 28.6 })).toContain('ind-rsi-os');
    expect(buildIndicatorHtml(base)).toContain('ind-rsi-neutral');
  });

  it('個別に欠けた値は — で埋め、列数(4)は崩さない', () => {
    const html = buildIndicatorHtml({ ...base, squeeze: sq({ bw: null, bwHigh: null }) });
    expect(count(html, 'ind-td')).toBe(4);
    const td = cells(html);
    expect(td[2]).toContain('—');    // BW
    expect(td[3]).toContain('—');    // 片方(high)が欠けたら高安セルごと —(片側だけの数字は誤読を招く)
    expect(td[3]).not.toContain('0.61');
  });

  it('データ未到達(null)は「蓄積中…」', () => {
    expect(buildIndicatorHtml(null)).toContain('蓄積中');
    const empty: IndicatorSnapshot = { ...base, rsi: null, sma: null, bbUpper: null, bbLower: null, bbMid: null, pctB: null };
    expect(buildIndicatorHtml(empty)).toContain('蓄積中');
  });
});

// 数値だけでは「今どちらへ動いているか」が読めない。スクイーズ/バルジは変化の向きが本体なので、
// %B と BW は1本前との比較を色で出す。同値に色を付けると拾うべき変化が埋もれるので無印にする。
describe('buildIndicatorHtml — %B / BW の 1本前比較(増加=緑 / 減少=橙 / 同値=無印)', () => {
  const mk = (pctB: number, prevPctB: number, bw: number, prevBw: number) =>
    cells(buildIndicatorHtml({ ...base, squeeze: sq({ pctB, prevPctB, bw, prevBw }) }));

  it('%B 増加 = ind-up / BW 減少 = ind-down(セル単位で付く)', () => {
    const td = mk(0.80, 0.70, 1.00, 2.00);
    expect(td[1]).toContain('ind-up');
    expect(td[1]).not.toContain('ind-down');
    expect(td[2]).toContain('ind-down');
    expect(td[2]).not.toContain('ind-up');
  });

  it('%B 減少 = ind-down / BW 増加 = ind-up(向きを取り違えていたら赤)', () => {
    const td = mk(0.60, 0.70, 2.00, 1.00);
    expect(td[1]).toContain('ind-down');
    expect(td[2]).toContain('ind-up');
  });

  it('同値は無印(色を付けない)', () => {
    const html = buildIndicatorHtml({ ...base, squeeze: sq({ pctB: 0.7, prevPctB: 0.7, bw: 1.0, prevBw: 1.0 }) });
    expect(html).not.toContain('ind-up');
    expect(html).not.toContain('ind-down');
  });

  it('1本前が無い(prev=null)ときは無印(比較不能を色で嘘をつかない)', () => {
    const html = buildIndicatorHtml({ ...base, squeeze: sq({ prevPctB: null, prevBw: null }) });
    expect(html).not.toContain('ind-up');
    expect(html).not.toContain('ind-down');
  });

  it('高安(BWhigh/low)には色を付けない(参照値であって変化ではない)', () => {
    const td = mk(0.80, 0.70, 2.00, 1.00);
    expect(td[3]).not.toContain('ind-up');
    expect(td[3]).not.toContain('ind-down');
  });
});

// squeeze は ADD-ONLY。旧世代のサーバ/未接続からの配信では欠落しうるので、そこで壊れないこと。
describe('buildIndicatorHtml — squeeze が無い配信へのフォールバック', () => {
  it('RSI は出し、%B / BW / 高安は — にする(例外にも空白にもしない)', () => {
    const { squeeze: _drop, ...noSqueeze } = base;
    const html = buildIndicatorHtml(noSqueeze as IndicatorSnapshot);
    expect(count(html, 'ind-td')).toBe(4);
    const td = cells(html);
    expect(td[0]).toContain('62.0');
    expect(td[1]).toContain('—');
    expect(td[2]).toContain('—');
    expect(td[3]).toContain('—');
    expect(html).not.toContain('ind-up');
    expect(html).not.toContain('ind-down');
    expect(html).not.toContain('蓄積中');
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

  // 引け後に「そのセッションが最終的にどこで終わったか」を見るのは実用的な用途なので、
  // 値がある限り数値は消さない。理由(取引時間外/OFF)は印として併記する。
  it('D-1: 値あり + closed は「数値 ＋ 取引時間外の印」(数値を消さない)', () => {
    const html = buildIndicatorHtml({ ...base, progress: { state: 'closed', remaining: 0 } });
    expect(count(html, 'ind-td')).toBe(4);
    expect(html).toContain('62.0');
    expect(html).toContain('2.10/0.61');         // 高安は残る
    expect(html).toContain('取引時間外');
    expect(html).not.toContain('蓄積中');
  });

  it('E-1: 値あり + disabled は「数値 ＋ OFF の印」', () => {
    const html = buildIndicatorHtml({ ...base, progress: { state: 'disabled', remaining: 0 } });
    expect(html).toContain('1.42');
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
    expect(html).toContain('0.83');
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

describe('trendClass', () => {
  it('増加=ind-up / 減少=ind-down / 同値=無印', () => {
    expect(trendClass(1.5, 1.4)).toBe('ind-up');
    expect(trendClass(1.3, 1.4)).toBe('ind-down');
    expect(trendClass(1.4, 1.4)).toBe('');
  });
  it('比較できない(null / undefined)ときは無印', () => {
    expect(trendClass(null, 1.4)).toBe('');
    expect(trendClass(1.4, null)).toBe('');
    expect(trendClass(undefined, undefined)).toBe('');
  });
});
