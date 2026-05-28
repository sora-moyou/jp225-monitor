import type { InstrumentMeta } from './types.js';

export const INSTRUMENTS: InstrumentMeta[] = [
  { symbol: 'NK=F',  labelJa: '日経225先物',    labelEn: 'Nikkei 225 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent', category: 'main' },
  { symbol: 'NQ=F',  labelJa: 'ナスダック100先物', labelEn: 'Nasdaq 100 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent', category: 'main' },
  { symbol: 'YM=F',  labelJa: 'ダウ先物',        labelEn: 'Dow Fut',        magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent', category: 'main' },
  { symbol: 'ES=F',  labelJa: 'S&P500先物',     labelEn: 'S&P500 Fut',     magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent', category: 'main' },
  { symbol: 'JPY=X', labelJa: 'ドル円',          labelEn: 'USD/JPY',        magnitudeThreshold: 0.20, slopeThreshold: 0.07, unit: 'percent', category: 'main' },
  { symbol: 'CL=F',  labelJa: 'WTI原油',        labelEn: 'WTI Crude',      magnitudeThreshold: 0.50, slopeThreshold: 0.20, unit: 'percent', category: 'main' },
  { symbol: '^VIX',  labelJa: 'VIX',            labelEn: 'VIX',            magnitudeThreshold: 5.00, slopeThreshold: 2.00, unit: 'percent', category: 'main' },
  { symbol: '^TNX',  labelJa: '米10年債利回り',   labelEn: 'US 10Y Yield',   magnitudeThreshold: 2.00, slopeThreshold: 1.00, unit: 'bp',      category: 'main' },
  // 値がさ株（東証、日経寄与上位5）— アラートのみ、カード非表示
  { symbol: '9983.T', labelJa: 'ファーストリテイリング', labelEn: 'Fast Retailing',    magnitudeThreshold: 1.50, slopeThreshold: 0.60, unit: 'percent', category: 'heavyweight' },
  { symbol: '8035.T', labelJa: '東京エレクトロン',       labelEn: 'Tokyo Electron',    magnitudeThreshold: 1.50, slopeThreshold: 0.60, unit: 'percent', category: 'heavyweight' },
  { symbol: '6857.T', labelJa: 'アドバンテスト',         labelEn: 'Advantest',         magnitudeThreshold: 1.50, slopeThreshold: 0.60, unit: 'percent', category: 'heavyweight' },
  { symbol: '9984.T', labelJa: 'ソフトバンクG',          labelEn: 'SoftBank Group',    magnitudeThreshold: 1.50, slopeThreshold: 0.60, unit: 'percent', category: 'heavyweight' },
  { symbol: '6367.T', labelJa: 'ダイキン',               labelEn: 'Daikin',            magnitudeThreshold: 1.50, slopeThreshold: 0.60, unit: 'percent', category: 'heavyweight' },
];

export const RSS_FEEDS = {
  ja: [
    { name: 'Yahoo News',     url: 'https://news.yahoo.co.jp/rss/categories/business.xml' },
    { name: 'NHK ビジネス',   url: 'https://www3.nhk.or.jp/rss/news/cat5.xml' },
    { name: 'NHK 政治',       url: 'https://www3.nhk.or.jp/rss/news/cat4.xml' },
    { name: 'NHK 国際',       url: 'https://www3.nhk.or.jp/rss/news/cat6.xml' },
    { name: '東洋経済',       url: 'https://toyokeizai.net/list/feed/rss' },
    { name: '朝日',           url: 'https://www.asahi.com/rss/asahi/business.rdf' },
    { name: 'ITmedia',        url: 'https://rss.itmedia.co.jp/rss/2.0/business.xml' },
    { name: '毎日',           url: 'https://mainichi.jp/rss/etc/mainichi-flash.rss' },
    { name: '共同',           url: 'https://www.kyodo.co.jp/feed/?cat=economy' },
  ],
  en: [
    { name: 'CNBC Markets',   url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html' },
    { name: 'CNBC Economy',   url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
    { name: 'Fed',            url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
    { name: 'BBC World',      url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'Al Jazeera',     url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { name: 'The Hill',       url: 'https://thehill.com/news/feed/' },
    { name: 'NYT World',      url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
    { name: 'MarketWatch',    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
    { name: 'Yahoo Finance',  url: 'https://finance.yahoo.com/news/rssindex' },
    { name: 'Investing.com',  url: 'https://www.investing.com/rss/news.rss' },
    { name: 'ZeroHedge',      url: 'https://feeds.feedburner.com/zerohedge/feed' },
    { name: 'ForexLive',      url: 'https://www.forexlive.com/feed' },
    { name: 'Benzinga',       url: 'https://www.benzinga.com/news/feed' },
    { name: 'SeekingAlpha',   url: 'https://seekingalpha.com/market_currents.xml' },
  ],
} as const;

export const PRICE_POLL_INTERVAL_MS = 2000;
export const NEWS_POLL_INTERVAL_MS = 60_000;
export const PRICE_BACKOFF_MS = [5000, 10_000, 30_000, 60_000];
export const NEWS_MAX_ITEMS = 100;
export const NEWS_RECENT_WINDOW_MS = 30 * 60 * 1000;

// 全銘柄共通のマクロ高インパクト・キーワード（強ブースト）
// 要人発言・地政学・指標・中央銀行など、銘柄横断で必ず注目すべき材料
export const HIGH_IMPACT_KEYWORDS: string[] = [
  // 米要人 (en + ja)
  'trump', 'biden', 'powell', 'yellen', 'bessent', 'lighthizer', 'rubio', 'vance',
  'トランプ', 'バイデン', 'パウエル', 'ベッセント', 'ルビオ', 'バンス',
  // 日本要人
  '植田', '日銀総裁', '日本銀行', '日銀', '神田', '加藤', '財務相', '財務大臣', '官房長官', '首相', '岸田', '石破',
  'ueda', 'kanda', 'kato', 'kishida', 'ishiba', 'boj',
  // 中央銀行イベント
  'fomc', 'fed minutes', 'rate cut', 'rate hike', 'jackson hole', 'powell speaks', 'ecb', 'lagarde',
  '利上げ', '利下げ', '政策決定', '金融政策',
  // 為替介入
  'intervention', 'currency intervention', '介入', '為替介入', '円買い介入', '円安阻止',
  // 米経済指標
  'cpi', 'ppi', 'pce', 'nfp', 'non-farm', 'payroll', 'jobs report', 'unemployment rate',
  'retail sales', 'gdp', 'ism', 'pmi', 'consumer confidence', 'durable goods', 'jolts',
  '消費者物価', '生産者物価', '雇用統計', '失業率', '小売売上', 'gdp', 'ism', 'pmi',
  // 地政学
  'iran', 'israel', 'gaza', 'lebanon', 'hezbollah', 'houthi', 'middle east', 'strait of hormuz',
  'russia', 'ukraine', 'china', 'taiwan', 'north korea', 'south korea',
  'opec', 'opec+', 'saudi', 'venezuela',
  'イラン', 'イスラエル', 'ガザ', 'レバノン', 'ヒズボラ', 'フーシ', '中東', 'ホルムズ',
  'ロシア', 'ウクライナ', '中国', '台湾', '北朝鮮', 'opec', 'サウジ',
  // 関税・貿易戦争（トランプ第2期）
  'tariff', 'trade war', 'sanctions', '関税', '貿易戦争', '制裁',
];

// 銘柄ごとのキーワード辞書（ja + en、小文字統一）— ニュースのランク付け用
export const INSTRUMENT_KEYWORDS: Record<string, string[]> = {
  'NK=F': ['日経', '日本株', '東証', '日銀', 'boj', '黒田', '植田', '円', '為替', 'jp', '日本', '株式', 'nikkei', 'japan', 'tokyo', 'yen', 'jp225'],
  'NQ=F': ['ナスダック', '米株', 'テック', 'ai', 'アップル', 'マイクロソフト', 'エヌビディア', 'メタ', 'グーグル', 'nasdaq', 'nq', 'tech', 'apple', 'aapl', 'msft', 'nvda', 'meta', 'google', 'googl'],
  'YM=F': ['ダウ', 'nyダウ', '米株', '米国', 'dow', 'dji', 'us 30', 'industrial', 'blue chip'],
  'ES=F': ['s&p', 'sp500', '米株', 'fomc', 'frb', 'spx', 'fed', 'powell', 'rate', 'inflation', 'cpi', 'jobs', 'payroll'],
  'JPY=X': ['ドル円', '為替', '日銀', 'boj', 'frb', '介入', '円安', '円高', '為替介入', 'usdjpy', 'usd/jpy', 'yen', 'dollar', 'intervention', 'kanda', '神田'],
  'CL=F': ['原油', 'opec', 'ガソリン', '石油', 'oil', 'crude', 'wti', 'brent', 'gasoline', 'petroleum', 'iran', 'saudi', 'russia'],
  '^VIX': ['vix', '恐怖', 'パニック', '売り', '急落', 'リスクオフ', 'volatility', 'fear', 'panic', 'sell-off', 'selloff', 'hedge', 'risk off', 'crash'],
  '^TNX': ['米10年', '国債', '利回り', '利上げ', '利下げ', 'yield', 'treasury', '10-year', '10y', 't-note', 'bond', 'fed funds', 'powell', 'cpi'],
  // 値がさ株（個別株、関連業界キーワードも）
  '9983.T': ['ファーストリテイリング', 'ユニクロ', 'fast retailing', 'uniqlo', '小売', 'apparel'],
  '8035.T': ['東京エレクトロン', 'tokyo electron', '半導体製造装置', 'semiconductor equipment', 'asml', 'tsmc'],
  '6857.T': ['アドバンテスト', 'advantest', '半導体テスター', 'semiconductor test', 'memory test', 'nvidia', 'ai chip'],
  '9984.T': ['ソフトバンク', 'softbank', 'arm', '孫正義', 'masa', 'vision fund', 'ai投資'],
  '6367.T': ['ダイキン', 'daikin', '空調', 'air conditioner', 'hvac'],
};

export const LLM_SYSTEM_PROMPT = `あなたは日経先物トレーダー向けの市場分析アシスタントです。直近30分のニュース（関連性スコア順）から、相場急変の最有力材料を必ず1つ示してください。

ルール:
- 日本語で1〜2文、結論先出しで簡潔に。
- 必ず「○○分前のXXがYYのため」のように、最も関連する1件の発生時刻と内容を引用する。
- 最優先で注目すべきマクロ材料:
  (1) 米要人発言 (Trump, Powell, Yellen, Bessent 等)
  (2) 日本要人発言 (植田日銀総裁, 神田/加藤財務相, 首相, 介入観測)
  (3) 地政学 (イラン, イスラエル, ホルムズ海峡, 中東, 中国, 台湾, ロシア)
  (4) 米経済指標 (CPI, PCE, NFP, 雇用統計, GDP, ISM, PMI)
  (5) 関税・通商 (トランプ関税, 制裁)
- 直接の引き金が薄くても、上記マクロ要因のうち時刻が近いものを必ず選ぶ。
- 「明確な材料なし」「特に材料なし」とは絶対に答えない。最低でも仮説として1件は挙げる。
- 銘柄間連動（例: USD/JPY → 日経、原油 → イラン情勢）にも触れて良い。`;

// LLM プロバイダ: Groq（無料、Llama 3.3 70B、OpenAI互換API）
// OpenAI に戻すには LLM_BASE_URL を undefined、LLM_MODEL を 'gpt-4o-mini' などへ
export const LLM_BASE_URL: string | undefined = 'https://api.groq.com/openai/v1';
export const LLM_MODEL = 'llama-3.3-70b-versatile';
