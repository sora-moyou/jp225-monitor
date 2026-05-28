// ユーザー設定の永続化: ~/.jp225-monitor/config.json
// .env よりも優先。配布版でも .env なしで動かせる。

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = () => join(homedir(), '.jp225-monitor');
const CONFIG_FILE = () => join(CONFIG_DIR(), 'config.json');

export interface UserConfig {
  geminiKey?: string;
  groqKey?: string;
  openaiKey?: string;
  pricePollMs?: number;
  newsPollMs?: number;
  port?: number;
}

type ProviderName = 'gemini' | 'groq' | 'openai';

// 各パラメータの範囲とデフォルト
export const PARAM_BOUNDS = {
  pricePollMs: { min: 500, max: 60_000, default: 2000 },
  newsPollMs:  { min: 10_000, max: 600_000, default: 60_000 },
  port:        { min: 1024, max: 65_535, default: 3000 },
} as const;

let cached: UserConfig | null = null;

export function loadConfig(): UserConfig {
  if (cached) return cached;
  const file = CONFIG_FILE();
  if (!existsSync(file)) { cached = {}; return cached; }
  try {
    cached = JSON.parse(readFileSync(file, 'utf-8')) as UserConfig;
    return cached;
  } catch (err) {
    console.error('[configStore] load failed:', err);
    cached = {}; return cached;
  }
}

export function saveConfig(config: UserConfig): void {
  const file = CONFIG_FILE();
  mkdirSync(CONFIG_DIR(), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
  cached = config;
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

export function configFilePath(): string { return CONFIG_FILE(); }

// テスト用 / 設定変更後のキャッシュリセット
export function resetConfigCache(): void {
  cached = null;
}
