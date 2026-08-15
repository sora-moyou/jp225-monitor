// bars_1m の1行が「どこから来たか」(出所)と、出所が違う書き込みがぶつかったときの唯一の解決規則。
//
// ■ なぜ要るか
//   bars_1m は主キー (symbol, t) で、基礎データ(週次 xlsx 由来・server/basedata.ts の importBars)も
//   ライブ(フィードの tick を畳んだ足・collector/record.ts)も **同じ銘柄名 NIY=F** で同じ表に書く。
//   これまで出所を区別する列が無く、`ON CONFLICT DO UPDATE` で **後に書いた方が勝つ** だけだった。
//   つまり「基礎データを取り込んだ分に、後からライブの値が上書きされる」ことが起こりうる。
//
// ■ 実測(2026-08-03〜08-13・同一分 10,392 本で基礎データとライブを突き合わせ)
//   ・終値: 完全一致 39.8% / |差|中央 5円 / p90 15円 / p99 40円 / 最大 140円。系統的なオフセットは無い
//     (平均差 −0.12円 = 同じ商品。別商品ならここに数百〜数千円の段差が出る)。
//   ・高値はライブが平均 3.41円 **低く**、安値はライブが平均 3.52円 **高い**。つまりライブ足のレンジは
//     基礎データより狭い(ライブは約2秒間隔のポーリングで分内の極値を取りこぼす)。ATR 等のボラ指標を
//     過小評価しないためにも、基礎データがある分は基礎データを使うのが正しい。
//
// ■ 規則(これが唯一の定義。表は core/barSource.test.ts で固定)
//   ・基礎データの書き込み … 常に上書きしてよい(基礎データが正)。
//   ・ライブの書き込み     … 既存行が基礎データなら上書きしない。
//   ・既存行の出所が NULL(この列を持たない版で書かれた行=大多数の既存 DB) … 従来どおり上書きする
//     (挙動を1ミリも変えないため)。

/** bars_1m.src に入る値。NULL は「出所不明(この列より前に書かれた行)」を意味し、この型には含めない。 */
export type BarSource = 'base' | 'live';

/** 基礎データ(週次 xlsx 由来)。 */
export const BAR_SRC_BASE = 'base';
/** ライブ(リアルタイムフィード由来)。 */
export const BAR_SRC_LIVE = 'live';

/** その行が基礎データ由来か。NULL(出所不明)は false。 */
export function isBaseBar(src: string | null | undefined): boolean {
  return src === BAR_SRC_BASE;
}

/**
 * 同一 (symbol, t) に既存行があるとき、`incoming` の書き込みで **上書きしてよいか**。
 * 行が存在しない場合(=単なる INSERT)はこの関数を呼ばない。
 *
 * @param existing 既存行の src('base' | 'live' | null=出所不明)
 * @param incoming これから書く側の出所
 */
export function shouldOverwriteBar(existing: string | null, incoming: BarSource): boolean {
  if (incoming === BAR_SRC_BASE) return true;   // 基礎データは常に正
  return !isBaseBar(existing);                  // ライブは基礎データを塗り替えない(NULL は従来どおり可)
}
