import type { NewsItem } from '../types.js';
import { detectionKindPromptLabel, isTechnicalKind, type DetectionKind } from '../../core/detectionKinds.js';
import {
  LLM_SYSTEM_PROMPT,
  NEWS_RECENT_WINDOW_MS, NEWS_RECENCY_DECAY_MIN,
  NEWS_PROXIMITY_TIGHT_MIN, NEWS_PROXIMITY_LOOSE_MIN,
  INSTRUMENT_KEYWORDS, HIGH_IMPACT_KEYWORDS,
} from '../config.js';
import type { Mover } from '../marketSnapshot.js';
import { callWithFallback } from './providers.js';

export interface ExplainInput {
  symbol: string;
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  // ★検知種別は core/detectionKinds.ts が唯一の定義(手書きコピー禁止)。
  detectionKind: DetectionKind;
  direction?: 'up' | 'down';
  change15min: number | null;
  pa15min: { open: number; high: number; low: number; current: number } | null;
  range1h: { high: number; low: number } | null;
  news: NewsItem[];
  crossAsset?: Mover[];
  newsSince?: number;     // ①: これ以降のニュースのみ参照(直前の急変以降)。0/未指定=従来の固定窓。
  l2Recent?: string;      // ①: 直近のテクニカル状態(L2シグナル)要約。テクニカル判定時に併記。
  newsWindowMs?: number;  // 暴落(crash)等で参照ニュース窓を広げる(未指定=既定4h)。
}

export function scoreNews(news: NewsItem, keywords: string[], now: number): number {
  const title = news.title.toLowerCase();
  let kwHits = 0;
  for (const kw of keywords) if (title.includes(kw.toLowerCase())) kwHits++;
  let highImpactHits = 0;
  for (const kw of HIGH_IMPACT_KEYWORDS) if (title.includes(kw.toLowerCase())) highImpactHits++;
  const ageMin = (now - news.publishedAt) / 60000;
  const recency = Math.max(0, 1 - ageMin / NEWS_RECENCY_DECAY_MIN);
  return kwHits * 2 + highImpactHits * 6 + recency;
}

// 急変近接プール選別 (v0.3.9)
// 4h 全体から拾うと「4h 前のキーワード豊富な記事 > 直近の正体不明短文」となり、的外れな引用が増える。
// ±15min → ±60min → 4h の段階フォールバックで、急変直前の材料を最優先する。
export function selectNewsPool(news: NewsItem[], now: number, sinceFloor = 0, windowMs = NEWS_RECENT_WINDOW_MS): NewsItem[] {
  // ①: 直前の急変以降に限定したい場合 sinceFloor を渡す。固定窓と「直前の急変以降」の遅い方を採用。
  // 暴落(crash)等は windowMs を広げて参照(ユーザー指定: ニュース期間を広く)。
  const cutoff = Math.max(now - windowMs, sinceFloor);
  const recent = news.filter(n => n.publishedAt >= cutoff);
  const tightMs = NEWS_PROXIMITY_TIGHT_MIN * 60_000;
  const looseMs = NEWS_PROXIMITY_LOOSE_MIN * 60_000;
  const tight = recent.filter(n => now - n.publishedAt <= tightMs);
  if (tight.length > 0) return tight;
  const loose = recent.filter(n => now - n.publishedAt <= looseMs);
  if (loose.length > 0) return loose;
  return recent;
}

export function formatCrossAsset(movers: Mover[]): string {
  if (movers.length === 0) return '【他資産】同時刻に目立った連動なし。';
  const lines = movers.map(m => {
    const arrow = m.direction === 'up' ? '▲' : '▼';
    const win = m.windowSeconds >= 300 ? '5分' : '1分';
    const sign = m.changePercent >= 0 ? '+' : '';
    return `- ${m.label} ${arrow} ${sign}${m.changePercent.toFixed(2)}% (${win}, z=${m.z.toFixed(1)})`;
  });
  return `【同時刻に大きく動いた他資産(z>=4.0)】\n${lines.join('\n')}`;
}

function rankAndFormatNews(pool: NewsItem[], symbol: string, now: number): string {
  const keywords = INSTRUMENT_KEYWORDS[symbol] ?? [];
  const ranked = [...pool]
    .map(n => ({ n, s: scoreNews(n, keywords, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map(x => x.n);
  if (ranked.length === 0) return '(直近4時間のニュース取得なし)';
  return ranked.map(n => {
    const ageMin = Math.max(0, Math.round((now - n.publishedAt) / 60000));
    return `- [${ageMin}分前] [${n.source}] ${n.title}`;
  }).join('\n');
}

export async function explain(input: ExplainInput): Promise<{ text: string; newsMaxPublishedAt: number }> {
  const now = Date.now();
  // ①: 参照プールを一度だけ確定し、実提示ニュースの最大 publishedAt を呼び出し側へ返す(アンカー前進用)。
  const pool = selectNewsPool(input.news, now, input.newsSince ?? 0, input.newsWindowMs ?? NEWS_RECENT_WINDOW_MS);
  const newsMaxPublishedAt = pool.reduce((m, n) => Math.max(m, n.publishedAt), 0);
  // ★種別名は core/detectionKinds.ts(promptLabel)が唯一の定義。ここに分岐の手書きコピーを戻さないこと。
  const kindLabel = detectionKindPromptLabel(input.detectionKind);
  // 方向は direction を真の源とし(dtb は changePercent=0 のため符号では判定不可)、無ければ符号で代替。
  const dir = input.direction ?? (input.changePercent >= 0 ? 'up' : 'down');
  const dirJa = dir === 'up' ? '上昇' : '下落';
  const windowHours = Math.round(NEWS_RECENT_WINDOW_MS / 3600_000);
  const ctx15Line = input.change15min !== null
    ? `【15分変化率】${input.change15min >= 0 ? '+' : ''}${input.change15min.toFixed(2)}%\n`
    : '';
  const pa15Line = input.pa15min
    ? `【15分OHLC】始値 ${fmt(input.pa15min.open)} / 高値 ${fmt(input.pa15min.high)} / 安値 ${fmt(input.pa15min.low)} / 現値 ${fmt(input.pa15min.current)}\n`
    : '';
  const range1hLine = input.range1h
    ? `【1時間レンジ】高値 ${fmt(input.range1h.high)} / 安値 ${fmt(input.range1h.low)}\n`
    : '';
  const dirEmphasis = dir === 'up' ? '⬆ 上昇方向' : '⬇ 下落方向';
  // テクニカル系(dtb/granville/break)は値幅(%)ではなくパターン局面なので、
  // 急変文・ノイズ注記(急変幅判定)を出さない。
  //   テクニカル(L2)判定は core/detectionKinds.ts が唯一の定義(nwave/dailyband も changePercent=0 の
  //   パターン局面なので急変文にしない)。
  const isTechnicalPattern = isTechnicalKind(input.detectionKind);
  const smallMag = !isTechnicalPattern && Math.abs(input.changePercent) <= 0.15;
  const ultraShort = input.detectionKind === 'slope' || input.windowSeconds <= 60;
  const noiseNotes = [
    smallMag ? '※ 急変幅が小さい (≤0.15%)。ノイズの可能性を考慮し、無理に材料を結びつけない。' : '',
    ultraShort ? '※ 超短期(〜1分)の動き。ニュース起因はまれ。同方向に動いた他資産が無ければ短期需給/テクニカルを既定とする。' : '',
  ].filter(Boolean).join('\n');
  // テクニカル系(dtb/granville/break)は「X秒でY%」の急変文ではなく、テクニカル局面として導入する。
  const headline = input.detectionKind === 'crash'
    ? `【暴落】${input.symbolLabel} がセッション高値から ${Math.abs(input.changePercent).toFixed(1)}% 急落しました(${dirEmphasis})。直近の材料を広く確認し、原因(ファンダ/需給/外部要因)を簡潔に。\n`
    : input.detectionKind === 'dtb'
    ? `【${kindLabel}】${input.symbolLabel} が主要な価格水準に ${dirEmphasis}(反転狙い)で接近しました(ダブルトップ/ボトム形成・ネック未達)。\n`
    : isTechnicalPattern
    ? `【${kindLabel}】${input.symbolLabel} がテクニカル局面(${kindLabel})にあります(${dirEmphasis})。\n`
    : `【急変・${kindLabel}】${input.symbolLabel} が ${input.windowSeconds}秒で ${input.changePercent.toFixed(2)}% ${dirJa} (${dirEmphasis}) しました。\n`;
  // ①ファンダ/テクニカル判定: 値動き(急変/フラッシュ)で、直前の急変以降に参照すべきニュースが
  // 1件も無ければ、LLMを呼ばず「テクニカル要因の可能性」と明示し、直近のテクニカル状態(L2)を併記する。
  // ※ 暴落(crash)は重大イベントなので短絡せず、必ず広いニュース窓でLLMに原因を分析させる(ユーザー指定)。
  if (!isTechnicalPattern && input.detectionKind !== 'crash' && pool.length === 0) {
    const l2 = input.l2Recent ? ` 直近のテクニカル状況: ${input.l2Recent}。` : '';
    return { text: `直前の急変以降、該当する材料ニュースなし → テクニカル要因の可能性。${l2}`, newsMaxPublishedAt };
  }
  const oppositeExample = dir === 'down'
    ? '「停戦/地政学リスク後退/利下げ観測/円安/米株高」は株高(⬆)要因なので、下落の説明に使わない'
    : '「地政学緊張・戦闘激化/利上げ・金利上昇/円高/弱い指標/米株安」は株安(⬇)要因なので、上昇の説明に使わない';
  const userPrompt =
    headline +
    (noiseNotes ? noiseNotes + '\n' : '') +
    ctx15Line + pa15Line + range1hLine +
    `\n${formatCrossAsset(input.crossAsset ?? [])}\n` +
    `\n【直近${windowHours}時間のニュース（関連性順、重大マクロは古くても上位）】\n${rankAndFormatNews(pool, input.symbol, now)}\n\n` +
    `[材料の方向(株式の一般則)]\n` +
    `・株高(⬆)要因: 停戦/地政学リスク後退, 利下げ観測, 良い経済指標, 円安, 米株高, リスクオン\n` +
    `・株安(⬇)要因: 地政学緊張・戦闘激化, 利上げ/金利上昇, 悪い経済指標, 円高, 米株安, リスクオフ\n` +
    `[手順]\n` +
    `1) まず「他資産」を見る。${dirEmphasis} と同方向に大きく動いた資産があれば、連動(リスクオン/オフ・金利・為替)として最優先で説明に使う。\n` +
    `2) 次に候補ニュースを上から見て、上の方向則で「その材料の極性」を判定し、${dirEmphasis} と一致するかを必ず確認する。\n` +
    `3) 極性が一致する材料(他資産 or ニュース)だけを選び「○○分前のXX、(方向の根拠)」形式で説明。\n` +
    `4) 極性が逆の材料は絶対に引用しない(例: ${oppositeExample})。一致する材料が無ければ「整合する明確な材料なし、短期需給/テクニカルの可能性」と書く。無理に結びつけない。\n` +
    `5) OHLCで下髭/上髭/サポート反転等が読めれば併記してよい。\n\n` +
    `出力は必ず200文字以内、1〜2文で。矛盾(株高要因で下落を説明する等)は禁止。`;

  const text = await callWithFallback(async (p) => {
    const completion = await p.client!.chat.completions.create({
      model: p.config.model,
      temperature: 0.3,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    const choice = completion.choices[0];
    const t = choice?.message?.content?.trim() ?? '(no response)';
    if (choice?.finish_reason === 'length') {
      console.warn(`[explain:${p.config.name}] TRUNCATED. usage=${JSON.stringify(completion.usage)}`);
      return t + ' …(token切れ)';
    }
    return t;
  }, 'explain');
  return { text, newsMaxPublishedAt };
}

export function fmt(n: number): string {
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(2);
  return n.toFixed(3);
}
