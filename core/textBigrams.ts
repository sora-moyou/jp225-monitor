// core/textBigrams.ts — 文字バイグラムによる日本語まじりテキストの類似判定。
//
// ★ここは既存実装の移設であって、新方式ではない。元は server/llm/dataTools.ts の private 関数で、
//   チャットの会話文脈フィルタに使われていた。ニュースの裏取り(corroboration)判定でも
//   「同じ出来事か」を測る必要が出たため、**同じ手法を 2 箇所で使う**ことにして core へ上げた。
//   コピーを増やすと片方だけ直したときに黙ってズレるので、関数はここ 1 つだけにする。
//
// なぜバイグラムか: 日本語は語分割が無いので、形態素解析器を入れずに類似を測るなら
// 2 文字の連なりを集合として比べるのが最も安く実用になる。英語混じりでも破綻しない。

/** 文字バイグラム配列(空白・記号除去・小文字化)。 */
export function bigrams(s: string): string[] {
  const c = s.toLowerCase().replace(/[\s、。,.!?？！「」（）()・:：;；'"’”]/g, '');
  const out: string[] = [];
  for (let i = 0; i + 2 <= c.length; i++) out.push(c.slice(i, i + 2));
  return out;
}

/**
 * 2 文字列のバイグラム重なり率(Szymkiewicz–Simpson / overlap 係数)。0〜1。
 * ★Jaccard ではなく overlap 係数にした理由: ニュースの見出しは長さが極端に違う
 *   (「【速報】日銀、利上げ」 vs 「日銀が政策金利を0.75%へ引き上げ、市場予想通り…」)。
 *   Jaccard だと長さの差だけで類似度が落ち、同じ出来事を別物と判定してしまう。
 *   overlap は「短い方がどれだけ長い方に含まれるか」を測るので、要約と詳報を同じ出来事と見なせる。
 */
export function bigramOverlap(a: string, b: string): number {
  const ga = new Set(bigrams(a));
  const gb = new Set(bigrams(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / Math.min(ga.size, gb.size);
}
