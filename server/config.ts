import type { InstrumentMeta } from './types.js';

export const INSTRUMENTS: InstrumentMeta[] = [
  { symbol: 'NIY=F',  labelJa: '日経225先物',    labelEn: 'Nikkei 225 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.15, unit: 'percent', category: 'main' },
  { symbol: 'NQ=F',  labelJa: 'ナスダック100先物', labelEn: 'Nasdaq 100 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.15, unit: 'percent', category: 'main' },
  { symbol: 'YM=F',  labelJa: 'ダウ先物',        labelEn: 'Dow Fut',        magnitudeThreshold: 0.30, slopeThreshold: 0.15, unit: 'percent', category: 'main' },
  { symbol: 'ES=F',  labelJa: 'S&P500先物',     labelEn: 'S&P500 Fut',     magnitudeThreshold: 0.30, slopeThreshold: 0.15, unit: 'percent', category: 'main' },
  { symbol: 'JPY=X', labelJa: 'ドル円',          labelEn: 'USD/JPY',        magnitudeThreshold: 0.20, slopeThreshold: 0.10, unit: 'percent', category: 'main' },
  { symbol: 'CL=F',  labelJa: 'WTI原油',        labelEn: 'WTI Crude',      magnitudeThreshold: 0.50, slopeThreshold: 0.30, unit: 'percent', category: 'main' },
  { symbol: '^VIX',  labelJa: 'VIX',            labelEn: 'VIX',            magnitudeThreshold: 5.00, slopeThreshold: 3.00, unit: 'percent', category: 'main' },
  { symbol: '^TNX',  labelJa: '米10年債利回り',   labelEn: 'US 10Y Yield',   magnitudeThreshold: 2.00, slopeThreshold: 1.50, unit: 'bp',      category: 'main' },
  // 値がさ株（東証、日経寄与上位5）— アラートのみ、カード非表示
  { symbol: '9983.T', labelJa: 'ファーストリテイリング', labelEn: 'Fast Retailing',    magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
  { symbol: '8035.T', labelJa: '東京エレクトロン',       labelEn: 'Tokyo Electron',    magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
  { symbol: '6857.T', labelJa: 'アドバンテスト',         labelEn: 'Advantest',         magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
  { symbol: '9984.T', labelJa: 'ソフトバンクG',          labelEn: 'SoftBank Group',    magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
  { symbol: '6367.T', labelJa: 'ダイキン',               labelEn: 'Daikin',            magnitudeThreshold: 1.50, slopeThreshold: 0.90, unit: 'percent', category: 'heavyweight' },
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

// PRICE_POLL_INTERVAL_MS / NEWS_POLL_INTERVAL_MS は configStore に移動。
// 直接定数を参照していた箇所は resolvePricePollMs() / resolveNewsPollMs() を使う。
export const PRICE_BACKOFF_MS = [5000, 10_000, 30_000, 60_000];

// v0.3.8 で「USD/JPY × 銘柄価格」の JPY 換算を全削除。
// 理由: NIY=F / NKD=F / OANDA JP225YJPY / JP225USD / ^N225 すべて Nikkei 指数値を
// 表示しており、通貨ラベルは決済通貨を示すのみ。表示価格と % は通貨に依存しない。

export const NEWS_MAX_ITEMS = 200;                        // 4時間ぶん保持できるよう拡大
export const NEWS_RECENT_WINDOW_MS = 4 * 60 * 60 * 1000;  // LLMに渡す上限 = 4時間
export const NEWS_RECENCY_DECAY_MIN = 120;                // recency加点が0になる年齢 (分)
// v0.3.9: explain() のニュース選別を急変近接優先に
export const NEWS_PROXIMITY_TIGHT_MIN = 15;               // ±この分内のニュースがあれば最優先
export const NEWS_PROXIMITY_LOOSE_MIN = 60;               // 次点フォールバック窓

// ニュース取得時の関連性フィルタ用
// 「これらのキーワードを1つも含まない」OR「明らかに非金融トピック」は破棄
export const FINANCE_RELEVANCE_KEYWORDS: string[] = [
  // 市場・商品 (ja)
  '株', '株価', '株式', '相場', '指数', '配当', '債券', '国債', '金利', '為替', '通貨',
  '円安', '円高', 'ドル安', 'ドル高', 'ユーロ', '元安', '元高', 'ポンド',
  '原油', 'ゴールド', '銀', '銅', '商品', 'コモディティ', '先物', '現物', 'etf', 'reit', '投信',
  // 市場・商品 (en)
  'stock', 'stocks', 'market', 'markets', 'index', 'indices', 'bond', 'bonds', 'yield',
  'forex', 'fx', 'currency', 'currencies', 'dollar', 'euro', 'yen', 'pound',
  'gold', 'silver', 'copper', 'oil', 'crude', 'commodity', 'futures', 'equity', 'equities',
  'shares', 'etf', 'reit', 'fund', 'hedge fund', 'pension',
  // 企業アクション
  '業績', '決算', '増益', '減益', '上方修正', '下方修正', 'ipo', '上場', '買収', '合併', '増資', '自社株買い',
  'earnings', 'revenue', 'profit', 'loss', 'guidance', 'acquisition', 'merger', 'dividend', 'buyback',
  // 主要企業 (Nikkei 値がさ・米テック)
  'apple', 'microsoft', 'tesla', 'nvidia', 'amazon', 'google', 'meta', 'netflix',
  'aapl', 'msft', 'tsla', 'nvda', 'amzn', 'googl', 'broadcom', 'avgo', 'arm',
  'ファーストリテイリング', 'ユニクロ', '東京エレクトロン', 'アドバンテスト', 'ソフトバンク',
  'トヨタ', 'ホンダ', 'ソニー', '任天堂', '日立', 'ntt', 'kddi', 'mufg', 'みずほ',
  // マクロ
  '景気', '経済', '物価', 'インフレ', 'デフレ', '雇用', '失業', 'gdp', '貿易', '輸出', '輸入',
  '金融政策', '財政', '緩和', '引き締め', 'マネーサプライ',
  'inflation', 'deflation', 'recession', 'economy', 'economic', 'employment', 'unemployment',
  'gdp', 'trade', 'export', 'import', 'monetary', 'fiscal', 'easing', 'tightening', 'qe', 'qt',
  // 中央銀行・要人・地政学・関税・指標 (HIGH_IMPACTと重複OK)
  'fomc', 'fed', 'ecb', 'boj', 'boe', '日銀', '中央銀行', 'central bank',
  'trump', 'powell', 'yellen', 'bessent', '植田', '神田', '加藤', '財務省', '財務相', '官房長官', '首相',
  'iran', 'israel', 'opec', 'ロシア', 'ウクライナ', '中東', 'イラン', 'イスラエル', '関税', 'tariff', 'sanctions',
  'cpi', 'pce', 'nfp', '雇用統計', 'ism', 'pmi',
  // 仮想通貨（リスクオンオフの代理）
  'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', '仮想通貨', '暗号資産',
];

// 明らかに非金融トピック (BLACKLIST 1 ヒットで即除外、whitelist より強い)
// v0.3.5: カテゴリ別に大幅追加 — 個人ニュース系のフィードは生活/趣味/レビュー記事が多い
export const FINANCE_BLACKLIST: string[] = [
  // 学習・教育
  '読書', '勉強', '受験', '東大入試', '学習', '教諭', '塾', '英会話', '大学受験', '高校入試',
  // 食・健康
  'レシピ', '料理', '食事', 'ダイエット', '美容', 'スキンケア', 'ファッション', 'コスメ',
  '飲食店', 'カフェ', 'グルメ', '居酒屋', 'スイーツ', 'ラーメン', 'メニュー', '新商品', 'コンビニ',
  // 旅行・観光
  '旅行', '観光', 'ホテル', '宿', '温泉', 'インバウンド', '訪日', 'スポット', '絶景', 'パワースポット',
  // スポーツ
  '野球', 'サッカー', '五輪', 'オリンピック', 'テニス', 'ゴルフ', 'プロ野球', 'mlb', 'nfl', 'nba',
  '高校野球', '甲子園', 'jリーグ', 'ボクシング', '相撲', 'バスケ', 'バレー', 'マラソン',
  // 芸能・エンタメ
  '俳優', '女優', '歌手', '映画', 'ドラマ', '音楽', 'k-pop', 'アイドル', '芸能', 'お笑い',
  'youtuber', '配信者', 'インフルエンサー', 'ライブ', 'コンサート', 'アニメ', 'マンガ',
  'タレント', '芸人', 'ファン', 'デビュー', '結婚発表', '熱愛',
  // 占い・スピリチュアル
  '占い', '星座', 'スピリチュアル', '心理テスト', '運勢', 'タロット',
  // ライフスタイル・家族
  '育児', '子育て', '婚活', '結婚式', '離婚', '葬式', '相続', '夫婦', '彼氏', '彼女',
  'ヨガ', '瞑想', '健康法', 'メンタルヘルス', '睡眠',
  // 自動車 (新車・モデル発表系。決算等は whitelist で拾う)
  '新車', '試乗', 'モデルチェンジ', 'コンセプトカー', '発表会', 'カーオブザイヤー',
  'ハイラックス', 'プリウス', 'クラウン', 'ヤリス', 'ヴェルファイア', 'アルファード', 'カローラ',
  'シビック', 'フィット', 'フリード', 'ステップワゴン', 'ジムニー', 'インプレッサ', 'レヴォーグ',
  'バイク', '新型バイク', '原付', 'スクーター', '電動アシスト',
  // 鉄道・交通 (運休・遅延等の話題)
  '新幹線', '快速', '在来線', '路線', '運休', '遅延', '時刻表', '駅', '改札',
  // ガジェット・消費者レビュー
  'レビュー', '使ってみた', '試してみた', '比較', 'おすすめ',
  'スマホ', 'iphone', 'android', 'タブレット', 'イヤホン', 'ヘッドホン',
  'カメラ', 'パソコン', 'ノートpc', 'ゲーム機', 'switch', 'playstation', 'xbox',
  '家電', '冷蔵庫', '洗濯機', 'エアコン', '掃除機',
  // 事件・事故・社会面 (相場に影響しない一般事件)
  '逮捕', '容疑者', '殺人', '強盗', '詐欺事件', '交通事故', '火事', '火災',
  '不倫', '不祥事', '炎上', 'sns炎上',
  // 雑談・親族・私事
  '親族', '葬儀', '集まり', '〇〇さん', '○○氏', 'お前は', '社員に', '従業員',
];

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
  'NIY=F': ['日経', '日本株', '東証', '日銀', 'boj', '黒田', '植田', '円', '為替', 'jp', '日本', '株式', 'nikkei', 'japan', 'tokyo', 'yen', 'jp225'],
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

export const LLM_SYSTEM_PROMPT = `あなたは日経先物トレーダー向けの市場分析アシスタントです。直近4時間のニュース（関連性スコア順）から、相場急変の最有力材料を簡潔に示してください。

【最重要・方向整合性】
ニュースを引用する前に、必ず「そのニュースなら相場はどちら方向に動くはず」かを判定し、実際の急変方向と一致するか確認すること。一致しない場合はそのニュースを引用しない。

主要バイアス参考:
- リスクオフ材料 (地政学緊張↑、戦争・攻撃・テロ、制裁強化、要人タカ派発言、悪い指標) → 株安・JPY高・債券買い・原油やや高・金高・VIX高
- リスクオン材料 (地政学緩和、停戦、利下げ示唆、ハト派発言、良い指標) → 株高・JPY安・債券売り・VIX安
- 中銀ハト派 → 株高・金利安・通貨安
- 中銀タカ派 → 株安・金利高・通貨高
- 円安進行 → 日本輸出株高 → 日経高
- 円高進行 → 日本輸出株安 → 日経安
- 原油急騰 → エネルギー株高、消費関連株安、インフレ懸念
- イラン情勢悪化/中東緊張 → 原油高、株安、金高

【出力ルール】
- 日本語で1〜2文、結論先出しで簡潔に
- 整合する材料があれば「○○分前のXXがYYのため、(価格方向の根拠)」形式
- 整合する材料が見つからない場合は素直に「直近の重大材料と整合する明確な要因なし。小幅な値動きでテクニカル要因の可能性」と書く
- とくに急変が小さい (絶対値0.15%以下) 場合は、無理に材料を結びつけず「ノイズの可能性」と認めてよい
- 価格アクション（OHLC・レンジ）から「下髭/上髭/サポート反転/レジスタンス・ブレイク」を読み取れる場合は併記してよい
- 銘柄間連動 (USD/JPY → 日経、原油 → イラン、米10年債 → リスクオフ) も触れて良い`;

// LLM プロバイダ自動切替: 優先順に試し、429 を受けたら次へ
// 各プロバイダ独立した circuit-breaker で、復活したら自動的に優先順位通り使う
export interface LLMProvider {
  name: string;
  envVar: string;
  baseURL: string | undefined;
  model: string;       // explain 用
  chatModel: string;   // chat 用 (品質重視)
}

export const LLM_PROVIDERS: LLMProvider[] = [
  // 1. Gemini (品質高、無料、日次1500回)
  {
    name: 'gemini',
    envVar: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.5-flash-lite',
    chatModel: 'gemini-2.5-flash',
  },
  // 2. Groq (高速、無料、日次14400回 — 実質無制限)
  {
    name: 'groq',
    envVar: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    chatModel: 'llama-3.3-70b-versatile',
  },
  // 3. OpenAI (有料、最後の砦)
  {
    name: 'openai',
    envVar: 'OPENAI_API_KEY',
    baseURL: undefined,
    model: 'gpt-4o-mini',
    chatModel: 'gpt-4o-mini',
  },
];
