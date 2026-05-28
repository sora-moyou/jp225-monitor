import type { Request, Response } from 'express';
import { loadConfig, saveConfig, configFilePath, type UserConfig } from '../configStore.js';
import { reloadProviders, getProviderStatus } from '../llm/openai.js';

// マスク (実値は返さない、設定済みフラグだけ返す)
export function getSettingsHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  res.json({
    geminiSet: !!config.geminiKey,
    groqSet: !!config.groqKey,
    openaiSet: !!config.openaiKey,
    geminiFromEnv: !config.geminiKey && !!process.env.GEMINI_API_KEY?.trim(),
    groqFromEnv: !config.groqKey && !!process.env.GROQ_API_KEY?.trim(),
    openaiFromEnv: !config.openaiKey && !!process.env.OPENAI_API_KEY?.trim(),
    providers: getProviderStatus(),
    configFile: configFilePath(),
  });
}

interface SettingsBody {
  geminiKey?: string | null;   // null = 削除、undefined = 変更なし、文字列 = 上書き
  groqKey?: string | null;
  openaiKey?: string | null;
}

function applyField(existing: string | undefined, incoming: unknown): string | undefined {
  if (incoming === undefined) return existing;
  if (incoming === null) return undefined;
  if (typeof incoming !== 'string') return existing;
  const trimmed = incoming.trim();
  return trimmed === '' ? existing : trimmed;
}

export function postSettingsHandler(req: Request, res: Response): void {
  const body = req.body as SettingsBody;
  const existing = loadConfig();
  const next: UserConfig = {
    geminiKey: applyField(existing.geminiKey, body.geminiKey),
    groqKey: applyField(existing.groqKey, body.groqKey),
    openaiKey: applyField(existing.openaiKey, body.openaiKey),
  };
  saveConfig(next);
  reloadProviders();
  res.json({ ok: true, providers: getProviderStatus() });
}
