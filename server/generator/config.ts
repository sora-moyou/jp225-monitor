// 分析用(別プロセス)の実行時設定。
//
// ★この設定は epoch(標本の期)の一部になる。間隔や対照の頻度を変えれば標本の性質が変わるので、
//   「設定を変えたのに同じ期のまま集計される」ことが無いよう、epoch の計算入力に丸ごと入れる
//   (server/generator/epoch.ts)。

/** 既定値。**設計として確定済み**の値はここに1か所だけ置く(分析用の他のモジュールは env を読まない)。 */
export const GENERATOR_DEFAULTS = {
  /** 1サイクルの間隔[ms]。2分ごとに1サイクル。 */
  intervalMs: 120_000,
  /** 対照(①')を挟む頻度。5サイクルに1回。0 で対照なし。 */
  controlEvery: 5,
  /** ★429-busy を受けたときの再試行までの待ち[ms]の範囲(15〜20秒)。1回だけ再試行する。 */
  retryMinMs: 15_000,
  retryMaxMs: 20_000,
  /** 1要求の上限[ms]。monitor 側はチャート撮影(最大42秒)を最大2回試してから LLM を呼ぶので、
   *  短すぎると「本当は返ってきたのに timeout と記録する」偽の欠測を作る。 */
  requestTimeoutMs: 180_000,
  /** 取引日ごとの件数を追記する間隔[ms]。取引日が変わったときは間隔に関わらず追記する。 */
  tallyIntervalMs: 30 * 60_000,
} as const;

export interface GeneratorConfig {
  /** 接続先の monitor。既定は localhost(monitor の設定ポート)。 */
  monitorUrl: string;
  intervalMs: number;
  controlEvery: number;
  retryMinMs: number;
  retryMaxMs: number;
  requestTimeoutMs: number;
  tallyIntervalMs: number;
}

/** 正の整数だけを受理する(不正値は既定へ倒す。★倒したことは呼び出し側がログに出す)。 */
function posInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 0以上の整数(対照の頻度は 0=対照なし を受理する)。 */
function nonNegInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** 実行時設定を env から解決する。接続先 URL は設定可能・既定は localhost。 */
export function resolveGeneratorConfig(env: NodeJS.ProcessEnv, defaultPort: number): GeneratorConfig {
  const url = env.GENERATOR_MONITOR_URL?.trim();
  const retryMin = posInt(env.GENERATOR_RETRY_MIN_MS, GENERATOR_DEFAULTS.retryMinMs);
  const retryMax = posInt(env.GENERATOR_RETRY_MAX_MS, GENERATOR_DEFAULTS.retryMaxMs);
  return {
    monitorUrl: (url || `http://127.0.0.1:${defaultPort}`).replace(/\/+$/, ''),
    intervalMs: posInt(env.GENERATOR_INTERVAL_MS, GENERATOR_DEFAULTS.intervalMs),
    controlEvery: nonNegInt(env.GENERATOR_CONTROL_EVERY, GENERATOR_DEFAULTS.controlEvery),
    retryMinMs: retryMin,
    // 下限を上回らせる(逆転した設定で待ち時間が負になる/常に下限になるのを防ぐ)。
    retryMaxMs: Math.max(retryMin, retryMax),
    requestTimeoutMs: posInt(env.GENERATOR_REQUEST_TIMEOUT_MS, GENERATOR_DEFAULTS.requestTimeoutMs),
    tallyIntervalMs: posInt(env.GENERATOR_TALLY_INTERVAL_MS, GENERATOR_DEFAULTS.tallyIntervalMs),
  };
}

/** ★epoch に食わせる分析用設定。**monitorUrl は含めない**:
 *  接続先は「どの PC のどのポートに繋いだか」であって、標本の性質ではない。含めると
 *  ポートを変えただけで期が割れる(=同じ実験なのに集計が分断される)。接続先は runs 表に残す。 */
export function epochGeneratorConfig(cfg: GeneratorConfig): Omit<GeneratorConfig, 'monitorUrl'> {
  const { monitorUrl: _ignored, ...rest } = cfg;
  return rest;
}
