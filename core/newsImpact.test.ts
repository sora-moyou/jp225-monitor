import { describe, it, expect } from 'vitest';
import type { NewsItem } from './types.js';
import {
  scoreNewsImpact, classifyNews, rankNewsByImpact, recencyDecay, relativeTimeLabel,
  IMPACT_DECAY_FLOOR, IMPACT_HALF_LIFE_MIN,
} from './newsImpact.js';

const NOW = 1_800_000_000_000;

function n(title: string, opts: Partial<NewsItem> = {}): NewsItem {
  return {
    id: opts.id ?? `t:${title}`,
    title,
    source: opts.source ?? 'Yahoo News',
    lang: opts.lang ?? 'ja',
    url: opts.url ?? 'https://example.com/a',
    publishedAt: opts.publishedAt ?? NOW - 5 * 60_000,
  };
}

describe('scoreNewsImpact — 純関数であること', () => {
  it('同じ入力なら必ず同じ出力(決定的)', () => {
    const item = n('トランプ大統領、対中関税を引き上げ');
    expect(scoreNewsImpact(item, NOW)).toEqual(scoreNewsImpact(item, NOW));
  });
});

describe('★ユーザー要望: トランプ / ベッセントの新規発言を確実に拾う', () => {
  it('トランプ発言は無名の一般ニュースより明確に上位', () => {
    const trump = scoreNewsImpact(n('トランプ大統領、追加関税を表明'), NOW);
    const plain = scoreNewsImpact(n('東証、売買代金は低調に推移'), NOW);
    expect(trump.score).toBeGreaterThan(plain.score);
    expect(trump.contentScore).toBeGreaterThanOrEqual(20);   // 要人12 + 関税10 相当
  });

  it('ベッセント財務長官は表記ゆれ(ベセント/ベッサント/bessent)でも拾う', () => {
    for (const name of ['ベッセント', 'ベセント', 'ベッサント', 'Bessent']) {
      const s = scoreNewsImpact(n(`${name}財務長官が為替について発言`), NOW);
      expect(s.reasons.some(r => r.label.startsWith('要人・機関')), name).toBe(true);
      expect(s.contentScore, name).toBeGreaterThanOrEqual(12);
    }
  });

  it('パウエル/FOMC/日銀も要人・機関として加点される', () => {
    for (const t of ['パウエルFRB議長が講演', 'FOMCが政策金利を据え置き', '日銀・植田総裁が会見']) {
      expect(scoreNewsImpact(n(t), NOW).reasons.some(r => r.label.startsWith('要人・機関')), t).toBe(true);
    }
  });
});

describe('★値がさ株', () => {
  it('寄与上位(TIER1)は 7 点、それ以外の値がさ株は 5 点', () => {
    const t1 = scoreNewsImpact(n('ファーストリテイリングが通期見通しを上方修正'), NOW);
    const t2 = scoreNewsImpact(n('ディスコが月次受注を開示'), NOW);
    expect(t1.reasons.find(r => r.label.includes('値がさ株'))?.points).toBe(7);
    expect(t2.reasons.find(r => r.label.includes('値がさ株'))?.points).toBe(5);
  });

  it('ユーザーが例示した5銘柄はすべて TIER1 として拾える', () => {
    for (const t of ['ファーストリテイリング', '東京エレクトロン', 'アドバンテスト', 'ソフトバンクグループ', '信越化学']) {
      const s = scoreNewsImpact(n(`${t}の株価が急伸`), NOW);
      expect(s.reasons.find(r => r.label.includes('値がさ株'))?.points, t).toBe(7);
    }
  });

  it('値がさ株は二重加点しない(TIER1 が当たれば TIER2 は見ない)', () => {
    const s = scoreNewsImpact(n('ファーストリテイリングと東京エレクトロンが同時に上昇'), NOW);
    expect(s.reasons.filter(r => r.label.includes('値がさ株'))).toHaveLength(1);
  });
});

describe('速報性・米国重み', () => {
  it('速報タグで加点される', () => {
    const a = scoreNewsImpact(n('【速報】日経平均が急落'), NOW);
    const b = scoreNewsImpact(n('日経平均が急落'), NOW);
    expect(a.contentScore - b.contentScore).toBe(6);
  });

  it('★日本語ソースの米国ニュースも米国重みが乗る(英語限定にしない)', () => {
    const jaUs = scoreNewsImpact(n('米国のCPIが予想を上回る', { lang: 'ja', source: 'Yahoo News' }), NOW);
    expect(jaUs.reasons.some(r => r.label.startsWith('米国関連'))).toBe(true);
  });

  it('英語ソースは海外ソース加点が乗る', () => {
    const en = scoreNewsImpact(n('Fed holds rates steady', { lang: 'en', source: 'CNBC Top News' }), NOW);
    expect(en.reasons.some(r => r.label === '海外ソース')).toBe(true);
    expect(en.overseas).toBe(true);
  });

  it('日本語ソースでも NY 面は海外扱い', () => {
    expect(scoreNewsImpact(n('米株が続伸', { source: 'nikkei225jp NY' }), NOW).overseas).toBe(true);
  });
});

// ★実データで踏んだ誤検知の回帰テスト。素の includes だと全部 false positive になる。
describe('★英数字キーワードは単語境界で当てる(部分一致にしない)', () => {
  it.each([
    ['ism', 'Maher says the party drifted further left, citing socialism'],
    ['dow', 'Nikkei futures drift down in thin trade'],
    ['disco', 'Retailer offers a deep discount on winter stock'],
    ['war', 'Investors move toward safer assets'],
    ['ny', 'The company reported quarterly results'],
    ['oil', 'Tempers boil over at the committee hearing'],
    ['us', 'Shares fell 3% versus the benchmark'],
  ])('%s が長い単語の中に当たらない: "%s"', (_kw, title) => {
    const s = scoreNewsImpact(n(title, { lang: 'en', source: 'Test' }), NOW);
    // 海外ソース(+3)以外の加点が入らない = 誤検知していない
    expect(s.contentScore).toBe(3);
  });

  it('★英語の語形変化(複数形など)は落とさない', () => {
    // 実データで踏んだ回帰: 完全一致にしたら "tariffs" が当たらなくなった。
    const s = scoreNewsImpact(n('Canada offers concessions to avoid Trump’s 50% tariffs', { lang: 'en' }), NOW);
    expect(s.reasons.some(r => r.label === 'イベント: tariff')).toBe(true);
    for (const t of ['New sanctions imposed', 'Russian missiles hit Kyiv', 'US payrolls miss badly']) {
      expect(scoreNewsImpact(n(t, { lang: 'en' }), NOW).contentScore, t).toBeGreaterThan(5);
    }
  });

  it('語尾を許しても3文字超の別語にはならない(disco→discount)', () => {
    expect(scoreNewsImpact(n('Retailer offers a deep discount', { lang: 'en' }), NOW).contentScore).toBe(3);
  });

  it('正しい語としてなら当たる', () => {
    expect(scoreNewsImpact(n('ISM manufacturing PMI beats', { lang: 'en' }), NOW).contentScore).toBeGreaterThan(3);
    expect(scoreNewsImpact(n('Dow Jones closes higher', { lang: 'en' }), NOW).contentScore).toBeGreaterThan(3);
    expect(scoreNewsImpact(n('Oil prices surge on OPEC cut', { lang: 'en' }), NOW).contentScore).toBeGreaterThan(3);
  });

  it('日本語は従来どおり部分一致(語分割が無いため)', () => {
    // 「関税」が「対中関税措置」の中でも当たること
    expect(scoreNewsImpact(n('政府は対中関税措置を検討'), NOW).contentScore).toBeGreaterThanOrEqual(10);
  });

  it('★ソース名も単語境界(moneyworld が NY 扱いにならない)', () => {
    expect(scoreNewsImpact(n('国内株の動向', { source: 'moneyworld' }), NOW).overseas).toBe(false);
    expect(scoreNewsImpact(n('米株の動向', { source: 'nikkei225jp NY' }), NOW).overseas).toBe(true);
  });
});

describe('鮮度の減衰', () => {
  it('半減期で減衰幅がちょうど半分になる', () => {
    expect(recencyDecay(0)).toBeCloseTo(1, 6);
    expect(recencyDecay(IMPACT_HALF_LIFE_MIN)).toBeCloseTo(IMPACT_DECAY_FLOOR + (1 - IMPACT_DECAY_FLOOR) / 2, 6);
  });

  it('どれだけ古くても下限を割らない(古い大材料が消えない)', () => {
    expect(recencyDecay(100_000)).toBeGreaterThanOrEqual(IMPACT_DECAY_FLOOR);
  });

  it('★古い大材料 > 新しい些事 が保たれる', () => {
    const oldBig = scoreNewsImpact(n('トランプ、対中関税を発動', { publishedAt: NOW - 4 * 60 * 60_000 }), NOW);
    const newSmall = scoreNewsImpact(n('東証の売買代金は低調', { publishedAt: NOW - 30_000 }), NOW);
    expect(oldBig.score).toBeGreaterThan(newSmall.score);
  });

  it('同じ内容なら新しい方が上', () => {
    const fresh = scoreNewsImpact(n('日銀が利上げを決定', { id: 'a', publishedAt: NOW - 60_000 }), NOW);
    const stale = scoreNewsImpact(n('日銀が利上げを決定', { id: 'b', publishedAt: NOW - 180 * 60_000 }), NOW);
    expect(fresh.score).toBeGreaterThan(stale.score);
  });
});

describe('★採点の内訳が残ること(なぜ上位に来たかを説明できる)', () => {
  it('加点要素ごとに 1 行ずつ内訳がある', () => {
    const s = scoreNewsImpact(n('【速報】トランプ大統領、対中関税を発動 米国株は急落'), NOW);
    const labels = s.reasons.map(r => r.label);
    expect(labels.some(l => l.startsWith('要人・機関'))).toBe(true);
    expect(labels.some(l => l.startsWith('イベント'))).toBe(true);
    expect(labels.some(l => l.startsWith('速報'))).toBe(true);
    expect(labels.some(l => l.startsWith('米国関連'))).toBe(true);
    expect(labels.some(l => l.startsWith('鮮度減衰'))).toBe(true);
  });

  it('内訳の加点合計が contentScore と一致する(数字が作り話でないこと)', () => {
    const s = scoreNewsImpact(n('パウエル議長、CPI上振れを受け利上げ示唆 米国'), NOW);
    const sum = s.reasons.filter(r => !r.label.startsWith('鮮度減衰') && r.label !== '新着ボーナス')
      .reduce((a, r) => a + r.points, 0);
    expect(sum).toBe(s.contentScore);
  });
});

describe('classifyNews — 分類できないものにラベルを付けない', () => {
  it('該当なしは null', () => {
    expect(classifyNews(n('本日の天気は晴れのち曇り'))).toBeNull();
  });
  it('速報が最優先', () => {
    expect(classifyNews(n('【速報】原油が急騰'))).toBe('breaking');
  });
  it('コモディティは経済より先に判定される(より具体的な方を勝たせる)', () => {
    expect(classifyNews(n('原油相場、1オンス当たりの金価格も上昇'))).toBe('commodity');
  });
  it('地政学 / 個別株 / 経済', () => {
    expect(classifyNews(n('イスラエルがガザへ空爆'))).toBe('geopolitics');
    expect(classifyNews(n('東京エレクトロンが決算発表'))).toBe('stock');
    expect(classifyNews(n('日銀が金融政策を維持'))).toBe('economy');
  });
});

describe('rankNewsByImpact', () => {
  it('インパクト順に並ぶ(非破壊)', () => {
    const items = [n('本日の値動きは小幅', { id: 'a' }), n('トランプ、関税を発表', { id: 'b' })];
    const before = JSON.stringify(items);
    const ranked = rankNewsByImpact(items, NOW);
    expect(ranked[0]!.id).toBe('b');
    expect(JSON.stringify(items)).toBe(before);   // 元配列は変えない
    expect(ranked[0]!.impact).toBeDefined();
  });

  it('完全に同点でも決定的な順序になる(id タイブレーク)', () => {
    const items = [
      { ...n('同じ見出し', { id: 'z' }), publishedAt: NOW },
      { ...n('同じ見出し', { id: 'a' }), publishedAt: NOW },
    ];
    expect(rankNewsByImpact(items, NOW).map(x => x.id)).toEqual(['a', 'z']);
    expect(rankNewsByImpact([...items].reverse(), NOW).map(x => x.id)).toEqual(['a', 'z']);
  });
});

describe('relativeTimeLabel', () => {
  it.each([
    [30_000, 'たった今'],
    [22 * 60_000, '22分前'],
    [60 * 60_000, '1時間前'],
    [26 * 60 * 60_000, '1日前'],
  ])('%i ms 前 → %s', (ago, expected) => {
    expect(relativeTimeLabel(NOW - ago, NOW)).toBe(expected);
  });
});
