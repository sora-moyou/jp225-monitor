// 設定モーダルの型定義。settingsModal.ts から純粋に切り出したもの(構造のみ・挙動不変)。

export type KnobSource = 'manual' | 'ai';

export interface SettingsResponse {
  kimiSet: boolean; geminiSet: boolean; groqSet: boolean; openaiSet: boolean;
  kimiFromEnv: boolean; geminiFromEnv: boolean; groqFromEnv: boolean; openaiFromEnv: boolean;
  webSearchKeySet: boolean; webSearchModel: string; webSearchOpenaiModel: string;
  basedataUserSet?: boolean; basedataPassSet?: boolean;   // ★基礎データ公開(225labo)認証 設定済み(真偽のみ)
  basedataSaveDir?: string;   // ★保存先フォルダ(可視・生の保存値・空欄=既定 Downloads)
  githubTokenSet?: boolean;   // ★GitHub PAT 設定済み(真偽のみ・秘密)
  basedataAutoPublish?: boolean;   // ★自動公開 有効/無効
  basedataAutoLastRun?: string;    // ★自動公開の直近結果サマリ(無ければ '')
  scalpLcCeilingYen: number; scalpBias: 'long' | 'short' | 'none'; scalpCooldownSec: number;
  scalpRangeEnabled: boolean; scalpTrendVetoYen: number;
  dotenEnabled?: boolean;   // ★ドテン(反転)許可(既定OFF)。monitor2(full)専用UI。
  rangeReevalEnabled?: boolean;   // ★レンジ再評価(未約定→ブレイク)許可(既定ON)。monitor2(full)専用UI。
  scalpChartFallbackText?: boolean;   // ★チャート撮影失敗でもテキストで継続(既定ON)。
  // ★v0.7.56: 委任 source + 初期LC下限 + LC安全上限
  scalpLcFloorYen: number;
  scalpLcFloorSource: KnobSource; scalpLcCeilingSource: KnobSource; scalpTrendVetoSource: KnobSource;
  scalpCooldownSource: KnobSource; scalpBiasSource: KnobSource; scalpRangeSource: KnobSource;
  scalpLcHardMaxEnabled: boolean; scalpLcHardMaxYen: number;
  // ★v0.8.2: System B(紙専用)の設定。raw=保存済み生値(未設定=A追従) / effective=A フォールバック済みの実効値(表示補助)。
  signalB?: SignalBRaw;
  signalBEffective?: SignalBEffective;
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
}

export interface KeyTestResponse {
  results?: Array<{ name: string; ok: boolean; notset?: boolean; error?: string }>;
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
}

// ★v0.8.3: 設定モーダル分割後、🎛️(詳細設定)側からも移設フィールド(Web検索モデル/AIエントリー/データ)を
//   読み込み/保存できるよう、全入力の load(refresh) と save(doSave) を戻り値として公開する。
//   入力は id 参照(getElementById)なので DOM がどちらのモーダルにあっても同じハンドラで動く。
export interface SettingsController {
  refresh: () => Promise<void>;
  save: () => Promise<void>;
}
