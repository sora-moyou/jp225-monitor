// 起動時の検証。**満たさなければ走らない**。
//
// ■ なぜ「走ってから気づく」ではダメか
//   この実験は1年かけて標本を溜める。前提が崩れたまま走ると、溜まるのは「測ったふりをした標本」で、
//   1年後にそれを捨てることになる。しかも捨てられるのは、崩れていたことに **気づけた場合だけ**。
//   だから前提は起動時に全部確かめ、1つでも欠ければ **理由を明示して終了** する。黙って縮退しない。
//
// ■ 何を確かめるか
//   ① monitor に到達できること
//   ② 決済実装が非公開実装であること(exit.impl==='private')
//      公開フォールバックだと決済はラチェット無しの別物で、実験は何も測らない。
//   ③ 変種の実装が実体を持つこと(exit.variantImpl==='private')
//      フォールバックだと 'candidate-a' の説明文が 'current' とほぼ同一になり、①と②が
//      **同じ質問** を投げる。それでも記録には「候補仕様で生成した」と残る=最悪の壊れ方。
//   ④ 生成器専用キーが全プロバイダで設定済みであること
//      ★共通キーへフォールバックしている状態で走らせない。生成器が上流クォータを食い潰すと
//      A(実弾)が 429 を踏み、最大8時間ポーズする。generatorGate の従属規則は **事後的** で、
//      A が最初の一発を必ず食う。事後の停止では守れない以上、事前に止めるしかない。
//   ⑤ 凍結設定を /api/settings から取得して記録(★取引記録から推測しない)
//   ⑥ 決済設定の版と指紋(exit.configVersion / exit.configHash)を記録

import { GENERATOR_PROVIDERS, type GeneratorProviderName } from '../configStore.js';

/** 生成器が「専用キーで動いている」と言える出どころ。'shared'(共通キー)と 'none' は不可。 */
const DEDICATED_KEY_SOURCES: readonly string[] = ['own', 'env'];

export interface PreflightOk {
  ok: true;
  /** /api/status の exit ブロック(数値は含まれない)。 */
  exit: { impl: string; variantImpl: string; configVersion: number | null; configHash: string };
  /** /api/settings の生スナップショット(そのまま記録する)。 */
  settings: Record<string, unknown>;
}

export type PreflightResult = PreflightOk | { ok: false; reason: string };

/** 取得済みの応答から前提を判定する純関数(ネットワークを触らない=テストで全経路を通せる)。 */
export function evaluatePreflight(statusJson: unknown, settingsJson: unknown): PreflightResult {
  if (!statusJson || typeof statusJson !== 'object') {
    return { ok: false, reason: '/api/status の応答が JSON オブジェクトではありません' };
  }
  const exitRaw = (statusJson as Record<string, unknown>).exit;
  if (!exitRaw || typeof exitRaw !== 'object') {
    return { ok: false, reason: '/api/status に exit ブロックがありません(monitor が古い可能性)' };
  }
  const exit = exitRaw as Record<string, unknown>;
  if (typeof exit.error === 'string') {
    return { ok: false, reason: `monitor が決済実装を観測できていません(exit.error=${exit.error})` };
  }
  if (exit.impl !== 'private') {
    return {
      ok: false,
      reason: `決済実装が非公開実装ではありません(exit.impl=${String(exit.impl)})。`
        + '公開フォールバックはラチェット無しの別物なので、この実験は何も測りません',
    };
  }
  if (exit.variantImpl !== 'private') {
    return {
      ok: false,
      reason: `決済仕様の変種が実体を持ちません(exit.variantImpl=${String(exit.variantImpl)})。`
        + '候補の説明文が現行とほぼ同一になり、①と②が同じ質問を投げます',
    };
  }
  const configHash = typeof exit.configHash === 'string' ? exit.configHash : null;
  if (!configHash) {
    return { ok: false, reason: '/api/status の exit.configHash が取得できません(決済設定の指紋が無い期は作らない)' };
  }

  if (!settingsJson || typeof settingsJson !== 'object') {
    return { ok: false, reason: '/api/settings の応答が JSON オブジェクトではありません' };
  }
  const settings = settingsJson as Record<string, unknown>;
  const sources = settings.generatorKeySources;
  if (!sources || typeof sources !== 'object') {
    return {
      ok: false,
      reason: '/api/settings に generatorKeySources がありません'
        + '(分析用の入口を持たない公開版 lite の monitor に繋いでいる可能性)',
    };
  }
  const shared: string[] = [];
  for (const p of GENERATOR_PROVIDERS) {
    const src = (sources as Record<GeneratorProviderName, unknown>)[p];
    if (!DEDICATED_KEY_SOURCES.includes(String(src))) shared.push(`${p}=${String(src)}`);
  }
  if (shared.length > 0) {
    return {
      ok: false,
      reason: `生成器専用キーが未設定のプロバイダがあります(${shared.join(' ')})。`
        + '共通キーへフォールバックしたまま走らせると、生成器が上流クォータを食い潰して'
        + '実弾(A)が429を踏み、最大8時間ポーズします(従属規則は事後的で A が最初の一発を必ず食う)',
    };
  }

  const configVersion = typeof exit.configVersion === 'number' ? exit.configVersion : null;
  return {
    ok: true,
    exit: { impl: 'private', variantImpl: 'private', configVersion, configHash },
    settings,
  };
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** monitor から /api/status と /api/settings を取り、前提を判定する。
 *  到達できない/JSON でない場合も **理由つきの ok:false** にする(例外で落とさない=理由が消えない)。 */
export async function runPreflight(
  monitorUrl: string, fetcher: Fetcher, timeoutMs: number,
): Promise<PreflightResult> {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetcher(`${monitorUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${path} が HTTP ${res.status}`);
    return await res.json();
  };
  let statusJson: unknown;
  let settingsJson: unknown;
  try {
    statusJson = await get('/api/status');
    settingsJson = await get('/api/settings');
  } catch (e) {
    return { ok: false, reason: `monitor(${monitorUrl})に到達できません: ${e instanceof Error ? e.message : String(e)}` };
  }
  return evaluatePreflight(statusJson, settingsJson);
}
