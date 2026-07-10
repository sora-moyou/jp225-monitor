import type { Request, Response } from 'express';
import {
  loadConfig, saveConfig, configFilePath, validateParam,
  resolvePricePollMs, resolveNewsPollMs, resolvePort, resolveCooldownMin,
  resolveAllNumericParams, PARAM_BOUNDS,
  type UserConfig,
} from '../configStore.js';
import { reloadProviders, getProviderStatus, testAllProviders } from '../llm/openai.js';
import { restartPriceLoop } from '../loops/priceLoop.js';
import { restartNewsLoop } from '../loops/newsLoop.js';
import { setCooldownMs } from '../alertCooldown.js';

// restart が要るのは pricePollMs/newsPollMs/port/cooldownMin のみ。
// その他(shock系)は resolver が次評価で即時反映するので restart 不要。
const NUMERIC_PARAM_KEYS = [
  'pricePollMs', 'newsPollMs', 'port', 'cooldownMin',
  'shockMove1Yen', 'shockMove2Yen', 'shock1Yen', 'shock2Yen', 'shockAccelYen',
  'shockAvgMult', 'shockScoreNeed', 'shockCooldownBars', 'openGuardBars', 'flashYen',
  'granvilleMaMid', 'granvilleMaLong',
  'levelTol', 'levelShowN', 'levelSelectWindowYen', 'fibConfluenceBonus', 'levelTestBonus',
  'levelLookbackSessions', 'levelLookbackSessions2',
] as const satisfies readonly (keyof typeof PARAM_BOUNDS)[];

export function getSettingsHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  res.json({
    geminiSet: !!config.geminiKey,
    groqSet: !!config.groqKey,
    openaiSet: !!config.openaiKey,
    geminiFromEnv: !config.geminiKey && !!process.env.GEMINI_API_KEY?.trim(),
    groqFromEnv: !config.groqKey && !!process.env.GROQ_API_KEY?.trim(),
    openaiFromEnv: !config.openaiKey && !!process.env.OPENAI_API_KEY?.trim(),
    tavilySet: !!config.tavilyKey,
    tavilyFromEnv: !config.tavilyKey && !!process.env.TAVILY_API_KEY?.trim(),
    // 数値パラメータ全14個 (port のみ env fallback があるため明示で上書き)
    ...resolveAllNumericParams(),
    pricePollMs: resolvePricePollMs(),
    newsPollMs: resolveNewsPollMs(),
    port: resolvePort(),
    cooldownMin: resolveCooldownMin(),
    providers: getProviderStatus(),
    configFile: configFilePath(),
  });
}

// GET /api/settings/test — 各プロバイダのAPIキーが「実際に有効か」を1トークンの ping で確認する。
// 「設定済み」と「有効」は別なので、キーが本当に通るかを診断する設定画面専用エンドポイント。
export async function testSettingsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const results = await testAllProviders();
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

interface SettingsBody {
  geminiKey?: string | null;
  groqKey?: string | null;
  openaiKey?: string | null;
  tavilyKey?: string | null;
  pricePollMs?: number | null;   // null = リセット (= default に戻す), number = 上書き, undefined = 変更なし
  newsPollMs?: number | null;
  port?: number | null;
  cooldownMin?: number | null;
}

function applyStringField(existing: string | undefined, incoming: unknown): string | undefined {
  if (incoming === undefined) return existing;
  if (incoming === null) return undefined;
  if (typeof incoming !== 'string') return existing;
  const trimmed = incoming.trim();
  return trimmed === '' ? existing : trimmed;
}

function applyNumberField(
  name: keyof typeof PARAM_BOUNDS,
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
  const bodyRec = body as Record<string, unknown>;
  const existing = loadConfig();

  // 全数値パラメータを 1 ループで検証
  const results: Record<string, { value: number | undefined; changed: boolean }> = {};
  const errors: string[] = [];
  for (const key of NUMERIC_PARAM_KEYS) {
    const r = applyNumberField(key, existing[key], bodyRec[key]);
    if (r.error) errors.push(r.error);
    results[key] = { value: r.value, changed: r.changed };
  }
  if (errors.length > 0) {
    res.status(400).json({ error: errors.join('; ') });
    return;
  }

  // 文字列フィールドを先に埋め、数値フィールドはループで代入
  const next: UserConfig = {
    geminiKey: applyStringField(existing.geminiKey, body.geminiKey),
    groqKey: applyStringField(existing.groqKey, body.groqKey),
    openaiKey: applyStringField(existing.openaiKey, body.openaiKey),
    tavilyKey: applyStringField(existing.tavilyKey, body.tavilyKey),
  };
  const nextRec = next as Record<string, unknown>;
  for (const key of NUMERIC_PARAM_KEYS) {
    nextRec[key] = results[key]!.value;
  }
  saveConfig(next);
  reloadProviders();

  // restart は元の4キーのみ。shock 系は resolver が次評価で拾うので何もしない。
  if (results.pricePollMs!.changed) restartPriceLoop();
  if (results.newsPollMs!.changed) restartNewsLoop();
  if (results.cooldownMin!.changed) setCooldownMs(resolveCooldownMin() * 60_000);

  res.json({
    ok: true,
    providers: getProviderStatus(),
    portRequiresRestart: results.port!.changed,
  });
}
