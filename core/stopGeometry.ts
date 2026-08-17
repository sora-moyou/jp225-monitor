// core/stopGeometry.ts — **損切りの向きの規約の唯一の権威**(monitor 内)。
//
// ■ 規約(1行で)
//     買い(buy / long)の損切りは 建値の **下** / 売り(sell / short)の損切りは 建値の **上**。
//     境界(損切り === 建値 = 幅0)は「実質ストップにならない」ので **不正** とする。
//
// ■ なぜ1箇所に集めるか(このファイルが在る理由)
//   この規約は monitor 内で **5箇所に手書きで複製** されていた。
//     server/llm/scalpPlan.ts  … stopSideOk(向きの検査) / stopLossFromWidth(幅→価格=符号を決める)
//     server/signalTrade/decisions.ts … stopOnCorrectSide / stopLossAtEntry(直前の版で新設された複製)
//     server/llm/rationaleLc.ts … declaredSideOk(根拠文が申告した建値/損切りに同じ規約を当てる)
//   複製されたそれぞれに「向きの規約を変えるときは両方を一緒に直すこと」と注記が付いていた=
//   **人間の記憶に依存した同期** であり、全体点検(2026-07-31)が金銭リスクとして挙げた形そのもの。
//   このプロジェクトは実際に「損切りが逆位置になって実取引が5.5時間停止した」事故を出している。
//   よって符号を決める場所を1つにし、他は import する(複製ではなく import)。
//
// ■ このファイルの制約
//   ★**依存ゼロの葉モジュールであること**(何も import しない)。
//     server / web / どの層からも引ける必要があり、特に rationaleLc.ts は
//     「scalpPlan がこのモジュールを import しているので逆向きに import すると循環する」という理由で
//     複製を持っていた。core/ の葉に置くことで、その循環が構造的に発生しなくなる。
//
// ■ ★別リポにも同じ規約の写しがある(今回は集約していない)
//   `jp225-trade2` の `src/ai/sanity.ts` が **実弾側** で同じ向きの検査を持っている。
//   別リポ・別リリースなので今回の集約の対象外=**monitor 内の集約であって、trade2 とは今も手動同期**。
//   向きの規約を変えるときは trade2 側も必ず一緒に見ること(monitor だけ直すと、
//   monitor が出したプランを trade2 のサニティが拒否し続けて実取引が止まる=既知の事故の形)。

/** 幅(正の数)から損切り **価格** を導く。**符号が決まるのはここだけ**(純関数)。
 *  買い: 建値 − 幅(下) / 売り: 建値 + 幅(上)。
 *
 *  ★これが在るおかげで「逆側の損切り価格」を書く場所そのものが存在しない(v0.9.70 の設計)。
 *    LLM が出すのは正の数の幅だけで、向きは direction / side からコードが一意に決める。
 *    規則を散文で強めるのは6版効かなかったので、**逆位置を表現不能にする** 方式に切り替えた経緯がある。
 *  ★widthYen の妥当性(正・非0・桁落ちで建値と一致しない)は **呼び出し側の責務**。ここは符号だけを決める。 */
export function stopLossFromWidth(side: 'buy' | 'sell', entry: number, widthYen: number): number {
  return side === 'buy' ? entry - widthYen : entry + widthYen;
}

/** 損切り(stopLoss)が建値(entry)の正しい外側にあるか(幾何・向きの検査・純関数)。
 *  買い(long)は損切りが建値の「下」、売り(short)は「上」(建玉を保護する向き)。
 *  境界(stopLoss === entry = 幅0)は実質ストップにならないので **不正**(false)を返す。
 *
 *  ★用途は2つあり、どちらも同じ規約でよい:
 *    (a) 実際に出力する価格の検証(scalpPlan の parse/enforce・decisions の arm 前の最終ガード)
 *    (b) 根拠文が **申告した** 建値/損切りの向きの観測(rationaleLc・RECORD-ONLY)。
 *        (b) は判定に一切使わない記録専用だが、当てる規約は (a) と同一でなければ
 *        「文章では間違え続けているか」を同じ物差しで測れない。 */
export function stopSideOk(side: 'buy' | 'sell', entry: number, stopLoss: number): boolean {
  return side === 'buy' ? stopLoss < entry : stopLoss > entry;
}
