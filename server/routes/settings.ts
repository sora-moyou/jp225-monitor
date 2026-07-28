import type { Request, Response } from 'express';
import {
  loadConfig, saveConfig, configFilePath, validateParam,
  resolvePricePollMs, resolveNewsPollMs, resolvePort, resolveCooldownMin,
  resolveAllNumericParams, resolveScalpBias, resolveScalpRangeEnabled, resolveScalpDotenEnabled,
  resolveScalpRangeReevalEnabled, resolveScalpChartFallbackText, PARAM_BOUNDS,
  resolveScalpLcFloorDirective, resolveScalpLcCeilingDirective, resolveScalpTrendVetoDirective,
  resolveScalpCooldownDirective, resolveScalpBiasDirective, resolveScalpRangeDirective,
  resolveScalpLcHardMax, parseKnobSource, resolveDoubleFormingEnabled,
  type UserConfig, type ScalpBias, type KnobSource, type SignalBConfig,
} from '../configStore.js';
import { reloadProviders, getProviderStatus, testAllProviders } from '../llm/openai.js';
import { openDb, resolveDbPath, getMeta } from '../db/store.js';
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
  'breakScore', 'slopeConfluenceBonus',   // ★検知チューニング(40日ライブ)。resolver が次評価で即時反映=restart 不要。
  'scalpLcCeilingYen', 'scalpCooldownSec', 'scalpTrendVetoYen',
  'scalpLcFloorYen', 'scalpLcHardMaxYen',
] as const satisfies readonly (keyof typeof PARAM_BOUNDS)[];

// source フィールド適用: undefined=変更なし / 'ai'→'ai' 保存 / それ以外(null/'manual'/不正)=既定 manual(=未設定で保存)。
function applySourceField(existing: KnobSource | undefined, incoming: unknown): KnobSource | undefined {
  if (incoming === undefined) return existing;
  return parseKnobSource(incoming) === 'ai' ? 'ai' : undefined;
}

// AIエントリー バイアスの受理値。
const BIAS_VALUES = ['long', 'short', 'none'] as const;

// bias フィールドの適用: undefined=変更なし / null・''・'none'=既定(両方向=未設定) / 'long'|'short'=採用 / それ以外=エラー。
function applyBiasField(
  existing: ScalpBias | undefined,
  incoming: unknown,
): { value: ScalpBias | undefined; error: string | null } {
  if (incoming === undefined) return { value: existing, error: null };
  if (incoming === null) return { value: undefined, error: null };
  if (typeof incoming !== 'string') return { value: existing, error: null };
  const t = incoming.trim();
  if (t === '' || t === 'none') return { value: undefined, error: null };   // 既定(両方向)= 未設定で保存
  if (t === 'long' || t === 'short') return { value: t, error: null };
  return { value: existing, error: `scalpBias must be one of ${BIAS_VALUES.join('|')}` };
}

// scalpRangeEnabled(boolean)の適用: undefined=変更なし / null=既定(true)に戻す=未設定 / boolean=採用 / それ以外=変更なし。
function applyBoolField(existing: boolean | undefined, incoming: unknown): boolean | undefined {
  if (incoming === undefined) return existing;
  if (incoming === null) return undefined;
  if (typeof incoming === 'boolean') return incoming;
  return existing;
}

// 自動公開の直近結果サマリ(meta)。DB 未整備/例外時は '' を返す(設定画面を落とさない)。
function readAutoLastRun(): string {
  try {
    const db = openDb(resolveDbPath());
    try { return getMeta(db, 'basedata_auto_last_result') ?? ''; } finally { db.close(); }
  } catch { return ''; }
}

export function getSettingsHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  res.json({
    kimiSet: !!config.kimiKey,
    geminiSet: !!config.geminiKey,
    groqSet: !!config.groqKey,
    openaiSet: !!config.openaiKey,
    kimiFromEnv: !config.kimiKey && !!process.env.KIMI_API_KEY?.trim(),
    geminiFromEnv: !config.geminiKey && !!process.env.GEMINI_API_KEY?.trim(),
    groqFromEnv: !config.groqKey && !!process.env.GROQ_API_KEY?.trim(),
    openaiFromEnv: !config.openaiKey && !!process.env.OPENAI_API_KEY?.trim(),
    webSearchKeySet: !!config.webSearchKey,   // Web検索専用キー(空欄なら共通 geminiKey に従う)
    basedataUserSet: !!config.basedataUser,   // ★基礎データ公開(225labo)ユーザー名 設定済み(真偽のみ・秘密)
    basedataPassSet: !!config.basedataPass,   // ★基礎データ公開(225labo)パスワード 設定済み(真偽のみ・秘密)
    basedataSaveDir: config.basedataSaveDir ?? '',   // ★保存先フォルダ(可視・空欄=既定 Downloads)。生の保存値を返す。
    githubTokenSet: !!config.githubToken,     // ★GitHub PAT 設定済み(真偽のみ・秘密)
    basedataAutoPublish: !!config.basedataAutoPublish,   // ★自動公開(平日8:00以降の初回)有効/無効
    basedataAutoLastRun: readAutoLastRun(),   // ★自動公開の直近結果サマリ(meta・無ければ '')
    webSearchModel: config.webSearchModel ?? '',
    webSearchOpenaiModel: config.webSearchOpenaiModel ?? '',   // OpenAI Web検索モデル(空欄なら既定)
    scalpBias: resolveScalpBias(),   // AIエントリー: バイアス(未設定は 'none')。scalpLcCeilingYen は下の数値展開に含まれる。
    scalpRangeEnabled: resolveScalpRangeEnabled(),   // AIエントリー: レンジ両面ストラドル(★実験終了=未設定は false=OFF)。
    dotenEnabled: resolveScalpDotenEnabled(),   // ★ドテン(反転)許可(既定OFF)。monitor2 専用UIで切替。
    rangeReevalEnabled: resolveScalpRangeReevalEnabled(),   // ★レンジ再評価(未約定→ブレイク)許可(既定ON・レンジ使用時のみ実効)。monitor2 専用UIで切替。
    scalpChartFallbackText: resolveScalpChartFallbackText(),   // ★チャート撮影失敗時のテキスト縮退(既定ON=全停止防止)。
    doubleFormingEnabled: resolveDoubleFormingEnabled(),   // ★検知チューニング: double 形成通知(既定OFF=breakout のみ)。breakScore/slopeConfluenceBonus は数値展開に含まれる。
    // ★v0.7.56: 委任 source(手動/AI)。既定は全て 'manual'。
    scalpLcFloorSource: resolveScalpLcFloorDirective().mode,
    scalpLcCeilingSource: resolveScalpLcCeilingDirective().mode,
    scalpTrendVetoSource: resolveScalpTrendVetoDirective().mode,
    scalpCooldownSource: resolveScalpCooldownDirective().mode,
    scalpBiasSource: resolveScalpBiasDirective().mode,
    scalpRangeSource: resolveScalpRangeDirective().mode,
    // ★v0.7.56: LC安全上限(policy とは独立の安全系)。既定 enabled=true / value=150。
    scalpLcHardMaxEnabled: resolveScalpLcHardMax().enabled,
    // ★v0.8.2: System B(紙専用)の設定。raw=signalB に保存された生値(未設定=A追従) /
    //   effective=実効値(A へフォールバック済み。UI のプレースホルダ/select 初期値の表示補助)。
    signalB: config.signalB ?? {},
    signalBEffective: {
      scalpLcFloorYen: resolveScalpLcFloorDirective('B').value,
      scalpLcCeilingYen: resolveScalpLcCeilingDirective('B').value,
      scalpTrendVetoYen: resolveScalpTrendVetoDirective('B').value,
      scalpCooldownSec: resolveScalpCooldownDirective('B').value,
      scalpBias: resolveScalpBias('B'),
      scalpRangeEnabled: resolveScalpRangeEnabled('B'),
      scalpLcHardMaxYen: resolveScalpLcHardMax('B').value,
      scalpLcHardMaxEnabled: resolveScalpLcHardMax('B').enabled,
      scalpLcFloorSource: resolveScalpLcFloorDirective('B').mode,
      scalpLcCeilingSource: resolveScalpLcCeilingDirective('B').mode,
      scalpTrendVetoSource: resolveScalpTrendVetoDirective('B').mode,
      scalpCooldownSource: resolveScalpCooldownDirective('B').mode,
      scalpBiasSource: resolveScalpBiasDirective('B').mode,
      scalpRangeSource: resolveScalpRangeDirective('B').mode,
    },
    // 数値パラメータ (port のみ env fallback があるため明示で上書き)。scalpLcHardMaxYen/scalpLcFloorYen も含まれる。
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
  kimiKey?: string | null;
  geminiKey?: string | null;
  groqKey?: string | null;
  openaiKey?: string | null;
  webSearchKey?: string | null;      // Web検索(Gemini グラウンディング)専用キー
  basedataUser?: string | null;      // ★基礎データ公開(225labo)ユーザー名(秘密・空欄=変更なし)
  basedataPass?: string | null;      // ★基礎データ公開(225labo)パスワード(秘密・空欄=変更なし)
  basedataSaveDir?: string | null;   // ★保存先フォルダ(可視・空欄=既定 Downloads に戻す)
  githubToken?: string | null;       // ★GitHub PAT(秘密・空欄=変更なし)
  basedataAutoPublish?: boolean | null;   // ★自動公開 有効/無効(null=無効=未設定で保存)
  webSearchModel?: string | null;    // Web検索用 Gemini モデル
  webSearchOpenaiModel?: string | null;  // OpenAI Web検索モデル
  scalpBias?: string | null;         // AIエントリー: バイアス(long|short|none)
  scalpRangeEnabled?: boolean | null;  // AIエントリー: レンジ両面ストラドル(true=ON / null=既定ONに戻す)
  dotenEnabled?: boolean | null;       // ★ドテン(反転)許可(true=ON / false/null=OFF=既定)
  rangeReevalEnabled?: boolean | null; // ★レンジ再評価(未約定→ブレイク)許可(true/null=ON=既定 / false=OFF)
  scalpChartFallbackText?: boolean | null; // ★チャート撮影失敗時のテキスト縮退(true/null=ON=既定 / false=ストリクトvision)
  doubleFormingEnabled?: boolean | null;   // ★検知チューニング: double 形成通知(true=ON / false/null=OFF=既定=breakout のみ)
  scalpTrendVetoYen?: number | null;   // AIエントリー: トレンド veto 閾値(円)。null=既定(100)に戻す / 0=無効
  // ★v0.7.56: 委任 source(手動/AI)。'ai'→委任 / それ以外=manual。
  scalpLcFloorSource?: string | null;
  scalpLcCeilingSource?: string | null;
  scalpTrendVetoSource?: string | null;
  scalpCooldownSource?: string | null;
  scalpBiasSource?: string | null;
  scalpRangeSource?: string | null;
  // ★v0.7.56: LC安全上限。
  scalpLcHardMaxEnabled?: boolean | null;   // true=有効(既定) / false=無効 / null=既定(true)に戻す
  scalpLcHardMaxYen?: number | null;        // LC安全上限(円)。null=既定(150)に戻す
  scalpLcFloorYen?: number | null;          // 初期LC下限(円)。null=既定(45)に戻す
  // ★v0.8.2: System B(紙専用)の設定。ネストしたオブジェクトで送る。各フィールドは A と同名。
  //   値の空欄/未設定(null)=「A追従」(signalB から外す)/ source は ''(A追従)/'manual'/'ai'。
  signalB?: Record<string, unknown> | null;
  pricePollMs?: number | null;   // null = リセット (= default に戻す), number = 上書き, undefined = 変更なし
  newsPollMs?: number | null;
  port?: number | null;
  cooldownMin?: number | null;
}

// ★v0.8.2: tri-state 真偽。'true'/true=true / 'false'/false=false / それ以外('')=undefined(=A追従で unset)。
function triBool(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

// ★v0.8.2: signalB 専用の source 適用。'ai'/'manual' は明示保存(B を A から切り離す)/ '' や未設定は unset(=A追従)。
function applySignalBSource(incoming: unknown): KnobSource | undefined {
  if (typeof incoming !== 'string') return undefined;
  const t = incoming.trim().toLowerCase();
  if (t === 'ai') return 'ai';
  if (t === 'manual') return 'manual';
  return undefined;   // '' / 不明 = A追従(unset)
}

// ★v0.8.2: body.signalB(存在時)から SignalBConfig を組み立てる。存在しなければ既存を保持。
//   数値/bias は既存の apply ヘルパで検証(未設定/null は unset=A追従)。source は applySignalBSource。
function buildSignalB(
  existing: SignalBConfig | undefined,
  incoming: Record<string, unknown> | null | undefined,
  errors: string[],
): SignalBConfig | undefined {
  if (incoming === undefined) return existing;   // B は変更なし
  if (incoming === null) return undefined;       // B を丸ごと A追従へ戻す
  const ex = (existing ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  const numKeys = ['scalpLcCeilingYen', 'scalpCooldownSec', 'scalpTrendVetoYen', 'scalpLcFloorYen', 'scalpLcHardMaxYen'] as const;
  for (const key of numKeys) {
    const r = applyNumberField(key, ex[key] as number | undefined, incoming[key]);
    if (r.error) errors.push(`signalB.${r.error}`);
    if (r.value !== undefined) next[key] = r.value;
  }
  // バイアスは B 専用に3値をそのまま扱う(''=A追従で unset / 'none'|'long'|'short'=明示保存=A から独立)。
  const biasIn = incoming.scalpBias;
  if (typeof biasIn === 'string') {
    const t = biasIn.trim();
    if (t === 'none' || t === 'long' || t === 'short') next.scalpBias = t;
    else if (t !== '') errors.push(`signalB.scalpBias must be one of none|long|short`);
  }
  // 真偽(レンジ両面/LC安全上限有効)は tri-state セレクト('true'|'false'=明示 / それ以外=''=A追従で unset)。
  const range = triBool(incoming.scalpRangeEnabled);
  if (range !== undefined) next.scalpRangeEnabled = range;
  const hardEn = triBool(incoming.scalpLcHardMaxEnabled);
  if (hardEn !== undefined) next.scalpLcHardMaxEnabled = hardEn;
  const srcKeys = ['scalpLcFloorSource', 'scalpLcCeilingSource', 'scalpTrendVetoSource',
    'scalpCooldownSource', 'scalpBiasSource', 'scalpRangeSource'] as const;
  for (const key of srcKeys) {
    const s = applySignalBSource(incoming[key]);
    if (s !== undefined) next[key] = s;
  }
  return Object.keys(next).length > 0 ? (next as SignalBConfig) : undefined;
}

function applyStringField(existing: string | undefined, incoming: unknown): string | undefined {
  if (incoming === undefined) return existing;
  if (incoming === null) return undefined;
  if (typeof incoming !== 'string') return existing;
  const trimmed = incoming.trim();
  return trimmed === '' ? existing : trimmed;
}

// 可視(非秘密)フィールド用: 空欄は「既定に戻す」= undefined(applyStringField は空欄で既存保持なので別扱い)。
function applyVisibleField(existing: string | undefined, incoming: unknown): string | undefined {
  if (incoming === undefined) return existing;
  if (incoming === null) return undefined;
  if (typeof incoming !== 'string') return existing;
  const trimmed = incoming.trim();
  return trimmed === '' ? undefined : trimmed;
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
  // AIエントリー バイアス(enum)を検証。
  const biasResult = applyBiasField(existing.scalpBias, bodyRec.scalpBias);
  if (biasResult.error) errors.push(biasResult.error);
  // AIエントリー レンジ両面(boolean)を適用(検証エラーなし=非boolean は変更なし)。
  const rangeEnabledValue = applyBoolField(existing.scalpRangeEnabled, bodyRec.scalpRangeEnabled);
  // ★ドテン(反転)許可(boolean・既定 false)。null/false=OFF(未設定で保存)。
  const dotenEnabledValue = applyBoolField(existing.dotenEnabled, bodyRec.dotenEnabled);
  // ★レンジ再評価(未約定→ブレイク)許可(boolean・既定 true)。null=既定(true)に戻す(applyBoolField=undefined 保存)。
  const rangeReevalEnabledValue = applyBoolField(existing.rangeReevalEnabled, bodyRec.rangeReevalEnabled);
  // ★チャート撮影失敗時のテキスト縮退(boolean・既定 true)。null=既定(true)に戻す。
  const chartFallbackValue = applyBoolField(existing.scalpChartFallbackText, bodyRec.scalpChartFallbackText);
  // ★検知チューニング: double 形成通知(boolean・既定 false)。null/false=OFF(未設定で保存)。
  const doubleFormingValue = applyBoolField(existing.doubleFormingEnabled, bodyRec.doubleFormingEnabled);
  // ★v0.7.56: LC安全上限の有効/無効(boolean・既定 true)。null=既定(true)に戻す(applyBoolField=undefined 保存)。
  const hardMaxEnabledValue = applyBoolField(existing.scalpLcHardMaxEnabled, bodyRec.scalpLcHardMaxEnabled);
  // ★基礎データ自動公開の有効/無効(boolean・既定 false)。checkbox は常に true/false を送る。
  const autoPublishValue = applyBoolField(existing.basedataAutoPublish, bodyRec.basedataAutoPublish);
  // ★v0.8.2: System B(紙専用)の設定を組み立てる(未指定=変更なし・数値/bias 検証込み)。
  const signalBValue = buildSignalB(existing.signalB, body.signalB, errors);
  if (errors.length > 0) {
    res.status(400).json({ error: errors.join('; ') });
    return;
  }

  // 文字列フィールドを先に埋め、数値フィールドはループで代入
  const next: UserConfig = {
    kimiKey: applyStringField(existing.kimiKey, body.kimiKey),
    geminiKey: applyStringField(existing.geminiKey, body.geminiKey),
    groqKey: applyStringField(existing.groqKey, body.groqKey),
    openaiKey: applyStringField(existing.openaiKey, body.openaiKey),
    webSearchKey: applyStringField(existing.webSearchKey, body.webSearchKey),   // 秘密: 空欄=変更なし
    basedataUser: applyStringField(existing.basedataUser, body.basedataUser),   // ★秘密: 空欄=変更なし
    basedataPass: applyStringField(existing.basedataPass, body.basedataPass),   // ★秘密: 空欄=変更なし
    basedataSaveDir: applyVisibleField(existing.basedataSaveDir, body.basedataSaveDir),   // ★可視: 空欄=既定に戻す
    githubToken: applyStringField(existing.githubToken, body.githubToken),      // ★秘密: 空欄=変更なし
    basedataAutoPublish: autoPublishValue,   // ★自動公開 有効/無効

    webSearchModel: applyVisibleField(existing.webSearchModel, body.webSearchModel), // 可視: 空欄=既定に戻す
    webSearchOpenaiModel: applyVisibleField(existing.webSearchOpenaiModel, body.webSearchOpenaiModel), // 可視: 空欄=既定に戻す
    scalpBias: biasResult.value,   // AIエントリー: バイアス(none は未設定で保存)
    scalpRangeEnabled: rangeEnabledValue,   // AIエントリー: レンジ両面(既定ONは未設定で保存)
    dotenEnabled: dotenEnabledValue,   // ★ドテン(反転)許可(既定OFFは未設定で保存)
    rangeReevalEnabled: rangeReevalEnabledValue,   // ★レンジ再評価(未約定→ブレイク)許可(既定ONに戻すときは null→未設定で保存)
    scalpChartFallbackText: chartFallbackValue,   // ★チャート撮影失敗時のテキスト縮退(既定ONに戻すときは null→未設定で保存)
    doubleFormingEnabled: doubleFormingValue,   // ★検知チューニング: double 形成通知(既定OFFは未設定で保存)
    // ★v0.7.56: 委任 source(manual は未設定で保存=既定)。
    scalpLcFloorSource: applySourceField(existing.scalpLcFloorSource, bodyRec.scalpLcFloorSource),
    scalpLcCeilingSource: applySourceField(existing.scalpLcCeilingSource, bodyRec.scalpLcCeilingSource),
    scalpTrendVetoSource: applySourceField(existing.scalpTrendVetoSource, bodyRec.scalpTrendVetoSource),
    scalpCooldownSource: applySourceField(existing.scalpCooldownSource, bodyRec.scalpCooldownSource),
    scalpBiasSource: applySourceField(existing.scalpBiasSource, bodyRec.scalpBiasSource),
    scalpRangeSource: applySourceField(existing.scalpRangeSource, bodyRec.scalpRangeSource),
    // ★v0.7.56: LC安全上限の有効/無効(既定 true は未設定で保存)。
    scalpLcHardMaxEnabled: hardMaxEnabledValue,
    // ★v0.8.2: System B(紙専用)の設定(空=undefined で保存=全て A追従)。
    signalB: signalBValue,
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
