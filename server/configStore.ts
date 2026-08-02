// ユーザー設定の永続化: ~/.jp225-monitor/config.json
// .env よりも優先。配布版でも .env なしで動かせる。

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveVariant } from './variant.js';
import type { LlmCaller } from './llm/caller.js';   // 型のみ(実行時 import なし=循環なし)

const CONFIG_DIR = () => join(homedir(), '.jp225-monitor');
const CONFIG_FILE = () => join(CONFIG_DIR(), 'config.json');

export interface UserConfig {
  kimiKey?: string;
  geminiKey?: string;
  groqKey?: string;
  openaiKey?: string;
  webSearchKey?: string;   // チャットの web_search(Gemini グラウンディング)専用キー。未設定なら共通 geminiKey に落ちる。
  webSearchModel?: string; // web_search 用の Gemini モデル(chatModel と別)。未設定は既定 gemini-flash-latest。
  webSearchOpenaiModel?: string; // Gemini キーが無い/枠切れ時に OpenAI で Web 検索するモデル。未設定は既定 gpt-4o-mini-search-preview。
  chromePath?: string;    // scalp-plan のチャート撮影に使う chrome.exe の明示パス(未設定は自動解決)
  // ★提案生成器(caller='generator')専用の API キー。**未設定なら共通キーへフォールバック**する。
  //   「今回キーを分けるかは未定・分けられる構造にする」への答え: プール分離(providers.ts)は既に
  //   キー解決をプール別に通しているので、ここへ値を入れるだけで上流クォータまで完全に分離できる。
  generatorKeys?: { gemini?: string; groq?: string; openai?: string; kimi?: string };
  // ★提案生成器の日次予算(1取引日あたりの許可回数)。0=生成器を無効化。未設定は保守的な既定値。
  generatorDailyBudget?: number;
  basedataUser?: string;  // ★基礎データ公開(225labo)ログインのユーザー名。秘密扱い(既存 API キーと同モデル)。
  basedataPass?: string;  // ★基礎データ公開(225labo)ログインのパスワード。秘密扱い。
  basedataSaveDir?: string;  // ★基礎データ公開の保存先フォルダ(xlsx/gz/meta)。可視。未設定は Downloads。
  githubToken?: string;   // ★基礎データ公開を gh CLI 無しで行う GitHub PAT。秘密扱い。未設定は gh CLI にフォールバック。
  basedataAutoPublish?: boolean;  // ★平日8:00以降の初回に自動公開(monitor2専用)。未設定/false は無効。
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
  // ★検知チューニング(40日ライブ分析の方向的中率から): double は反転が効かず(形成通知の的中低)/
  //   break は継続方向のアルファが≈0pt(単独では乱発のみ)/ slope(超短期フラッシュ)は唯一の順行アルファ +52pt。
  //   → double は形成を止め breakout も減点、break は単独では出さず、slope 方向一致にコンフルエンス加点する。
  doubleFormingEnabled?: boolean;    // double: 形成中(forming)も出すか。未設定/false=OFF(breakout のみ・既定)。
  // ★N波動(値幅観測論): スイング A→B→C の N値/V値/E値 を節目に出し、B 抜け確認で nwave アラート。
  nwaveEnabled?: boolean;            // N波動の節目/アラートを出すか。未設定/true=ON(既定)。false=OFF。
  nwaveMinSwingYen?: number;         // N波動の最小1波幅 |B−A|(円)。これ未満の浅い波は捨てる。未設定は 300。
  breakScore?: number;               // break 単独スコア。既定 0.9(minScore=1未満→単独breakは出さず、コンフルエンス時のみ生きる)。
  slopeConfluenceBonus?: number;     // slope と同方向の直近モメンタムに一致したクラスタへの加点。既定 0.5。
  scalpLcCeilingYen?: number;        // AIエントリー: 最大初期LC(損切り)幅[円]。未設定は 65。buildScalpPlan の上限既定。
  scalpBias?: ScalpBias;             // AIエントリー: バイアス。'long'=買い中心 / 'short'=売り中心 / 'none'=両方向(既定)。
  scalpCooldownSec?: number;         // AIエントリー: 決済(filled→flat)後に再ARMを抑止する秒数。未設定は 90。0で無効。
  scalpRangeEnabled?: boolean;       // AIエントリー: レンジ判断時の両面ストラドル(実験)。★v0.7.53で実験終了=未設定は false(OFF)。true で再有効化可。
  scalpTrendVetoYen?: number;        // AIエントリー: 直近10分でこの円以上動いたらトレンドと見なし逆行フェード新規を禁止。未設定は 100。0で無効。
  scalpLcFloorYen?: number;          // ★AIエントリー 初期LC幅の下限[円]。プロンプト + **コードで強制**(下限未満のレッグを落とす)。未設定は 45。
  dotenEnabled?: boolean;            // ★ドテン(反転)許可。ON=AIが保有中に反転を判断してよい / 未設定/false=OFF(既定・挙動不変)。monitor2 専用UIで設定。
  rangeReevalEnabled?: boolean;      // ★レンジ両指値が平均以上未約定→ブレイク(両逆指値)再評価。未設定/true=ON(既定・ただしレンジ自体が既定OFFなのでレンジ使用時のみ実効) / false=OFF。monitor2 専用UIで設定。
  indicatorsEnabled?: boolean;       // ★テクニカル指標(RSI/SMA/BB)のパネル表示 + AI文脈供給。未設定/true=ON(既定) / false=OFF。表示/文脈のみ(検知は不変)。
  aiTechnicalEnabled?: boolean;      // ★AIテクニカル許可(RSI/BB をエントリーのタイミング判断に使う)。未設定/true=ON(既定) / false=OFF=許可行なし(byte-safe)。決済は既定ロジック。
  scalpChartFallbackText?: boolean;  // ★チャート撮影失敗(ws-error等)時の縮退。未設定/true=ON(2回失敗ならテキストのみでAI継続=全停止防止) / false=ストリクトvision(撮影不可なら見送り)。グローバル(A/B共有)。
  // ★v0.7.56: 委任可能な各 knob の source。'ai'=AIに委任(該当制約を課さない) / それ以外/未設定='manual'(現状の強制)。
  //   既定は全て 'manual'=現状の挙動を一切変えない。ユーザーが1つずつ AI へ倒す枠組み。
  // ★初期LC下限だけは委任の対象外: source が 'ai' でもコードは下限を強制する(強制が委任に勝つ)。
  //   この設定自体の廃止は別途。当面は「値は使うが mode は下限の強制可否を変えない」意味になる。
  scalpLcFloorSource?: KnobSource;     // 初期LC下限: mode に関係なくコードで強制(下限未満レッグ落とし)。ai はプロンプト文面だけが変わる
  scalpLcCeilingSource?: KnobSource;   // 最大初期LC: manual→超過レッグ落とし / ai→上限で落とさない(hardMax は別)
  scalpTrendVetoSource?: KnobSource;   // トレンドveto: manual→数値veto / ai→数値veto無効(AI自己判断)
  scalpCooldownSource?: KnobSource;    // クールダウン: manual→ゲート / ai→ゲート無効
  scalpBiasSource?: KnobSource;        // バイアス: manual→方向veto / ai→veto無効(自由方向)
  scalpRangeSource?: KnobSource;       // レンジ両面: manual→on/off設定どおり / ai→AIが採用可否(range許可)
  // ★v0.7.56: LC安全上限(実弾暴走防止・policy の scalpLcCeiling とは独立の安全系)。
  //   有効時は手動でもAIでも |entry−SL| がこの円超のレッグを必ず落とす(最後の安全網)。無効時はハード上限なし。
  scalpLcHardMaxYen?: number;          // LC安全上限[円]。未設定は 150。
  scalpLcHardMaxEnabled?: boolean;     // LC安全上限を有効にするか。未設定は true(既定で安全網ON)。
  // ★v0.8.2: System B(紙専用の並走エンジン)の独立設定。A と同じ knob 一式を持つ(全て任意)。
  //   B リゾルバは signalB.<knob> を優先し、未設定は A(グローバル)値/directive にフォールバックする
  //   (箱出しは B も A と同一挙動→そこから B だけ差分)。実売買 A には一切影響しない(B は currentSignal を出さない)。
  signalB?: SignalBConfig;
  // ★lite(簡易公開版)の独立設定。lite の 🎛️ に露出した項目だけをここに持ち、monitor2(full)の
  //   最上位キーと混ざらないようにする(同一PCで両方使っても互いに干渉しない)。
  //   variant='lite' のときだけ参照され、未設定の項目は最上位→組み込み既定へフォールバックする。
  lite?: LiteConfig;
}

// ★lite 独立設定ブロック。lite の詳細設定に露出した項目のみ(全て任意=未設定は最上位へフォールバック)。
//   ここに項目を足すのは「lite の画面に出した」ときだけ。出していない設定を入れてはいけない
//   (monitor2 が設定した値が lite 側で見えなくなり、原因不明の挙動差になる)。
//   委任モード(source)も設定なので、値と一緒に独立させる(片方で AI委任にしたら両方変わる、を防ぐ)。
export interface LiteConfig {
  scalpBias?: ScalpBias;
  scalpLcFloorYen?: number;
  scalpLcCeilingYen?: number;
  scalpLcHardMaxEnabled?: boolean;
  scalpLcHardMaxYen?: number;
  // 委任モード(手動/AI)。LC安全上限は「AIに委ねる対象」ではない安全弁なので source を持たない。
  scalpLcFloorSource?: KnobSource;
  scalpLcCeilingSource?: KnobSource;
  scalpBiasSource?: KnobSource;
}

// ★lite 名前空間が担当するキー(= lite の画面に出した 値5 + 委任モード3)。
//   これ以外は lite でも最上位から解決する。
export const LITE_OWNED_KEYS = [
  'scalpBias', 'scalpLcFloorYen', 'scalpLcCeilingYen', 'scalpLcHardMaxEnabled', 'scalpLcHardMaxYen',
  'scalpLcFloorSource', 'scalpLcCeilingSource', 'scalpBiasSource',
] as const;
export type LiteOwnedKey = typeof LITE_OWNED_KEYS[number];
const LITE_OWNED_SET: ReadonlySet<string> = new Set(LITE_OWNED_KEYS);
export function isLiteOwnedKey(key: string): key is LiteOwnedKey { return LITE_OWNED_SET.has(key); }

// ★v0.8.2: System B の独立設定ブロック。A と同じ knob 一式(全て任意=未設定は A へフォールバック)。
export interface SignalBConfig {
  scalpLcCeilingYen?: number;
  scalpBias?: ScalpBias;
  scalpCooldownSec?: number;
  scalpRangeEnabled?: boolean;
  scalpTrendVetoYen?: number;
  scalpLcFloorYen?: number;
  scalpLcHardMaxYen?: number;
  scalpLcHardMaxEnabled?: boolean;
  scalpLcFloorSource?: KnobSource;
  scalpLcCeilingSource?: KnobSource;
  scalpTrendVetoSource?: KnobSource;
  scalpCooldownSource?: KnobSource;
  scalpBiasSource?: KnobSource;
  scalpRangeSource?: KnobSource;
}

// ★v0.8.2: シグナル系統プロファイル。'A'(実売買・グローバル設定=既定/省略と同一) / 'B'(紙専用・signalB 設定)。
export type SignalProfile = 'A' | 'B';

// AIエントリーのバイアス。'none'(両方向)が既定。
export type ScalpBias = 'long' | 'short' | 'none';

// ★v0.7.56: 委任可能な knob の source。'manual'=数値/enum を強制 / 'ai'=AI に委任(該当制約を課さない)。
export type KnobSource = 'manual' | 'ai';

type ProviderName = 'gemini' | 'groq' | 'openai' | 'kimi';

// 各パラメータの範囲とデフォルト
export const PARAM_BOUNDS = {
  pricePollMs: { min: 500, max: 60_000, default: 2000 },
  newsPollMs:  { min: 10_000, max: 600_000, default: 60_000 },
  port:        { min: 1024, max: 65_535, default: 3000 },
  cooldownMin: { min: 1, max: 120, default: 15 },
  shockMove1Yen:    { min: 1, max: 500,  default: 45 },
  shockMove2Yen:    { min: 1, max: 1000, default: 55 },
  shock1Yen:        { min: 1, max: 1000, default: 50 },
  shock2Yen:        { min: 1, max: 2000, default: 70 },
  shockAccelYen:    { min: 0, max: 1000, default: 10 },
  shockAvgMult:     { min: 0.1, max: 20, default: 2.0 },
  shockScoreNeed:   { min: 2, max: 6,    default: 5 },
  shockCooldownBars:{ min: 0, max: 120,  default: 5 },
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
  nwaveMinSwingYen:      { min: 50, max: 3000, default: 300 },   // ★N波動の最小1波幅 |B−A|(円)。浅い波の雑音を捨てる。
  breakScore:            { min: 0, max: 3, default: 0.9 },   // ★40日ライブ: break 継続は≈0pt。単独(0.9<minScore1)は出さずコンフルエンスでのみ生かす。
  slopeConfluenceBonus:  { min: 0, max: 2, default: 0.5 },   // ★40日ライブ: slope は唯一の順行アルファ +52pt。方向一致クラスタへ加点。
  scalpLcCeilingYen:      { min: 20, max: 300, default: 65 },   // AIエントリー最大初期LC(円)。openai.ts LC_YEN_MIN/MAX と整合。
  scalpCooldownSec:       { min: 0, max: 3600, default: 90 },   // AIエントリー: 決済後の再ARM抑止秒数。0で無効。
  scalpTrendVetoYen:      { min: 0, max: 1000, default: 100 },  // AIエントリー: トレンド veto 閾値(円)。直近10分でこの円以上動いたら逆行フェードを禁止。0で無効。
  scalpLcFloorYen:        { min: 20, max: 300, default: 45 },   // ★AIエントリー 初期LC幅の下限(円)。プロンプト + コードで強制(委任でも効く)。
  scalpLcHardMaxYen:      { min: 20, max: 500, default: 150 },  // ★v0.7.56: LC安全上限(円)。有効時は手動/AIとも超過レッグを落とす。
} as const;

let cached: UserConfig | null = null;
let cachedMtime = -1;

// ★設定を絶対に失わないためのバックアップ。saveConfig で config.json.bak に複製し、
//   config.json が欠落/破損したとき復元する(更新時のプロセス kill 中の書き込み中断対策)。
const BAK_FILE = () => join(CONFIG_DIR(), 'config.json.bak');

// 指定ファイルを JSON として読み、UserConfig を返す(読めない/壊れていれば null)。
function tryReadConfig(path: string): UserConfig | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as UserConfig;
  } catch { return null; }
}

export function loadConfig(): UserConfig {
  const file = CONFIG_FILE();
  if (!existsSync(file)) {
    // 主ファイル欠落 → バックアップから復元(あれば)。
    const bak = tryReadConfig(BAK_FILE());
    if (bak) {
      try { copyFileSync(BAK_FILE(), file); } catch { /* ignore */ }
      console.warn('[configStore] config.json 欠落 → バックアップから復元しました');
      cached = bak; cachedMtime = -1; return cached;
    }
    if (!cached) cached = {}; return cached;
  }
  let mtime = -1;
  try { mtime = statSync(file).mtimeMs; } catch { /* ignore */ }
  if (cached && mtime === cachedMtime) return cached;
  const main = tryReadConfig(file);
  if (main) { cached = main; cachedMtime = mtime; return cached; }
  // 主ファイル破損 → バックアップから復元(あれば)。設定を失わない。
  const bak = tryReadConfig(BAK_FILE());
  if (bak) {
    try { copyFileSync(BAK_FILE(), file); } catch { /* ignore */ }
    console.warn('[configStore] config.json 破損 → バックアップから復元しました');
    cached = bak;
    try { cachedMtime = statSync(file).mtimeMs; } catch { cachedMtime = -1; }
    return cached;
  }
  console.error('[configStore] config.json 破損・バックアップも無し → 空設定で継続');
  if (!cached) cached = {};
  return cached;
}

export function saveConfig(config: UserConfig): void {
  const file = CONFIG_FILE();
  mkdirSync(CONFIG_DIR(), { recursive: true });
  const json = JSON.stringify(config, null, 2);
  // ★原子的書き込み(tmp→rename): 書き込み中断で config.json が空/半端になるのを防ぐ。
  const tmp = file + '.tmp';
  writeFileSync(tmp, json, 'utf-8');
  renameSync(tmp, file);
  // ★直近の正常値をバックアップ(復元用)。失敗しても致命的にしない。
  try { writeFileSync(BAK_FILE(), json, 'utf-8'); } catch { /* ignore */ }
  cached = config;
  try { cachedMtime = statSync(file).mtimeMs; } catch { cachedMtime = -1; }
  console.log(`[configStore] saved to ${file} (+bak)`);
}

// APIキー解決: config.json 優先 → 環境変数 fallback
export function resolveApiKey(provider: ProviderName): string | undefined {
  const config = loadConfig();
  const fromConfig =
    provider === 'kimi'   ? config.kimiKey
  : provider === 'gemini' ? config.geminiKey
  : provider === 'groq'   ? config.groqKey
  : config.openaiKey;
  if (fromConfig && fromConfig.trim()) return fromConfig.trim();
  const envName =
    provider === 'kimi'   ? 'KIMI_API_KEY'
  : provider === 'gemini' ? 'GEMINI_API_KEY'
  : provider === 'groq'   ? 'GROQ_API_KEY'
  : 'OPENAI_API_KEY';
  return process.env[envName]?.trim();
}

/** 環境変数名(生成器プール用)。共通キーの env 名に GENERATOR_ を前置する。 */
const GENERATOR_ENV: Record<ProviderName, string> = {
  kimi:   'GENERATOR_KIMI_API_KEY',
  gemini: 'GENERATOR_GEMINI_API_KEY',
  groq:   'GENERATOR_GROQ_API_KEY',
  openai: 'GENERATOR_OPENAI_API_KEY',
};

/** ★プール別の API キー解決。providers.ts のプール(default/generator)構築が使う。
 *  - pool==='default' → **resolveApiKey と完全に同一**(既存経路は1ミリも変えない)。
 *  - pool==='generator' → 専用キー(config.generatorKeys → env GENERATOR_*)があればそれ。
 *    無ければ **共通キーへフォールバック**する(=キーを分けなくても動く)。
 *  ★フォールバック時は上流のクォータが共有されたままである点に注意。それは
 *    generatorGate.ts の日次予算 + 従属規則(default が quota を踏んだら生成器停止)で受け持つ。 */
export function resolveApiKeyForPool(provider: ProviderName, pool: LlmCaller): string | undefined {
  if (pool === 'default') return resolveApiKey(provider);
  const own = loadConfig().generatorKeys?.[provider];
  if (own && own.trim()) return own.trim();
  const env = process.env[GENERATOR_ENV[provider]]?.trim();
  if (env) return env;
  return resolveApiKey(provider);
}

// ─── 提案生成器の日次予算 ────────────────────────────────────────────────
/** 生成器の日次予算の既定値[回/取引日]。
 *  ★根拠: 2分間隔でフルカバー(日中7h + ナイト13h)すると約 600 回/取引日。運用見込みは 700〜1,600 回。
 *    既定はそれを **大きく下回る 200** にする=「第1週の実測で決める」までの間、実測に十分な標本
 *    (200件/日)を取りつつ、上流クォータへの露出を1セッション相当に抑える。
 *    上限に達した生成器は **止まって記録する**(無音の縮退やモード書き換えは絶対にしない)ので、
 *    既定が低すぎればユーザーはログで即座に気づき、実測値に基づいて設定を上げられる。 */
export const GENERATOR_DAILY_BUDGET_DEFAULT = 200;
export const GENERATOR_DAILY_BUDGET_MAX = 5000;

/** 生成器の日次予算を解決。config.json → env GENERATOR_DAILY_BUDGET → 既定。0 は「無効」の意味で受理する。 */
export function resolveGeneratorDailyBudget(): number {
  const v = loadConfig().generatorDailyBudget;
  const raw = typeof v === 'number' && Number.isFinite(v) ? v : Number(process.env.GENERATOR_DAILY_BUDGET);
  if (!Number.isFinite(raw)) return GENERATOR_DAILY_BUDGET_DEFAULT;
  return Math.min(Math.max(Math.floor(raw), 0), GENERATOR_DAILY_BUDGET_MAX);
}

// 基礎データ公開(225labo)の資格情報を解決。config.json 優先 → env LABO225_USER/LABO225_PASS フォールバック。
export function resolveBasedataCreds(): { user?: string; pass?: string } {
  const cfg = loadConfig();
  const user = (cfg.basedataUser && cfg.basedataUser.trim()) || process.env.LABO225_USER?.trim();
  const pass = (cfg.basedataPass && cfg.basedataPass.trim()) || process.env.LABO225_PASS?.trim();
  return { user: user || undefined, pass: pass || undefined };
}

// 基礎データ公開の保存先フォルダを解決。config 値(trim)優先 → 未設定は ~/Downloads(gh PC へコピーしやすい)。
export function resolveBasedataSaveDir(): string {
  const d = loadConfig().basedataSaveDir;
  return (d && d.trim()) || join(homedir(), 'Downloads');
}

// GitHub PAT を解決(gh CLI 無しで REST 公開する用)。config 優先 → env GITHUB_TOKEN / GH_TOKEN。
export function resolveGithubToken(): string | undefined {
  const t = loadConfig().githubToken;
  if (t && t.trim()) return t.trim();
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
}

// チャットの web_search(Gemini グラウンディング)キー解決。
// 専用 webSearchKey → 共通 geminiKey(config.json 優先) → env GEMINI_API_KEY の順にフォールバック。
export function resolveWebSearchKey(): string | undefined {
  const cfg = loadConfig();
  if (cfg.webSearchKey && cfg.webSearchKey.trim()) return cfg.webSearchKey.trim();
  if (cfg.geminiKey && cfg.geminiKey.trim()) return cfg.geminiKey.trim();
  return process.env.GEMINI_API_KEY?.trim();
}

export const DEFAULT_WEB_SEARCH_MODEL = 'gemini-flash-latest';

// web_search 用 Gemini モデル。未設定は既定(現行 GA Flash=grounding 対応の 3.x に追従するエイリアス)。
export function resolveWebSearchModel(): string {
  const m = loadConfig().webSearchModel;
  return m && m.trim() ? m.trim() : DEFAULT_WEB_SEARCH_MODEL;
}

// OpenAI Web 検索モデル。Gemini キーが無い/枠切れのとき OpenAI で Web 検索する。
// 既定は web 検索対応の chat.completions モデル(search-preview 系)。
export const DEFAULT_WEB_SEARCH_OPENAI_MODEL = 'gpt-4o-mini-search-preview';

export function resolveWebSearchOpenaiModel(): string {
  const m = loadConfig().webSearchOpenaiModel;
  return m && m.trim() ? m.trim() : DEFAULT_WEB_SEARCH_OPENAI_MODEL;
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

// ★内部ヘルパ(export): 切り出したドメインモジュール(config/*Resolvers.ts)が使う。
//   configStore が re-export する構成のため public 面に出るが、用途はドメインリゾルバの実装専用。
export function resolveNumeric(key: keyof typeof PARAM_BOUNDS): number {
  // ★lite 名前空間の解決を1か所に集約するため readKnobRaw 経由にする。
  //   profile 省略 + full では従来どおり最上位を読むだけ(=monitor2 はバイト不変)。
  const v = readKnobRaw(undefined, key);
  return typeof v === 'number' ? v : PARAM_BOUNDS[key].default;
}

// ★v0.8.2: プロファイル対応の knob 生値読み取り。profile==='B' のとき signalB.<key> を優先し、
//   未設定/undefined は A(グローバル・トップレベル)値へフォールバックする。profile 省略/'A' は
//   トップレベルのみ=既存挙動と完全一致(=A はバイト不変)。
// ★lite 独立設定: variant='lite' のときだけ、露出 5項目(LITE_OWNED_KEYS)を config.lite から先に読む。
//   未設定なら最上位へ落ちる=既存 lite ユーザーがバージョンアップしても実効設定が変わらない。
//   full(monitor2)では config.lite を一切見ない。
export function readKnobRaw(profile: SignalProfile | undefined, key: string): unknown {
  const cfg = loadConfig() as Record<string, unknown>;
  if (profile === 'B') {
    const b = cfg.signalB as Record<string, unknown> | undefined;
    if (b && b[key] !== undefined) return b[key];
  }
  if (isLiteOwnedKey(key) && resolveVariant() === 'lite') {
    const l = cfg.lite as Record<string, unknown> | undefined;
    if (l && l[key] !== undefined) return l[key];
  }
  return cfg[key];
}

// ★v0.8.2: プロファイル対応の数値 knob。profile 省略/'A' は resolveNumeric と完全一致。
export function resolveNumericProfile(profile: SignalProfile | undefined, key: keyof typeof PARAM_BOUNDS): number {
  const v = readKnobRaw(profile, key);
  return typeof v === 'number' ? v : PARAM_BOUNDS[key].default;
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

// ─── ドメイン別リゾルバの re-export ───────────────────────────────────────
// configStore を公開エントリに保ちつつ、実装はドメイン別モジュールに分割(純粋な移動)。
// 既存 importer は従来どおり './configStore.js' から同じシンボルを import できる。
export {
  resolveScalpLcCeiling, resolveScalpCooldownSec, resolveScalpTrendVetoYen,
  resolveScalpBias, resolveScalpRangeEnabled, resolveScalpLcFloorYen,
  resolveScalpDotenEnabled, resolveScalpRangeReevalEnabled, resolveScalpChartFallbackText,
  resolveIndicatorsEnabled, resolveScalpAiTechnicalEnabled,
  parseKnobSource,
  resolveScalpLcFloorDirective, resolveScalpLcCeilingDirective, resolveScalpTrendVetoDirective,
  resolveScalpCooldownDirective, resolveScalpBiasDirective, resolveScalpRangeDirective,
  resolveScalpLcHardMax,
} from './config/scalpResolvers.js';
export type { KnobDirective } from './config/scalpResolvers.js';
export {
  resolveShockParams, resolveShockCooldownBars, resolveOpenGuardBars, resolveFlashYen,
  resolveGranvilleMaMid, resolveGranvilleMaLong, resolveHitThreshold,
  resolveDoubleFormingEnabled, resolveBreakScore, resolveSlopeConfluenceBonus,
} from './config/alertResolvers.js';
export { resolveLevelsConfig, resolveNwaveEnabled, resolveNwaveMinSwingYen } from './config/levelsResolvers.js';
