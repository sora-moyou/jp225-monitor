// 設定モーダルの型定義。settingsModal.ts から純粋に切り出したもの(構造のみ・挙動不変)。

export type KnobSource = 'manual' | 'ai';

// ★提案生成器(分析用・実弾 A とは別プール)が実際にどのキーを使うか。**キーの値は運ばない**。
//   'own'/'env' = 専用キー(=プールもキーも分離) / 'shared' = 共通キーへフォールバック中
//   (=ローカルのポーズは分離されるが **上流のクォータは A と共有**) / 'none' = キーそのものが無い。
export type GeneratorKeySource = 'own' | 'env' | 'shared' | 'none';
export const GENERATOR_PROVIDERS = ['gemini', 'groq', 'openai', 'kimi'] as const;
export type GeneratorProviderName = typeof GENERATOR_PROVIDERS[number];

export interface SettingsResponse {
  kimiSet: boolean; geminiSet: boolean; groqSet: boolean; openaiSet: boolean;
  kimiFromEnv: boolean; geminiFromEnv: boolean; groqFromEnv: boolean; openaiFromEnv: boolean;
  webSearchKeySet: boolean; webSearchModel: string; webSearchOpenaiModel: string;
  // ★LLM プロバイダのモデル名。llmModels=保存値(空欄=未設定=既定) /
  //   llmModelsEffective=いま実際に使う値 / llmModelDefaults=コードの既定(プレースホルダ用)。
  //   古いサーバ(このフィールドを返さない版)でも画面が壊れないよう全て任意。
  llmModels?: Partial<Record<string, string>>;
  llmModelsEffective?: Partial<Record<string, string>>;
  llmModelDefaults?: Partial<Record<string, string>>;
  basedataUserSet?: boolean; basedataPassSet?: boolean;   // ★基礎データ公開(225labo)認証 設定済み(真偽のみ)
  basedataSaveDir?: string;   // ★保存先フォルダ(可視・生の保存値・空欄=既定 Downloads)
  githubTokenSet?: boolean;   // ★GitHub PAT 設定済み(真偽のみ・秘密)
  basedataAutoPublish?: boolean;   // ★自動公開 有効/無効
  basedataAutoLastRun?: string;    // ★自動公開の直近結果サマリ(無ければ '')
  scalpLcCeilingYen: number; scalpBias: 'long' | 'short' | 'none'; scalpCooldownSec: number;
  scalpRangeEnabled: boolean; scalpTrendVetoYen: number;
  dotenEnabled?: boolean;   // ★ドテン(反転)許可(既定OFF)。monitor2(full)専用UI。
  rangeReevalEnabled?: boolean;   // ★レンジ再評価(未約定→ブレイク)許可(既定ON)。monitor2(full)専用UI。
  indicatorsEnabled?: boolean;   // ★テクニカル指標(RSI/SMA/BB)の表示 + AI文脈供給(既定ON)。
  aiTechnicalEnabled?: boolean;   // ★AIテクニカル許可(RSI/BB をエントリーのタイミング判断に使う・既定ON)。決済は既定ロジック。
  scalpChartFallbackText?: boolean;   // ★チャート撮影失敗でもテキストで継続(既定ON)。
  // ★v0.7.56: 委任 source + 初期LC下限 + LC安全上限
  scalpLcFloorYen: number;
  scalpLcFloorSource: KnobSource; scalpLcCeilingSource: KnobSource; scalpTrendVetoSource: KnobSource;
  scalpCooldownSource: KnobSource; scalpBiasSource: KnobSource; scalpRangeSource: KnobSource;
  scalpLcHardMaxEnabled: boolean; scalpLcHardMaxYen: number;
  // ★v0.8.2: System B(紙専用)の設定。raw=保存済み生値(未設定=A追従) / effective=A フォールバック済みの実効値(表示補助)。
  signalB?: SignalBRaw;
  signalBEffective?: SignalBEffective;
  // ★提案生成器(分析用): キーの出どころ(値は含まない)+ 日次予算。
  generatorKeySources?: Partial<Record<GeneratorProviderName, GeneratorKeySource>>;
  generatorDailyBudget?: number;          // 実効値(config → env → 既定)
  generatorDailyBudgetDefault?: number;   // 既定値(プレースホルダ表示用)
  generatorDailyBudgetMax?: number;       // 上限(入力の max 属性用)
  generatorEnabled?: boolean;             // ★生成器サイドカーを動かすか(既定 false=待機のみ)
  pricePollMs: number; newsPollMs: number; port: number; cooldownMin: number;
  providers: Array<{ name: string; enabled: boolean; paused: boolean; pausedUntil: number }>;
  configFile: string;
}

// ★v0.8.2: System B の生設定(未設定フィールド=A追従)。
export interface SignalBRaw {
  scalpLcCeilingYen?: number; scalpBias?: 'none' | 'long' | 'short'; scalpCooldownSec?: number;
  scalpRangeEnabled?: boolean; scalpTrendVetoYen?: number; scalpLcFloorYen?: number;
  scalpLcHardMaxYen?: number; scalpLcHardMaxEnabled?: boolean;
  scalpLcFloorSource?: KnobSource; scalpLcCeilingSource?: KnobSource; scalpTrendVetoSource?: KnobSource;
  scalpCooldownSource?: KnobSource; scalpBiasSource?: KnobSource; scalpRangeSource?: KnobSource;
}
// ★v0.8.2: B の実効値(A フォールバック済み)。プレースホルダ/初期表示に使う。
export interface SignalBEffective {
  scalpLcFloorYen: number; scalpLcCeilingYen: number; scalpTrendVetoYen: number; scalpCooldownSec: number;
  scalpBias: 'none' | 'long' | 'short'; scalpRangeEnabled: boolean;
  scalpLcHardMaxYen: number; scalpLcHardMaxEnabled: boolean;
  scalpLcFloorSource: KnobSource; scalpLcCeilingSource: KnobSource; scalpTrendVetoSource: KnobSource;
  scalpCooldownSource: KnobSource; scalpBiasSource: KnobSource; scalpRangeSource: KnobSource;
}

export interface SaveResponse {
  ok: boolean;
  portRequiresRestart?: boolean;
}

export interface BasedataStatus {
  ok: boolean;
  published?: boolean;
  available?: boolean;
  lastBar?: string | null;
  count?: number | null;
  error?: string;
}

export interface SavePayload {
  kimiKey?: string | null;
  geminiKey?: string | null;
  groqKey?: string | null;
  openaiKey?: string | null;
  webSearchKey?: string | null;
  webSearchModel?: string | null;
  webSearchOpenaiModel?: string | null;
  // ★LLM プロバイダのモデル名(可視・空欄=''=既定に戻す)。
  geminiModel?: string | null;
  groqModel?: string | null;
  kimiModel?: string | null;
  openaiModel?: string | null;
  basedataUser?: string | null;   // ★基礎データ公開(225labo)ユーザー名(秘密・空欄=送らない)
  basedataPass?: string | null;   // ★基礎データ公開(225labo)パスワード(秘密・空欄=送らない)
  basedataSaveDir?: string | null;   // ★保存先フォルダ(可視・常に送る・空欄=既定に戻す)
  githubToken?: string | null;    // ★GitHub PAT(秘密・空欄=送らない)
  basedataAutoPublish?: boolean | null;   // ★自動公開 有効/無効(常に送る)
  scalpLcCeilingYen?: number | null;
  scalpBias?: 'long' | 'short' | 'none' | null;
  scalpCooldownSec?: number | null;
  scalpRangeEnabled?: boolean | null;
  dotenEnabled?: boolean | null;   // ★ドテン(反転)許可
  rangeReevalEnabled?: boolean | null;   // ★レンジ再評価(未約定→ブレイク)許可
  indicatorsEnabled?: boolean | null;    // ★テクニカル指標(表示+AI文脈)
  aiTechnicalEnabled?: boolean | null;   // ★AIテクニカル許可(エントリーのタイミング判断)
  scalpChartFallbackText?: boolean | null;   // ★チャート撮影失敗でもテキストで継続
  scalpTrendVetoYen?: number | null;
  // ★v0.7.56: 委任 source + 初期LC下限 + LC安全上限
  scalpLcFloorYen?: number | null;
  scalpLcFloorSource?: KnobSource;
  scalpLcCeilingSource?: KnobSource;
  scalpTrendVetoSource?: KnobSource;
  scalpCooldownSource?: KnobSource;
  scalpBiasSource?: KnobSource;
  scalpRangeSource?: KnobSource;
  scalpLcHardMaxEnabled?: boolean | null;
  scalpLcHardMaxYen?: number | null;
  // ★v0.8.2: System B(紙専用)。ネストしたオブジェクトで送る(各フィールドは A と同名・''/null=A追従)。
  signalB?: Record<string, unknown>;
  // ★提案生成器の専用キー。秘密フィールド規約(空欄=変更なし)+ null=消去(共通キーへ戻す)。
  //   何も入力せず消去もしないときは **フィールドごと送らない**(=変更なし)。
  generatorKeys?: Partial<Record<GeneratorProviderName, string | null>>;
  generatorDailyBudget?: number | null;   // 生成器の日次予算。空欄=null=既定に戻す / 0=無効。
  generatorEnabled?: boolean | null;      // ★生成器サイドカー(true=動かす / false/null=既定=動かさない)。
}

// 「キーを検証」の1プロバイダぶんの結果。★モデル一覧(GET /v1/models・トークン非消費)で
//   「キーが無効」と「そのキーでそのモデルが使えない」を **区別して** 返す。
//   古いサーバ(モデル情報を返さない版)でも壊れないよう、追加分は全て任意。
export interface KeyTestResult {
  name: string;
  ok: boolean;
  notset?: boolean;
  error?: string;
  model?: string;            // 検証したモデル(設定値 → 既定)
  isDefaultModel?: boolean;  // モデル欄が空(=既定のまま)か
  keyOk?: boolean;           // キー自体は通ったか
  modelOk?: boolean;         // 設定中のモデルがそのキーで使えるか
  models?: string[];         // そのキーで使えるモデル一覧
  modelsTotal?: number;      // 一覧の総数(models は上限で切り詰められる)
  reason?: 'ok' | 'key' | 'model' | 'unknown';
  via?: 'models' | 'ping';   // 判定経路('models'=無料の一覧 / 'ping'=1トークン)
  listError?: string;        // 一覧が取れず ping に落ちた理由
}

export interface KeyTestResponse {
  results?: KeyTestResult[];
  error?: string;
}

export interface SettingsElements {
  openBtn: HTMLButtonElement;
  modal: HTMLElement;
  closeBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  inputGemini: HTMLInputElement;
  inputGroq: HTMLInputElement;
  inputKimi: HTMLInputElement;
  inputOpenai: HTMLInputElement;
  inputWebSearch: HTMLInputElement;        // Web検索(Gemini グラウンディング)専用キー
  inputWebSearchModel: HTMLInputElement;   // Web検索用 Gemini モデル
  inputWebSearchOpenaiModel: HTMLInputElement;  // OpenAI Web検索モデル
  inputScalpLcCeiling: HTMLInputElement;   // AIエントリー: 最大初期LC(円)
  selectScalpBias: HTMLSelectElement;      // AIエントリー: バイアス
  inputScalpCooldown: HTMLInputElement;    // AIエントリー: クールダウン(秒)
  inputScalpTrendVeto: HTMLInputElement;   // AIエントリー: トレンド veto 閾値(円・0で無効)
  checkScalpRangeEnabled: HTMLInputElement; // AIエントリー: レンジ両面ストラドル(実験・紙で別枠計測)
  checkScalpDotenEnabled: HTMLInputElement; // ★ドテン(反転)許可(monitor2 専用・変異gateで lite 非表示)
  checkScalpRangeReeval: HTMLInputElement;  // ★レンジ再評価(未約定→ブレイク)許可(monitor2 専用・変異gateで lite 非表示)
  checkIndicatorsEnabled: HTMLInputElement; // ★テクニカル指標(RSI/SMA/BB)の表示+AI文脈供給
  checkAiTechnicalEnabled: HTMLInputElement; // ★AIテクニカル許可(エントリーのタイミング判断)
  checkScalpChartFallback: HTMLInputElement; // ★チャート撮影失敗でもテキストで継続(既定ON)
  // ★v0.7.56: 委任モード select + 初期LC下限 + LC安全上限
  inputScalpLcFloor: HTMLInputElement;
  selectLcFloorMode: HTMLSelectElement;
  selectLcCeilingMode: HTMLSelectElement;
  selectTrendVetoMode: HTMLSelectElement;
  selectCooldownMode: HTMLSelectElement;
  selectBiasMode: HTMLSelectElement;
  selectRangeMode: HTMLSelectElement;
  checkScalpLcHardMaxEnabled: HTMLInputElement;
  inputScalpLcHardMax: HTMLInputElement;
  // ★v0.8.2: System B(紙専用)の設定入力。B の value 系は空欄=A追従 / mode/tri-state は ''=A追従。
  inputScalpLcCeilingB: HTMLInputElement;
  selectScalpBiasB: HTMLSelectElement;
  inputScalpCooldownB: HTMLInputElement;
  inputScalpTrendVetoB: HTMLInputElement;
  selectRangeEnabledB: HTMLSelectElement;      // tri-state('' A追従/'true'/'false')
  inputScalpLcFloorB: HTMLInputElement;
  selectLcFloorModeB: HTMLSelectElement;
  selectLcCeilingModeB: HTMLSelectElement;
  selectTrendVetoModeB: HTMLSelectElement;
  selectCooldownModeB: HTMLSelectElement;
  selectBiasModeB: HTMLSelectElement;
  selectRangeModeB: HTMLSelectElement;
  selectHardMaxEnabledB: HTMLSelectElement;    // tri-state('' A追従/'true'/'false')
  inputScalpLcHardMaxB: HTMLInputElement;
  statusArea: HTMLElement;
  backdrop: HTMLElement;
  checkUpdateBtn: HTMLButtonElement;
  updateResult: HTMLElement;
  currentVersion: HTMLElement;
  // ★基礎データ公開(225labo)。monitor2 専用。
  inputLaboUser: HTMLInputElement;
  inputLaboPass: HTMLInputElement;
  inputBasedataSaveDir: HTMLInputElement;   // 保存先フォルダ(可視)
  inputGithubToken: HTMLInputElement;       // GitHub PAT(秘密)
  checkBasedataAutoPublish: HTMLInputElement;   // 自動公開 有効/無効
  basedataAutoStatus: HTMLElement;          // 自動公開の直近結果サマリ表示
  basedataPublishBtn: HTMLButtonElement;
  basedataPublishResult: HTMLElement;
  mergeDbBtn: HTMLButtonElement;
  mergeResult: HTMLElement;
  exportDbBtn: HTMLButtonElement;
  exportResult: HTMLElement;
  replaceDbBtn: HTMLButtonElement;
  replaceResult: HTMLElement;
  testKeysBtn: HTMLButtonElement;
  testResult: HTMLElement;
  // ★提案生成器(分析用・実弾 A とは別プール)。キー欄はプロバイダごと・状態表示は form.ts が
  //   id(genkey-<name>-status / genkey-<name>-src)で書き込む。
  inputGenGemini: HTMLInputElement;
  inputGenGroq: HTMLInputElement;
  inputGenOpenai: HTMLInputElement;
  inputGenKimi: HTMLInputElement;
  checkGenKeysClear: HTMLInputElement;      // 保存時に専用キーを消去(=共通キーへ戻す)
  inputGeneratorBudget: HTMLInputElement;   // 日次予算(回/取引日・空欄=既定)
  checkGeneratorEnabled: HTMLInputElement;  // ★生成器サイドカーを動かすか(既定オフ=待機のみ)
  testGenKeysBtn: HTMLButtonElement;        // 生成器プールのキー検証
  testGenResult: HTMLElement;
}

// ★v0.8.3: 設定モーダル分割後、🎛️(詳細設定)側からも移設フィールド(Web検索モデル/AIエントリー/データ)を
//   読み込み/保存できるよう、全入力の load(refresh) と save(doSave) を戻り値として公開する。
//   入力は id 参照(getElementById)なので DOM がどちらのモーダルにあっても同じハンドラで動く。
export interface SettingsController {
  refresh: () => Promise<void>;
  save: () => Promise<void>;
}
