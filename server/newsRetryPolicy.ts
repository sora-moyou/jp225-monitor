// server/newsRetryPolicy.ts — 翻訳の再試行ポリシー(純関数・**依存ゼロ**)。
//
// ★なぜ独立した葉モジュールなのか:
//   この方針を検証する手段は2つある — テストと、実DBを測り直す scripts/news-window-measure.mts。
//   ポリシーが newsTranslate.ts(= LLM プロバイダ一式を読み込む)に埋まっていると、
//   「窓の長さを測るだけ」のスクリプトが API キーを読み、プロバイダを構築してしまう。
//   ここを依存ゼロにしておけば、**測定と方針だけを** 切り出して確かめられる。

// ─── ★窓の長さ(バックオフの上限を決める唯一の外的事実) ───────────────────────
//
// 翻訳の対象になるのは **その回の取得で返ってきた記事**だけで、取得は新しい順に
// NEWS_MAX_ITEMS 件(=200)。記事はそこから押し出されると items に戻らないので、
// 「窓が続く時間」より長いバックオフは、待っている間に対象が消える = ただ訳さないのと同じ。
//
// ★実測(2026-08-11・稼働機DBのコピー・**200件窓の全アンカー 1320本**):
//     min 92.9分 / p05 98分 / p25 136分 / median 183分 / p75 244分 / max 2499分
//   ★以前ここに書いていた「約5.2時間」は **1アンカーだけの値**で、実分布では上位13%だった。
//     それを根拠にした累計130分は、実際には **アンカーの20.3%で窓を超えていた**(=救えない)。
//   ★この定数は循環しない: `npx tsx scripts/news-window-measure.mts <db>` がいつでも測り直し、
//     宣言値・ラダー・実測 min の関係を検査して不整合なら exit 1 を返す。
//     テスト側も「NEWS_MAX_ITEMS ÷ 最大到着ペース」と突き合わせるので、
//     NEWS_MAX_ITEMS を変えたらこの定数を見直さないと落ちる。
/** 200件窓が続く時間の下限(実測 min 92.9分に対し **切り下げて** 90分)。バックオフはこれを超えてはならない。 */
export const NEWS_FETCH_WINDOW_MIN_MS = 90 * 60_000;
/** 上の実測が示す新着の最大ペース[件/分]。★NEWS_MAX_ITEMS と窓の整合を機械的に見張るために持つ。 */
export const NEWS_PEAK_ARRIVAL_PER_MIN = 200 / 90;

// ─── 失敗した記事の再試行 ─────────────────────────────────────────────────
//
// ★事故(2026-08-10): 一度 translate_error が付いた記事は **永久に未訳**だった。
//   プロバイダ側の一過性の 400 で 455 件が固まり、原因を直しても救われなかった。
//   かといって毎分叩き直すのは、LLM が落ちている間ずっと費用と 429 を生むので論外。
//
// ★間隔の根拠: 累計が **実測最小の窓に必ず収まる**こと。10分 → 30分(累計40分)は
//   1320アンカーの **100%** で窓に収まる(90分に対して 2.25倍の余裕)。
// ★回数の根拠: 3回(初回 + 再試行2回)。**回数を消費するのは「記事に固有の理由」で失敗したときだけ**
//   (プロバイダ側の障害では 1 も増えない)なので、ここで守りたいのは
//   「同じ見出しを永遠に叩き続けない」ことだけ。長いラダーはもう要らない。
//   3回使い切った記事は **健全なプロバイダが3回とも使える訳を返せなかった** 記事。
/** 失敗回数 n(1始まり)の後、次に試すまでの待ち[ms]。長さ=再試行の回数。 */
export const TRANSLATE_RETRY_BACKOFF_MS = [10 * 60_000, 30 * 60_000];
/** 1記事あたりの試行回数の上限(初回 + 再試行)。これを超えたら二度と訳さない。 */
export const TRANSLATE_MAX_ATTEMPTS = TRANSLATE_RETRY_BACKOFF_MS.length + 1;
/** バックオフの累計[ms]。★窓に収まることを検査するための導出値(手で書かない)。 */
export const TRANSLATE_RETRY_TOTAL_MS = TRANSLATE_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0);

/** 失敗した記事の再試行状態(DB 由来)。 */
export interface TranslateRetryState {
  /** **記事に固有の理由で**失敗した回数。0=プロバイダ側の事情で失敗しただけ(消費なし)。 */
  attempts: number;
  /** 最後に試した時刻[epoch ms]。0/不明なら再試行しない。 */
  lastAttemptAt: number;
}

/**
 * 失敗済みの記事を **今** もう一度訳してよいか(純関数)。
 * ★attempts=0(=プロバイダ側の事情で失敗しただけ)は **待たずに** 対象へ戻す。
 *   その記事について何も分かっていないので、バックオフを掛ける理由が無い。
 * ★状態が無い/時刻が不明なときは false = 再試行しない(安全側)。
 */
export function shouldRetryTranslation(st: TranslateRetryState | undefined, now: number): boolean {
  if (!st) return false;
  if (!Number.isFinite(st.lastAttemptAt) || st.lastAttemptAt <= 0) return false;
  const attempts = Math.max(0, Math.floor(st.attempts));
  if (attempts === 0) return true;                               // ★連鎖が落ちていただけ = 即対象
  if (attempts >= TRANSLATE_MAX_ATTEMPTS) return false;          // ★打ち止め(無限リトライ禁止)
  const wait = TRANSLATE_RETRY_BACKOFF_MS[attempts - 1]!;
  return now - st.lastAttemptAt >= wait;
}
