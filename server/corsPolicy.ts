// CORS 例外(/api/exit-stop)の **パス照合の規約** だけを置く純モジュール。
//
// ■ 直した欠陥(消すとまた同じ穴が開く)
//   server/index.ts は `NO_CORS_PATHS.has(req.path)` と **完全一致** で照合していた。ところが express は
//   既定で caseSensitive=false / strict=false なので、同じハンドラへ届く別表記が存在する。実測:
//     POST /api/exit-stop   → Access-Control-Allow-Origin: (なし)   ← 意図どおり
//     POST /API/exit-stop   → Access-Control-Allow-Origin: *        ← 例外をすり抜けた
//     POST /api/exit-stop/  → Access-Control-Allow-Origin: *        ← 同上
//   ハンドラ側の access gate(Origin / Referer / Sec-Fetch-Site を持つ要求を 403)が効くので
//   ブラウザからのオラクル化には至らない = **多層防御の1層が効いていなかった** という位置づけだが、
//   「片方が効いているから片方は要らない」は多層防御ではないので直す。
//
// ★access gate は一切弱めない。ここは CORS ヘッダを付けない範囲を **広げる** 方向にしか働かない。
// ★index.ts に置かず別モジュールにしてあるのは、index.ts が import しただけでサーバを起動する
//   副作用モジュールで、テストから読めないため(観測できない規約は守られない)。

/**
 * ルーティングと同じ規約(caseSensitive=false / strict=false)でパスを正規化する。
 *  - 小文字化      … `/API/exit-stop` を `/api/exit-stop` と同一視する。
 *  - 末尾スラッシュ除去 … `/api/exit-stop/` を `/api/exit-stop` と同一視する('/' 自身は残す)。
 * ★迷ったら「CORS を付けない側」へ倒す(付けそこねても壊れるのは正規経路ではなくブラウザ探索だけ)。
 */
export function normalizeCorsPath(p: string): string {
  const lower = p.toLowerCase();
  return lower.length > 1 ? lower.replace(/\/+$/, '') : lower;
}
