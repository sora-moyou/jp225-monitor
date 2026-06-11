import { describe, it, expect } from 'vitest';
import { parseMinkabuIndicators, toNewsItem, computeReaction, type EconIndicator } from './econIndicators.js';

// 実 minkabu の行構造を模した HTML(US★4 + JP★3 + US★4未発表)。
const HTML = `
<table>
<tr class="fs-s" data_importance="4" data_country="US"><td class="eilist__time p5 tbl__time-upcoming"><span>23:00</span></td><td class="tbl__middle eilist__time p5"><div class="flag_container"></div></td><td class="tbl__middle p5"><a class="flexbox" href="/indicators/US-MSIP"><p class="flexbox__grow fbd">アメリカ・ミシガン大学消費者信頼感指数（速報値） 06月 [ミシガン大学消費者信頼感指数]</p></a></td><td class="tbl__middle eilist__star p5"><span>★★★★</span></td><td class="tbl__middle eilist__move trit pt5 pr5 is-plus"><span>+11.5pips</span></td><td class="tbl__middle eilist__data trit pt5 pr5"><span>44.8</span></td><td class="tbl__middle eilist__data trit pt5 pr5"><span>46.0</span></td><td class="tbl__middle eilist__data trit pt5 pr5"><span>46.5</span></td></tr>
<tr class="fs-s" data_importance="3" data_country="JP"><td class="eilist__time p5"><span>08:50</span></td><td class="tbl__middle p5"><a href="/indicators/JP-X"><p>日本・なにか 05月</p></a></td><td class="eilist__star p5"><span>★★★</span></td><td class="eilist__move"><span>-2pips</span></td><td class="eilist__data"><span>1.0</span></td><td class="eilist__data"><span>1.1</span></td><td class="eilist__data"><span>1.2</span></td></tr>
<tr class="fs-s" data_importance="5" data_country="US"><td class="eilist__time p5 tbl__time-upcoming"><span>21:30</span></td><td class="tbl__middle p5"><a href="/indicators/US-CPI"><p>アメリカ・消費者物価指数（CPI） 05月 [前月比]</p></a></td><td class="eilist__star p5"><span>★★★★★</span></td><td class="eilist__move"><span>---</span></td><td class="eilist__data"><span>0.3%</span></td><td class="eilist__data"><span>0.2%</span></td><td class="eilist__data"><span>---</span></td></tr>
<tr class="fs-s" data_importance="5" data_country="US"><td class="eilist__time p5 tbl__time-upcoming"><span>21:30</span></td><td class="tbl__middle p5"><a href="/indicators/US-CPI"><p>アメリカ・消費者物価指数（CPI） 05月 [前年比]</p></a></td><td class="eilist__star p5"><span>★★★★★</span></td><td class="eilist__move"><span>+5pips</span></td><td class="eilist__data"><span>2.8%</span></td><td class="eilist__data"><span>2.9%</span></td><td class="eilist__data"><span>3.0%</span></td></tr>
</table>`;

describe('parseMinkabuIndicators', () => {
  it('US×★4+×発表済み のみ抽出(JP除外・未発表除外)', () => {
    const inds = parseMinkabuIndicators(HTML, '2026-06-12');
    // US-MSIP(★4・発表済) と CPI前年比(★5・発表済)。JP=国違い / CPI前月比=未発表'---' は除外。
    expect(inds).toHaveLength(2);
    const msip = inds.find(i => i.name.includes('ミシガン'))!;
    expect(msip.name).toBe('ミシガン大学消費者信頼感指数（速報値）');   // 冗長な別名は付けない
    expect(msip.importance).toBe(4);
    expect(msip.previous).toBe('44.8');
    expect(msip.forecast).toBe('46.0');
    expect(msip.actual).toBe('46.5');
    expect(msip.releaseAt).toBe(Date.parse('2026-06-12T23:00:00+09:00'));
    const cpi = inds.find(i => i.name.includes('CPI'))!;
    expect(cpi.name).toBe('消費者物価指数（CPI）（前年比）');   // サブ種別[前年比]を名前に残す
    expect(cpi.actual).toBe('3.0%');
  });

  it('壊れた入力は空配列', () => {
    expect(parseMinkabuIndicators('', '2026-06-12')).toEqual([]);
    expect(parseMinkabuIndicators('<table></table>', '2026-06-12')).toEqual([]);
  });
});

describe('computeReaction', () => {
  it('+10分の終値差(符号付)', () => {
    expect(computeReaction(38000, 38045)).toBe(45);
    expect(computeReaction(38000, 37950)).toBe(-50);
  });
  it('欠損は null', () => {
    expect(computeReaction(null, 38000)).toBeNull();
    expect(computeReaction(38000, null)).toBeNull();
  });
});

describe('toNewsItem', () => {
  const ind: EconIndicator = { name: 'CPI', releaseAt: Date.parse('2026-06-11T21:30:00+09:00'), importance: 5, previous: '0.3%', forecast: '0.2%', actual: '0.2%' };
  it('結果・予想・前回を出す', () => {
    const n = toNewsItem(ind, null);
    expect(n.title).toContain('結果 0.2%');
    expect(n.title).toContain('予想 0.2%');
    expect(n.title).toContain('前回 0.3%');
    expect(n.source).toBe('米経済指標');
    expect(n.lang).toBe('ja');
    expect(n.publishedAt).toBe(ind.releaseAt);
    expect(n.id).toBe(`econ:CPI:${ind.releaseAt}`);
  });
  it('反応あり: → NK225 +45pt(10分)', () => {
    expect(toNewsItem(ind, 45).title).toContain('→ NK225 +45pt(10分)');
    expect(toNewsItem(ind, -30).title).toContain('→ NK225 -30pt(10分)');
  });
  it('予想/前回が --- なら省く', () => {
    const n = toNewsItem({ ...ind, forecast: '---', previous: '---' }, null);
    expect(n.title).not.toContain('予想');
    expect(n.title).not.toContain('前回');
    expect(n.title).toContain('結果 0.2%');
  });
});
