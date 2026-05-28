// ユーザー設定の永続化: ~/.jp225-monitor/config.json
// .env よりも優先。配布版でも .env なしで動かせる。

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(homedir(), '.jp225-monitor');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface UserConfig {
  geminiKey?: string;
  groqKey?: string;
  openaiKey?: string;
}

type ProviderName = 'gemini' | 'groq' | 'openai';

let cached: UserConfig | null = null;

export function loadConfig(): UserConfig {
  if (cached) return cached;
  if (!existsSync(CONFIG_FILE)) { cached = {}; return cached; }
  try {
    cached = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as UserConfig;
    return cached;
  } catch (err) {
    console.error('[configStore] load failed:', err);
    cached = {}; return cached;
  }
}

export function saveConfig(config: UserConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  cached = config;
  console.log(`[configStore] saved to ${CONFIG_FILE}`);
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

export function configFilePath(): string { return CONFIG_FILE; }
