import type { Request, Response } from 'express';
import {
  loadConfig, saveConfig, configFilePath, validateParam,
  resolvePricePollMs, resolveNewsPollMs, resolvePort, resolveCooldownMin,
  resolveAllNumericParams, resolveScalpBias, resolveScalpRangeEnabled, resolveScalpDotenEnabled,
  resolveScalpRangeReevalEnabled, resolveScalpChartFallbackText,
  resolveIndicatorsEnabled, resolveScalpAiTechnicalEnabled, PARAM_BOUNDS,
  resolveScalpLcFloorDirective, resolveScalpLcCeilingDirective, resolveScalpTrendVetoDirective,
  resolveScalpCooldownDirective, resolveScalpBiasDirective, resolveScalpRangeDirective,
  resolveScalpLcHardMax, parseKnobSource, resolveDoubleFormingEnabled, resolveNwaveEnabled, resolveBandwalkEnabled,
  resolveGeneratorKeySources, resolveGeneratorDailyBudget, resolveGeneratorEnabled,
  GENERATOR_PROVIDERS, GENERATOR_DAILY_BUDGET_DEFAULT, GENERATOR_DAILY_BUDGET_MAX,
  type UserConfig, type ScalpBias, type KnobSource, type SignalBConfig, type LiteConfig,
} from '../configStore.js';
import { normalizeCaller } from '../llm/caller.js';
import { resolveVariant } from '../variant.js';
import { isAnalysisEnabled } from '../analysisGate.js';
import { reloadProviders, getProviderStatus } from '../llm/openai.js';
import { checkProviderModels } from '../llm/modelCheck.js';
import { DEFAULT_LLM_MODELS, LLM_MODEL_CONFIG_KEYS, resolveLlmModel, type LLMProviderName } from '../config.js';
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
  'nwaveMinSwingYen',   // ★N波動の最小1波幅(円)。resolver が次評価で即時反映=restart 不要。
  'scalpLcCeilingYen', 'scalpCooldownSec', 'scalpTrendVetoYen',
  'scalpLcFloorYen', 'scalpLcHardMaxYen',
] as const satisfies readonly (keyof typeof PARAM_BOUNDS)[];

// ★保存経路が「扱いを明示的に決める」非数値フィールド(= 設定画面が送ってくるもの)。
//   数値は NUMERIC_PARAM_KEYS が担当するので、ここには並べない。
//   下の decided がこの一覧を型で強制されるため、追加し忘れ/書き忘れがコンパイルエラーになる。
const EXPLICIT_PARAM_KEYS = [
  'kimiKey', 'geminiKey', 'groqKey', 'openaiKey', 'webSearchKey',
  'basedataUser', 'basedataPass', 'basedataSaveDir', 'githubToken', 'basedataAutoPublish',
  'webSearchModel', 'webSearchOpenaiModel',
  // ★LLM プロバイダのモデル名(可視・空欄=既定に戻す)。Web検索モデルと同じ扱い。
  'geminiModel', 'groqModel', 'kimiModel', 'openaiModel',
  'scalpBias', 'scalpRangeEnabled', 'dotenEnabled', 'rangeReevalEnabled',
  'indicatorsEnabled', 'aiTechnicalEnabled', 'scalpChartFallbackText',
  'doubleFormingEnabled', 'nwaveEnabled', 'bandwalkEnabled',
  'scalpLcFloorSource', 'scalpLcCeilingSource', 'scalpTrendVetoSource',
  'scalpCooldownSource', 'scalpBiasSource', 'scalpRangeSource',
  'scalpLcHardMaxEnabled',
  'signalB', 'lite',
  // ★提案生成器(caller='generator')の設定。UI を持たせた(⚙️「提案生成器」fieldset)。
  'generatorKeys',          // 生成器プール専用の API キー(未設定なら共通キーへフォールバック)。秘密扱い・GET では値を返さない。
  'generatorDailyBudget',   // 生成器の日次予算[回/取引日]。0=無効。未設定は GENERATOR_DAILY_BUDGET_DEFAULT。
  'generatorEnabled',       // ★生成器サイドカーを走らせるか。未設定/false=無効(既定)。有効化するまで LLM も台帳も触らない。
] as const satisfies readonly (keyof UserConfig)[];
type ExplicitParamKey = typeof EXPLICIT_PARAM_KEYS[number];

// ★保存経路が値を決めない=既存値をそのまま持ち越すフィールド。
//   設定画面にUIが無く、config.json の手編集でしか設定しない類(chromePath など)。
const PRESERVED_PARAM_KEYS = [
  'chromePath',   // チャート撮影に使う chrome.exe の明示パス(UI 無し・手編集のみ)
] as const satisfies readonly (keyof UserConfig)[];
type PreservedParamKey = typeof PRESERVED_PARAM_KEYS[number];

// ★型で漏れを検出する仕掛け: UserConfig にフィールドを足したのに、明示決定(EXPLICIT_PARAM_KEYS /
//   NUMERIC_PARAM_KEYS)にも持ち越し(PRESERVED_PARAM_KEYS)にも入れ忘れると、ここがコンパイル
//   エラーになり、漏れたキー名がエラーメッセージに出る。
//   (実行時も next = {...existing, ...} で値は保持されるが、扱いの明示を型で強制しておく。)
type AssertTrue<T extends true> = T;
type UnclassifiedConfigKey = Exclude<
  keyof UserConfig,
  ExplicitParamKey | PreservedParamKey | typeof NUMERIC_PARAM_KEYS[number]
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AllConfigKeysClassified = AssertTrue<[UnclassifiedConfigKey] extends [never] ? true : UnclassifiedConfigKey>;

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

// ★LLM モデル欄のスナップショット。'raw'=config の保存値(空欄=未設定)/ 'effective'=実際に使う値(既定込み)。
//   プロバイダの列挙は LLM_MODEL_CONFIG_KEYS(config.ts)が SSOT=プロバイダを足しても書き漏れない。
function llmModelSnapshot(config: UserConfig, kind: 'raw' | 'effective'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(LLM_MODEL_CONFIG_KEYS) as LLMProviderName[]) {
    out[name] = kind === 'raw' ? (config[LLM_MODEL_CONFIG_KEYS[name]] ?? '') : resolveLlmModel(name);
  }
  return out;
}

export function getSettingsHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  // ★公開版(lite)は提案生成器(分析用)を持たない=2つ目の API キーの欄も日次予算の欄も出さない。
  //   画面から消すだけでなく **応答からも落とす**(残っていると「隠しただけ」で、次に UI を触った人が
  //   また出してしまう)。full では isAnalysisEnabled()===true なので従来と同じ4フィールドが返る。
  const generator = isAnalysisEnabled()
    ? {
      // ★提案生成器(分析用・実弾 A とは別プール)。
      //   generatorKeySources は **キーの値ではなく「どのキーを使うか」** を返す
      //   ('own'/'env'=専用キー / 'shared'=共通キーへフォールバック中=上流クォータは A と共有 / 'none'=キー無し)。
      //   フォールバックしていることが画面から見えないと「分離したつもりで分離できていない」が無音で成立する。
      generatorKeySources: resolveGeneratorKeySources(),
      // ★生成器サイドカーの有効/無効。**既定は false**(同梱されていても、有効化するまで走らない)。
      generatorEnabled: resolveGeneratorEnabled(),
      generatorDailyBudget: resolveGeneratorDailyBudget(),   // 実効値(config → env → 既定・クランプ済み)
      generatorDailyBudgetDefault: GENERATOR_DAILY_BUDGET_DEFAULT,
      generatorDailyBudgetMax: GENERATOR_DAILY_BUDGET_MAX,
    }
    : {};
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
    // ★LLM プロバイダのモデル名。raw=保存値(空欄=未設定=既定)/ effective=実際に使う値 /
    //   defaults=コードの既定(プレースホルダ表示用)。3つ出すのは「空欄なのに何が動いているのか」を
    //   画面から分かるようにするため(既定値が画面に無いと、未設定と故障の区別がつかない)。
    llmModels: llmModelSnapshot(config, 'raw'),
    llmModelsEffective: llmModelSnapshot(config, 'effective'),
    llmModelDefaults: { ...DEFAULT_LLM_MODELS },
    scalpBias: resolveScalpBias(),   // AIエントリー: バイアス(未設定は 'none')。scalpLcCeilingYen は下の数値展開に含まれる。
    scalpRangeEnabled: resolveScalpRangeEnabled(),   // AIエントリー: レンジ両面ストラドル(★実験終了=未設定は false=OFF)。
    dotenEnabled: resolveScalpDotenEnabled(),   // ★ドテン(反転)許可(既定OFF)。monitor2 専用UIで切替。
    rangeReevalEnabled: resolveScalpRangeReevalEnabled(),   // ★レンジ再評価(未約定→ブレイク)許可(既定ON・レンジ使用時のみ実効)。monitor2 専用UIで切替。
    indicatorsEnabled: resolveIndicatorsEnabled(),   // ★テクニカル指標(RSI/SMA/BB)パネル + AI文脈供給(既定ON・表示/文脈のみ)。
    aiTechnicalEnabled: resolveScalpAiTechnicalEnabled(),   // ★AIテクニカル許可(RSI/BB をエントリーのタイミング判断に使う・既定ON)。決済は既定ロジック。
    scalpChartFallbackText: resolveScalpChartFallbackText(),   // ★チャート撮影失敗時のテキスト縮退(既定ON=全停止防止)。
    ...generator,
    doubleFormingEnabled: resolveDoubleFormingEnabled(),   // ★検知チューニング: double 形成通知(既定OFF=breakout のみ)。breakScore/slopeConfluenceBonus は数値展開に含まれる。
    nwaveEnabled: resolveNwaveEnabled(),   // ★N波動の節目/アラート(既定ON)。nwaveMinSwingYen は数値展開に含まれる。
    bandwalkEnabled: resolveBandwalkEnabled(),   // ★バンドウォークのアラート/AI文脈(既定ON)。閾値は server/bandwalk.ts の DEFAULT_BANDWALK。
    // ★v0.7.56: 委任 source(手動/AI)。既定は全て 'manual'。
    scalpLcFloorSource: resolveScalpLcFloorDirective().mode,
    scalpLcCeilingSource: resolveScalpLcCeilingDirective().mode,
    scalpTrendVetoSource: resolveScalpTrendVetoDirective().mode,
    scalpCooldownSource: resolveScalpCooldownDirective().mode,
    scalpBiasSource: resolveScalpBiasDirective().mode,
    scalpRangeSource: resolveScalpRangeDirective().mode,
    // ★v0.7.56: LC安全上限(policy とは独立の安全系)。既定 enabled=true / value=159。
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

// GET /api/settings/test — 各プロバイダについて「キーが実際に有効か」＋「**設定中のモデルが
// そのキーで使えるか**」を確認する(設定画面専用の診断)。
// ★判定は OpenAI 互換の `GET /v1/models`(トークン非消費)で行い、使えない場合は
//   **そのキーで使えるモデルの一覧**を返す。「404」で終わらせず次の一手が決まるようにするため
//   (Moonshot の "Not found the model … or Permission denied" はキーごとに違う=こちらでは選べない)。
//   一覧が取れないプロバイダは従来どおり 1トークンの ping に落ちる(server/llm/modelCheck.ts)。
// ★?pool=generator で **生成器プールのキー**を検証する(省略/'default' は従来と同じキー選択)。
//   検証は実際に外部へリクエストを送るので、プールごとに正しいキー(resolveApiKeyForPool)で送る。
//   未知の pool は黙って default に倒さず 400(caller と同じ規約: 失敗は声を出す)。
export async function testSettingsHandler(req: Request, res: Response): Promise<void> {
  const pool = normalizeCaller((req.query as Record<string, unknown> | undefined)?.pool);
  // 受理値の一覧は normalizeCaller(caller.ts)が SSOT。ここはクエリ名に合わせて語だけ言い換える。
  if (!pool.ok) { res.status(400).json({ error: pool.error.replace(/^caller/, 'pool') }); return; }
  try {
    const results = await checkProviderModels(pool.caller);
    res.json({ pool: pool.caller, results });
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
  // ★LLM プロバイダのモデル名(可視・空欄=既定に戻す)。未指定=変更なし。
  geminiModel?: string | null;
  groqModel?: string | null;
  kimiModel?: string | null;
  openaiModel?: string | null;
  scalpBias?: string | null;         // AIエントリー: バイアス(long|short|none)
  scalpRangeEnabled?: boolean | null;  // AIエントリー: レンジ両面ストラドル(true=ON / null=既定ONに戻す)
  dotenEnabled?: boolean | null;       // ★ドテン(反転)許可(true=ON / false/null=OFF=既定)
  rangeReevalEnabled?: boolean | null; // ★レンジ再評価(未約定→ブレイク)許可(true/null=ON=既定 / false=OFF)
  indicatorsEnabled?: boolean | null;  // ★テクニカル指標(RSI/SMA/BB)の表示+AI文脈供給(true/null=ON=既定 / false=OFF)
  aiTechnicalEnabled?: boolean | null; // ★AIテクニカル許可(エントリーのタイミング判断)(true/null=ON=既定 / false=OFF)
  scalpChartFallbackText?: boolean | null; // ★チャート撮影失敗時のテキスト縮退(true/null=ON=既定 / false=ストリクトvision)
  doubleFormingEnabled?: boolean | null;   // ★検知チューニング: double 形成通知(true=ON / false/null=OFF=既定=breakout のみ)
  nwaveEnabled?: boolean | null;           // ★N波動の節目/アラート(true/null=ON=既定 / false=OFF)
  bandwalkEnabled?: boolean | null;        // ★バンドウォークのアラート/AI文脈(true/null=ON=既定 / false=OFF)
  generatorEnabled?: boolean | null;       // ★提案生成器サイドカー(true=有効 / false/null=無効=既定)
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
  scalpLcHardMaxYen?: number | null;        // LC安全上限(円)。null=既定(159)に戻す
  scalpLcFloorYen?: number | null;          // 初期LC下限(円)。null=既定(55)に戻す
  // ★v0.8.2: System B(紙専用)の設定。ネストしたオブジェクトで送る。各フィールドは A と同名。
  //   値の空欄/未設定(null)=「A追従」(signalB から外す)/ source は ''(A追従)/'manual'/'ai'。
  signalB?: Record<string, unknown> | null;
  // ★提案生成器の専用 API キー。秘密フィールドの規約に揃える:
  //   未指定/''=変更なし / 文字列=保存 / **null=そのプロバイダの専用キーを消去(=共通キーへ戻す)** /
  //   generatorKeys 自体が null=全プロバイダの専用キーを消去。
  generatorKeys?: Record<string, unknown> | null;
  generatorDailyBudget?: number | null;   // 生成器の日次予算[回/取引日]。null=既定(200)に戻す / 0=無効。
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

// ★lite 独立設定: lite の 🎛️ に露出した項目だけを config.lite へ組み立てる。
//   - 未指定(undefined)=lite の既存値を保持 / null=unset(=最上位→組み込み既定へフォールバック)
//   - 'none' / false / 'manual' といった「既定と同じ値」も明示保存する。最上位の規約(既定=unset)を
//     そのまま持ち込むと unset になり、monitor2 側の値を引き継いでしまって独立にならない。
//   数値・bias の検証は呼び出し元(最上位の適用ループ)が同じ incoming/同じ bounds で先に済ませ、
//   エラー時は 400 で return しているため、ここへ来る値は必ず妥当。
const LITE_NUMERIC_KEYS = ['scalpLcFloorYen', 'scalpLcCeilingYen', 'scalpLcHardMaxYen'] as const;
// 委任モード(手動/AI)も lite 独立。LC安全上限は安全弁なので source を持たない(UI にもモード選択が無い)。
const LITE_SOURCE_KEYS = ['scalpLcFloorSource', 'scalpLcCeilingSource', 'scalpBiasSource'] as const;
function buildLiteConfig(existing: LiteConfig | undefined, body: Record<string, unknown>): LiteConfig | undefined {
  const ex = existing ?? {};
  const next: LiteConfig = {};
  for (const key of LITE_NUMERIC_KEYS) {
    const v = applyNumberField(key, ex[key], body[key]).value;
    if (v !== undefined) next[key] = v;
  }
  // バイアス: 'none' も明示保存する('' / null / 非文字列 は unset=フォールバック)。
  const biasIn = body.scalpBias;
  if (biasIn === undefined) {
    if (ex.scalpBias !== undefined) next.scalpBias = ex.scalpBias;
  } else if (typeof biasIn === 'string') {
    const t = biasIn.trim();
    if (t === 'none' || t === 'long' || t === 'short') next.scalpBias = t;
  }
  // LC安全上限の有効/無効: false も明示保存(null は unset=フォールバック)。
  const enabled = applyBoolField(ex.scalpLcHardMaxEnabled, body.scalpLcHardMaxEnabled);
  if (enabled !== undefined) next.scalpLcHardMaxEnabled = enabled;
  // 委任モード: 'manual' も明示保存(applySignalBSource と同じ規約。'' / 未指定は既存保持→unset)。
  for (const key of LITE_SOURCE_KEYS) {
    const s = body[key] === undefined ? ex[key] : applySignalBSource(body[key]);
    if (s !== undefined) next[key] = s;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

// ★lite(公開版)の保存が **最上位 config に書いてよいキー**。
//   理由: web の buildSavePayload は「画面に出しているか」を知らないので、lite で隠している項目
//   (レンジ両面/ドテン/指標トグル/クールダウン/トレンドveto/自動公開 …)の値も往復でそのまま送り返す。
//   これを素通しにすると **新規インストールの lite で「保存」を1回押すだけで、画面に無い項目が
//   最上位へ「その時の既定値」で焼き付く**(実測)。値は当時の既定と同じなので即時の挙動は変わらないが、
//   将来リリースで既定を変えても、その機だけ古い値のまま無音で走り続ける。
//   ここに載っていないキーは lite では **保存前の既存値へ戻す**(applyLiteTopLevelGuard)。
//   ★lite の AIエントリー 4項目(LITE_OWNED_KEYS)はここに入れない: 最上位ではなく config.lite に書くため。
const LITE_TOP_LEVEL_WRITABLE_KEYS = [
  // 「APIキー(無料/有料)」fieldset は lite でも表示する = キー本体と各行のモデル欄は lite でも書ける。
  'geminiKey', 'groqKey', 'openaiKey', 'kimiKey', 'webSearchKey',
  'geminiModel', 'groqModel', 'kimiModel', 'openaiModel',
  'lite',   // ★lite 独立設定ブロックそのもの(buildLiteConfig の結果)
] as const satisfies readonly (keyof UserConfig)[];
const LITE_TOP_LEVEL_WRITABLE: ReadonlySet<string> = new Set(LITE_TOP_LEVEL_WRITABLE_KEYS);

/** ★lite の保存の関門(純関数・単一の権威)。lite の画面に無いキーは保存前の値へ戻す。
 *  next は {...existing, ...decided} 済みのものを渡す。allow に載ったキーだけが next の値で残る。 */
export function applyLiteTopLevelGuard(existing: UserConfig, next: UserConfig): UserConfig {
  const ex = existing as Record<string, unknown>;
  const out = { ...next } as Record<string, unknown>;
  for (const key of new Set([...Object.keys(out), ...Object.keys(ex)])) {
    if (!LITE_TOP_LEVEL_WRITABLE.has(key)) out[key] = ex[key];
  }
  return out as UserConfig;
}

// ★提案生成器の専用 API キー。既存の秘密フィールド(applyStringField)と同じ規約に、
//   「専用キーを外して共通キーへ戻す」ための明示クリア(null)を足したもの。
//   ・incoming 未指定           → 変更なし
//   ・incoming === null         → 全プロバイダの専用キーを消去(=すべて共通キーへフォールバック)
//   ・オブジェクト内 未指定/''  → そのプロバイダは変更なし(秘密フィールドの既存規約)
//   ・オブジェクト内 null       → そのプロバイダの専用キーを消去(=共通キーへフォールバック)
//   ・オブジェクト内 文字列     → trim して保存
type GeneratorKeys = NonNullable<UserConfig['generatorKeys']>;
export function buildGeneratorKeys(
  existing: GeneratorKeys | undefined,
  incoming: Record<string, unknown> | null | undefined,
): GeneratorKeys | undefined {
  if (incoming === undefined) return existing;
  if (incoming === null) return undefined;
  if (typeof incoming !== 'object') return existing;
  const next: GeneratorKeys = { ...(existing ?? {}) };
  for (const p of GENERATOR_PROVIDERS) {
    const v = incoming[p];
    if (v === undefined) continue;
    if (v === null) { delete next[p]; continue; }
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t === '') continue;   // 空欄=変更なし(既存キー欄と同じ挙動)
    next[p] = t;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

// ★生成器の日次予算。null=既定に戻す(未設定で保存)/ 0=生成器を無効化 / 1..MAX=採用。
//   範囲外や非数値は 400 にする(黙って丸めない=設定した値と動く値がずれない)。
export function applyGeneratorBudget(
  existing: number | undefined,
  incoming: unknown,
): { value: number | undefined; error: string | null } {
  if (incoming === undefined) return { value: existing, error: null };
  if (incoming === null) return { value: undefined, error: null };
  if (typeof incoming !== 'number' || !Number.isFinite(incoming) || !Number.isInteger(incoming)) {
    return { value: existing, error: 'generatorDailyBudget must be an integer' };
  }
  if (incoming < 0 || incoming > GENERATOR_DAILY_BUDGET_MAX) {
    return { value: existing, error: `generatorDailyBudget out of range (0-${GENERATOR_DAILY_BUDGET_MAX})` };
  }
  return { value: incoming, error: null };
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
  // ★テクニカル指標(表示+AI文脈)(boolean・既定 true)。null=既定(true)に戻す(undefined 保存)/ false=OFF。
  const indicatorsEnabledValue = applyBoolField(existing.indicatorsEnabled, bodyRec.indicatorsEnabled);
  // ★AIテクニカル許可(エントリーのタイミング判断)(boolean・既定 true)。null=既定(true)に戻す / false=OFF。
  const aiTechnicalEnabledValue = applyBoolField(existing.aiTechnicalEnabled, bodyRec.aiTechnicalEnabled);
  // ★チャート撮影失敗時のテキスト縮退(boolean・既定 true)。null=既定(true)に戻す。
  const chartFallbackValue = applyBoolField(existing.scalpChartFallbackText, bodyRec.scalpChartFallbackText);
  // ★検知チューニング: double 形成通知(boolean・既定 false)。null/false=OFF(未設定で保存)。
  const doubleFormingValue = applyBoolField(existing.doubleFormingEnabled, bodyRec.doubleFormingEnabled);
  // ★N波動の節目/アラート(boolean・既定 true)。null=既定(true)に戻す(undefined 保存)/ false=OFF。
  const nwaveEnabledValue = applyBoolField(existing.nwaveEnabled, bodyRec.nwaveEnabled);
  // ★バンドウォーク(boolean・既定 true)。null=既定(true)に戻す(undefined 保存)/ false=OFF。
  const bandwalkEnabledValue = applyBoolField(existing.bandwalkEnabled, bodyRec.bandwalkEnabled);
  // ★v0.7.56: LC安全上限の有効/無効(boolean・既定 true)。null=既定(true)に戻す(applyBoolField=undefined 保存)。
  const hardMaxEnabledValue = applyBoolField(existing.scalpLcHardMaxEnabled, bodyRec.scalpLcHardMaxEnabled);
  // ★基礎データ自動公開の有効/無効(boolean・既定 false)。checkbox は常に true/false を送る。
  const autoPublishValue = applyBoolField(existing.basedataAutoPublish, bodyRec.basedataAutoPublish);
  // ★v0.8.2: System B(紙専用)の設定を組み立てる(未指定=変更なし・数値/bias 検証込み)。
  const signalBValue = buildSignalB(existing.signalB, body.signalB, errors);
  // ★提案生成器: 専用キー(秘密・空欄=変更なし / null=消去)と日次予算(範囲検証)。
  //   ★公開版(lite)は生成器を持たない=**既存値を据え置き、body を一切見ない**。
  //     lite と full は同じ config ファイルを共有するので、ここを素通しにすると
  //     lite の保存が monitor2 側の生成器設定(2つ目のキー/日次予算)を黙って消す。
  const analysis = isAnalysisEnabled();
  const generatorKeysValue = analysis
    ? buildGeneratorKeys(existing.generatorKeys, body.generatorKeys)
    : existing.generatorKeys;
  const generatorBudget = analysis
    ? applyGeneratorBudget(existing.generatorDailyBudget, bodyRec.generatorDailyBudget)
    : { value: existing.generatorDailyBudget, error: null };
  if (generatorBudget.error) errors.push(generatorBudget.error);
  // ★生成器サイドカーの有効/無効(boolean・既定 false)。null/false=無効(未設定で保存)。
  //   lite は生成器を持たない=body を見ずに既存値を据え置く(lite の保存が monitor2 の設定を消さない)。
  const generatorEnabledValue = analysis
    ? applyBoolField(existing.generatorEnabled, bodyRec.generatorEnabled)
    : existing.generatorEnabled;
  if (errors.length > 0) {
    res.status(400).json({ error: errors.join('; ') });
    return;
  }
  // ★lite 独立設定: lite で保存したら露出 5項目は config.lite にだけ書き、最上位は据え置く。
  //   full で保存したら config.lite には一切触れない(monitor2 は lite を読み書きしない)。
  const isLite = resolveVariant() === 'lite';
  const liteValue = isLite ? buildLiteConfig(existing.lite, bodyRec) : existing.lite;

  // 保存で扱いを明示的に決めるフィールド(非数値)。EXPLICIT_PARAM_KEYS 全件の記載を型が強制する
  // (書き忘れ=コンパイルエラー)。数値フィールドは下のループで代入する。
  const decided: { [K in ExplicitParamKey]: UserConfig[K] } = {
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
    // ★LLM プロバイダのモデル名: 可視フィールド(空欄=未設定で保存=コードの既定に戻る)。
    //   保存後の reloadProviders + LLM_PROVIDERS の getter で、再起動なしに次の呼び出しから効く。
    geminiModel: applyVisibleField(existing.geminiModel, body.geminiModel),
    groqModel: applyVisibleField(existing.groqModel, body.groqModel),
    kimiModel: applyVisibleField(existing.kimiModel, body.kimiModel),
    openaiModel: applyVisibleField(existing.openaiModel, body.openaiModel),
    // ★lite の「最上位を据え置く」は applyLiteTopLevelGuard(下)が一括で担う=ここは variant を見ない
    //   (以前は lite に露出した数項目だけ個別に据え置いており、画面に無い項目は素通しで焼き付いていた)。
    scalpBias: biasResult.value,   // AIエントリー: バイアス(none は未設定で保存)
    scalpRangeEnabled: rangeEnabledValue,   // AIエントリー: レンジ両面(既定ONは未設定で保存)
    dotenEnabled: dotenEnabledValue,   // ★ドテン(反転)許可(既定OFFは未設定で保存)
    rangeReevalEnabled: rangeReevalEnabledValue,   // ★レンジ再評価(未約定→ブレイク)許可(既定ONに戻すときは null→未設定で保存)
    indicatorsEnabled: indicatorsEnabledValue,   // ★テクニカル指標(表示+AI文脈)(既定ONに戻すときは null→未設定で保存)
    aiTechnicalEnabled: aiTechnicalEnabledValue, // ★AIテクニカル許可(既定ONに戻すときは null→未設定で保存)
    scalpChartFallbackText: chartFallbackValue,   // ★チャート撮影失敗時のテキスト縮退(既定ONに戻すときは null→未設定で保存)
    doubleFormingEnabled: doubleFormingValue,   // ★検知チューニング: double 形成通知(既定OFFは未設定で保存)
    nwaveEnabled: nwaveEnabledValue,   // ★N波動の節目/アラート(既定ONに戻すときは null→未設定で保存)
    bandwalkEnabled: bandwalkEnabledValue,   // ★バンドウォーク(既定ONに戻すときは null→未設定で保存)
    // ★v0.7.56: 委任 source(manual は未設定で保存=既定)。lite の据え置きは下の関門が担う。
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
    // ★lite 独立設定(full では existing.lite をそのまま持ち越す=触らない)。
    lite: liteValue,
    // ★提案生成器(分析用・実弾 A とは別プール)。キーは秘密扱い(値は GET で返さない)。
    generatorKeys: generatorKeysValue,
    generatorDailyBudget: generatorBudget.value,
    generatorEnabled: generatorEnabledValue,   // ★既定(無効)は未設定で保存
  };

  // ★既存 config を土台にして、明示的に決めたフィールドだけを上書きする。
  //   全フィールドを列挙して新しいオブジェクトを作る形にすると、列挙から漏れたフィールド
  //   (実害: chromePath)が保存のたびに黙って消える。土台にすれば PRESERVED_PARAM_KEYS も
  //   将来足されるフィールドも自動的に生き残る。
  //   なお decided の値が undefined のキーは「上書きして undefined」になり、saveConfig の
  //   JSON 直列化でキーごと落ちる=従来どおり「既定に戻す」規約が保たれる。
  const merged: UserConfig = { ...existing, ...decided };
  const mergedRec = merged as Record<string, unknown>;
  for (const key of NUMERIC_PARAM_KEYS) {
    mergedRec[key] = results[key]!.value;
  }
  // ★lite: 画面に無い項目は最上位へ書かない(単一の関門)。露出した 4項目は config.lite に書き済み。
  const next: UserConfig = isLite ? applyLiteTopLevelGuard(existing, merged) : merged;
  saveConfig(next);
  reloadProviders();

  // restart は元の4キーのみ。shock 系は resolver が次評価で拾うので何もしない。
  // ★lite ではこの4キーは保存されない(関門で据え置き)ので、再起動する理由も無い=変化なし扱いにする。
  const numChanged = (key: 'pricePollMs' | 'newsPollMs' | 'cooldownMin' | 'port'): boolean =>
    !isLite && results[key]!.changed;
  if (numChanged('pricePollMs')) restartPriceLoop();
  if (numChanged('newsPollMs')) restartNewsLoop();
  if (numChanged('cooldownMin')) setCooldownMs(resolveCooldownMin() * 60_000);

  res.json({
    ok: true,
    providers: getProviderStatus(),
    portRequiresRestart: numChanged('port'),
  });
}
