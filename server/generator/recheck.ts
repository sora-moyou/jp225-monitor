// ★稼働中の再検証(前提 + 期)。**サイクルごとに** 呼ぶ。
//
// ■ なぜ「起動時1回」では嘘になるか
//   epoch.ts はこう書いてある — 「**入力が動けば epoch が自動で変わる** ようにする(人が手で版を上げる
//   運用にしない=上げ忘れた瞬間に静かに嘘になる)」。ところが実際に epoch を計算していたのは main() の
//   **ループの外** で、1回だけだった。生成器プロセスは数か月動き続けるのに、その間に
//   バイアス(long/short)や LC 安全上限をライブで切り替えるのは **この案件では常態** なので、
//   設定を変えた瞬間から「別条件の標本が同じ期のラベルで積まれ続ける」。
//   人が版を上げ忘れるのを嫌って自動化したはずの仕組みが、再評価しないせいで同じ穴を開けていた。
//   → **止めるのではなく期を分ける**。設定を変えたら、その時点から新しい epoch で積む。
//
//   同じ穴が前提検証にもある。稼働中に生成器専用キーを外すと configStore が黙って共通キーへ
//   フォールバックし(resolveGeneratorKey)、生成器が A の枠を食い始める。起動時にしか見ないなら
//   気づけない。→ 前提が **崩れた** ら止める(unreachable は monitor の再起動でも起きるので止めない)。
//
// ■ ここには HTTP と純計算しか無い(取引経路に一切触らない)

import { buildEpochInput, computeEpoch, type EpochExitInput } from './epoch.js';
import { epochGeneratorConfig, type GeneratorConfig } from './config.js';
import { runPreflight, type Fetcher, type PreflightOk } from './preflight.js';

/** 再検証の結末。★「変わっていない」も明示的な値にする(無言の続行を作らない)。 */
export type RecheckResult =
  /** 前提OK・epoch も同じ。そのまま続ける。 */
  | { kind: 'same'; epoch: string; pre: PreflightOk; epochInput: Record<string, unknown> }
  /** 前提OK・**epoch が変わった**。ここから先は新しい期として積む(止めない)。 */
  | { kind: 'epoch-changed'; epoch: string; prevEpoch: string; pre: PreflightOk; epochInput: Record<string, unknown> }
  /** ★前提が崩れた。止める。 */
  | { kind: 'violated'; reason: string }
  /** monitor に届かなかった。前提が崩れた証拠が無いので **止めない**(現在の期のまま続ける)。 */
  | { kind: 'unreachable'; reason: string };

/** 前提と epoch を取り直して、前回の epoch と比べる。
 *  ★epoch の計算は起動時と **完全に同じ関数** を通す(計算方式が2か所に散ると片方だけ古くなる)。 */
export async function recheck(
  cfg: GeneratorConfig, fetcher: Fetcher, timeoutMs: number, prevEpoch: string | null,
): Promise<RecheckResult> {
  const pre = await runPreflight(cfg.monitorUrl, fetcher, timeoutMs);
  if (!pre.ok) return { kind: pre.kind, reason: pre.reason };
  const epochInput = buildEpochInput(pre.settings, pre.exit as EpochExitInput, epochGeneratorConfig(cfg));
  const epoch = computeEpoch(epochInput);
  if (prevEpoch !== null && epoch !== prevEpoch) {
    return { kind: 'epoch-changed', epoch, prevEpoch, pre, epochInput };
  }
  return { kind: 'same', epoch, pre, epochInput };
}

/** 期が変わった理由を人が読める形にする(★「何が変わって期が割れたか」を1年後に読むため)。
 *  値そのものは出さない: 決済は指紋、キーは出どころしか epoch 入力に載っていないが、
 *  凍結設定には数値が入るので **キー名だけ** を出す。 */
export function epochInputDiffKeys(prev: unknown, next: unknown): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const ao = a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : null;
    const bo = b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null;
    if (ao && bo) {
      for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
        walk(ao[k], bo[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    out.push(path || '(root)');
  };
  walk(prev, next, '');
  return out.sort();
}
