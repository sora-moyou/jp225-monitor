// server/llm/planSplitConfig.ts — ★計画サイクルを A/B に分けるかどうかの **唯一のスイッチ**。
//
// ■ なぜ1箇所にするか
//   ★この分割が効くかは **完全に未測定** です(実 LLM で1回も走らせていない)。
//   出して悪ければ戻す必要があるので、戻す操作を **1箇所** に閉じ込める。
//
// ■ 戻し方は2通り(どちらでも旧経路に戻る)
//   ① 恒久: 下の PLAN_SPLIT_DEFAULT を false にして再ビルド
//   ② 即時: 環境変数 JP225_PLAN_SPLIT=0 を置いて再起動(★ビルドし直さずに戻せる)
//   ★どちらでも「A/B を呼ぶ経路そのものが実行されない」= 旧経路が1バイトも変わらずに走る。
//
// ■ ★ここで env を読む理由(設定 UI にしない理由)
//   設定 UI に置くと「実行中に切り替わる」= 同じサイクルの途中で経路が変わりうるし、
//   台帳の app_version だけでは前後を切れなくなる。★起動時に1回だけ決めて、
//   そのプロセスの間は動かさない(= 記録の母集団が途中で混ざらない)。

/** ★分割の既定。**false = 旧経路(1回呼び出し)**。ここが恒久の戻し場所。 */
export const PLAN_SPLIT_DEFAULT = false;

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
  return PLAN_SPLIT_DEFAULT;   // ★読めない値で黙って有効化しない
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
