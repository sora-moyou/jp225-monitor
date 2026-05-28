import type { Request, Response } from 'express';
import {
  loadConfig, saveConfig, configFilePath, validateParam,
  resolvePricePollMs, resolveNewsPollMs, resolvePort,
  type UserConfig,
} from '../configStore.js';
import { reloadProviders, getProviderStatus } from '../llm/openai.js';
import { restartPriceLoop } from '../loops/priceLoop.js';
import { restartNewsLoop } from '../loops/newsLoop.js';

export function getSettingsHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  res.json({
    geminiSet: !!config.geminiKey,
    groqSet: !!config.groqKey,
    openaiSet: !!config.openaiKey,
    geminiFromEnv: !config.geminiKey && !!process.env.GEMINI_API_KEY?.trim(),
    groqFromEnv: !config.groqKey && !!process.env.GROQ_API_KEY?.trim(),
    openaiFromEnv: !config.openaiKey && !!process.env.OPENAI_API_KEY?.trim(),
    pricePollMs: resolvePricePollMs(),
    newsPollMs: resolveNewsPollMs(),
    port: resolvePort(),
    providers: getProviderStatus(),
    configFile: configFilePath(),
  });
}

interface SettingsBody {
  geminiKey?: string | null;
  groqKey?: string | null;
  openaiKey?: string | null;
  pricePollMs?: number | null;   // null = リセット (= default に戻す), number = 上書き, undefined = 変更なし
  newsPollMs?: number | null;
  port?: number | null;
}

function applyStringField(existing: string | undefined, incoming: unknown): string | undefined {
  if (incoming === undefined) return existing;
  if (incoming === null) return undefined;
  if (typeof incoming !== 'string') return existing;
  const trimmed = incoming.trim();
  return trimmed === '' ? existing : trimmed;
}

function applyNumberField(
  name: 'pricePollMs' | 'newsPollMs' | 'port',
  existing: number | undefined,
  incoming: unknown,
): { value: number | undefined; error: string | null; changed: boolean } {
  if (incoming === undefined) return { value: existing, error: null, changed: false };
  if (incoming === null) return { value: undefined, error: null, changed: existing !== undefined };
  const err = validateParam(name, incoming);
  if (err) return { value: existing, error: err, changed: false };
  return { value: incoming as number, error: null, changed: existing !== incoming };
}

export function postSettingsHandler(req: Request, res: Response): void {
  const body = req.body as SettingsBody;
  const existing = loadConfig();

  const priceResult = applyNumberField('pricePollMs', existing.pricePollMs, body.pricePollMs);
  const newsResult = applyNumberField('newsPollMs', existing.newsPollMs, body.newsPollMs);
  const portResult = applyNumberField('port', existing.port, body.port);

  const errors = [priceResult.error, newsResult.error, portResult.error].filter((e): e is string => e !== null);
  if (errors.length > 0) {
    res.status(400).json({ error: errors.join('; ') });
    return;
  }

  const next: UserConfig = {
    geminiKey: applyStringField(existing.geminiKey, body.geminiKey),
    groqKey: applyStringField(existing.groqKey, body.groqKey),
    openaiKey: applyStringField(existing.openaiKey, body.openaiKey),
    pricePollMs: priceResult.value,
    newsPollMs: newsResult.value,
    port: portResult.value,
  };
  saveConfig(next);
  reloadProviders();

  if (priceResult.changed) restartPriceLoop();
  if (newsResult.changed) restartNewsLoop();

  res.json({
    ok: true,
    providers: getProviderStatus(),
    portRequiresRestart: portResult.changed,
  });
}
