// server/llm/planSplitConfig.ts — ★計画サイクルを A/B に分けるかどうかの **唯一のスイッチ**。
//
// ■ ★v0.9.96 で既定が反転した(false → **true**)
//   ユーザーの判断で「分割を **既定で有効** にして出す」。
//   ★これで「既定オフだから安全」という言い訳は使えない。分割経路の壊れは
//     出荷までに直っていることが前提(v0.9.96 でレンジの純減と二重表示を塞いだ)。
//   ★効きは **依然として未測定**(実 LLM で A/B の成績を比べていない)。有効化は
//     「測るために走らせる」判断であって、良いと分かったからではない。
//
// ■ 戻し方は2通り(どちらでも旧経路に戻る) ★**反転しても戻し口は1バイトも変えていない**
//   ① 即時: 環境変数 JP225_PLAN_SPLIT=0 を置いて再起動(★ビルドし直さずに戻せる。**本命**)
//   ② 恒久: 下の PLAN_SPLIT_DEFAULT を false に戻して再ビルド
//   ★どちらでも「A/B を呼ぶ経路そのものが実行されない」= 旧経路が1バイトも変わらずに走る
//     (scalpPlan.ts の `if (isPlanSplitEnabled() && …)` の中だけが分割で、外は無改造)。
//   ★**戻し口が1箇所であることが、この既定変更の前提**。増やさないこと。
//
// ■ ★出して悪ければ戻す(既定が反転したので手順も反転している)
//   悪いと判断したら **env で 0 を置いて再起動** する。ビルドも版上げも要らない。
//   ★「何が悪かったか」を切るための材料は台帳に残る:
//     a_direction / a_why / b_variant / b_strategy / ai_why / split_bypass_reason /
//     a_provider(_model) / b_provider(_model) / tool_calls。
//     ★分割で走った回だけ a_direction が非 NULL なので、**母集団は SQL で切れる**。
//
// ■ ★ここで env を読む理由(設定 UI にしない理由)
//   設定 UI に置くと「実行中に切り替わる」= 同じサイクルの途中で経路が変わりうるし、
//   台帳の app_version だけでは前後を切れなくなる。★起動時に1回だけ決めて、
//   そのプロセスの間は動かさない(= 記録の母集団が途中で混ざらない)。

/** ★分割の既定。**true = A/B 分割(2回呼び出し)**(v0.9.96 で false から反転)。
 *  ここは恒久の戻し場所。★即時に戻すときは env(JP225_PLAN_SPLIT=0)を使う。 */
export const PLAN_SPLIT_DEFAULT = true;

/** 環境変数名(即時の戻し場所)。'1'/'true'/'on' で有効、'0'/'false'/'off' で無効。 */
export const PLAN_SPLIT_ENV = 'JP225_PLAN_SPLIT';

/** ★プロセス起動後に1回だけ解決して固定する(途中で母集団が混ざらないようにする)。 */
let resolved: boolean | null = null;

/** 純関数版(テスト用)。env の生値から有効/無効を決める。未設定・読めない値は既定。 */
export function resolvePlanSplit(raw: string | undefined): boolean {
  if (raw === undefined) return PLAN_SPLIT_DEFAULT;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  // ★読めない値では **既定に落ちる**。v0.9.96 で既定が true になったので、
  //   ここは「黙って有効化しない」ではなく「黙って無効化もしない」= 既定に従う、が正確。
  //   ★戻したいときは必ず 0/false/off/no のどれかを書くこと(綴り違いは戻らない)。
  return PLAN_SPLIT_DEFAULT;
}

/** いま A/B 分割で動いているか。★プロセス内で最初の1回だけ決まる。 */
export function isPlanSplitEnabled(): boolean {
  if (resolved === null) {
    resolved = resolvePlanSplit(process.env[PLAN_SPLIT_ENV]);
    console.log(`[scalp-plan] 計画サイクル: ${resolved ? 'A/B 分割(2回呼び出し)' : '従来(1回呼び出し)'}`
      + ` — 切り替えは ${PLAN_SPLIT_ENV}=1/0 か PLAN_SPLIT_DEFAULT`);
  }
  return resolved;
}

/** ★テスト専用: プロセス内の固定を解除する(本番からは呼ばない)。 */
export function resetPlanSplitForTest(): void { resolved = null; }
