// ユーザー設定の永続化: ~/.jp225-monitor/config.json
// .env よりも優先。配布版でも .env なしで動かせる。

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_SHOCK_PARAMS, type ShockParams } from './shockDetector.js';

const CONFIG_DIR = () => join(homedir(), '.jp225-monitor');
const CONFIG_FILE = () => join(CONFIG_DIR(), 'config.json');

export interface UserConfig {
  geminiKey?: string;
  groqKey?: string;
  openaiKey?: string;
  tavilyKey?: string;     // チャットの web_search(Tavily)用
  chromePath?: string;    // scalp-plan のチャート撮影に使う chrome.exe の明示パス(未設定は自動解決)
  pricePollMs?: number;
  newsPollMs?: number;
  port?: number;
  cooldownMin?: number;   // アラート共有クールダウン(分)
  shockMove1Yen?: number;
  shockMove2Yen?: number;
  shock1Yen?: number;
  shock2Yen?: number;
  shockAccelYen?: number;
  shockAvgMult?: number;
  shockScoreNeed?: number;
  shockCooldownBars?: number;
  openGuardBars?: number;
  flashYen?: number;
  granvilleMaMid?: number;    // グランビル 中期MA 本数(1分足)
  granvilleMaLong?: number;   // グランビル 長期MA 本数(1分足)
  levelTol?: number;
  levelShowN?: number;
  levelSelectWindowYen?: number;
  fibConfluenceBonus?: number;
  levelTestBonus?: number;
  levelLookbackSessions?: number;    // 直近高安の対象セッション数
  levelLookbackSessions2?: number;   // 直近高安2(少し長い期間)の対象セッション数
}

type ProviderName = 'gemini' | 'groq' | 'openai';

// 各パラメータの範囲とデフォルト
export const PARAM_BOUNDS = {
  pricePollMs: { min: 500, max: 60_000, default: 2000 },
  newsPollMs:  { min: 10_000, max: 600_000, default: 60_000 },
  port:        { min: 1024, max: 65_535, default: 3000 },
  cooldownMin: { min: 1, max: 120, default: 15 },
  shockMove1Yen:    { min: 1, max: 500,  default: 25 },
  shockMove2Yen:    { min: 1, max: 1000, default: 40 },
  shock1Yen:        { min: 1, max: 1000, default: 50 },
  shock2Yen:        { min: 1, max: 2000, default: 70 },
  shockAccelYen:    { min: 0, max: 1000, default: 10 },
  shockAvgMult:     { min: 0.1, max: 20, default: 2.0 },
  shockScoreNeed:   { min: 2, max: 6,    default: 4 },
  shockCooldownBars:{ min: 0, max: 120,  default: 3 },
  openGuardBars:    { min: 0, max: 60,   default: 3 },
  flashYen:         { min: 1, max: 1000, default: 80 },
  granvilleMaMid:   { min: 5, max: 200,  default: 25 },
  granvilleMaLong:  { min: 5, max: 400,  default: 75 },
  levelTol:              { min: 5, max: 200, default: 25 },
  levelShowN:            { min: 1, max: 12, default: 5 },
  levelSelectWindowYen:  { min: 100, max: 10000, default: 1500 },
  fibConfluenceBonus:    { min: 1.0, max: 5.0, default: 1.5 },
  levelTestBonus:        { min: 0, max: 1, default: 0.15 },
  levelLookbackSessions:  { min: 2, max: 60,  default: 10 },
  levelLookbackSessions2: { min: 2, max: 120, default: 20 },
} as const;

let cached: UserConfig | null = null;
let cachedMtime = -1;

export function loadConfig(): UserConfig {
  const file = CONFIG_FILE();
  if (!existsSync(file)) { if (!cached) cached = {}; return cached; }
  let mtime = -1;
  try { mtime = statSync(file).mtimeMs; } catch { /* ignore */ }
  if (cached && mtime === cachedMtime) return cached;
  try {
    cached = JSON.parse(readFileSync(file, 'utf-8')) as UserConfig;
    cachedMtime = mtime;
    return cached;
  } catch (err) {
    console.error('[configStore] load failed:', err);
    if (!cached) cached = {};
    return cached;
  }
}

export function saveConfig(config: UserConfig): void {
  const file = CONFIG_FILE();
  mkdirSync(CONFIG_DIR(), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
  cached = config;
  try { cachedMtime = statSync(file).mtimeMs; } catch { cachedMtime = -1; }
  console.log(`[configStore] saved to ${file}`);
}

// APIキー解決: config.json 優先 → 環境変数 fallback
export function resolveApiKey(provider: ProviderName): string | undefined {
  const config = loadConfig();
  const fromConfig =
    provider === 'gemini' ? config.geminiKey
  : provider === 'groq'   ? config.groqKey
  : config.openaiKey;
  if (fromConfig && fromConfig.trim()) return fromConfig.trim();
  const envName =
    provider === 'gemini' ? 'GEMINI_API_KEY'
  : provider === 'groq'   ? 'GROQ_API_KEY'
  : 'OPENAI_API_KEY';
  return process.env[envName]?.trim();
}

// チャットの web_search(Tavily) キー解決: config.json 優先 → 環境変数 TAVILY_API_KEY。
export function resolveTavilyKey(): string | undefined {
  const fromConfig = loadConfig().tavilyKey;
  if (fromConfig && fromConfig.trim()) return fromConfig.trim();
  return process.env.TAVILY_API_KEY?.trim();
}

// 3 つの数値パラメータ resolver
// 優先順: config > env (port のみ) > default
export function resolvePricePollMs(): number {
  const v = loadConfig().pricePollMs;
  return typeof v === 'number' ? v : PARAM_BOUNDS.pricePollMs.default;
}

export function resolveNewsPollMs(): number {
  const v = loadConfig().newsPollMs;
  return typeof v === 'number' ? v : PARAM_BOUNDS.newsPollMs.default;
}

export function resolveCooldownMin(): number {
  const v = loadConfig().cooldownMin;
  return typeof v === 'number' ? v : PARAM_BOUNDS.cooldownMin.default;
}

export function resolvePort(): number {
  const v = loadConfig().port;
  if (typeof v === 'number') return v;
  const env = Number(process.env.PORT);
  const b = PARAM_BOUNDS.port;
  if (Number.isFinite(env) && env >= b.min && env <= b.max) return env;
  return b.default;
}

// 範囲外なら理由を文字列で返す。OK なら null。
export function validateParam(
  name: keyof typeof PARAM_BOUNDS,
  value: unknown,
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${name} must be a number`;
  }
  const b = PARAM_BOUNDS[name];
  if (value < b.min || value > b.max) {
    return `${name} out of range (${b.min}-${b.max})`;
  }
  return null;
}

function resolveNumeric(key: keyof typeof PARAM_BOUNDS): number {
  const v = (loadConfig() as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : PARAM_BOUNDS[key].default;
}

export function resolveShockParams(): ShockParams {
  return {
    ...DEFAULT_SHOCK_PARAMS,   // 固定: avgLen/breakLen/sameDirLen/sameDirNeed
    move1: resolveNumeric('shockMove1Yen'),
    move2: resolveNumeric('shockMove2Yen'),
    shock1: resolveNumeric('shock1Yen'),
    shock2: resolveNumeric('shock2Yen'),
    accelTh: resolveNumeric('shockAccelYen'),
    avgMult: resolveNumeric('shockAvgMult'),
    scoreNeed: resolveNumeric('shockScoreNeed'),
  };
}
export function resolveShockCooldownBars(): number { return resolveNumeric('shockCooldownBars'); }
export function resolveOpenGuardBars(): number { return resolveNumeric('openGuardBars'); }
export function resolveFlashYen(): number { return resolveNumeric('flashYen'); }
export function resolveGranvilleMaMid(): number { return resolveNumeric('granvilleMaMid'); }
export function resolveGranvilleMaLong(): number { return resolveNumeric('granvilleMaLong'); }

// v0.6.0: 的中率の「成功」判定しきい値(順行% ≥ これ)。シグナル種別ごとに持てる(既定は全種別同値 0.1%)。
// config の hitThresholds 例: { "default": 0.1, "double": 0.2, "level_sr": 0.15 }(リビルド不要で変更可)。
const DEFAULT_HIT_PCT = 0.1;
export function resolveHitThreshold(detectionKind: string | null): number {
  const cfg = loadConfig() as { hitThresholds?: Record<string, number> };
  const m = cfg.hitThresholds;
  if (m) {
    if (detectionKind && typeof m[detectionKind] === 'number') return m[detectionKind];
    if (typeof m.default === 'number') return m.default;
  }
  return DEFAULT_HIT_PCT;
}

// 主要レベル(意識される水準)のノブをまとめて解決。
// 数値のみ返す(Level 型に依存しない＝levels を import しない＝循環回避)。
export function resolveLevelsConfig(): {
  tol: number;
  showN: number;
  selectWindowYen: number;
  fibConfluenceBonus: number;
  levelTestBonus: number;
  lookbackSessions: number;
  lookbackSessions2: number;
} {
  return {
    tol: resolveNumeric('levelTol'),
    showN: resolveNumeric('levelShowN'),
    selectWindowYen: resolveNumeric('levelSelectWindowYen'),
    fibConfluenceBonus: resolveNumeric('fibConfluenceBonus'),
    levelTestBonus: resolveNumeric('levelTestBonus'),
    lookbackSessions: resolveNumeric('levelLookbackSessions'),
    lookbackSessions2: resolveNumeric('levelLookbackSessions2'),
  };
}

// 全数値パラメータを解決して返す（/api/settings GET 用、DRY）
export function resolveAllNumericParams(): Record<keyof typeof PARAM_BOUNDS, number> {
  const out = {} as Record<keyof typeof PARAM_BOUNDS, number>;
  for (const key of Object.keys(PARAM_BOUNDS) as (keyof typeof PARAM_BOUNDS)[]) {
    out[key] = resolveNumeric(key);
  }
  return out;
}

export function configFilePath(): string { return CONFIG_FILE(); }

// 起動時に呼ぶ: pricePollMs / newsPollMs / port が未設定なら default を
// config.json に書き込む。これで settings modal が常にデフォルト値を見せられる。
export function ensureDefaults(): void {
  const cfg = loadConfig();
  let modified = false;
  if (cfg.pricePollMs === undefined) {
    cfg.pricePollMs = PARAM_BOUNDS.pricePollMs.default;
    modified = true;
  }
  if (cfg.newsPollMs === undefined) {
    cfg.newsPollMs = PARAM_BOUNDS.newsPollMs.default;
    modified = true;
  }
  if (cfg.port === undefined) {
    cfg.port = PARAM_BOUNDS.port.default;
    modified = true;
  }
  if (cfg.cooldownMin === undefined) {
    cfg.cooldownMin = PARAM_BOUNDS.cooldownMin.default;
    modified = true;
  }
  if (modified) {
    saveConfig(cfg);
    console.log('[configStore] wrote default polling params');
  }
}

// テスト用 / 設定変更後のキャッシュリセット
export function resetConfigCache(): void {
  cached = null;
  cachedMtime = -1;
}
