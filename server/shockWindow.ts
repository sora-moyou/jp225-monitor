// アラート説明で「ユーザーが実際に提示されたニュース以降」だけを次回参照するためのアンカー。
// /api/explain が実際に説明を生成した時のみ前進する(API節約モード/テクニカル固定文では /api/explain を
// 呼ばないので据置)。値=直近説明で提示したニュースの最大 publishedAt。
let lastReferencedNewsAt = 0;

/** 説明で実提示したニュースの最大 publishedAt を記録(単調・0は無視)。 */
export function noteReferencedNews(maxPublishedAt: number): void {
  if (maxPublishedAt > lastReferencedNewsAt) lastReferencedNewsAt = maxPublishedAt;
}

/** 説明で参照すべきニュースの開始時刻(=直近で実提示したニュース以降)。0=まだ無し→従来の固定窓。 */
export function newsSinceForAlert(): number { return lastReferencedNewsAt; }

export function _reset(): void { lastReferencedNewsAt = 0; }
