import { describe, it, expect } from 'vitest';
import {
  parseMinkabuIndicators, toNewsItem, computeReaction, groupReleases, toNewsItemForRelease,
  type EconIndicator,
} from './econIndicators.js';

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

// ─── ★同じ発表の下位系列を1枚にまとめる(2026-08-13 の不具合) ──────────────────
//
// 症状: NEWS に「消費者物価指数（CPI）」がほぼ同じ見た目で並んだ。
// 実データ(2026-08-12 21:30 発表・minkabu 実取得)では CPI は **4つの下位系列**が
// 同時刻に出る。従来はそれぞれ別のニュースになり、しかも **全部に同じ反応(+265pt)** が
// 付いていた = 1つの値動きを4つの指標に別々に帰属させる誤った記録でもあった。
const AT = Date.parse('2026-08-12T21:30:00+09:00');
/** 実取得した4件(値は実物)。 */
const CPI_REAL: EconIndicator[] = [
  { name: '消費者物価指数（CPI）（前月比）', releaseAt: AT, importance: 5, previous: '-0.4%', forecast: '0.1%', actual: '0.1%' },
  { name: '消費者物価指数（CPI）（前年比）', releaseAt: AT, importance: 5, previous: '3.5%', forecast: '3.4%', actual: '3.4%' },
  { name: '消費者物価指数（CPI）（食品・エネルギー除くコア・前月比）', releaseAt: AT, importance: 5, previous: '0.0%', forecast: '0.2%', actual: '0.2%' },
  { name: '消費者物価指数（CPI）（食品・エネルギー除くコア・前年比）', releaseAt: AT, importance: 5, previous: '2.6%', forecast: '2.5%', actual: '2.5%' },
];

describe('groupReleases — 同じ発表は1枚にまとめる', () => {
  it('★CPI の4系列が1件になる(実データ)', () => {
    const rels = groupReleases(CPI_REAL);
    expect(rels).toHaveLength(1);
    expect(rels[0]!.baseName).toBe('消費者物価指数（CPI）');
    expect(rels[0]!.releaseAt).toBe(AT);
    expect(rels[0]!.parts.map(p => p.label)).toEqual([
      '前月比', '前年比', '食品・エネルギー除くコア・前月比', '食品・エネルギー除くコア・前年比',
    ]);
  });

  it('★1枚のカードに4つの結果が入り、反応は1回だけ', () => {
    const n = toNewsItemForRelease(groupReleases(CPI_REAL)[0]!, 265);
    expect(n.id).toBe(`econ:消費者物価指数（CPI）:${AT}`);
    for (const [label, actual] of [['前年比', '3.4%'], ['前月比', '0.1%'], ['食品・エネルギー除くコア・前年比', '2.5%']]) {
      expect(n.title).toContain(`${label} ${actual}`);
    }
    expect(n.title).toContain('予想 3.4%');
    expect(n.title).toContain('前回 3.5%');
    // ★同じ値動きを何度も主張しない(従来は4枚それぞれに付いていた)
    expect(n.title.match(/NK225/g) ?? []).toHaveLength(1);
    expect(n.publishedAt).toBe(AT);
    expect(n.source).toBe('米経済指標');
  });

  it('★単独の指標は従来と1文字も変わらない(既存の見え方を壊さない)', () => {
    const solo: EconIndicator = {
      name: 'ミシガン大学消費者信頼感指数（速報値）', releaseAt: AT, importance: 4,
      previous: '44.8', forecast: '46.0', actual: '46.5',
    };
    const rels = groupReleases([solo]);
    expect(rels).toHaveLength(1);
    expect(toNewsItemForRelease(rels[0]!, 45)).toEqual(toNewsItem(solo, 45));
  });

  it('同じ時刻でも別の指標はまとめない', () => {
    const other: EconIndicator = { name: '小売売上高（前月比）', releaseAt: AT, importance: 5, previous: '0.1%', forecast: '0.2%', actual: '0.3%' };
    const rels = groupReleases([...CPI_REAL, other]);
    expect(rels).toHaveLength(2);
    expect(rels.map(r => r.baseName).sort()).toEqual(['小売売上高（前月比）', '消費者物価指数（CPI）']);
  });

  it('同じ指標でも発表時刻が違えばまとめない(別の月の発表)', () => {
    const prevMonth = CPI_REAL.map(i => ({ ...i, releaseAt: AT - 30 * 86_400_000 }));
    const rels = groupReleases([...CPI_REAL, ...prevMonth]);
    expect(rels).toHaveLength(2);
    expect(new Set(rels.map(r => r.releaseAt)).size).toBe(2);
  });

  it('入力の順序は保つ(発表ページの並びのまま・こちらで序列を作らない)', () => {
    const rels = groupReleases([CPI_REAL[1]!, CPI_REAL[0]!]);
    expect(rels[0]!.parts.map(p => p.label)).toEqual(['前年比', '前月比']);
  });
});
