import type { NewsItem, Price } from '../types.js';
import {
  resolveScalpLcFloorDirective, resolveScalpLcCeilingDirective, resolveScalpTrendVetoDirective,
  resolveScalpBiasDirective, resolveScalpRangeDirective, resolveScalpLcHardMax, resolveScalpCooldownDirective,
  resolveScalpAiTechnicalEnabled,
  type ScalpBias, type KnobSource, type SignalProfile,
} from '../configStore.js';
import { describeExitLogic, describeExitLogicVariant, loadExitImpl, type ExitVariant } from '../signalTrade/exit/index.js';
// ★v0.9.44: レンジの形の観測は依存ゼロの leaf(signalTrade/rangeShape.ts)に置く。engine.ts が LLM スタックを
//   遅延ロードしている設計を壊さないため(engine は result.rangeAnomaly を読むだけ=静的 import 不要)。
import { describeRangeAnomaly, type RangeAnomaly } from '../signalTrade/rangeShape.js';
import { BB_BAND_LABEL } from '../../core/indicatorSpec.js';
// ★損切りの向きの規約は core/stopGeometry.ts が唯一の権威(依存ゼロの葉)。ここでは複製せず import する。
//   従来ここから export されていた2関数は、外部の import 面を変えないよう そのまま再輸出する(下)。
import { stopLossFromWidth, stopSideOk } from '../../core/stopGeometry.js';
// ★エントリー位置(指値=現在値の手前 / 逆指値=現在値の向こう)の規約も同じ理由で core の葉へ移した。
//   画面(web/components/signalPanel.ts)が同じ判定を必要とするが、web は server を import できない。
//   複製すると「片方だけ直す」事故が生まれるので、実体を core/entryLabel.ts に置いて両方から import する。
import { entryPositionOk, type EntryTrendDir } from '../../core/entryLabel.js';
import { describeBandwalk, type Bandwalk } from '../bandwalk.js';
// 型だけの import(実行時に消える)。scalpPlan は撮影モジュールを実行時には一切呼ばない。
import type { ChartShotIdentity } from '../chart/chartShot.js';
import { callWithFallback, isLLMEnabled, isVisionCapableProvider, formatErrForLog, NoFallbackError } from './providers.js';
import { sanitizeErrorForOutput } from './redact.js';
import { DEFAULT_CALLER, type LlmCaller } from './caller.js';
import { DEFAULT_PROMPT_VARIANT, type PromptVariant } from './promptVariant.js';
import { isWebSearchEnabled, webSearch } from './webSearch.js';
// ★RECORD-ONLY: 送るプロンプトの一方向指紋だけを作る純関数(本文はこのファイルの外へ出さない)。
import { promptFingerprint } from './promptFingerprint.js';
// ★v0.9.100(A/B 分割・段4): 切り替えは planSplitConfig の1箇所。
import { isPlanSplitEnabled } from './planSplitConfig.js';
import { runSplitPlan, type SplitRecord } from './scalpPlanSplit.js';
import type { ContextPresence } from './contextPresence.js';
import { TREND_MAX_TOKENS } from './trendPrompt.js';
import type { SqueezeState } from './planVariants.js';
// ★RECORD-ONLY: 根拠文の「申告した LC幅」と実際に出力した損切りの突き合わせ(純関数・判定には使わない)。
import { auditLcDeclarations, type LcDeclarationCheck, type LcLegName } from './rationaleLc.js';
// ★RECORD-ONLY: 根拠文の「そのレッグは出さない」表明と、実際に発注されるレッグの突き合わせ(判定には使わない)。
import { auditOmissionClaims, type OmissionClaimCheck } from './rationaleOmission.js';
import { getPrices } from '../cache.js';
import {
  NIKKEI_SYMBOL, buildMonitorContext, formatPricesForChat, formatNewsForChat,
  buildDataToolHandlers, runChatWithTools,
  EXPLAIN_MOVE_TOOL, QUERY_ALERTS_TOOL, PRICE_HISTORY_TOOL, WEB_SEARCH_TOOL,
  type ToolHandlers, type CreateFn,
} from './dataTools.js';

// ─── スキャル計画 (POST /api/scalp-plan) ─────────────────────────────
// 兄弟アプリ jp225-trade2(AI トレーダー)が呼ぶ。monitor の LLM を「固定のスキャル戦略質問」で走らせ、
// buildMonitorContext + データツール(explain_move/query_alerts/price_history/web_search)を使って
// ライブデータに基づく構造化プランを返す。既存の chat と同じプロバイダ選択・キー解決・tool ループを再利用する。

/** レンジ両面ストラドルの1レッグ(実験・仮想取引で別枠計測)。現在値の上/下に1つずつ置く。
 *  side=buy/sell × type=limit(レンジ内逆張り指値)/stop(抜け追随逆指値)。entry=新規価格・stopLoss=初期LC。
 *  ★v0.9.70: stopLoss(価格)は **内部表現のまま不変**。LLM から受け取るのは lcWidth(正の幅)だけで、
 *   符号は parse がここで付ける(=逆位置が構造的に表現できない)。 */
export interface RangeLeg {
  side: 'buy' | 'sell';
  type: 'limit' | 'stop';
  entry: number;
  stopLoss: number;
}

/** trade2 が受け取る構造化スキャルプラン。
 *  direction==='none' は「見送り(良い場面が無い)」で、価格フィールドは不要(rationale + refPrice のみ)。
 *  direction==='range' は「レンジ両面ストラドル」で、range に上下2レッグ(片レッグ落ちも可)を持つ。 */
export interface AiPlan {
  direction: 'buy' | 'sell' | 'none' | 'range';
  limitEntry?: number;        // 指値(押し目/戻り側の新規)。none/range の時は不要。
  stopEntry?: number;         // 逆指値(ブレイク側の新規)。none/range の時は不要。
  stopLossForLimit?: number;  // 指値約定時の損切り逆指値。none/range の時は不要。
  stopLossForStop?: number;   // 逆指値約定時の損切り逆指値。none/range の時は不要。
  rationale: string;         // 判断理由(日本語)。none の時は見送り理由。
  refPrice: number;          // 計画時に見た現在値(NIY=F)
  // ★AI自己レジーム/確信度(v0.7.54・記録のみ=ゲートには使わない)。AI が「まず自分で相場観を述べてから
  //   計画を出す」ための構造化出力。欠落/不正は undefined(後方互換)。決済時に signal_trades.meta へ保存し、
  //   後で「確信度は勝率と相関するか」「自己regimeは実際と合うか」を実測する。
  regime?: 'trend_up' | 'trend_down' | 'range' | 'unclear';
  confidence?: number;       // 0-100(この計画/レジーム判断への確信度)。
  // ★戦略ラベル(v0.9.84・記録のみ=ゲートには使わない)。④AIが理由と共に提示 →⑤結果を記録 →⑥AIへ返す、の
  //   学習ループで **「何を狙って外したのか」** を集計できるようにするための2つ。いまの⑥は
  //   「直近の負け: buy 68940→68880 -60」しか返せず、AI は狙いの単位で学べない。これがあれば
  //   「押し目 12件 勝率33%」の形で返せる。欠落/不正は undefined(regime/confidence と同じ後方互換)。
  //
  // ★未知のラベルは **その他に丸めない**。SCALP_STRATEGY_LABELS に無い文字列が来ても生値のまま残す。
  //   理由: 丸めると「リストが現実と合っていない」という **いちばん知りたい事実** が台帳から消える。
  //   ★別フィールド(strategyUnknown 等)を足さないのも意図的: 既知/未知は「値 × その時点のラベル一覧」で
  //     いつでも判定でき(isKnownScalpStrategy)、判定を書き込むと **書いた時点の一覧** が台帳に凍りつく。
  //     ラベル一覧は今後増える前提なので、凍らせず生値だけを残す方が後から数え直せる。
  strategy?: string;         // 相場の読みのラベル(候補=SCALP_STRATEGY_LABELS。一覧外の生値もそのまま入る)。
  strategyWhy?: string;      // なぜその読みにしたか(1行・日本語)。
  // ★v0.9.87(記録+表示・ゲートには使わない): **なぜこの価格なのか** の答え。
  //   この仕組みの価格は必ず節目から導かれる契約(指値=節目の内側 / ブレイク新規=節目の外側)なので、
  //   「どの節目を使ったか」が価格の理由そのものになる。★文章ではなく **数値** で受け取る:
  //   根拠文(rationale)は実測で LC検算に埋め尽くされ(根拠文76字のうち検算76字・理由0字)、
  //   文章の枠を増やしても押し出される。数値フィールドなら他の指示と枠を奪い合わない。
  //   ★内側/外側と距離は **コードが計算する**(AI には書かせない=嘘の表示を作らない)。
  //   欠落・不正・非数値でも計画は落とさない(strategy と同じ後方互換)。
  limitLevel?: number;       // 指値の根拠にした節目の価格。
  stopLevel?: number;        // ブレイク新規の根拠にした節目の価格。
  // ======================================================================================
  // ★★★ 次の設計(ユーザー確定・2026-08-21)。**まだ実装していない。指示が出るまで着手しない** ★★★
  //
  //   ── ユーザーの指示(時系列・逐語) ──────────────────────────────────────────────
  //     1「LC幅をAIにも求め、LC価格はこちらでつけてください」
  //     2「内側/外側 …【節目】が基準 についても、AIが調整せず、こちらで調整して」
  //     3「(ずらす量は)ともに5円」
  //     4「例えば節目70000円のブレイクを狙うという理由と、70005円逆指値のシグナルは矛盾しない」
  //     5「★なぜこの節目かと聞くと節目依存が強すぎます。例えば節目が離れているときは節目の真ん中でもいい
  //        です。★なぜこの価格を選んだかにしてください」
  //     6「★5円の調整はピボット節目のみにしてください。フィボナッチ等の節目は不要です」
  //     7「★キリバンとの重なりは表の価格に寄せてください」
  //
  //   ── 分担 ────────────────────────────────────────────────────────────────
  //     AI が出す   : 目線(ブル/ベア/レンジ) / ★Ｘの狙う価格・Ｙの狙う価格 / 損切りの幅 /
  //                   ★なぜその価格を選んだか
  //     コードが作る : ★発注価格 = 狙う価格 ±5円(ピボットのときだけ) / 損切り価格(既存)
  //
  //   ★★ 「節目」ではなく **「狙う価格」**。AI は節目に縛られない(節目が離れていれば中間でよい)。
  //      理由も「なぜその価格を選んだか」を問う。★私(実装側)が一度「なぜその節目か」で設計しかけたのを
  //      ユーザーが訂正した = **節目依存が強すぎる** ため。この訂正を消さないこと。
  //
  //   ── 5円をずらす対象(ユーザー承認済み) ────────────────────────────────────────
  //     ずらす(ピボット)   : スイング高安 / セッション高安・本日高安・長期高安 / 前日終値・寄付 /
  //                          反応価格・もみ合い帯・出来高集中
  //     ずらさない(計算値) : フィボ戻し / N値・V値・E値 / キリ番 / ADR予測レンジ / トレンドライン
  //     ★重なったらピボット優先(キリ番70,000が同時に本日高値なら **ピボット扱いで5円ずらす**)。
  //     ★根拠: 左は **実際に注文が出た値段** なので板が厚く、5円ずらす意味がある。
  //             右は **計算値** で、板が厚い理由がない。
  //
  //   ── ずらす向き(機械的に一意。AI は関与しない) ──────────────────────────────────
  //     指値(引きつける)   : 現在価格に **近づく側** へ5円
  //     逆指値(抜けたら乗る): 現在価格から **遠ざかる側** へ5円
  //
  //   ── ★逆側の検査(これが効果を決める) ───────────────────────────────────────────
  //     節目を出させても逆側は直らない(AI は自由な価格を出す)。**コードが側を検査する**:
  //       Ｘ の狙う価格が現在価格より上か / Ｙ が下か → 逆側ならその脚を落とす。
  //     ★なくすのは「申告 vs 出力」の一致検査。**残すのは「側」の検査**(実測 8/8 が逆側だった)。
  //
  //   ── ★5円は「執行の都合」であって相場の判断ではない ────────────────────────────
  //     このプロジェクトは「現在値から最低50円離す」が相場の規則の顔で **執行のラグ緩衝** だった前例を持つ。
  //     ⇒ 5円は **コード側の定数**(core/ の葉・stopGeometry.ts の隣が筋)として持ち、
  //       ★**プロンプトには数値を書かない**(v0.9.64: 印字した「5」が損切りの代入に流用された)。
  //   ── ★未測定(定数の由来として必ず残す) ────────────────────────────────────────
  //     ★**5円という値に根拠は無い**。「執行の都合」と言うなら執行の実測(だましの発生率)から決めるのが
  //     筋だが **今は未測定**。ユーザーの判断で 5円 とした。後で実測から見直せるよう、この経緯を
  //     定数のコメントにそのまま移すこと。
  //
  //   ── 着手時に設計して報告すること ───────────────────────────────────────────────
  //     1 ★一致の判定 = **完全一致**(ユーザー確定・2026-08-21「完全一致です。」)。**許容(±数円)は作らない**。
  //       ・根拠のない数字をもう1つ増やさずに済む(許容幅を作れば、その値にまた根拠が要る)
  //       ・判定が1行で書け、説明も1行で済む
  //       ・★副作用が明快: AI が 70,003 と出せばピボット(70,000)に一致しないので **そのまま 70,003 で発注**。
  //         ★**ずれた値を出したら、ずれたまま通る**。
  //       ★これは欠陥ではなく **仕様**: この設計では AI は節目に縛られず、節目の中間を選んでもよい
  //         (「なぜこの節目か」ではなく「**なぜこの価格を選んだか**」を問う理由がこれ)。
  //         **一致しない価格 = AI が節目以外の根拠で選んだ価格** なので、ずらさないのが正しい。
  //     1' ★**「一致しなかった件数」を台帳から読めるようにする**(新しい列か、既存の記録で読めるなら不要)。
  //       理由: ★**この設計が効いているかを測る唯一の手がかり**。
  //         一致率が高い = AI は節目を狙っている(5円が効いている)
  //         一致率が低い = AI は節目以外を狙っている(5円はほとんど発火しない)
  //       ★どちらでも正しいが、**どちらなのかを知らないまま運用しない**。
  //       前例: 「実データ11,859レッグで0件・構造的に発火しない保険」を **測って初めて知った**。
  //     2 5円の置き場所(core/ の葉)。プロンプトには書かない。
  //     2' ★5円刻みへの丸め = **コードがやる。プロンプトには刻みのことを書かない**
  //       (ユーザー指示「価格は5円刻みとすることは、AIに伝えて。」→ ★**取り消し**「あらためます。
  //        こちらで丸めてください。」= 確定)。
  //       ■ 実装は **既にある**(v0.9.83): server/signalTrade/entryTick.ts の
  //         `roundEntryToTick` / `ENTRY_TICK_YEN=5`。**そのまま使う**(新しく作らない)。
  //       ■ ★これでプロンプトに「5」を書かずに済む。v0.9.64 で stopEntry の隣の「5」が損切りの値に
  //         流用され **10円以下の損切りが43件** 出た前例があるので、**入れずに済むならそのほうが安全**。
  //       ■ ★丸めると「AI が狙った価格」と「実際の発注価格」がずれる(68,742.5 → 68,740)。
  //         ★**ピボットの5円ずらしとは性質が違う。混ぜないこと**:
  //           ・ピボットの5円ずらし … **執行の都合として説明できる**(70,000のブレイク → 70,005)。
  //             だから理由(狙う価格について述べる)と矛盾しない。
  //           ・端数の丸め         … ★**説明する筋が無い。ただの処理**。理由の対象ではない。
  //         丸めの向きは必ず **約定しにくい側**(買い指値→切り下げ / 売り指値→切り上げ /
  //         買い逆指値→切り上げ / 売り逆指値→切り下げ)なので、意図しない約定は作らない。ずれは5円未満。
  //       ■ ★二重にずれることは無い(確認済み): ピボットは実際に注文が出た値段なので5円刻みに乗っており、
  //         ±5円しても刻みのまま = 丸めは no-op。**中間を狙った回だけ丸めが働く**。
  //       ■ ★丸めが **何件発火したか** を後から数えられるようにする。
  //         実データ1,430件では **一度も発火していない**(AI が自然に5円刻みを出しているため)。
  //         次の版で中間を許して初めて出番が来る。★発火しているのかどうかを知らないまま運用しない
  //         (前例: 「実データ11,859レッグで0件・構造的に発火しない保険」を **測って初めて知った**)。
  //     3 ★limitEntry / stopEntry は **フィールドごと消さない**(trade2 が読むのは最終価格 = 執行の契約を動かさない)。
  //     4 後方互換(旧記録が壊れないこと)。
  //     5 理由フィールド(entryWhyForLimit / entryWhyForStop)の文面を **「なぜその価格を選んだか」** にする。
  //       ★契約の構造変更と **同じ版** に入れる(分けると片方が嘘になる期間ができる)。
  //     6 画面は別コーダーの担当。**同じ版に揃える**(契約が変わって画面が古いと「契約文が嘘になる」再発)。
  //     7 5円が執行の都合であることをコメントに明記(上記)。
  //
  //   ── ★次の版に入るもの(これで確定・2026-08-21) ─────────────────────────────────
  //     1 AI が「狙う価格」を出す(節目でも中間でも)
  //     2 理由は「なぜその価格を選んだか」
  //     3 コードが5円ずらす — ★**ピボットに完全一致したときだけ**
  //     4 コードが側を検査する(Ｘ は現在価格より上 / Ｙ は下・逆側ならその脚を落とす)
  //     5 ★コードが5円刻みに丸める(**プロンプトには書かない**・既存の roundEntryToTick を使う)
  //     6 ★一致しなかった件数・丸めが発火した件数を台帳に残す
  //
  //   ── ★実装前に直す必要がある事実の誤り(このファイルの実装と照合した結果) ──────────────
  //     上の分類表に付いていた識別子には **実在しないもの/取り違え** がある(server/levels.ts と照合):
  //       ・`swingPivots` は kind ではない。水準とは **別供給** のピボット(server/swingPivots.ts の
  //         extractSwingPivots)。levels.ts:356 に「ピボット(swingPivots)を別途供給する」と明記されている。
  //       ・「もみ合い帯」= kind `congestion`。「出来高集中」= kind **`volume`**(`congestion` ではない)。
  //       ・`support` は **kind ではない**。トレンドライン入力の向き('support' | 'resistance')。
  //     ★実在する kind(server/levels.ts): adr / congestion / grid250 / grid500 / grid1000 / longHL /
  //       nwave / open / prevClose / reaction / sessHL / todayHL / trendline / volume。
  //     ⇒ ずらす側 = swingPivots(別供給) + sessHL, todayHL, longHL, prevClose, open, reaction,
  //                  congestion, volume
  //       ずらさない側 = nwave, grid250, grid500, grid1000, adr, trendline(+ フィボ戻しは水準表に無い)
  //     ★フィボ戻しは現在この水準表に kind として存在しない。指示にある以上、**どこから来る値なのかを
  //       着手時に確認すること**(存在しない分類を実装すると、参照先の無い分岐が残る)。
  // ======================================================================================
  // ★v0.9.88(記録+表示・ゲートには使わない): **理由の箱をレッグごとに分ける**。
  //
  //   ■ なぜ分けるか(実測)
  //     同じ断面・同じデータで **JSON の理由フィールドの数だけ** を変えた測定で、
  //     1脚あたりの理由は 散文211字 / 箱の数 1 で59字 / 箱の数 2 で107字(+81%) だった。
  //     パース失敗0・欠損0・型違反0で、位置/種別/SL の向きも 24/24 で崩れていない。
  //     ⇒ 理由の量を決めているのは文言ではなく **箱の数** だという読み。
  //     本番の rationale はプラン全体で1本なのに脚は2本あり、「理由の記載なし 80.3%」の
  //     原因は文言ではなく **箱の不足** だろうという仮説。★本番データでは未検証。
  //   ■ 命名の規則(本番の既存語彙に揃える)
  //     「なぜ」= `...Why`(既存 `strategyWhy`) / レッグ別 = `...ForLimit` / `...ForStop`
  //     (既存 `lcWidthForLimit` / `stopLossForStop`)。実験で使った `biasWhy` / `slWhy` は採らない:
  //     `bias` は **設定名**(long/short/none)と衝突し、`sl` は JSON の語彙に存在しない(幅は `lcWidth`)。
  //   ■ rationale は **消さない・意味も変えない**。監査(server/llm/rationaleLc.ts)が生の rationale を
  //     読んでおり、LC検算の要求も外さない(外すと符号ミスが3倍になる実測がある)。
  //   ■ 欠落・不正でも計画は落とさない(strategy と同じ後方互換)。
  directionWhy?: string;     // なぜその direction(目線)にしたか。
  entryWhyForLimit?: string; // なぜ limitEntry をその価格にしたか。
  entryWhyForStop?: string;  // なぜ stopEntry をその価格にしたか。
  lcWhyForLimit?: string;    // なぜ lcWidthForLimit をその幅にしたか。
  lcWhyForStop?: string;     // なぜ lcWidthForStop をその幅にしたか。
  // direction==='range' の時のみ。upper.entry>refPrice>lower.entry。enforce/parse で片レッグに
  // 落ちることがある(その場合 upper か lower が undefined=実質片面)。
  range?: { upper?: RangeLeg; lower?: RangeLeg };
}

/** ★v0.9.44: 見送り(none)に至った経路(記録専用)。判定・採否・SSE・決済には一切影響しない。
 *  従来 engine のログは veto=y/n の1ビットしか区別できず、8通りの経路が同じ見た目になっていた。
 *  - 'ai'            : AI 自身が direction:"none" を返した(良い場面が無い)
 *  - 'geometry'      : ★**エントリーが refPrice の反対側**(売りなのに指値が現在値の下 等)で両レッグ落ち。
 *                      ★v0.9.95 でこの意味に **限定** した(下の 'lcWidthInvalid' を参照)。
 *  - 'lcWidthInvalid': ★**AI が幅の欄に書いた値が使えない**(負・0・非有限・建値と同じ点になる)で落ちた。
 *                      ★v0.9.95 で 'geometry' から分離。分離前は両者が同じコードに束ねられており、
 *                        画面の文言も「エントリーが現在値の逆側、**または**損切り幅の値が不正」と
 *                        2つを『または』で並べるしかなかった(=台帳から どちらか を特定できない)。
 *
 *  ★★ 旧記録(分離前の 'geometry')は **遡って分けられる**(実測で確認済み・2026-08-21) ★★
 *    判別は推定ではなく **構造** で決まる:
 *      ・幅が使えず落ちた脚 … 損切り価格を導けていないので LegDrop に `stopLoss` が **無い**
 *      ・逆側で落ちた脚     … 脚は組めているので `entry` と `stopLoss` が **両方ある**
 *    ⇒ 旧 'geometry' のうち `stopLoss` を持つものが「逆側」、持たないものが「幅の値が不正」。
 *    ★実測(手元の全複製・内容が同一の leg_drops_json は1回だけ数えた): **geometry の脚 589件 →
 *      逆側 589件(100%) / 幅の値が不正 0件 / 判定不能 0件**。`lcWidth` を持つ geometry も 0件。
 *    ⇒ ★**過去の geometry の集計に「幅が不正だった回」は混ざっていない**。分離前の分析はそのまま使える。
 *    (ただし これは手元の複製の範囲での実測。別PC/別期間の台帳を足すときは同じ判別式で数え直すこと。)
 *  - 'stopSide'      : 損切りがエントリーの内側/反対側で両レッグ落ち
 *  - 'lc'            : 初期LC幅が上限超で両レッグ落ち
 *  - 'lcFloor'       : ★初期LC幅が下限未満で両レッグ落ち(下限は委任対象外=常に強制)
 *  - 'bias'          : バイアス veto(long なのに sell / short なのに buy)
 *  - 'trend'         : トレンド veto(強上昇に逆行する sell / 強下降に逆行する buy)
 *  - 'rangeDisabled' : レンジ無効設定なのに range が返った(防御多重化)
 *  - 'missing'       : AI がレッグを出さなかった / 壊れた形だった
 *  - 'stale'         : ★ARM 時点の live 価格では既にエントリーを通過していて全レッグ落ち(engine の
 *                      stale plan veto=checkStaleLegs。plan 段では起きない=engine のログ専用の値)
 *  - 'aFailed'       : ★v0.9.97 **目線を決める呼び出し自体の故障**。応答が得られない/3語(buy/sell/range)の
 *                      どれでもない値が返った。★相場のせいではないので 'ai' と混ぜない。
 *  - 'aiSilent'      : ★v0.9.97 **AI が価格も理由も返さなかった**(無言の見送り)。★'ai' は「置けないと
 *                      **文で** 言った」を指す。無言をそこに混ぜると **故障が「相場が悪かった」に化ける**。 */
export type NoneReason = 'ai' | 'geometry' | 'lcWidthInvalid' | 'stopSide' | 'lc' | 'lcFloor' | 'bias' | 'trend' | 'rangeDisabled' | 'missing' | 'stale' | 'aFailed' | 'aiSilent';

/** 見送り(none)時に「AI が出したが最終プランに残らなかった」レッグの生数値(記録専用)。
 *  ログ1行に出すことで、根拠文(rationale)から価格を推定する必要を無くす。 */
export interface NoneLeg {
  name: 'limit' | 'stop' | 'upper' | 'lower';
  entry: number;
  stopLoss?: number;
  ok: boolean;    // そのレッグ自体は検証を通っていたか(bias/trend の全体 veto では true になりうる)
}
/** none 化される前に AI が出した direction と、そのレッグ群(記録専用)。 */
export interface NoneLegs { dir: 'buy' | 'sell' | 'range'; legs: NoneLeg[]; }

/** ★v0.9.57(記録専用): **レッグ1本ごと** の脱落。noneLegs が「両レッグ落ちて none になった回」しか
 *  残さないため、**片レッグだけ落ちた回**(=最終プランは成立しているが逆指値だけ消えた 等)は
 *  理由が構造的に残らず、根拠文の日本語(「（逆指値レッグは条件を満たさず不採用）」)しか手掛かりが無かった。
 *  その結果、台帳では「AI が逆指値を出さなかった(missing)」と「向き違反で落とした(geometry/stopSide)」が
 *  どちらも stopEntry:null に潰れて区別できず、実際に誤った測定(見送り行だけを grep して分母が偏る)が起きた。
 *
 *  ★意味づけ: 「そのステージが受け取っていたレッグを、どの検証で落としたか」。
 *    - parse 段: AI が出さなかったレッグも 'missing' として1件残す(=「提案しなかった」を明示的に記録する)。
 *    - enforce 段: **受け取った時点で在ったレッグだけ** を対象にする(parse で既に落ちた/不在のレッグは
 *      ここでは何も落としていないので記録しない=同じ事実を二重に数えない)。
 *  ★理由の語彙は既存の NoneReason をそのまま使う(新しい語彙を作らない)。実際に現れるのは
 *    'missing' / 'lcWidthInvalid' / 'stopSide' / 'geometry'(parse 段)と 'stopSide' / 'lc' / 'lcFloor' / 'trend' / 'bias'(enforce 段)。
 *  ★記録専用: 採否・価格・veto・SSE・決済には一切影響しない。 */
export interface LegDrop {
  /** どのレッグか(NoneLeg と同じ語彙)。 */
  name: NoneLeg['name'];
  /** どの検証で落ちたか(NoneReason の語彙をそのまま再利用)。 */
  reason: NoneReason;
  /** AI が出していたエントリー価格。reason='missing'(そもそも出していない)では undefined。 */
  entry?: number;
  /** AI が出していた損切り価格。無ければ undefined。 */
  stopLoss?: number;
  /** ★v0.9.70: AI が **幅の欄に書いた生の値**(新契約)。使えない幅(負・0・非有限に相当)で落としたときだけ載る。
   *  ★これが無いと「根拠文には −55 と書いてあるのに台帳には何も残らない」= 件数すら数えられなかった。
   *  既存の読み手は知らないキーを無視するだけ(leg_drops_json の形は互換)。 */
  lcWidth?: number;
}

// vetoFired(v0.7.54): buildScalpPlan が enforcePlanConstraints のトレンド veto が発火したかを surface する
//   (挙動は不変=記録のみ)。regime/confidence は plan 側に載る。engine が meta へ保存し A/B 計測に使う。
// noneReason/noneLegs(v0.9.44): 見送り(none)の経路と落としたレッグの生数値(記録のみ=engine のログ用)。
// rangeAnomaly(v0.9.44): レンジが規約(2択・組を混ぜない)に反する形で届いたか。★必ず **AI の生出力(parse 直後)**
//   に対して判定した結果を載せる(enforce 後だと veto/bias で片脚が落ちて観測できなくなる)。記録のみ。
// chartShot(v0.9.51): ★①と②が **同じ画像を見たか** を仮定でなく記録にするための識別子と齢。
//   scalpPlanRunner が caller!=='default' のときだけ載せる(既存の呼び出し元のオブジェクトは byte 不変)。
//   記録専用で、判定にも決済にも一切影響しない。型は撮影側(chart/chartShot.ts)が SSOT。
// contextOmitted: ★プロンプトから **外した** 文脈ブロックの名前(記録専用)。
//   scalpPlanRunner が caller!=='default'(分析用)のときだけ載せる=既存の呼び出し元は byte 不変。
//   分析用では両腕とも仮想取引の成績の履歴を外している(母集団の独立性。理由は scalpPlanRunner.ts の
//   GENERATOR_OMITTED_CONTEXT)。この情報が無い記録は「外していない版で取った標本」を意味する。
// legDrops(v0.9.57): ★**片レッグだけ** 落ちた回も含む、レッグ1本ごとの脱落理由(記録のみ)。
//   noneLegs(両レッグ落ち=none のときだけ)とは別のフィールドで、意味も形も互いに変えない。
// contextAt / promptFp(RECORD-ONLY): ★「いつの断面から文脈を組み立てたか」と「組み立てたプロンプトの指紋」。
//   scalpPlanRunner が **全経路(A/B 含む)** で載せる。台帳(signal_plans)に落として、凍結した入力からの
//   再生が「その時刻に実際に渡ったもの」と同じかを突き合わせられるようにするための2点(記録専用)。
//   contextAt … buildRichScalpContextResult に渡した now(epoch ms)。台帳の t(記録時刻)とは別物。
//   promptFp  … system+user プロンプトの一方向指紋(server/llm/promptFingerprint.ts。**本文は持たない**)。
//   どちらも採否・価格・SSE・決済には一切影響しない。ok:false(計画が得られなかった回)にも載りうる
//   = 「文脈は組んだが LLM で落ちた」と「文脈を組む前に見送った」を後から区別できる。
// lcAudit(RECORD-ONLY): ★根拠文で AI が **申告した LC幅** と、AI が実際に出力した |entry − stopLoss| の突き合わせ。
//   実測(2026-08-07)で「根拠文には正しい幅(例55円)を書きながら損切りには建値の隣(±5円)を入れる」故障が
//   落ちたレッグに集中して残っていた(採用レッグでは殆ど起きない)。JSON だけ・根拠文だけを見ても検出できない。
//   ★ここは **測るだけ**。採否・価格・noneReason・legDrops は1バイトも変えない(食い違いで落としも直しもしない)。
//   ★対象は **AI の生出力**(parse 段で見えるレッグ全部=後段で落ちるレッグも含む)。落ちたレッグにしか
//     故障が残らないので、採用レッグだけを見ると存在しないことになってしまう。
// omissionAudit(RECORD-ONLY・v0.9.66): ★根拠文で「そのレッグは出さない(省略/見送り)」と **述べた** レッグと、
//   **実際に発注されるレッグ**(最終プランに残ったレッグ)の突き合わせ。
//   AI が「ブレイク新規は下限に届かないので省略した」と書きながら、下限を満たす有効な価格対を出すことがある。
//   その場合コードは何も落とさない(落ちるのは lcFloor/stopSide に掛かったときだけ)ので、そのレッグは
//   そのまま発注される = **AI の意図と実際の注文が食い違ったまま素通り** する。
//   ★lcAudit と違い、対象は **最終プラン**(生出力ではない)。知りたいのは「出さないと言ったのに出た」であって、
//     コードが落としてくれた回は意図と注文が一致しているため。
//   ★ここも **測るだけ**。採否・価格・noneReason・legDrops は1バイトも変えない。
// ★v0.9.70(RECORD-ONLY・lcAudit の行に相乗り): 損切りの **幅をどこから得たか**(widthSource)と、
//   旧形式(価格)から復元したときに **符号を訂正したか**(signCorrected)。列は増やさない(lc_audit_json の中身の拡張)。
//   これが無いと「モデルが先祖返りして旧フィールドを出し、コードが黙って救済し続けている」状態が
//   台帳から読めない(=無言の失敗になる)。数え方は `lc_audit_json LIKE '%legacy-price%'`。
// imageSent(RECORD-ONLY・v0.9.70): ★その計画で **実際にチャート画像を送ったか**。
//   「送るつもりだったか」ではない: ビジョン非対応プロバイダへフォールバックした回は false になる。
//   A/B(画像の効き目)の群を台帳に残すための唯一の真実で、判定・価格・決済には一切影響しない。
// chartVision(RECORD-ONLY・v0.9.70): そのサイクルの **チャート画像の群**(設定モード / 撮ろうとしたか / 実際に送ったか)。
//   runner が載せる(buildScalpPlan 直呼びでは付かない)。台帳では settings_json にマージされる=列は増えない。
export interface ChartVisionRecord {
  /** その時の設定。'off'=送らない(既定) / 'ab'=半分だけ送る。 */
  mode: 'off' | 'ab';
  /** その回に画像を撮って送ろうとしたか(A/B のコイン投げの結果)。 */
  requested: boolean;
  /** ★実際に送ったか。**A/B の群として使ってよいのはこちらだけ**。 */
  sent: boolean;
}

// provider(RECORD-ONLY・v0.9.70): ★**その計画の答えを返した** LLM プロバイダとチャットモデル。
//   これが無いと、チャート画像の A/B は「画像 × モデル」の交絡を含んだまま後から層別できない
//   (画像を送る回は必ずビジョン対応=gemini/openai へ行き、送らない回は groq/kimi でも通るため)。
//   ★答えが得られなかった回(プロバイダ不在・全滅・再要求してもパースできず)は **載せない**=台帳は NULL。
//   「送ろうとした先」は記録しない(曖昧さを残さない)。
export interface AnsweringProvider { name: string; model: string }

// trendDir(RECORD-ONLY + 表示・v0.9.88): その計画を出したときに **コードが測った** トレンドの向き
//   (server/signalTrade/regime.ts の Regime.trendDir をそのまま)。runner が足す。
//   ★AI の自己申告(AiPlan.regime)とは別物。画面の「順張り/逆張り」はこちらを使う
//   (AI に見せた勢いの行と同じ値=画面とプロンプトで食い違わない)。
//   ★採否・価格・脚落ち・決済には一切使わない(veto は従来どおり Regime.dir/strong が駆動する)。
// appVersion / promptBuild(RECORD-ONLY・v0.9.93): ★「この行を書いたのはどの版・どの文面か」。
//   appVersion  … 実行中のアプリの版(server/appVersion.ts)。
//   promptBuild … その質問文の変種の **プロンプトの型** の指紋(`pb1:<16桁hex>`・server/llm/promptBuild.ts)。
//   ★どちらも scalpPlanRunner が載せる(この層で載せると promptBuild.ts ⇄ scalpPlan.ts が循環参照になる)。
//   ★prompt_fp(sp1)とは別物: sp1 は毎回変わる全文の指紋で、版の層別キーには使えない。
// splitRecord(RECORD-ONLY・段5): ★A/B 分割の測定材料(server/llm/scalpPlanSplit.ts の SplitRecord)。
//   ★scalpPlanRunner が(A/B 分割が実際に走った回だけ)載せる。分割が無効/A が一度も呼ばれなかった
//   旧経路の回は undefined のまま=signal_plans の新列は NULL(段5 の後方互換の要)。
// contextPresence(RECORD-ONLY・段5続き): ★文脈のどのブロック(ATR/節目/本日高安/BB/スイング/
//   長い時間軸/日足バンド/基礎データ全体/アラート/ニュース)が実際に入ったかの記録(server/llm/contextPresence.ts)。
//   ★scalpPlanRunner が **分割の有無に関係なく無条件で** 載せる(旧経路でも記録される)。
//   ★この関数を持たない旧版(このリリース前)で記録された行だけが undefined=signal_plans は NULL。
// splitBypassReason(RECORD-ONLY・段6続き): ★分割ON設定なのに、この回だけ旧経路へ落とした理由。
//   'heldPosition'/'armedContext'/'promptVariant' のいずれか(複数ならカンマ区切り)。resolveSplitBypassReasons
//   が検出した回だけ載る。★分割OFFの回・分割ONで実際に分割経路を通った回は undefined=NULL
//   (「使わなかった」と「使った」を同じ NULL に潰さない)。
export type ScalpPlanResult =
  | { ok: true; plan: AiPlan; appVersion?: string; promptBuild?: string; imageSent?: boolean; provider?: AnsweringProvider; chartVision?: ChartVisionRecord; vetoFired?: boolean; noneReason?: NoneReason; noneLegs?: NoneLegs; legDrops?: readonly LegDrop[]; lcAudit?: readonly LcAuditRow[]; omissionAudit?: readonly OmissionClaimCheck[]; rangeAnomaly?: RangeAnomaly; chartShot?: ChartShotIdentity; contextOmitted?: readonly string[]; contextAt?: number; promptFp?: string; trendDir?: EntryTrendDir; splitRecord?: SplitRecord; contextPresence?: ContextPresence; splitBypassReason?: string }
  | { ok: false; error: string; appVersion?: string; promptBuild?: string; imageSent?: boolean; provider?: AnsweringProvider; chartVision?: ChartVisionRecord; contextAt?: number; promptFp?: string; splitRecord?: SplitRecord; contextPresence?: ContextPresence; splitBypassReason?: string };

// 見送り理由の優先順位(記録専用)。2レッグで理由が異なるとき、より上流(先に適用される)ステージを採る。
// トレンド/バイアスは plan 全体の veto、LC は制約、geometry/stopSide は AI 応答の幾何、missing は不提示。
// 'stale' は plan 段では発生しない(engine の ARM 直前ガード=最下流)ため末尾に置く。
// ★v0.9.97: 'aFailed'(目線側の故障)は **最上流**。目線が出ていないので下流の理由はどれも成立しない。
//   'aiSilent'(無言の見送り)は 'ai' の直後=「AI が言ったこと」の並びに置くが、★別の語なので潰れない。
const NONE_REASON_PRIORITY: NoneReason[] =
  ['aFailed', 'trend', 'bias', 'lc', 'lcFloor', 'geometry', 'lcWidthInvalid', 'stopSide', 'missing', 'rangeDisabled', 'ai', 'aiSilent', 'stale'];

/** 2レッグ分の脱落理由から、ログに載せる代表理由を1つ選ぶ純関数(記録専用)。両方 null なら undefined。 */
export function pickNoneReason(a: NoneReason | null, b: NoneReason | null): NoneReason | undefined {
  const cand = [a, b].filter((x): x is NoneReason => x != null);
  if (cand.length === 0) return undefined;
  return cand.sort((x, y) => NONE_REASON_PRIORITY.indexOf(x) - NONE_REASON_PRIORITY.indexOf(y))[0];
}

/** レンジ2脚の生数値を診断用 NoneLegs にする(記録専用)。AI が出さなかった脚は含めない。 */
function noneLegsFromRange(
  upper0: RangeLeg | null | undefined, lower0: RangeLeg | null | undefined, ok = false,
): NoneLegs | undefined {
  const legs: NoneLeg[] = [];
  if (upper0) legs.push({ name: 'upper', entry: upper0.entry, stopLoss: upper0.stopLoss, ok });
  if (lower0) legs.push({ name: 'lower', entry: lower0.entry, stopLoss: lower0.stopLoss, ok });
  return legs.length ? { dir: 'range', legs } : undefined;
}

/** directional(buy/sell)2脚の生数値を診断用 NoneLegs にする(記録専用)。価格が無い脚は含めない。 */
function noneLegsFromDirectional(
  dir: 'buy' | 'sell',
  v: { limitEntry?: number | null; stopLossForLimit?: number | null; stopEntry?: number | null; stopLossForStop?: number | null },
  limitOk: boolean, stopOk: boolean,
): NoneLegs | undefined {
  const legs: NoneLeg[] = [];
  if (v.limitEntry != null) legs.push({ name: 'limit', entry: v.limitEntry, stopLoss: v.stopLossForLimit ?? undefined, ok: limitOk });
  if (v.stopEntry != null) legs.push({ name: 'stop', entry: v.stopEntry, stopLoss: v.stopLossForStop ?? undefined, ok: stopOk });
  return legs.length ? { dir, legs } : undefined;
}

/** レッグ1本ぶんの脱落を記録用の配列へ足す純関数(記録専用)。reason が null(落ちていない)なら何もしない。
 *  価格は分かる時だけ載せる(missing では entry/stopLoss を持たない=「出していない」ことが形からも読める)。 */
function pushLegDrop(
  out: LegDrop[], name: LegDrop['name'], reason: NoneReason | null,
  entry?: number | null, stopLoss?: number | null,
  /** ★v0.9.70: 使えない幅で落としたときに、AI が幅の欄に書いた生の値を残す(数えられるように)。 */
  lcWidth?: number | null,
): void {
  if (reason === null) return;
  const d: LegDrop = { name, reason };
  if (entry != null && Number.isFinite(entry)) d.entry = entry;
  if (stopLoss != null && Number.isFinite(stopLoss)) d.stopLoss = stopLoss;
  if (lcWidth != null && Number.isFinite(lcWidth)) d.lcWidth = lcWidth;
  out.push(d);
}

// ─── ★v0.9.70: 損切りは「幅」だけを LLM から受け取る(符号はコードが決める) ────────────────
//
// ★実データ(2026-08-04〜10 の台帳スナップショット・signal_plans.leg_drops_json)で確定した事実:
//   「損切りがエントリーの逆側(stopSide)」で落ちたレッグ **171件が171件ともブレイク新規(stop)レッグ** で、
//   指値レッグは0件。同じ計画の中で指値レッグは正しい向きだった。AI は算術を間違えておらず、幅も正しい。
//   **符号だけが逆**。原因は「外側」という語が同じプロンプト内で逆向きの2つの意味を持つこと
//   (ブレイク新規の「節目の外側」=抜ける方向 / 損切りの「外側」=建玉を守る向き)。
//   散文で規則を強めるのは6版効かなかった(名指しした側だけ直り、名指ししない側へ移った)。
//
// ★対策の型: 規則の遵守を求めるのをやめ、**逆位置を表現不能にする**。
//   LLM が出すのは正の数の幅だけ(lcWidthForLimit / lcWidthForStop / range の lcWidth)。
//   損切り価格は stopLossFromWidth が direction/side から一意に導く=逆側の価格を書く場所が存在しない。
//   ★parse から後ろ(AiPlan・signal_plans の列・SSE・仮想取引エンジン・トレード側)は今までどおり **価格** を扱う。
//
// ★効き目の実測(同じスナップショット・各回の settings_json の実効下限/上限で評価):
//   逆位置171レッグを新実装に通すと **採用49 / 下限(lcFloor)で落ちる112 / 上限で落ちる2 / 幾何・幅0で落ちる8**。
//   逆位置レッグの幅は **50%(86件)が5円**(中央値5〜10円)= 建値の隣で、そもそも損切りとして妥当ではない。
//   救われるのは主に幅45〜55の回で、**見送り(none)が取引に変わる計画は3件だけ**。
//   ⇒ この変更の値打ちは「取引機会が増えること」ではなく、**不正な向きの注文が構造的に作れなくなること**。
//      機会の増分を過大に見積もらないこと(初版の報告で「171件中163件が採用される」と書いたのは誤り)。

/** 損切りの幅の出所(記録専用の語彙)。
 *  'lcWidth'      = 新契約のフィールドをそのまま使った。
 *  'legacy-price' = 新契約が無く、旧フィールド(損切り **価格**)から |エントリー − 価格| で幅を復元した。 */
export type LcWidthSource = 'lcWidth' | 'legacy-price';

/** 幅の解決結果(純関数の戻り値)。widthYen===null のレッグは落とす(既存の片レッグ落としと同じ経路)。 */
export interface LcWidthResolution {
  /** 正の幅[円]。得られなければ null。 */
  widthYen: number | null;
  /** どこから得たか。widthYen===null のときは未設定。 */
  source?: LcWidthSource;
  /** legacy-price のとき、AI が出した価格が **エントリーの逆側(または同値)** だったか
   *  = コードが符号を付け直して救済した回。★黙って直さないための記録(台帳で数えられる)。 */
  signCorrected?: boolean;
  /** ★v0.9.70: AI が **その欄に実際に書いた値**。widthYen===null(落とす)ときに台帳へ残すために持つ。
   *  これが無いと「AI は −55 と書いたのに、台帳には何も残らない」= 件数すら数えられない。 */
  rawWidth?: number;
  /** 同上。旧形式で来た場合に AI が書いた損切り **価格**(落とすときの記録用)。 */
  rawStopLoss?: number;
}

/** ★RECORD-ONLY: lcAudit の1行(rationale 突き合わせ)に、幅の出所と符号訂正の有無を相乗りさせた形。
 *  台帳の列は増やさない(lc_audit_json の中身だけが1〜2キー増える)。 */
export interface LcAuditRow extends LcDeclarationCheck {
  /** 幅をどこから得たか(新契約 / 旧形式フォールバック)。 */
  widthSource?: LcWidthSource;
  /** 旧形式フォールバックで **符号を訂正した** 回だけ true(正しい向きの旧形式では未設定)。 */
  signCorrected?: boolean;
}

/** LLM 出力から損切りの **幅(正の数)** を決める純関数(SSOT)。
 *  - 新契約(width)が **在れば** それだけを見る。非有限/0以下は無効=そのレッグは落とす(黙って旧形式に逃げない)。
 *  - 新契約が **無い** ときだけ旧形式(価格)へフォールバックし、|エントリー − 価格| を幅として採る。
 *    ★大きさだけを使い、向きはコードが付ける=モデルが先祖返りしても逆位置は発生しない。
 *  ★v0.9.70(桁落ちの穴を塞ぐ): 幅が正でも `entry ∓ 幅 === entry` になる組み合わせは実在する
 *    (幅 1e-12 / エントリー 1e20 など。double の丸めで損切り価格がエントリーと同じ数になる)。
 *    そのまま通すと **stopSide が発火する** = 「構造上ありえない」はずの記録が台帳に出て、
 *    読んだ人が存在しない符号バグを追う。よって導出した価格がエントリーと一致する幅は **無効** とし、
 *    他の使えない幅と同じ経路で落とす(=stopSide は本当に発火しなくなる)。 */
export function resolveLcWidth(args: {
  side: 'buy' | 'sell';
  entry: number | null;
  /** 新契約フィールド(lcWidthForLimit / lcWidthForStop / lcWidth)の生値。 */
  width: unknown;
  /** 旧契約フィールド(stopLossForLimit / stopLossForStop / stopLoss)の生値=損切り **価格**。 */
  legacyStopLoss: unknown;
}): LcWidthResolution {
  const { side, entry, width, legacyStopLoss } = args;
  /** 幅として使えるか(エントリーが分かるときは、導出した損切り価格が建値と別の数になることまで見る)。 */
  const usable = (w: number): boolean =>
    Number.isFinite(w) && w > 0 &&
    (entry === null || !Number.isFinite(entry) || stopLossFromWidth(side, entry, w) !== entry);
  if (typeof width === 'number') {
    if (usable(width)) return { widthYen: width, source: 'lcWidth' };
    const out: LcWidthResolution = { widthYen: null };
    if (Number.isFinite(width)) out.rawWidth = width;
    return out;
  }
  if (typeof legacyStopLoss !== 'number' || !Number.isFinite(legacyStopLoss)) return { widthYen: null };
  if (entry === null || !Number.isFinite(entry)) return { widthYen: null, rawStopLoss: legacyStopLoss };
  const w = Math.abs(entry - legacyStopLoss);
  if (!usable(w)) return { widthYen: null, rawStopLoss: legacyStopLoss };
  return { widthYen: w, source: 'legacy-price', signCorrected: !stopSideOk(side, entry, legacyStopLoss) };
}

/** 幅(正の数)から損切り **価格** を導く唯一の場所。符号はここでしか決まらない(純関数)。
 *  買い: エントリー − 幅(下) / 売り: エントリー + 幅(上)。
 *  ★実体は core/stopGeometry.ts(損切りの向きの規約の唯一の権威)。ここは従来の import 面を保つ再輸出。 */
export { stopLossFromWidth };

/** LLM 出力に「そのレッグの損切り指定が **在ったか**」(新旧どちらの形でも)。
 *  ★数値であることだけを見る(旧実装の `num()` と同じ受理範囲=対の不整合の判定を変えない)。
 *  値が妥当かどうかは resolveLcWidth の責務(不正なら対の不整合ではなく「そのレッグを落とす」)。 */
function hasLcField(width: unknown, legacyStopLoss: unknown): boolean {
  return typeof width === 'number' || typeof legacyStopLoss === 'number';
}

/** ★RECORD-ONLY: 根拠文の申告 LC幅と実出力の突き合わせを **例外を外へ出さずに** 作る。
 *  記録の失敗で計画(取引の判断)を止めない。握りつぶすが、握りつぶした事実は必ず1行ログに残す。
 *  1件も突き合わせられなければ undefined(空配列は載せない=「観測できた」と「0件」を混ぜない)。
 *  ★v0.9.70: 各レッグの「幅の出所」と「符号を訂正したか」を同じ行に載せる(列は増やさない)。 */
/** ★v0.9.83: 各レッグの `side` も渡す。渡さないと rationaleLc は根拠文の損切りの **向き** を判定できず
 *  'sideUnknownDirection' としか記録できない(推測で埋めない規律)。directional は plan の direction、
 *  range は脚ごとの side(上部=売り/下部=買い)。 */
function lcAuditFor(
  rationale: string,
  legs: ReadonlyArray<{ leg: LcLegName; entry?: number | null; stopLoss?: number | null; side?: 'buy' | 'sell' | null; widthSource?: LcWidthSource; signCorrected?: boolean }>,
): readonly LcAuditRow[] | undefined {
  try {
    const rows: LcAuditRow[] = auditLcDeclarations(rationale, legs);
    for (const row of rows) {
      const src = legs.find(l => l.leg === row.leg);
      if (src?.widthSource) row.widthSource = src.widthSource;
      if (src?.signCorrected) row.signCorrected = true;
    }
    return rows.length ? rows : undefined;
  } catch (e) {
    console.warn('[scalp-plan] LC申告の突き合わせに失敗(記録のみ・計画は続行):', e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

/** ★RECORD-ONLY: 「そのレッグは出さない」という表明と、実際に発注されるレッグの突き合わせを
 *  **例外を外へ出さずに** 作る。lcAuditFor と同じ作法(記録の失敗で計画を止めない・握りつぶした事実は残す)。
 *  表明が1件も読めなければ undefined(空配列は載せない=「観測できた」と「0件」を混ぜない)。 */
function omissionAuditFor(
  rationale: string,
  present: { limit: boolean; stop: boolean },
): readonly OmissionClaimCheck[] | undefined {
  try {
    const rows = auditOmissionClaims(rationale, present);
    return rows.length ? rows : undefined;
  } catch (e) {
    console.warn('[scalp-plan] 「出さない」表明の突き合わせに失敗(記録のみ・計画は続行):', e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

// 初期 LC(損切り)幅の既定レンジ。呼び出し側が /api/scalp-plan で lcFloorYen/lcCeilingYen を
// 指定しない時のフォールバック(旧記述の「trade2」は誤り。呼び出し元は上の注記を参照)。★v0.7.39: 旧「原則45〜75/上限95」の二段を撤去し、
// 単一上限「下限〜65 に収める・65 超は出さない」へ collapse。パラメータで上下限を可変にする。
// ★下限の既定は configStore の PARAM_BOUNDS.scalpLcFloorYen.default と同値に揃える(現行 55)。
//   実経路(buildScalpPlan)は必ず設定値を渡すので、この定数は引数省略時のフォールバックのみ。
export const DEFAULT_LC_FLOOR_YEN = 55;
export const DEFAULT_LC_CEILING_YEN = 65;

// ─── ★v0.9.56: LC 上限の「提示」を実効値に揃える(保存値のアンカー化を止める) ─────────────
//
// ★実測(同じ相場・同じ節目データで提示だけを変えた 6+3 サンプル):
//   「下限55 / 上限65【AI委任】/ 安全上限159」と提示 → 出力 LC 幅 60,60,60,60,60,58(6レッグ全部 58〜60)。
//     AI の説明は「本来幅55円+緩衝5円=60円」「55〜65円の許容帯の中央付近」= **委任しても 65 を実質の上限として読む**。
//   「55〜159 の範囲」と提示   → 出力 LC 幅 65,75,110,125,80,70,90,100(65〜125・中央値85)。
//     説明も「63250 の強いレジスタンスの上に余裕を持たせた結果として65円」= **節目起点でレッグごとに変わる**。
//   原因: 保存値(65)がプロンプト内で 8 箇所も反復される一方、「あなたが決めてよい」は委任ノートの1文だけだった。
//   帰結: プロンプト自身が指示する「隣接の節目が弱ければ一段先の強い節目まで引きつける」が、幅が 60 に固着して実行不能だった。
//
// ★方針: 上限が AI委任のときは **保存値を一切印字しない**。代わりにコードが実際に強制する上限
//   (lcEffectiveCeiling = 安全上限が有効ならその値 / 無効なら背骨 LC_YEN_MAX)を「下限〜上限の範囲」として提示する。
//   手動のときは従来どおり保存値をそのまま印字する(byte 一致)。
/** LC 上限の提示モード。delegated=false(既定)は従来と byte 一致。 */
export interface LcCeilingPresentation {
  /** 上限が AI委任か。true=「下限〜上限の範囲で相場構造に応じて決める」形で提示する。 */
  delegated: boolean;
  /** 委任時に提示する上限の呼び名。安全上限 有効='安全上限' / 無効='コード上限'(背骨 LC_YEN_MAX)。 */
  capLabel: string;
}
/** 手動(既定)。この値で呼ぶ限り全てのプロンプト生成は従来と byte 一致する。 */
export const LC_CEIL_MANUAL: LcCeilingPresentation = { delegated: false, capLabel: '安全上限' };

/** 設定(上限の値・委任モード・LC安全上限)から「プロンプトに印字してよい上限」を決める(純関数・SSOT)。
 *  - 手動: 保存値をそのまま返す(=従来と完全一致。実効上限との差は enforce 側が担保する)。
 *  - 委任: 保存値は返さず、実際に強制される上限(安全上限 有効=その値 / 無効=LC_YEN_MAX)を返す。 */
export function resolveLcPresentation(opts: {
  floorYen: number; ceilingYen: number; ceilingMode?: KnobSource; lcHardMax?: LcHardMax;
}): { floorYen: number; ceilingYen: number; ceil: LcCeilingPresentation } {
  if (opts.ceilingMode !== 'ai') return { floorYen: opts.floorYen, ceilingYen: opts.ceilingYen, ceil: LC_CEIL_MANUAL };
  return {
    floorYen: opts.floorYen,
    ceilingYen: lcEffectiveCeiling({ ceilingYen: opts.ceilingYen, ceilingMode: 'ai', lcHardMax: opts.lcHardMax }),
    ceil: { delegated: true, capLabel: opts.lcHardMax?.enabled ? '安全上限' : 'コード上限' },
  };
}



// ★★★ v0.9.94(削除の記録): LC_DERIVATION_ORDER(導出の順序)と LC_BUFFER_NOTE(損切りの緩衝)を
//   **定数ごと削除** した。印字箇所は question / system / strategySpec の各3箇所(計6印字)。
//
//   ■ ユーザーの設計「LC幅をAIにも求め、LC価格はこちらでつけてください」「LCの自己検証は不要」
//     を最後まで通すと、**「どの節目からどう損切り価格を導くか」の手順は AI に要らない**。
//   ■ ★実害(この版の主目的): 導出の順序は1ブロックに「買いは下・売りは上」を **3回** 持ち、
//     しかも損切り(stop loss)の話。stopEntry(ブレイク新規)と 損切り はどちらも「stop」なので、
//     このループをなぞらせると stopEntry に漏れる。実測 `sell/stop/上` 22件がその形。
//     同じ二義は v0.9.70 でも起きている(逆位置171件が171件ともブレイク新規レッグ)。
//   ■ ★「売りは上」はプロンプト全体で 12回 あり、**12回すべてが損切りの話**だった
//     (導出の順序6・緩衝3・SL_SIDE_RULE 3)。この削除と SL_SIDE_RULE の建値基準の除去で **0回** になる。
//   ■ ★宣言だけ残さない: 印字しなくなった定数は残さず消す(参照先の無い記述が実害を出した前例がある)。
//   ■ ★失われた規則(正直に): 「LC幅は結果であって出発点ではない/先に幅を決めて節目に当てはめるのは誤り」
//     という **固着対策の1文** はここに在り、一緒に消えた。同じ圧力は PLAN_BAD_EXAMPLES の
//     ✗③(幅が毎回ほぼ同じ・下限ちょうど)と ✗④(両レッグが同じ幅)が持ち続ける。
//     ★固着が悪化しうる(実測: 60円が84%→52%、下限55が14%→41%へ移動中)。要観測。

/** ★v0.9.60: 損切りの向きを **エントリーの向きと同格**(不等式・単独ブロック)にする SSOT。
 *  ★根拠(実測 2026-08-04・11時間/138計画): AI が出したレッグの 67件 が「損切りがエントリーの逆側」で落ちており、
 *    その LC幅の中央値は 5円 だった(=建値の隣のティック)。一方エントリーの向きは不等式で単独に置かれていて
 *    ほぼ守られていた。つまり「指示が無い」のではなく「指示の格が違う」。散文の1文を不等式に格上げする。
 *  ★「外側」という語が同じプロンプト内で2つの逆向きの意味に使われていた(ブレイク新規=節目の外側は"抜ける方向"、
 *    損切り=エントリーの外側は"建玉を守る向き")。★v0.9.62 でこの解説行はここから外したが、同じ区別は
 *    【節目への置き方】(question / strategySpec の同一文)に残っている=規則は1つも失われていない。
 *  ★v0.9.62(実測 2026-08-06): 不等式へ格上げした後も stopSide 落ち10件が残り、**その10件全部が売り** で、
 *    **全部がブレイク新規レッグ**(売りの指値レッグは正しく足していた)。根拠文も「ブレイク新規は65660円に設定し、
 *    LC幅は55円で65605円となります」= 幅は正しく、符号だけ逆。つまり不等式は「確認するもの」であって
 *    「計算するもの」ではなく、幅を出した後の符号選択の段では働かない。よって不等式を **符号込みの式** に
 *    置き換え(足すのではなく置換=増分ゼロ)、AI が実際に間違えている一点(「ブレイク新規が下でも損切りは上」)を
 *    名指しで書く。旧「外側」の抽象的な語の解説行は、この具体的な1行が同じことをより強く言うので落とす。 */
/** ★v0.9.70: 符号の式を **撤去** し、「損切りの価格は出力しない=幅だけを出す」という契約の説明に置き換える。
 *  ★根拠: 式(v0.9.62)も不等式(v0.9.60)も散文(それ以前)も効かなかった。実データでは 逆位置171件が171件とも
 *   ブレイク新規レッグに集中し、指値レッグは0件=同じ一文の中で片方だけ符号を誤る。つまり規則の理解の問題ではない。
 *  ★よって規則を強めるのをやめ、**逆位置を表現不能にする**。符号は parse(stopLossFromWidth)が direction から
 *   一意に決めるので、AI が逆側の価格を書く場所そのものが存在しない。
 *  ★ここに符号の式を残さない理由: 残すと「幅だけ出す」契約と矛盾し、AI が JSON に符号付きの値を入れる誘因になる。 */
export const SL_SIDE_RULE =
  '★【最優先: 損切りは「幅」だけを出す(価格は出力しない)】損切りの価格フィールドは存在しない。出すのは lcWidthForLimit / lcWidthForStop(range は各レッグ lcWidth)= **正の数の幅[円]** だけ。\n'
  + '  向きはシステムが direction から決めて損切り価格を計算する。あなたが向きを選ぶ余地は無く、選ぶ必要も無い。\n'
  + '  ★符号付き(マイナス)の値・0・エントリーからの引き算の答え(=価格)を幅の欄に書かないこと。幅は必ず正の数で、そのレッグが取りうる損失の大きさそのもの。\n'
  + '  range も同じ(各レッグ lcWidth は正の数。向きはそのレッグの side からシステムが決める)。';

/** ★v0.9.61: 初期LC幅の **下限** を、価格の向き/損切りの向きと同じ格(最優先・不等式・単独ブロック)へ格上げする SSOT。
 *  ★根拠(実測 2026-08-05): 自己検算に「③損切りの幅」を入れた **後でも** lcFloor 落ちが 61件(指値19/逆指値42)。
 *    根拠文は「サポートの5円上に指値」等の **置き方** しか語らず、結果が何円になったかを一度も述べていない
 *    =幅を数えていないから気づかない。よって (a)不等式へ格上げ (b)自分で引き算させる (c)その数値を rationale に
 *    書かせる。★JSON スキーマにフィールドは足さない(parse/記録の形を変えないため。書かせ先は rationale)。
 *  ★責任の所在: 「コードが落とす」だけを書くと免責(=守らなくてよい)に読める。落ちた結果が **あなたの計画が
 *    実行されないこと** だと言い切る。 */
/** ★v0.9.70(この版で直した無言の失敗): 根拠文に書かせる「幅の申告」の書式(SSOT)。
 *
 *  ★事故: この版の初版(未出荷)は例文を「(エントリー価格)と(損切りの位置)の距離=(幅)」にした。この形は
 *    rationaleLc.ts の WIDTH_RE が **1件も読めない**。つまり **モデルがプロンプトの例に忠実に従うほど
 *    lcAudit が undeclared に落ち**、v0.9.61〜v0.9.64 で積み上げた「申告 vs 実出力」の計測が丸ごと死ぬ。
 *    プロンプトとパーサを別々に書くと必ずこうなるので、**書式をここ1箇所に持たせて両方から使う**。
 *  ★書式は既にパースできる「LC幅は N円」に揃える(新しい書き方を発明しない)。
 *  ★プロンプト側には実数値を入れない(アンカー対策)。テストは同じ関数に実数値を入れて生成した文字列を
 *    パーサに食わせる=例文の形を変えた瞬間にテストが落ちる。 */
export function lcWidthDeclarationExample(
  legLabel: string, entry: string, stopPos: string, width: string,
): string {
  return `${legLabel} ${entry}と${stopPos}の引き算 → LC幅は${width}円`;
}

export function lcFloorRule(floorYen: number): string {
  return '★【最優先: 損切りの幅(無条件・例外なし)】各レッグは独立に次の不等式を満たすこと。\n'
    // ★v0.9.70: 絶対値 |エントリー − 損切り| を撤去し、幅そのものの不等式にする。絶対値は符号を隠す形で、
    //   実データではこの形の検算が「逆位置なのに通る」ことを許していた(監査も match と記録していた)。
    + `  lcWidthForLimit ≥ ${floorYen}円 ／ lcWidthForStop ≥ ${floorYen}円 ／ range も各レッグ lcWidth ≥ ${floorYen}円\n`
    // ★v0.9.63(圧縮): 例示を1レッグぶんに縮める(同じ書式の完全な例は scalpJsonInstruction の rationale 注記が持つ)。
    // ★v0.9.64: 幅の申告(v0.9.61)は効いた(申告値は正しくなった)が、実測 2026-08-07 では
    //   「幅は正しく申告し、損切り価格だけ 建値±数円」= 代入の段が見えないまま汚染される形が31件残った。
    //   よって申告させる単位を「幅」から **代入の式そのもの** に変える(足すのではなく置換)。
    //   式の答えと JSON の値の一致を要求すると、汚染が rationale の中で自己矛盾として露見する。
    // ★v0.9.70: 申告させる単位を「代入の式(符号込み)」から「引き算(幅を数える)」へ戻す。符号は もう存在しない。
    //   ★例文は lcWidthDeclarationExample(SSOT)から作る=プロンプトの例と rationaleLc のパーサが必ず噛み合う。
    // ★v0.9.63(圧縮): 「下限割れのレッグは取引されない=あなたの計画がその分だけ実行されない」は
    //   【実出力に在った誤り】の見出し行が「落ちたレッグは取引されず、両レッグ落ちれば見送り」として
    //   全例に一括で与える(免責に読ませないための『責任は免除されない』だけを残す)。
    + `  ★${floorYen}円未満になるレッグは 対の幅ごと省く`
    + '(下限を守る責任は免除されない)。';
}

/** ★v0.9.61: 初期LC下限の「意味と責任」。★従来これは buildDelegationNote の `modes.lcFloor==='ai'` の中にしか
 *  無く、運用機の設定(下限=手動)では **一度も AI に届いていなかった**。手動こそユーザーが決めた絶対条件なので、
 *  モードに関係なく常に(戦略仕様ブロックで)出す。 */
export function lcFloorReason(floorYen: number): string {
  return '理由: この決済は「含み益が一定に達して初めて利益ロックの床が発動する」方式なので、下限より狭い初期LCは床が働く前に被弾し決済ロジックが構造的に成立しない。'
    + `下限は好みではなく **計画が成立するための条件** で、手動でもAI委任でも外れない(${floorYen}円未満のレッグは取引されない)。`;
}

/** ★v0.9.60: 出力前の自己検算(SSOT)。従来はエントリーの不等式しか検算させておらず、
 *  損切りの向き・幅は自己検算の対象外だった(=最多の脱落理由が自己検算をすり抜けていた)。同じ場所・同じ強さで検算させる。
 *  ★v0.9.61: ③に「節目の別」を足して4点にする(エントリーと損切りが同じ節目を基準だと幅は構造的に足りない)。
 *  ★v0.9.62: ②を **数値の大小の確認** に具体化する(旧文は不等式の再掲で、符号を選び違えた本人には
 *    同じ選択がもう一度通ってしまう)。実測の誤りは全て「売りのブレイク新規の損切りだけがエントリーより小さい」形
 *    だったので、その形を名指しで検算対象にする。※項目数は4のまま=増分は最小。 */
/** ★v0.9.70: 旧②「損切りの向き(符号)」を **削除** し4点→3点にする。符号は出力に存在しないので、
 *  検算しようがない(検算項目として残すと、存在しないフィールドを見に行かせることになる)。
 *  ★これで検算されなくなったもの: **無い**。旧②が守らせようとしていた「買いは下・売りは上」は、
 *   parse の stopLossFromWidth が direction から必ずそう置くようになった(AI の遵守に依存しない)。 */
export function selfCheckNote(): string {
  return '★【出力前の自己検算(必須)】出力前に limitEntry と stopEntry を refPrice と比較し、レッグごとに次の1点を確かめること。\n'
    // ★★★ v0.9.93: ①を ③ と同じ「型」にする(この版の1変数。②③は1文字も触っていない) ★★★
    //
    //   ■ 実測(v0.9.92 の proposals 26,734件・app_version で版を切って比較)
    //     エントリーが現在価格の逆側で落ちる geometry:
    //       買い 3.1% → 3.0%(ほぼ不変) / ★売り 35.9% → **48.0%**(n=50)
    //     しかも **失敗の型が入れ替わった**:
    //       旧 = sell/limit/下(戻り売りの指値を下に) → 新 = ★sell/stop/上 20件(ブレイク売りを上に)
    //     読み: Ｃ(v0.9.92)が「売りのブレイク新規はサポートのすぐ下」という **方向つきの手がかり** を
    //     消したため、AI が「ブレイク=上抜け」という既定の連想に落ちた。
    //
    //   ■ ★なぜ ① を直すのか(自己検算の非対称)
    //     ③ には「実際に引き算する」**作業** と「rationale に書く」**証跡** がある。① にはどちらも無く、
    //     「上の不等式を満たすか」= 離れた場所への参照を **確認するだけ** だった。
    //     直近の違反数がそれを裏づける: ③の系(lcFloor)=0件 / 損切りの向き(stopSide・コードが強制)=0件 /
    //     ★①の系(geometry)= 売りで48%。
    //     このプロジェクトの記録「**式の価値は答えでなく型。外すと符号ミスが3倍(10→30件・p<0.05)**」に
    //     照らすと、① だけが型を持っていない。
    //
    //   ■ ★不等式は再掲しない(印字回数を増やさない)
    //     代わりに **小さい順に並べて書かせる**。並び順そのものが証跡になるので、
    //     不等式を4度目に書き写さずに「実際に比較した」ことが記録に残る。
    //
    //   ■ ★「真ん中は refPrice」= 判定の相手(これが無いとループが閉じない)
    //     並びを書かせるだけでは **証跡は残るが AI 自身は矛盾に気づけない**。ベアで枠を取り違えても
    //     AI は正直に「refPrice < stopEntry」と書き、それで終わってしまう。
    //     ③ が効いているのは「書かせる」からではなく、**書いた答えを宣言済みの基準に当てている**から
    //     (幅 → 下限〜上限 / 出力する lcWidthFor… の値と一致)。① も同じ形にする。
    //     ★基準は「真ん中に来る名前は refPrice」の1語だけ。不等式(stopEntry < refPrice < limitEntry)は
    //       書き写さない=印字を増やさずに、**1語で露見する** 形にできる
    //       (ベアで stop を上に置けば limitEntry と stopEntry が両方 refPrice の上に来て、真ん中が refPrice にならない)。
    //     ★コード側でも機械判定できる(並び + 実際に出力した3つの数値の突き合わせ)。
    //
    //   ■ ★片レッグだけの回で破綻させない
    //     名前が2つしか並ばない回には「真ん中」が存在しない。そこで基準は **「両レッグを出したなら」**
    //     という条件つきにした。片レッグの回は条件に当たらないので **何も要求されず、並びの証跡だけが残る**
    //     (存在しない中央を探させない/否定文で「片脚のときは見るな」と書かない)。
    //     ★片脚の向きに基準を与えるには direction × レッグ種別の対応(Ｂ の表)を書き写すことになり、
    //       印字が増えるうえ Ｃ の測定と軸が重なる。よってここでは扱わない(順番は ① → ①の閉じ方 → Ｂ)。
    //     ★増えた語は refPrice / limitEntry / stopEntry / rationale / レッグ のみ(すべて既存語)。
    //       新しい数値・長さの指示・禁止(否定文)は1つも足していない=作業の形だけで書いている。
    + '  ①エントリーの向き: refPrice と、出したレッグの limitEntry / stopEntry を実際に大小比較し、小さい順に並べて rationale に書くこと。両レッグを出したなら、真ん中に来る名前は refPrice。\n'
    // ★v0.9.63(削除): 末尾の「(同じ節目なら幅は必ず足りない)」は ✗② が実際に起きた形として同じことを言う。
    // ★★★ v0.9.94: ③(損切りの幅の自己検算)を **丸ごと削除** した ★★★
    //
    //   ■ ユーザー指示(逐語): 「LC幅をAIにも求め、LC価格はこちらでつけてください。」→「a です。**LCの自己検証は不要です。**」
    //   ■ 何が壊れていたか(削除の根拠)
    //     契約が求めるのは lcWidthForLimit / lcWidthForStop の **正の幅だけ** で、損切りの価格フィールドは
    //     存在しない(v0.9.70)。価格は core/stopGeometry.ts の stopLossFromWidth が direction/side から付ける。
    //     ★なのに旧③は「エントリーと **損切りの位置** の距離を実際に **引き算** し」と要求していた。
    //     「損切りの位置」は出力に存在しないので、AI は毎回それを **想像して** 引き算していた。
    //     実測: LC の理由の箱(lcWhyFor*)は **100% がこの引き算** で、**幅が合わない 14/39・向きが逆 24/39**。
    //     存在しない価格をでっち上げているので、合わなくて当然だった。
    //   ■ ★符号の心配が要らないことを実装で確認した(v0.9.70 以降・「式を外すと符号ミス3倍」は価格欄が在った時期の話)
    //     ・契約に損切り価格のフィールドが無い(scalpJsonInstruction に stopLossFor* は0回)
    //     ・価格は必ず stopLossFromWidth(direction, entry, 幅) が作る=符号は direction からしか決まらない
    //     ・旧形式の価格が万一来ても resolveLcWidth が Math.abs で幅に直し、符号は付け直される
    //     ⇒ **逆位置は表現不能**。自己検算で符号を守る必要は無い。
    //   ■ ★消したのはここ(自己検算)だけ。幅の下限/上限そのものは他の SSOT が持ち続ける:
    //     lcFloorRule(最優先ブロックの不等式)/ scalpJsonInstruction の lcNote(フィールド注記)/
    //     strategySpec の初期LC行 / 委任ノート。**コードの強制(enforce)も不変**。
    //   ■ ★見出しの「3点」→「2点」も同時に直す(数が合わない指示を残さない)。
    //   ■ ★末尾の1文は残す: 「1つでも満たさない…両レッグとも満たさなければ direction:"none"」は
    //     ①②に対しても意味を持つ(向き・節目の別を満たさないレッグの扱い)。
    //     「対の幅ごと省略」は **省略の規約**(entry と lcWidth を対で省く)で、③に依存していない
    //     (同じ規約は JSON 契約と PLAN_BAD_EXAMPLES ✗⑥ が別に持つ)。
    + '  満たさないレッグは 対の幅ごと省略すること。両レッグとも満たさなければ direction:"none" にする。';
}

/** ★v0.9.63(ユーザー指示「だめな例いくつか作成し、AIに見せて」): 規則を散文で足す修正が3版続けて
 *  「別の失敗へ移る」だけに終わったので、**実際に台帳(signal_plans)に残った失敗の形** をそのまま見せる。
 *
 *  ★収録した例はすべて実記録から取った実在の形(架空の失敗は書かない):
 *    ①損切りが建値の隣(2026-08-04・中央値5円・88件)/②エントリーと損切りを同じ節目から導く(根拠文が実在)/
 *    ③幅が下限に固着(v0.9.62 期間の系統A指値の96%が下限〜下限+5・相異なる値は3種類)/④両レッグ同じ幅/
 *    ⑤申告と実物の食い違い(2026-08-07・31件)/⑥「省略する」と述べてフィールドを出す。
 *
 *  ★v0.9.70(削除): 旧②「売りのブレイク新規で損切りを建値の下」(=逆位置・実データ171件)は
 *    **表現不能になった** ので例から外した(損切りの価格を書く場所が消え、向きは direction からコードが決める)。
 *    起こりえない形を例示し続けると、存在しないフィールド(stopLossForStop)を想起させる副作用しか残らない。
 *    残した6例は どれも新しい契約でも起こりうる(幅が小さすぎる/節目が同じ/固着/両レッグ同幅/申告と食い違い/省略矛盾)。
 *
 *  ★アンカー対策(この設計の中心・最重要):
 *   このプロジェクトでは「目立つ数値がそのまま選ばれる」現象が2回続けて起きている(上限65 を印字→LC が60に固着 /
 *   下限を最優先ブロックへ格上げ→下限ちょうどに固着)。**だめな例に書いた数値が次の固着を生んでは意味がない** ため:
 *    (a) 価格を実数で書かない。P/R1/R2/S1/S2 の記号だけで書く(コピーできる価格が1つも無い)。
 *    (b) 幅を数値で書かない。「数円」「広め」「狭め」と定性的にだけ言う(良い例も同じ)。
 *    (c) この本文に現れる数値は「5」(既存の節目緩衝)と記号の添字(R1/R2/S1/S2)だけ。
 *        ★**下限・上限の設定値は1度も現れない**=印字回数を1回も増やさない(固着の再生産をしない)。
 *    (d) 「下限ちょうどは禁止」とは書かない(それは『下限+一定』という新しい固着を作る)。
 *        書くのは「下限ちょうどになる場面自体は正しい。誤りは **毎回** そうなること」。
 *   ★良い例を1つだけ併記する理由: だめな例だけだと「ではどうするか」が残らず、③の過剰修正(幅を機械的に広げる)を
 *    招く。ただし良い例に具体的な幅を書けば それ自体が新しいアンカーになるので、良い例の要点は数値ではなく
 *    **「2つのレッグの幅が揃わないこと」** に置く(幅の多様性を、数値の列挙ではなく構造で示す)。
 *
 *  ★[ ]の検証ラベル(ユーザー追加指示): 例が仮の話でなく **実際に落とされる形** だと示す。語彙は実装が使う
 *   NoneReason / LegDrop.reason(lcFloor / stopSide / geometry / lc / missing / trend / bias)と、
 *   画面注記(LEG_DROP_REASON_TEXT)の日本語をそのまま使う=プロンプト・台帳・画面で1つの語になる。
 *   ★③④は **どの検証も落とさない**(下限を満たす限りコードは通す)。そこを正直に書くことが、③に効く唯一の圧力。
 *   ※関数名(entrySideOk 等)は書かない: AI に意味があるのは「何を確認され、落ちたらどうなるか」であって内部名ではない。 */
export const PLAN_BAD_EXAMPLES =
  '★【過去の実出力に在った誤り(同じ形を出さないこと)】記号 P=現在値 / R1,R2=Pより上の節目(R2が遠い) / S1,S2=Pより下の節目(S2が遠い)。'
  + '各例の[ ]は その形を落とす検証で、台帳と画面の注記にも同じ語が残る。落ちたレッグは取引されず、両レッグ落ちれば その回は見送り(none)。\n'
  // ★v0.9.64: ①②③に書いていた実数の「5」(±5 / 0〜5円上)を記号と定性語に置き換える。この本文は
  //   実出力の引用だが、引用であっても数値は数値として供給される(設計注 (a)(b) と同じ理由)。
  // ★v0.9.70(削除): 旧✗②「売りのブレイク新規の符号ミス([stopSide])」は **表現不能になった** ので落とす
  //   (損切りの価格を書く場所が無くなり、向きは direction からシステムが決める)。起こりえない誤りを
  //   例として見せ続けると、存在しないフィールドを想起させる=新しい誤りの供給源になる。
  //   残りの6例は **どれも新しい契約でもそのまま起こりうる**(幅が小さすぎる/節目が同じ/幅が固着/両レッグ同幅/
  //   申告と出力の食い違い/省略と述べて出す)ので、価格の語だけを幅の語に直して残す。
  + '  ✗①建値の隣: 買い stopEntry=R1のすぐ上 に対して lcWidthForStop に 数円 を入れた形(損切りの位置=R1)。ブレイク新規を節目のすぐ外側に置くための緩衝を、損切りの幅そのものと読んだ形。→損切りの節目は S1/S2 を選び、幅は引き算の結果。[lcFloor=損切り幅が設定の下限より狭い]\n'
  + '  ✗②エントリーと損切りが同じ節目: 「指値はサポートのすぐ上、ブレイク新規はレジスタンスのすぐ上」とだけ述べ、損切りも同じ節目を基準にした形。同じ節目の内と外の差は緩衝ぶん(数円)だけで幾何的に下限を満たせない。→買いの指値が S1 の内側なら損切りの基準は S2。[lcFloor]\n'
  + '  ✗③幅が毎回ほぼ同じ・下限ちょうど: 節目の配置は日ごとに違うのに出した幅がほぼ1種類だった形=下限の数値をそのまま幅の欄に書いている。下限は満たすべき条件で、置くべき値ではない(たまたま下限ちょうどの場面はある。誤りは毎回そうなること)。→先に節目を選び、幅は結果として受け取る。\n'
  + '  ✗④両レッグが同じ幅: 2つのレッグは基準の節目も向きも違うので、幅が同じ数値になるのは先に幅を決めた時だけ。→レッグごとに独立に引き算する。\n'
  // ★v0.9.64: 2026-08-07 の実出力で現れた2つの形。⑤は「幅の計算も申告も正しいのに出力だけ建値の隣」
  //   (31件)、⑥は「省略すると述べながらフィールドを出した」(実在の根拠文)。どちらも規則の理解ではなく
  //   **最後の書き出しの段** で壊れているので、その段を名指しで例にする。※数値・価格は書かない(アンカー対策)。
  + '  ✗⑤申告と実物の食い違い(最後の書き出しだけが壊れる): rationale には正しい LC幅を書きながら、lcWidthForStop には 数円 を入れた形。計算も申告も合っていて、書き出す瞬間だけ ブレイク新規を節目からずらす緩衝に引きずられている。→数えた答えをそのまま幅の欄に出す。[lcFloor]\n'
  + '  ✗⑥「省略する」と述べてフィールドを出す: rationale に「ブレイク新規は下限に届かないので省略した」と書きながら stopEntry と lcWidthForStop の数値を出した形。判断は正しいのに JSON に反映されていない。→省略とは その対のフィールドを書かないこと。[lcFloor]\n'
  + '  ※③④はどの検証にも掛からない=落ちないので誰も直さない。防げるのはあなただけ。\n'
  + '  ○良い形(要点は数値ではなく「2つの幅が揃わないこと」): 買いで S1 が薄く S2 が厚い日 → 指値=S1の内側/損切り=S2の外側 で幅は広め。同じ日のブレイク新規=R1の外側/損切り=直近スイング安値の外側 で幅は狭め。2つの幅は違う数値になる(同じなら、どちらかは節目から導いていない)。';

/** LC 幅の許容レンジの提示文(SSOT)。手動=従来の「A〜B円に収め」/ 委任=「下限A円〜{capLabel}B円 の範囲で…決める」。 */
export function lcRangePhrase(floorYen: number, ceilingYen: number, ceil: LcCeilingPresentation): string {
  return ceil.delegated
    ? `下限${floorYen}円〜${ceil.capLabel}${ceilingYen}円 の範囲で、相場構造(節目/スイングの位置)に応じてあなたが決め`
    : `${floorYen}〜${ceilingYen}円に収め`;
}

/** ★v2(実験中・実行時には未接続): ユーザー指示で全面的に簡素化した質問文。
 *
 *  なぜ作るか(2026-08-11):
 *    現行 buildScalpQuestion は 5,475文字・★24個・「必ず/厳禁/絶対/無条件/例外なし」15個まで
 *    肥大した。その大半は **6版にわたる「規則を足す」修正の瘢痕** で、実測ではそのたびに
 *    失敗が消えず **別の形へ移動** しただけだった(下限55固着 → 中間60固着 / 売りを名指しで直す
 *    → 買いへ移動 / 式を書かせる → 式は正しく符号だけ誤り)。
 *    唯一 完全に効いたのは v0.9.70 の「**書けなくする**」(損切りの符号をコードが決める)だけ。
 *
 *  よって v2 の設計方針は「禁止を並べない・システムの分担を明示する」:
 *    - AI が出すのは 方向 / エントリー価格 / **LC幅(正の数)** / 根拠 の4つだけ
 *    - 向き・距離・幅の範囲は **コードが検証** する(既に enforce/parse が持っている)ので繰り返さない
 *    - 「あなたが気にしなくてよいこと」を最後に明示し、AI に二重の負担をさせない
 *
 *  ★実行時には接続しない(既定は v1 のまま)。オフライン再生ハーネスで v1 と並べて測ってから決める。
 *  ★ceilYen は **実行時に解決した実効上限** を渡すこと(ハードコード禁止)。設定を変えたら
 *    プロンプトも追随する = 宣言と実体をずらさない(v0.9.72 の教訓)。
 *  ★showRange=false のとき、幅の範囲は AI に見せない(案B)。実測で「55〜65 を見せたら中間の60に
 *    62%集中」が起きているため、範囲の提示そのものが固着源かを切り分けられるようにしてある。
 *    案A と案B は **この1点しか違わない**(1変数ずつ動かす)。
 */
export function buildScalpQuestionV2(opts: {
  floorYen: number;
  ceilYen: number;
  /** false なら幅の範囲を提示しない(案B)。既定 true = ユーザー提案どおりの案A。 */
  showRange?: boolean;
  /** ドテン許可時のみ注入(engine が保有中に呼ぶ経路)。 */
  dotenEnabled?: boolean;
  /** レンジ(両面)許可時のみ注入。稼働機は現在 false。 */
  rangeEnabled?: boolean;
  /** ★計画時に見た現在値。v1 の scalpJsonInstruction と同じく refPrice を返させるために渡す
   *  (v2 は自前で JSON 契約を持つので、渡さないと台帳の ref_price が候補腕だけ欠測になる)。 */
  refPrice?: number;
}): string {
  const { floorYen, ceilYen, showRange = true, dotenEnabled = false, rangeEnabled = false, refPrice } = opts;
  const width = showRange
    ? `**【厳格ルール】幅は ${floorYen}円以上 ${ceilYen}円以下。範囲外は不可。**`
    : '**幅は、損切りを置く節目までの距離から決めてください。**\n'
      + '「いくらにするか」ではなく「どこに置くか」を先に決め、その距離を円で答えます。\n'
      + '狭すぎる幅・広すぎる幅はシステムが自動で除きます(範囲は非公開)。';
  const doten = dotenEnabled
    ? '\n### ドテン\n保有中に相場つきが変わったと判断したら、反対方向への転換(ドテン)を提案してよい。\n'
    : '';
  const range = rangeEnabled
    ? '\n### レンジ\n明確な方向性が無く上下に反応帯があると判断したら direction:"range" を選び、\n'
      + '現在値の上と下に1本ずつ、指値でもブレイク新規でも**自由に**提案してよい。\n'
      + '上のレッグは現在値より上、下のレッグは現在値より下に置くこと。\n'
    : '';
  return [
    'あなたは日経225先物(ミニ/マイクロ)のスキャルピングを行うトレーダーです。',
    '上に与えたデータだけを根拠に、いまの戦略を JSON で答えてください。',
    '',
    '### 1. 方向',
    '買い(buy) / 売り(sell) のどちらかを選び、理由を述べてください。',
    '良い場面が無ければ無理に作らず none で見送って構いません。',
    '',
    '### 2. エントリー価格',
    '現在価格(refPrice)を基準に、次の2つを出してください。',
    '- limitEntry … 押し目/戻りを待って入る指値',
    '- stopEntry  … 節目を抜けたら入るブレイク新規',
    '',
    '先に約定した方で取引します。片方だけでも構いません。',
    'それぞれ、その価格にした狙いを述べてください。',
    '',
    '**節目ちょうどには置かないこと。** 指値は刺さらず、ブレイク新規はだましに遭います。',
    '',
    '### 3. ロスカット幅',
    'limitEntry と stopEntry のそれぞれについて、損切りまでの幅を**円で**答えてください',
    '(lcWidthForLimit / lcWidthForStop)。',
    '',
    width,
    doten + range,
    '### 出力(この JSON だけを返す。前後に文章を付けない)',
    '',
    '```json',
    '{',
    // ★regime / confidence / refPrice は **記録のための3つ**(v1 の JSON 契約と同じ意味・同じ名前)。
    //   これが無いと台帳の regime / confidence / ref_price 列が候補の腕だけ空になり、
    //   「質問文を変えたら見立てが変わったか」を腕どうしで比べられない(母集団が揃わない)。
    '  "regime": "trend_up" | "trend_down" | "range" | "unclear",   // いまの相場をどう見たか',
    '  "confidence": number,          // その見立てと計画への確信度(0〜100の整数)',
    `  "direction": ${rangeEnabled ? '"buy" | "sell" | "none" | "range"' : '"buy" | "sell" | "none"'},`,
    '  "limitEntry": number,          // 出さないなら省略',
    '  "lcWidthForLimit": number,     // limitEntry を出すなら必須・正の数',
    '  "stopEntry": number,           // 出さないなら省略',
    '  "lcWidthForStop": number,      // stopEntry を出すなら必須・正の数',
    ...(rangeEnabled ? [
      '  "range": {                   // direction が range のときだけ。現在値の上と下に1本ずつ',
      '    "upper": { "side": "buy"|"sell", "type": "limit"|"stop", "entry": number, "lcWidth": number },',
      '    "lower": { "side": "buy"|"sell", "type": "limit"|"stop", "entry": number, "lcWidth": number }',
      '  },',
    ] : []),
    '  "rationale": "...",            // 1〜3行',
    `  "refPrice": number             // 計画時に見た現在値${refPrice === undefined ? '(上のデータの現在価格)' : `(${refPrice})`}`,
    '}',
    '```',
    '',
    '### システムが自動で行うこと(あなたが気にする必要はありません)',
    '',
    // ★v0.9.94: 向きの記述(建値基準の「上/下」)を落とす。上/下 は **現在価格が基準** に単一化したので、
    //   ここだけ建値基準にすると同じ語が2つの基準を持つ。AI は向きを出せないのだから知る必要も無い。
    '- **損切りの向き**はシステムが決めます。**あなたが出すのは幅(正の数)だけ**で、向きを選ぶ余地はありません。',
    '- エントリーの向き(買いなら limitEntry < refPrice < stopEntry)、現在値からの距離、幅の範囲は**システムが検証**します。満たさないものは自動で除かれます。',
    '- 建玉の管理・注文の発注・決済の執行は、すべてシステムが行います。',
  ].join('\n');
}

/** LC 幅の下限/上限を受けてスキャル戦略質問(ユーザー指定・日本語)を生成する。
 *  初期 LC 幅を {floor}〜{ceiling} 円に収め、{ceiling} 円超は出さない(単一上限)。
 *  上限はレッグ独立(v0.7.37)・指値のみ/逆指値のみの回避を保持。 */
export function buildScalpQuestion(
  floorYen: number = DEFAULT_LC_FLOOR_YEN,
  ceilingYen: number = DEFAULT_LC_CEILING_YEN,
  rangeEnabled = true,
  trendVetoYen: number = DEFAULT_TREND_VETO_YEN,
  // ★v0.9.56: 上限が AI委任のときだけ提示の形を変える(既定=手動=従来と byte 一致)。
  //   ceilingYen には委任時 **実効上限**(安全上限 or 背骨)が入る=保存値はここまで届かない。
  lcCeil: LcCeilingPresentation = LC_CEIL_MANUAL,
  // ★v1d(2026-08-17): 「現在値から最低50円離す」という **最低距離の記述だけ** を落とす。
  //   **既定 false = v1 と byte 一致**(実取引につながる経路は1ミリも動かない)。
  //   ★落とすのは最低距離だけ。距離の **上限**(片レッグ200円/両レッグ幅400円)はこのフラグでも残る
  //     (同時に2つ動かすと、出力が変わったとき どちらの効果か言えなくなる=1コミット1変数)。
  //   ★v1d は実測で悪化(不採用)につき候補腕からは降りたが、変種としては生かす(過去台帳・テスト用)。
  omitMinDistance = false,
  // ★v1e(2026-08-18): 「指値・ブレイク新規の距離の**上限**(片レッグ200円/両レッグ幅400円)」の記述だけを落とす。
  //   **既定 false = v1 と byte 一致**。★落とすのは上限だけ。最低距離50円はこのフラグでも残る
  //     (v1d の実測で「最低距離は効いている(消すと悪化)」と決着済みのため=同時に2つ動かさない)。
  omitMaxDistance = false,
): string {
  // レンジ両面ストラドルの追記(実験・仮想取引で別枠計測)。rangeEnabled=false のときは range を禁止する。
  // ★v0.9.44: 1行に詰め込んでいた説明を複数行の箇条書きに開き、「fade / breakout の2択(組で選ぶ)」に書き直す。
  //   従来は4通り(上下×指値/逆指値)を並べていたため、AI が組を混ぜて「下=買い逆指値」のような
  //   定義上ありえない配置(lower.entry<現在値 と両立しない)を出し、parse で落ちて見送りになっていた。
  const rangeNote = rangeEnabled
    ? '\n⑤明確な方向性が無く、上下に反応帯があるレンジと判断したら direction:"range" で、' +
      '現在値の上と下に1レッグずつ置いてよい(両面ストラドル)。各レッグは side/type/entry/lcWidth(損切りは幅だけ=向きは side からシステムが決める)。\n' +
      '  ★【レンジは2択(組で選ぶ・必須)】次の2つの「組」のどちらか一方を丸ごと選ぶこと。組を混ぜない(4通りから好きな2つを拾わない)。\n' +
      '   ・fade(両側指値/type:"limit")の組 = 上(upper)は 売り指値[side:"sell"/type:"limit"] / 下(lower)は 買い指値[side:"buy"/type:"limit"]\n' +
      '   ・breakout(両側ブレイク新規/type:"stop")の組 = 上(upper)は 買いのブレイク新規[side:"buy"/type:"stop"] / 下(lower)は 売りのブレイク新規[side:"sell"/type:"stop"]\n' +
      // ★v0.9.60(削除): 「※組を混ぜると上下が同じ方向の注文になり…」の理由行は system prompt に同文がある。
      // ★委任時は「最大損切り幅の2倍」を保存値でも安全上限でもなく **そのレンジで自分が置く損切り幅** に対して言う。
      //   保存値を書けばアンカーになり、安全上限を書けば非現実的な閾値になってどちらも規則の意図を壊すため。
      // ★v0.9.60(削除): 上の「理由:」1行も system prompt に同文があるので質問文からは削る。
      (lcCeil.delegated
        ? `  ★どちらの組を選ぶか(重要): 上下の反応帯の幅が、そのレンジで置く損切り幅の2倍より広ければ fade(両側指値)の組、` +
          `損切り幅の2倍以下の狭い横這いなら breakout(両側ブレイク新規)の組にすること。\n`
        : `  ★どちらの組を選ぶか(重要): 上下の反応帯の幅が${ceilingYen * 2}円より広ければ fade(両側指値)の組、` +
          `${ceilingYen * 2}円以下の狭い横這いなら breakout(両側ブレイク新規)の組にすること。\n`) +
      '  ★上下の位置(無条件): upper.entry > 現在値 > lower.entry。この不等式を満たさない数値は出力しないこと。\n' +
      // ★v0.9.60(削除): 「※買いのブレイク新規は必ず現在値より上…定義上ありえない」の2行は
      //   system prompt の rangeLine に同文がある(質問文では重複)。
      `  各レッグの初期LCも上限(≤${ceilingYen}円)内に収めること。\n` +
      '  ★レンジの距離: 上下2本(upper/lower)を出すときは 上と下の価格差を400円以内にする(幅が広すぎるレンジは出さない)。片方だけのレンジは その1本を現在値から200円以内に置く。\n'
    : '\ndirection は buy/sell/none のみ、range(両面)は出さないこと。\n';
  return (
    'あなたが考える現在のスキャル戦略を教えてください。\n' +
    // ★★★ v0.9.89 で「逆指値」の語をプロンプトへ **5箇所** 再導入した(事実の記録・変更不要) ★★★
    //   内訳(エバリュエーターの数え・レンジOFF時): 質問文Ｂの2行(買い目線/売り目線)+
    //         対応表(scalpOrderTypeContract)の3行 = 5箇所。★レンジONではさらにア)の2行が加わる
    //         (実測の出現回数: OFF=5回 / ON=9回。うち1回は v0.9.44 から在る【用語の区別】の引用)。
    //   ★v0.9.44 は「『逆指値』は新規(エントリー)の意味では使わない」と決め、語彙テストで禁じた語である。
    //     当時この二義(ブレイク新規の逆指値 / 損切りの逆指値)は **損切り逆位置171件** を生んだ。
    //   ★それでも入れたのは、ユーザーの逐語の文面をそのまま使うという指示に従ったため(判断は上位で確定済み)。
    //   ★いま実害の経路は塞がっている: v0.9.70 以降、損切りは lcWidth(正の幅)でしか表現できず
    //     **価格フィールドが存在しない**。向きは parse が direction から一意に付ける(逆位置は表現不能)。
    //     = 171件を生んだ v0.9.44 当時とは前提が違う。
    //   ★★観測項目(投入後の最初のセッションで最優先): **損切りの向きの誤りが増えていないか**。
    //     見る先 = signal_plans / proposals の leg_drops_json の reason='stopSide' 件数と、
    //     lc_audit_json(申告 LC幅 と実出力の突き合わせ)。増えていたらこの5箇所を最初に疑うこと。
    // ★v0.9.89(ユーザー指示・逐語): ①=Ａ(目線の判断) / ②=Ｂ(その目線に応じたエントリー注文の提案)。
    //   ★ユーザーが書いた文面をそのまま使う(全角のＸ/Ｙ/Ａ・行頭行末のハイフン・「一つづつを」も直さない)。
    //   ★Ｂは「上の価格Ｘ・下の価格Ｙ」という **位置** で脚を指し、目線ごとに注文タイプが決まる形。
    //     フィールド(limitEntry/stopEntry/range.upper/range.lower)への割り当ては scalpJsonInstruction が持つ
    //     (同じ対応表を2箇所に散文で書かない=ここは注文の言葉・契約はフィールドの言葉)。
    // ★v0.9.90(ユーザー指示): Ａ(相場方向を尋ねる軸)の日本語を **ブル / ベア / レンジ** にする。
    //   ■ なぜ(依頼の狙い): それまでＡとＢが **同じ語「買い」「売り」** を共有していた
    //     (Ａ「買い/売りのどちらかを判断」= 相場観 ／ Ｂ「買い目線の場合: …指値買い注文」= 注文の side)。
    //     1つの語が「相場の方向」と「注文の売買方向」の2つを指す状態は、v0.9.44 の「逆指値」の二義
    //     (ブレイク新規 / 損切り)と同じ形で、あの時は損切り逆位置171件を生んだ。軸ごとに語を分ける。
    //   ■ 変えないもの(重要): **注文タイプの側の「買い注文/売り注文」は売買の side なので そのまま**。
    //     JSON の値(direction:"buy"|"sell"|"range")も **英語の識別子** なので不変
    //     (変えると台帳・parse・実データとの互換が壊れる)。画面(パネル)の「買い目線/売り目線」も不変。
    //   ■ ★方向が反転しないための書き方: ブル/ベア/レンジは **必ず direction の値と同じ括弧の中で** 出す。
    //     ここ(Ａ)と対応表(scalpOrderTypeContract)の両方で `ブル(direction:"buy")` の形にしてあり、
    //     日本語ラベルと enum 値が **隣接して1対1** で結ばれる(対応表では さらに同じ行に注文の side も並ぶ
    //     =ブル→buy→買い注文 が1行で自己補強される)。★離れた場所での対応づけは作らない。
    `①Ａ: 最初に${rangeEnabled ? 'ブル(direction:"buy")/ベア(direction:"sell")/レンジ(direction:"range")のどれか' : 'ブル(direction:"buy")/ベア(direction:"sell")のどちらか'}を判断(良い場面が無ければ無理に作らず direction:"none" で見送ってよい)\n` +
    '②Ｂ: 現在価格より上の価格Ｘと下の価格Ｙを一つづつを選び、それぞれに対して、Ａに応じたエントリー注文を提案してください。先に約定した方で取引します' +
    // ★v1d: この括弧まるごとが「最低距離」の記述(本則+range への非適用の但し書き)。
    //   但し書きは本則が消えれば宛先を失う(存在しない規則の例外の説明になる)ので、一緒に落とす。
    (omitMinDistance
      ? '\n'
      : '(指値とブレイク新規は、現在値からそれぞれ少なくとも50円以上離すこと。この最低距離は buy/sell のみで、range の各レッグには適用しない=レンジは上下の反応帯の位置で決める)\n') +
    // ★v0.9.90: 条件ラベル(目線)だけを Ａ と同じ語に揃える。**注文名(逆指値買い注文/指値売り注文)は side なので不変**。
    '-ブルの場合：Ｘの逆指値買い注文、Ｙの指値買い注文-\n' +
    '-ベアの場合：Ｘの指値売り注文、Ｙの逆指値売り注文\n' +
    // ★レンジの2行(ア/イ)は **レンジ設定が ON のときだけ** 出す。OFF では買い/売りの2ケースだけになり、
    //   この段落にレンジの語は1文字も出ない(=禁止の説明すら足さない。死んだ条項を作らないため)。
    (rangeEnabled
      ? '-レンジの場合は、アまたはイで提案してください。\n' +
        'ア）レンジ抜け：Ｘの逆指値買い注文、Ｙの逆指値売り注文\n' +
        'イ）レンジ継続：Ｘの指値売り注文、Ｙの指値買い注文\n'
      : '') +
    // ★帯(○○円以上ＸＸ円以下)は **設定から解決した値** を埋める。呼び出し元(buildScalpPlan)が
    //   resolveLcPresentation の結果(floorYen / 実効上限)をこの2引数で渡している=ここに数値をベタ書きしない。
    `またそれぞれに、ストップ幅（${floorYen}円以上${ceilingYen}円以下）も提案し、価格Ｘ、Ｙの説明も加えてください。\n` +
    // ★最優先=無条件の不等式。節目の話より前に単独行で置く(節目基準を主語にしない)。
    '\n★【最優先: 価格の向き(無条件・例外なし)】現在値(refPrice)に対して、次の不等式を必ず満たすこと。\n' +
    '  売り: stopEntry < refPrice < limitEntry\n' +
    '  買い: limitEntry < refPrice < stopEntry\n' +
    '  節目・トレンド・ニュースなど他のどんな理由よりもこの不等式を優先する。この不等式を満たさない数値は出力しないこと。\n' +
    '  言い換えると 買いは 指値=現在値より下 / ブレイク新規=現在値より上、売りは 指値=現在値より上 / ブレイク新規=現在値より下。逆に置くと即約定・不正なので厳禁。\n' +
    // ★v0.9.61(削除): 「片方だけ(指値のみ/ブレイク新規のみ)を出すときも、その1本は上の不等式における自分の位置を
    //   必ず守る」の1行は、直下の【指値・ブレイク新規の距離(必須)】が同じことを言っている(「その1本を向き通りに
    //   置いた上で…」)ので、同じメッセージ内の三重掲載になっていた。
    // ★v0.9.60: 損切りの向きを、直上のエントリーの向きと **同じ格**(不等式・単独ブロック)で置く。
    `\n${SL_SIDE_RULE}\n` +
    // ★v0.9.61: 損切りの **幅の下限** も、上2つと同じ格(最優先・不等式・単独ブロック)で並べる。
    `\n${lcFloorRule(floorYen)}\n` +
    // ★語の分離。「逆指値」がブレイク新規と損切りの両方を指すため混線していた。
    '\n★【用語の区別(混同禁止)】「逆指値」という語は2つの別物を指すので、必ず英語フィールド名で呼び分けること。\n' +
    '  stopEntry = ブレイク新規(まだ建てていない・節目を抜けたら入るエントリー注文)。損切りではない。\n' +
    '  lcWidthForLimit / lcWidthForStop = 損切りの **幅**(すでに約定した建玉を守る注文の大きさ)。エントリーでも価格でもない。\n' +
    // ★v0.9.60(削除): 「rationale でも別の語で書くこと」の1行は system prompt に同文があり、
    //   質問文の末尾にも rationale の書き方の指示が別に入っているので重複。

    // ★★★ v0.9.92: 位置の規則(Ｃ)から **方向の語(買い/売り)を追放** する ★★★
    //
    //   ■ 実測で確定したこと(limit_level=AI が申告した節目の価格・v0.9.88 以降は申告率100%)
    //     売り×指値で『現在値の逆側』になった 8本のうち、**申告した節目が現在値より下だったもの 8/8(100%)**。
    //     『節目は正しいのに置き方を間違えた』は **0件**。
    //     ⇒ AI は「節目の5〜10円内側」を **正しく計算している**。壊れているのは **節目の選択** で、
    //       『現在値より下にあるもの』を レジスタンス と呼んで売り指値の基準にしていた。
    //   ■ v0.9.92(節目の呼び名に (現在値より上) を足す)では足りない: 呼び名を足しても
    //     **AI が下の節目を『レジスタンス』と呼ぶ余地** が残る(=規則を強めても表現できてしまう)。
    //   ■ ★この版の手: 規則を足すのではなく **間違いを表現できなくする**(v0.9.70 で損切りを幅だけにしたのと同じ)。
    //     位置は Ｘ/Ｙ が既に持っている(Ｂ の定義: Ｘ=現在価格より上 / Ｙ=現在価格より下)ので、
    //     位置の規則は **買いか売りかを知らなくてよい**。よって Ｃ から方向の語を消す。
    //     ⇒ 実害パターン(売りの指値を現在価格より下)は、この形では **書きようが無い**。
    //   ■ 段の分担(各段の仕事は1つ): Ａ=相場の方向(ブル/ベア/レンジ) → Ｂ=方向から注文の種類 → Ｃ=Ｘ/Ｙ の価格。
    //   ■ 消えた規則は無い(旧【ブレイク新規の置き場所】と【節目への置き方】は Ｃ から導ける):
    //     ブル Ｙ 指値   = 下の節目の5〜10円内側 → 節目より上・現在価格より下(押し目)
    //     ブル Ｘ ブレイク新規 = 上の節目のすぐ外側 → 現在価格より上(レジスタンス抜け)
    //     ベア Ｘ 指値   = 上の節目の5〜10円内側 → 節目より下・現在価格より上(戻り売り)
    //     ベア Ｙ ブレイク新規 = 下の節目のすぐ外側 → 現在価格より下(サポート抜け)
    //   ★数値は1つも足していない(5〜10円は不変。ブレイク新規のずらし量は v0.9.64 で撤去したまま=量を書かない)。
    //   ★語彙も足していない(内側/外側/節目/Ｘ/Ｙ/指値/ブレイク新規 はすべて既存語)。
    '\n★【Ｃ: Ｘ・Ｙ の価格の決め方(位置の規則)】現在価格(refPrice)だけを基準にする。内側=現在価格に近づく向き / 外側=現在価格から遠ざかる向き。\n' +
    '  Ｘ(現在価格より上に置く注文): 現在価格より上の節目を1つ選ぶ。指値なら その節目の 5〜10円 内側 / ブレイク新規(stopEntry)なら その節目の すぐ外側(抜けたと分かる最小限だけ離す。ずらす量は決めない)。\n' +
    '  Ｙ(現在価格より下に置く注文): 現在価格より下の節目を1つ選ぶ。指値なら その節目の 5〜10円 内側 / ブレイク新規(stopEntry)なら その節目の すぐ外側(同上)。\n' +
    '  ★狙う節目ちょうどには置かない。選べる節目が無ければ その脚を省く。\n' +
    // ★v0.9.64 の判断を維持: ブレイク新規のずらし量(0〜5円)は書かない。損切りの代入へ 5 が流用されていた実測による。
    '  ★この「外側」は現在価格から遠ざかる向きであって、損切りの「外側」(建玉を守る向き)とは別物。★このずらし幅は損切りには一切使わない。\n' +
    // ★v0.9.60(削除): 『★【逆張り指値の節目選び(重要)】』の4行(約230字)は system prompt に同文が入る重複。
    //   質問文(user)側は「向き」の規則に集中させ、節目の強弱の解説は system prompt 1箇所に集約する。
    // ★v0.9.60(圧縮): 距離ルールの1行目は ★最優先 の不等式をこの同じメッセージ内で3度目に書き写していたので、
    //   参照に置き換えた(数値の上限だけを残す)。
    // ★v1e(2026-08-18・omitMaxDistance): この段落まるごとが「距離の上限」の記述。落とすと段落自体が消え、
    //   前後の空行(paragraph 区切り)は1つに畳まれる(v1d と違い、この段落は独立した1文なので
    //   途中に空文字列を挟む必要が無い=そのまま '' にするだけで済む)。
    (omitMaxDistance
      ? ''
      : '\n★【指値・ブレイク新規の距離(必須)】両方を出すときは現在値がその2つの価格の間に入るように置き(上の不等式のとおり)、' +
        '指値とブレイク新規の価格差[両者の幅]は400円以内にする=幅が広すぎる両面は出さない。' +
        '片方だけ[指値のみ/ブレイク新規のみ]を出すときは、その1本を向き通りに置いた上で現在値から200円以内に収める' +
        '[200円超離れた片レッグは出さない=約定不能・古い価格になりやすいため]。\n') +
    // ★v0.9.56 ②: 「ストップ幅に5円加える」は下限に足す指示だと読まれていた(AI が『本来のストップ幅=下限55』と解釈し 60 を出した)。
    //   +5円 が何に加わるのかを明示する。
    // ★v0.9.60(削除): ここに在った「損切りは必ずエントリーの外側に置く…内側/反対側には置かないこと」の散文は、
    //   上の SL_SIDE_RULE(不等式・最優先ブロック)に格上げして置き換えた(同じ内容を弱い形で二度書かない)。
    `\n③それぞれのストップ(損切り)の **幅** を定めてください(価格は出さない=向きは上の【最優先: 損切りは「幅」だけを出す】のとおりシステムが付ける)。\n` +
    // ★v0.9.56 ③: 節目 → ストップ位置 → 幅 の順であることを明示(幅を先に決めて節目に当てはめるのは誤り)。
    '④この建玉は、利が乗ると段階的に利益を確定し損切りを引き上げる決済方式を使う。\n' +
    `  ゆえに初期の損切り(LC)幅は${lcRangePhrase(floorYen, ceilingYen, lcCeil)}、1回の損切りが積み上げた利益を飛ばさない(コツコツドカンを避ける)。\n` +
    // ★v0.9.60(削除): 「損切りは直近の節目/スイングの外側に置き、狭すぎ・広すぎを避ける」は直上の
    //   LC_DERIVATION_ORDER ①②と完全に同義なので削る(弱い言い換えを残すと導出の順序がぼやける)。
    // ★v0.9.61(削除): 「${ceilingYen}円を超える損切りは出さない」は直上の lcRangePhrase(許容範囲)と
    //   直下のレッグ省略ブロックの二重言い換え。上限の数値反復は「幅を先に決める」誤りを誘うので1回減らす。
    `  LC 幅(下限・上限)は、指値レッグ・ブレイク新規レッグ それぞれ独立に満たすこと。\n` +
    rangeNote +
    // ★v0.9.60(圧縮): 4行のうち3行は上限値(${ceilingYen})を5回書き直しているだけだった。上限の数値を
    //   繰り返すほど「幅を先に決める」誤りを誘うので、規則を1行に畳んで数値の反復を1回に減らす。
    // ★v0.9.61(削除): 【LC が収まらないときのレッグ省略】ブロックは、直上④の「レッグごとに独立に満たす」・
    //   【最優先: 損切りの幅】の「選び直す→届かないレッグだけ省く」・自己検算の「両レッグとも満たさなければ none」
    //   の3つで既に言い尽くされていた(同じ質問文の中の4度目の掲載)。規則は1つも失われない。
    // ★v0.9.63: 実出力に在った失敗の形(5つ)+良い形。★自己検算の **直前** に置く=検算の各項目が
    //   「見たことのある形」と結びつく。注入は質問文(user message)の1箇所だけ(同じ内容を3ビルダーに
    //   複写すると、これまで効かなかった散文の増殖と同じことになるため)。
    `\n${PLAN_BAD_EXAMPLES}\n` +
    // ★出力直前の自己検算。ここで落とせば、コード側の検証で両レッグ落ち=見送り(none)になる事故を防げる。
    // ★v0.9.60: エントリーの向きだけでなく **損切りの向きと幅** も同じ場所・同じ強さで検算させる(SSOT=selfCheckNote)。
    `\n${selfCheckNote()}\n` +
    // ★v0.9.64: 従来この規則は片方向(出さないレッグを「置いた」と書かない)だけだった。実測 2026-08-07 の
    //   根拠文「…ブレイク新規のLC幅が下限未満のため、ブレイク新規は省略。指値レッグのみで計画を立てた」に対し
    //   stopEntry/stopLossForStop の数値が出ていた=判断は正しく JSON に反映されていない。逆方向
    //   (省略と述べたなら価格を出さない)を、省略の定義とともに書く。
    '\n★rationale[説明文]は実際に出力したレッグだけ説明すること(食い違いは両方向とも禁止): ' +
    '①出していないレッグを「置いた/設定した」と書かない。' +
    '②逆に「省略する/見送る/出さない」と述べたレッグは、その対のフィールド(指値レッグ=limitEntry と lcWidthForLimit / ブレイク新規レッグ=stopEntry と lcWidthForStop)を JSON に **書かない**こと。★省略とはフィールドを出さないことであって、数値を出したうえで「省略した」と述べるのは矛盾(そのレッグは書いたとおりに発注される)。\n' +
    trendGuidance(trendVetoYen)
  );
}

// トレンド veto の初期閾値[円]。config resolveScalpTrendVetoYen と揃える(0=veto 無効)。
export const DEFAULT_TREND_VETO_YEN = 100;

/** レンジ両面(direction:"range")の実効許可値。manual は設定値(override 優先)/ ai は AI 委任=許可(true)。
 *  ★SSOT: system prompt の rangeLine と、技術文脈の「直近の勢い」1行に添えるレンジ文言は、必ず同じ値を使う
 *   (片方が「レンジ禁止」もう片方が「レンジ可」だと AI が混乱するため)。scalpPlanRunner が同じ関数を呼ぶ。 */
export function resolveEffectiveRangeEnabled(profile?: SignalProfile, override?: boolean): boolean {
  const d = resolveScalpRangeDirective(profile);
  return d.mode === 'manual' ? (override ?? d.value) : true;
}

/** レジーム/トレンド逆行フェードを禁じる補助プロンプト(遵守はコードの enforcePlanConstraints で担保)。
 *  trendVetoYen<=0(=veto 無効)のときは空文字(=注入なし)。 */
function trendGuidance(trendVetoYen: number): string {
  if (!(trendVetoYen > 0)) return '';
  return (
    // ★トレンド判定は「10分だけ」ではなく 10分・30分・MA20傾き の合議(=『直近の勢い』行の末尾ラベルの正体)。
    //   軸の列挙は実装(computeRegime)と厳密に一致させる。1時間は数値基準を持たないので合議には入れず、
    //   『長い時間軸』ブロックの数値を AI 自身に見せて補助的に参照させる。
    `『レンジ』は 10分・30分・MA20傾き のどれも横ばい(10分が±${trendVetoYen}円未満 かつ 30分が±${trendVetoYen * 2}円未満)` +
    'のときだけと判断すること。10分が静かでも 30分/MA20傾き が一方向に動いていればレンジではない' +
    '(『直近の勢い』行の末尾ラベルがこの合議の結論。『長い時間軸(1時間/2時間/当日始値比)』の数値も併せて参照すること)。' +
    'トレンドと判断したら、トレンド方向の順張り(ブレイク新規(stopEntry)/押し目・戻りの順張り)か direction:"none" で見送りにする。' +
    'トレンドに逆行する新規(順トレンドの高値売り/安値買いの戻り売買)は出さない。' +
    '★直近10分と長い時間軸が逆向きのとき(『直近の勢い』が「戻り」「押し目」表示)は、どちらのトレンドとも断定せず、' +
    'direction:"none"(見送り)を基本とすること。' +
    // ★v0.9.61(削除): 末尾の「上で渡す『直近の勢い』と『長い時間軸』の数値を必ず判断に使うこと。」は、
    //   同じ段落の3文前「(『直近の勢い』行の末尾ラベルが…『長い時間軸』の数値も併せて参照すること)」と同義。
    `※コード側の自動見送り(veto)は直近10分の勢い(±${trendVetoYen}円)だけで判定するので、` +
    `10分が±${trendVetoYen}円未満でも長い時間軸がトレンドなら veto は掛からない=逆行を出さないのはあなたの判断による。`
  );
}

// 固定のスキャル戦略質問(既定 LC 幅 45〜65)。プロンプト文言テストや後方互換のための既定インスタンス。
export const SCALP_QUESTION = buildScalpQuestion();

/** LC 幅の下限/上限を受けてスキャルの system prompt を生成する。
 *  ★v0.7.37 のレッグ独立/指値のみ回避、v0.7.38 のギャップ検証済み知見ガードレールを保持。 */
export function buildScalpSystemPrompt(
  floorYen: number = DEFAULT_LC_FLOOR_YEN,
  ceilingYen: number = DEFAULT_LC_CEILING_YEN,
  rangeEnabled = true,
  trendVetoYen: number = DEFAULT_TREND_VETO_YEN,
  aiTechnicalEnabled = false,   // ★true でテクニカル指標(RSI/BB)許可の1行を追記。false(既定)は byte 一致=従来不変。
  // ★v0.9.56: 上限が AI委任のときだけ提示の形を変える(既定=手動=従来と byte 一致)。
  lcCeil: LcCeilingPresentation = LC_CEIL_MANUAL,
  // ★v1e(2026-08-18): 「指値・ブレイク新規の距離の上限(片レッグ200円/両レッグ幅400円)」の箇条書きを落とす。
  //   **既定 false = v1 と byte 一致**。buildScalpQuestion の同名フラグと対で使う(1つの規則を同時に消す)。
  omitMaxDistance = false,
): string {
  // ★テクニカル許可(RSI/BB)。ON のときだけ追記=OFF(既定)では byte 単位で従来の system prompt と一致。
  const techLine = aiTechnicalEnabled
    ? `\n- ★【テクニカル指標(RSI/BB)の活用が許可されています】渡す「テクニカル指標(5分足・RSI14/SMA14/BB${BB_BAND_LABEL})」を、エントリーの"タイミング"判断に使ってよい(例: RSI が売られすぎ[≤30]からの反転や BB 下限からの反発で押し目買い指値、RSI 買われすぎ[≥70]や BB 上限での戻り売り指値など)。ただしテクニカルだけで逆張りせず、上のトレンド判断(生きたトレンドはフェードしない)と節目/勢いを優先すること。※決済(手仕舞い)は既定のロジックが担当するので、テクニカルを根拠に手仕舞いを指示することはしない。`
    : '';
  return buildScalpSystemPromptBody(floorYen, ceilingYen, rangeEnabled, trendVetoYen, techLine, lcCeil, omitMaxDistance);
}

/** system prompt 本体(techLine を末尾に差し込む)。buildScalpSystemPrompt から呼ぶ内部関数。 */
function buildScalpSystemPromptBody(
  floorYen: number,
  ceilingYen: number,
  rangeEnabled: boolean,
  trendVetoYen: number,
  techLine: string,
  lcCeil: LcCeilingPresentation = LC_CEIL_MANUAL,
  omitMaxDistance = false,
): string {
  // レンジ両面ストラドル(実験・仮想取引で別枠計測)の指示行。rangeEnabled=false は range を明示禁止する。
  // ★v0.9.44: 1行に詰め込んでいたレンジ指示を複数行に開き、「fade / breakout の2択(組で選ぶ)」へ書き直す。
  //   4通り(上下×指値/逆指値)の並列表記だと AI が組を混ぜて「下=買い逆指値」等の定義上ありえない配置を出し、
  //   lower.entry<現在値 と両立せず parse で落ちて見送りになっていた。
  // ★v0.9.56: レンジの組(fade/breakout)を選ぶ閾値。手動=従来どおり保存値の2倍を印字 / 委任=「自分が置く損切り幅の2倍」。
  //   委任時に保存値(65)を書けばアンカーになり、安全上限(159)を書けば 318円 という非現実的な閾値になる。
  const rangePairChoice = lcCeil.delegated
    ? `★どちらの組を選ぶか[重要]: 上下の反応帯の幅が、そのレンジで置く損切り幅の2倍より広ければ fade(両側指値)の組、損切り幅の2倍以下の狭い横這いなら breakout(両側ブレイク新規)の組にすること。上下幅が損切り幅の2倍以下では逆張りの利幅が損切り幅を上回らず成立しない(狭い横這いは抜けに追随するのが正しい)。`
    : `★どちらの組を選ぶか[重要]: 上下の反応帯の幅が${ceilingYen * 2}円より広ければ fade(両側指値)の組、${ceilingYen * 2}円以下の狭い横這いなら breakout(両側ブレイク新規)の組にすること。損切り幅は最大${ceilingYen}円なので、上下幅が${ceilingYen * 2}円以下では逆張りの利幅が損切り幅を上回らず成立しない(狭い横這いは抜けに追随するのが正しい)。`;
  const rangeLine = rangeEnabled
    ? `\n- ★レンジ両面(direction:"range"): 明確な方向性が無く上下に反応帯があるレンジと判断したら direction:"range" を返してよい(両面ストラドル・実験扱い)。range の時は range.upper / range.lower にそれぞれ side(buy/sell)・type(limit=レンジ内逆張り指値 / stop=抜け追随のブレイク新規)・entry・lcWidth(損切りの幅=正の数。向きは side からシステムが決める)を出す。
  ★【レンジは2択(組で選ぶ・必須)】次の2つの「組」のどちらか一方を丸ごと選ぶこと。組を混ぜない(4通りから好きな2つを拾わない)。
   ・fade(両側指値/type:"limit")の組 = 上(upper)は 売り指値[side:"sell"/type:"limit"] / 下(lower)は 買い指値[side:"buy"/type:"limit"]
   ・breakout(両側ブレイク新規/type:"stop")の組 = 上(upper)は 買いのブレイク新規[side:"buy"/type:"stop"] / 下(lower)は 売りのブレイク新規[side:"sell"/type:"stop"]
   ※組を混ぜると上下が同じ方向の注文になり、それはレンジではなく通常の buy/sell プランと同じものになるため。
  ${rangePairChoice}
  ★上下の位置(無条件): upper.entry > 現在値 > lower.entry。この不等式を満たさない数値は出力しないこと。※買いのブレイク新規は必ず現在値より上・売りのブレイク新規は必ず現在値より下なので、「下(lower)に買いのブレイク新規」「上(upper)に売りのブレイク新規」は定義上ありえない。絶対に出さないこと。
  各レッグの初期LCも上限(≤${ceilingYen}円)内に収める。
  ★レンジの距離: 上下2本(upper/lower)を出すときは 上と下の価格差を400円以内にする(幅が広すぎるレンジは出さない)。片方だけのレンジは その1本を現在値から200円以内に置く。方向性が明確なら従来どおり buy/sell を優先。`
    : `\n- range(両面ストラドル)は出さないこと(direction に range を使わない)。`;
  return `あなたは日経225先物(NIY=F)のスキャルピングを専門とするトレーダーです。
手元の【市場の現状】(現在価格・テクニカル節目・直近アラート・本日OHLC・ニュース)と、
利用可能なデータツール(explain_move / query_alerts / price_history / web_search)を必要に応じて使い、
現在の相場に対する具体的なスキャルのエントリー計画を1つ立ててください。

制約:
- ★まず自分で現在のレジーム(regime: trend_up=上昇トレンド / trend_down=下降トレンド / range=レンジ / unclear=不明)と、その判断・計画への確信度(confidence: 0〜100)を下し、JSON の regime と confidence に入れてから direction 以下の計画を出すこと(自分の相場観を明示してから計画する)。渡された構造化データ(数値の足/節目/ボラ/スイング/アラート結果/自分の成績)を最優先の根拠にする。
- direction は buy / sell / none${rangeEnabled ? ' / range' : ''} のいずれか。良いエントリー場面が無ければ無理にプランを作らず direction:"none"(見送り)を返してよい。その場合 rationale に見送り理由を書き、計画の4フィールド(limitEntry/stopEntry/lcWidthForLimit/lcWidthForStop)は不要。${rangeLine}
- buy/sell の時: 指値(limitEntry)は押し目買い/戻り売り側の新規、ブレイク新規(stopEntry)は節目を抜けた側の新規。原則として両方の価格を出すが、下記のとおり片方だけ(指値のみ/ブレイク新規のみ)でもよい。
- ★【最優先: 価格の向き(無条件・例外なし)】現在値(refPrice)に対して、次の不等式を必ず満たすこと。
  売り: stopEntry < refPrice < limitEntry
  買い: limitEntry < refPrice < stopEntry
  節目・トレンド・ニュースなど他のどんな理由よりもこの不等式を優先する。この不等式を満たさない数値は出力しないこと。
  言い換えると 買いは 指値=現在値より下 / ブレイク新規=現在値より上、売りは 指値=現在値より上 / ブレイク新規=現在値より下。逆に置くと即約定してしまい不正なので厳禁。
  片方だけ(指値のみ/ブレイク新規のみ)を出すときも、その1本は上の不等式における自分の位置を必ず守る(例: 売りの stopEntry は必ず現在値より下)。
- ${SL_SIDE_RULE}
- ${lcFloorRule(floorYen)}
- ★【用語の区別(混同禁止)】「逆指値」という語は2つの別物を指すので、必ず英語フィールド名で呼び分けること。
  stopEntry = ブレイク新規(まだ建てていない・節目を抜けたら入るエントリー注文)。損切りではない。
  lcWidthForLimit / lcWidthForStop = 損切りの **幅**(すでに約定した建玉を守る注文の大きさ)。エントリーでも価格でもない。
  rationale(説明文)でも両方をまとめて「逆指値」とだけ書かないこと。
- ★【Ｃ: Ｘ・Ｙ の価格の決め方(位置の規則)】現在価格(refPrice)だけを基準にする。内側=現在価格に近づく向き / 外側=現在価格から遠ざかる向き。
  Ｘ(現在価格より上に置く注文): 現在価格より上の節目を1つ選ぶ。指値なら その節目の 5〜10円 内側 / ブレイク新規(stopEntry)なら その節目の すぐ外側(抜けたと分かる最小限だけ離す。ずらす量は決めない)。
  Ｙ(現在価格より下に置く注文): 現在価格より下の節目を1つ選ぶ。指値なら その節目の 5〜10円 内側 / ブレイク新規(stopEntry)なら その節目の すぐ外側(同上)。
  ★狙う節目ちょうどには置かないこと。選べる節目が無ければ その脚を省く。
  理由: 指値を節目ちょうどに置くと反応して約定しない(刺さらない)ことが多く、ブレイク新規を節目ちょうどに置くとだまし(往復)に遭いやすい。
  ★この「外側」は現在価格から遠ざかる向きであって、損切りの「外側」(建玉を守る向き)とは別物。このずらし幅は損切りには一切使わない。
  range の各レッグ(upper=Ｘ / lower=Ｙ)も同じ置き方にする。
- ★【逆張り(指値)の節目選び】反発を狙う指値は十分に強い節目(複数回タッチ/主要ラウンド/上位足の節目)にのみ置く。最も近い(隣接の)節目が弱い(タッチ浅い/新しい/薄い)ときは、そこで逆張りせず もう一つ先のより強い節目まで引きつけて置くこと。近くに強い節目が無ければ逆張り指値は見送り、順方向のブレイク新規(stopEntry)を優先する。
${omitMaxDistance ? '' : '- ★【指値・ブレイク新規の距離(必須)】両方を出すときは現在値がその2つの価格の間に入るように置き(上の不等式のとおり)、指値とブレイク新規の価格差(両者の幅)は400円以内にすること=幅が広すぎる両面は出さない。片方だけ(指値のみ/ブレイク新規のみ)を出すときは、その1本を上の向き通りに置いた上で現在値から200円以内に収めること(200円を超えて離れた片レッグは出さない=約定不能・古い価格になりやすいため)。\n'}- それぞれの約定時の損切りの **幅**(lcWidthForLimit / lcWidthForStop・正の数)を出す(損切りの価格は出力しない=システムが向きを付けて計算する)。指値レッグは limitEntry+lcWidthForLimit、ブレイク新規レッグは stopEntry+lcWidthForStop を対で出す(片方だけは不可)。
- この建玉は、利が乗ると段階的に利益を確定し損切りを引き上げる決済方式を使う。ゆえに初期の損切り(LC)幅は${lcRangePhrase(floorYen, ceilingYen, lcCeil)}、1回の損切りが積み上げた利益を飛ばさない(コツコツドカンを避ける)ようにする。${ceilingYen}円を超える損切りは出さない。
- ★この LC 幅(下限・上限)は 指値レッグ・ブレイク新規レッグ それぞれ独立に 満たすこと。
- ${selfCheckNote()}
- ★【検証済みの知見(9年バックテストで確認・従うこと)】寄り付きギャップ(前セッション終値と当セッション始値の乖離)を主要根拠とする戦略は優位性ゼロと確認済み。「ギャップ埋め狙いの逆張り」「ギャップ反転の追随」「ギャップ継続の追随」いずれも期待値マイナス。よって『ギャップが埋まる/反転する/継続する』を主な根拠にしたエントリーは提案しないこと(該当する局面は他に明確な根拠が無ければ direction:"none" で見送る)。ギャップの大小に方向エッジは無い(大きいギャップほど有利ということはない)。※これはギャップを根拠にした売買を禁じるもので、ギャップと無関係の節目/トレンド/アラート根拠のエントリーは通常どおり可。
- すべての価格は円単位の実数(NIY=F の実値レンジ)で、refPrice(現在値)と整合させる。
- rationale は日本語で判断根拠を簡潔に述べる。★rationale は実際に出力したレッグだけ説明すること(食い違いは両方向とも禁止): ①出していないレッグを「置いた」と書かない。②「省略する/見送る」と述べたレッグは その対のフィールド(limitEntry+lcWidthForLimit / stopEntry+lcWidthForStop)を JSON に書かないこと=★省略とはフィールドを出さないことであり、数値を出して「省略した」と述べるのは矛盾(そのレッグは書いたとおりに発注される)。${trendVetoYen > 0 ? `
- ★【レジーム/勢い】${trendGuidance(trendVetoYen)}` : ''}${techLine}`;
}

// 固定のスキャル system prompt(既定 LC 幅 45〜65)。プロンプト文言テストや後方互換のための既定インスタンス。
export const SCALP_SYSTEM_PROMPT = buildScalpSystemPrompt();

/** 各 knob の委任モード。全 knob 'manual'(既定)なら委任ノートは空=プロンプト不変(回帰なし)。 */
export interface KnobModes {
  lcFloor: KnobSource; lcCeiling: KnobSource; trendVeto: KnobSource;
  cooldown: KnobSource; bias: KnobSource; range: KnobSource;
}

/** ★v0.9.44: buildScalpPlan がインラインで組み立てていた注記を純関数化(出力は byte 不変=挙動不変)。
 *  目的は「AI に届く文字列の生成箇所」を全てテストで固定できるようにすること。旧実装では biasNote /
 *  heldNote / armedNote / visionNote がテストから到達できず、新ルールとの矛盾が入り込んでも検出できなかった。 */

/** エントリー方向の制約(手動バイアス時のみ)。'none' は '' = 注入なし。 */
export function buildBiasNote(bias: ScalpBias): string {
  return bias === 'long'  ? '\n\n【エントリー方向の制約】買い中心。売り(sell)の新規は原則見送り(direction:"none")とし、買い(buy)の好機のみ提案すること。'
       : bias === 'short' ? '\n\n【エントリー方向の制約】売り中心。買い(buy)の新規は原則見送り(direction:"none")とし、売り(sell)の好機のみ提案すること。'
       : '';
}

/** ドテン(保有中の反転評価=held-eval)。未指定(flat-plan)は '' = 従来と byte 一致。 */
export function buildHeldNote(held?: { dir: 'buy' | 'sell'; entry: number }): string {
  if (!held) return '';
  return `\n\n【保有中(ドテン評価)】現在 ${held.dir === 'buy' ? 'long(買い)' : 'short(売り)'}@${Math.round(held.entry)} を保有中です。`
    + `ドテン(反転=決済して同時に反対方向へ新規)が許可されています。決済が妥当かつ反対方向へ強く動く場面だと判断したときだけ、`
    + `direction を保有と反対(${held.dir === 'buy' ? 'sell' : 'buy'})にした反転プランを返してよい(常にではなく、その場面だけ)。`
    + `反転が不要なら direction:"none" で保有継続とすること。`;
}

/** レンジ再評価(未約定→ブレイク)。未指定(通常)は '' = 従来と byte 一致。 */
export function buildArmedNote(ctx?: { mode: 'range-fade'; ageMs: number; avgMs: number }): string {
  if (!ctx) return '';
  return `\n\n【レンジ未約定(ブレイク再評価)】現在レンジ両指値を ARM後 ${Math.round(ctx.ageMs / 60_000)}分 未約定`
    + `(平均 ${Math.round(ctx.avgMs / 60_000)}分 を超過)。レンジが反発せず抜けそうなら breakout(両側ブレイク新規・range 各レッグ type:"stop")の組へ`
    + `切替えたプランを返してよい(組は混ぜない)。反発継続が見込めるなら現状維持(同じ fade=両側指値の組)。場面が崩れたなら direction:none。`;
}

/** ★v0.9.61: バンドウォーク成立中だけの注記(未成立/未判定は '' = プロンプトは従来と byte 一致)。
 *
 *  緩めるのは **エントリーまでの距離と、節目を起点にせよという要求の2つだけ**。
 *  ★損切り(LC)の下限・上限・安全上限、および 価格/損切りの向きの不等式は **一切緩めない**
 *   (この注記の中でもそれを明記して、AI が「全部自由になった」と読まないようにする)。
 *  理由: バンドウォーク中は価格がバンドに沿って動き続けるため、節目まで引きつけた 50円以上離れた指値は
 *  置いていかれて約定しない。ユーザー指定「節目にこだわらず近くの逆指値や指値も可」。
 *
 *  ★v1d(2026-08-17・omitMinDistance): ①は「最低距離は課さない」という **免除** である。
 *   本則(質問文・strategySpec の最低距離)が消える変種では、免除だけが残ると
 *   **存在しない規則の例外** を説明することになる(設計書 原則5「存在しない機構を AI に説明しない」)。
 *   よって ① を落とし、残る②を①に繰り上げ、「2点」→「1点」も整合させる。
 *   ★助詞も直す: 「要求 **も** 課さない」の「も」は 消えた前項(最低距離の免除)を指す語なので、
 *     単独で残すと **参照先を失った表現** になる。v1d 側だけ「は」にする(v1 は1バイトも変えない)。
 *   ★消えるのは最低距離に関する文と、その「も」だけ。免除の中身(節目起点)と、
 *     緩めないもの(LC幅・向き・距離の上限)の列挙は1バイトも変えない。
 *
 *  ★v1e(2026-08-18・omitMaxDistance): 逆に、末尾の「緩まないものの列挙」の中の
 *   **「距離の上限(片レッグ200円以内/両レッグ幅400円以内)は」の1句だけ** が宛先を失う側。
 *   v1e は質問文・system prompt・strategySpec から距離の上限そのものを外すので、この注記だけが
 *   「200/400円は変わらない」と言い続けると **プロンプトのどこにも書かれていない規則を参照する**
 *   ことになる(このセッションで潰してきた欠陥と同型: 委任時に消える機構への言及、rangeEnabled=false
 *   時の「上の2択」参照など)。よってこの1句だけを落とす。★緩まないものの残り(LC幅の下限・上限・
 *   安全上限、価格の向きの不等式、損切りは「幅」だけを出す契約)は1バイトも変えない=v1e でも実在する
 *   規則だけを列挙する。 */
export function buildBandwalkNote(bw?: Bandwalk | null, omitMinDistance = false, omitMaxDistance = false): string {
  if (!bw) return '';
  const dirJa = bw.direction === 'up' ? '上昇(買い方向)' : '下降(売り方向)';
  const relaxCount = omitMinDistance ? '1点' : '2点';
  return `\n\n【バンドウォーク成立中(${dirJa})】${describeBandwalk(bw)}\n`
    + `この局面に限り、上に書いた次の${relaxCount}だけを緩めてよい:\n`
    + (omitMinDistance
      ? ''
      : '  ①指値・ブレイク新規を現在値から最低50円離す、という最低距離は課さない(現在値のすぐ近く=数円〜数十円 に置いてよい)。\n')
    + (omitMinDistance
      // ★v1d: 単独の項なので「も」は使わない(前項が存在しない)。
      ? '  ①エントリーを節目(サポート/レジスタンス)から導く要求は課さない(近くに節目が無くてもよい。'
      : '  ②エントリーを節目(サポート/レジスタンス)から導く要求も課さない(近くに節目が無くてもよい。')
    + `バンドウォークの向き(${bw.direction === 'up' ? '買い' : '売り'})に沿って、押し目/戻りの浅い指値(limitEntry) や `
    + '直近高安をすぐ抜けるブレイク新規(stopEntry) を、現在値の近くに置いてよい)。\n'
    // ★v0.9.70: 【最優先: 損切りの向き】は「損切りは幅だけを出す」契約に置き換わったので、参照先の名前を直す
    //   (存在しないブロック名を参照させない=緩和の対象が曖昧にならないようにする)。
    + `  ★緩むのはこの${relaxCount}のみ。損切り(LC)幅の下限・上限・安全上限、【最優先: 価格の向き】の不等式と【最優先: 損切りは「幅」だけを出す】の契約`
    // ★v1e(omitMaxDistance): 距離の上限(200/400円)への言及だけを落とす。v1 は従来どおり「、距離の上限(…)は」を
    //   挟む(byte 不変)。v1e は「契約」に直接「は一切変わらない」を続ける(存在しない規則を参照させない)。
    + (omitMaxDistance
      ? 'は'
      : '、距離の上限(片レッグ200円以内/両レッグ幅400円以内)は')
    + ' **一切変わらない**(そのまま厳守すること)。\n'
    + '  ★バンドウォークは「価格の急変が起きるまで続く」と見なしてよいが、逆方向に強く反転したと判断したら'
    + ' 無理にこの向きへ入らず direction:"none" で見送ること。';
}

/** チャート画像を添付した時だけの注記。 */
export function buildVisionNote(hasImage: boolean): string {
  return hasImage ? '添付のチャート画像(当日の日経225先物のローソク足・主要水準・直近アラート)も判断材料にすること。\n\n' : '';
}

/** ★v0.7.56: AI に委任した knob だけ「この値はあなたが決める(自由・根拠を述べよ)」を動的に注入する。
 *  全 knob 手動(既定)なら '' を返す=system prompt は従来と byte 単位で不変。追記(additive)方式で、
 *  ai の knob については上の手動制約文を上書きする旨を明示する(コードの enforce も同時に制約を外す)。 */
export function buildDelegationNote(
  modes: KnobModes,
  // ★レンジ無効時に死んだ条項を出さない(2026-08-18): rangeEnabled は省略/true が既定(従来の呼び出しは
  //   全て挙動不変=byte 一致)。呼び出し側(buildScalpPlan)は実効の resolveEffectiveRangeEnabled を渡す。
  ctx: { floorYen: number; ceilingYen: number; hardMax: LcHardMax; rangeEnabled?: boolean },
): string {
  // ★AI委任は「制約を外すだけ」でなく、その項目が本来担っていた判断ロジック(狙い・基準・なぜ・使うデータ)を
  //   AI に正確に転写する。そうしないと AI は"意味を知らないまま自由になる"だけになる(=判断が盲目化する)。
  //   ※非公開の phase-exit の具体数値は書かない(公開リポ)。転写は定性的に留める。
  const rangeEnabled = ctx.rangeEnabled ?? true;
  const lines: string[] = [];
  if (modes.lcCeiling === 'ai') {
    // ★v0.9.56: 上の各所は委任時「下限〜実効上限の範囲」として提示済み(保存値は印字されない)ので、
    //   旧文「上の固定的なLC上限の数値指示は無視してよい」は宛先が消えた=矛盾になる。範囲の読み方に置き換える。
    const capYen = lcEffectiveCeiling({ ceilingYen: ctx.ceilingYen, ceilingMode: 'ai', lcHardMax: ctx.hardMax });
    const capLabel = ctx.hardMax.enabled ? '安全上限' : 'コード上限';
    const cap = ctx.hardMax.enabled
      ? `なお実弾の暴走防止として安全上限 ${ctx.hardMax.value}円 だけは絶対に超えないこと。`
      : '';
    lines.push(
      // ★v0.9.61(削除): 「損切りは **直近の節目**/スイングの外側に置き…妥当な幅を自分で決め」は、実測で判明した
      //   誤りそのもの(隣接=エントリーと同じ節目を損切りの基準にすると幅は数円にしかならない)を指示していた。
      //   併せて「節目/スイングの位置から損切り価格を先に決め、幅はその結果」も LC_DERIVATION_ORDER の弱い写しなので削る。
      `最大初期LC(損切り幅): あなたが決める。狙い=この建玉は利が乗ると段階的に利確し損切りを引き上げる決済方式のため、` +
      `初期LCは「1回の損切りが積み上げた利益を飛ばさない」幅に収める(コツコツドカン回避)。` +
      `上の各所に書いてある LC 幅「下限${ctx.floorYen}円〜${capLabel}${capYen}円」は **あなたが選べる範囲** であって、` +
      `その下限や上限に貼り付ける目安ではない。${cap}`,
    );
  }
  if (modes.lcFloor === 'ai') {
    // ★下限は委任できない(決済ロジックの前提条件)。設定が 'ai' でもコードは下限を強制するので、
    //   「自由に決めてよい」と誤解させないよう、委任の対象外であることをここで明示する。
    // ★v0.9.61(削除): 意味と理由の本文は lcFloorReason に一本化し、戦略仕様ブロックで **モードに依らず常時** 出す
    //   (旧実装はこの分岐の中だけに理由があり、運用機の設定=下限手動では一度も AI に届いていなかった)。
    //   ここに残すのは「委任にしても外れない」という、この分岐でしか言えない文脈だけ。
    lines.push(
      `初期LC下限: ★これは委任の対象外です。設定を「AI委任」にしても下限${ctx.floorYen}円は外れません` +
      `(意味と理由は上の【戦略ロジック仕様】の初期LC下限の項を参照し、そのとおり あなたが必ず満たすこと)。`,
    );
  }
  if (modes.trendVeto === 'ai') {
    lines.push(
      `トレンド/レンジの見極め: 固定の数値閾値は課さない=あなたが判定する。判断ロジック: 直近10〜30分がほぼ横ばいのときだけ「レンジ」とみなす。` +
      // ★レンジ無効時に死んだ条項を出さない(2026-08-18): 「上の2択」は rangeEnabled=true の時だけ質問文/system
      //   prompt に定義される(fade/breakout の組)。rangeEnabled=false ではこの参照先が無いので出さない
      //   (参照先の無い代名詞=このプロンプトで繰り返し事故を起こしている形)。
      (rangeEnabled
        ? `レンジと判断したときの取り方は上の2択に従うこと(上下の反応帯の幅が広ければ fade=両側指値の組 / 狭い横這いなら breakout=両側ブレイク新規の組。狭いレンジで逆張りしない)。`
        : '') +
      `直近が一方向に明確に動いていれば「トレンド」であり、それに逆行する新規(順トレンドの高値を売る/安値を買う戻り売買)は出さないこと。` +
      `★根拠: 生きたトレンドをフェードすると負ける(monitorの実データで勝率約2割・9年バックテストでも不利)ことが確認済み。` +
      `上で渡す「直近の勢い(10分/30分の値動き・MA20傾き・直近高安内の位置)」の数値を必ず根拠に使い、regime と confidence を自分で下すこと。` +
      `トレンドなら順張り(押し目/戻りの順張り or ブレイク新規(stopEntry))か direction:"none" で見送りにする。`,
    );
  }
  if (modes.bias === 'ai') {
    lines.push('売買方向(buy/sell): あなたが自由に決めてよい(バイアスの強制なし)。ただし明確な逆行トレンドには逆らわないこと(上のトレンド判断を優先)。');
  }
  if (modes.range === 'ai') {
    lines.push(
      'レンジ両面: 明確な方向性が無く上下に反応帯があると判断すれば range(両面=現在値の上下に1レッグずつ置く両面ストラドル)を提案してよい。' +
      '取り方は上の2択(fade=両側指値の組 / breakout=両側ブレイク新規の組)に従い、組は混ぜないこと。' +
      '★連敗が続いている(単方向のエントリーが機能していない)ときは、相場がレンジ(往復)で単方向が負け続けている可能性が高い。' +
      'その場合は上の「直近の成績(連敗)」を根拠に、range(両面)へ切り替えた方がよいかを必ず検討すること。' +
      'ただしトレンドが明確なら range にしない(生きたトレンドの両側フェードは不利=負ける)。真に横ばい/往復のときだけ range にする。');
  }
  if (modes.cooldown === 'ai') {
    lines.push('再エントリー: 決済直後でも明確な好機があれば提案してよい(クールダウンの強制なし)。ただし直近で損切りした直後に同じ理由で突入し直すことは避けること。');
  }
  if (lines.length === 0) return '';
  return '\n\n【AI委任(以下の項目はあなたの裁量。上のロジックを踏まえ、必ず根拠を述べること)】\n- ' + lines.join('\n- ');
}

// ─── ★戦略ラベル(v0.9.84・記録専用) ───────────────────────────────────────
//
// なぜ足すか: このプロジェクトの本体は ④AI が理由と共に提示 → ⑤結果を正確に記録 → ⑥それを AI に返す、
//   の学習ループである。いま⑥が返せるのは「直近の負け: buy 68940→68880 -60」だけで、
//   **何を狙って外したのか** が無いので AI は学びようがない。ラベルがあれば
//   「押し目 12件 勝率33%」の単位で返せる。
//
// ★前回の失敗(2026-08・実測)を踏まえた構造上の判断:
//   「なぜその向きか」を根拠文(rationale)に書かせる規則は **効かなかった**(理由の記載率 100%→100%、
//   ブレイク新規の採用率だけ 24%→8% に悪化)。原因は文言ではなく **箱** で、根拠文には既に LC幅の検算が
//   入っており、検算の例文は それ単体で完結する文なので AI は検算を書いて満たしたと判断して終わっていた
//   (中央値76字のうち検算76字・理由0字、98.1% が検算から書き始めていた)。
//   ⇒ 同じ箱に文言を足しても押し出されるだけ。よって **別の構造化フィールド** にする。
//
// ★提示の仕方(実測に基づく固着対策): 選択肢を見せると AI はそこに固着する(上限65円を印字→幅が60に固着、
//   下限55を強調→55に固着)。ラベルも同じ性質を持つはずなので、
//   ・番号を振らない(番号もアンカーになる)
//   ・順番に意味を持たせない(「まず〜を検討し」と書かない・語のグロスにも「上の」等の位置語を使わない)
//   ・例示に特定のラベルを使わない(使うのは偏りを生まない「その他」だけ)
//
// ★ラベル一覧は **設定や場面で出し入れしない**(ドテンが不許可の場面でも同じ7語を見せる)。
//   台帳の集計語彙が場面ごとに変わると、あとで母集団を揃えられなくなるため。
//
// ★★★ 分布が偏ったときの **第一容疑はアンカーであって相場ではない** ★★★
//   このブロックの外側(system prompt / 質問文 / strategySpec)には「押し目/戻り」と「ブレイク新規」が
//   **7箇所以上** 既出で、7ラベルのうちこの2つだけが強く刷り込まれている状態にある。
//   さらにラベルの並び順は固定で(再現性とテストのため意図的にそうしている)、先頭の語も有利になりうる。
//   よって「トレンド押し目・戻り」「ブレイク順張り」に偏った結果が出ても、それを相場の性質の
//   証拠として読まないこと。切り分けは 並び順を変えた版 / 語だけを変えた版 との対照で行う。
//   ★この偏りは今回の変更では解消できない(プロンプト全体の語彙に手を入れることになり、
//     走行中の A/B の主指標を動かす)。ここに容疑として残すだけにする。

/** ラベルと、その語が指す **相場の読み**(順序に意味は無い)。プロンプトと一覧の唯一の出所。 */
const SCALP_STRATEGY_LABEL_DEFS: readonly (readonly [label: string, gloss: string])[] = [
  ['トレンド押し目・戻り', '順張りで、節目まで引きつけて入る'],
  ['ブレイク順張り', '節目を抜けた方向へ乗る'],
  ['節目の逆張り', 'トレンドに逆らって、節目での反転を取る'],
  ['レンジ内', '横這いの上下端で取る'],
  ['バンドウォーク追随', 'バンドに沿った継続に乗る'],
  ['ドテン', '保有と逆へ転換する'],
  ['その他', 'ほかのどれでもない'],
] as const;

/** 戦略ラベルの候補(解析側が「既知/未知」を数えるための一覧。判定には使わない)。 */
export const SCALP_STRATEGY_LABELS: readonly string[] = SCALP_STRATEGY_LABEL_DEFS.map(([label]) => label);

/** どれにも当てはまらないときの語。★例示にはこの語だけを使う(偏りを生まない)。 */
export const SCALP_STRATEGY_OTHER = 'その他';

/** 受け取った値が一覧のラベルそのものか。★丸めるためではなく **数えるため** の関数
 *  (parse は一覧外の生値もそのまま残す=リストが現実と合っていないことを台帳に残す)。 */
export function isKnownScalpStrategy(v: string | undefined): boolean {
  return v !== undefined && SCALP_STRATEGY_LABELS.includes(v);
}

/** ★記録専用: 「この計画は何を狙ったのか」を 1語 + 1行 で残させる契約文(純関数)。
 *  v1 系(v1 / v1d / v1e)の共通の土台である scalpJsonInstruction が唯一の呼び出し元
 *  = 走行中の距離の上限の実験(v1 vs v1e)は両腕とも同じものを受け取る。 */
export function scalpStrategyContract(): string {
  return '\n★【この計画の読み(strategy / strategyWhy)】\n'
    + '  strategy には、この計画を出したときの **相場の読み** に最も近い語を、次の中から1つだけ選び、その語のまま書く。\n'
    + SCALP_STRATEGY_LABEL_DEFS.map(([label, gloss]) => `    ${label} … ${gloss}\n`).join('')
    // ★語の共有を切る(レビュー指摘): 以前ここは「引きつけて入る脚」と書いていたが、それは
    //   ラベル「トレンド押し目・戻り」の語釈(節目まで引きつけて入る)と同じ語だった。
    //   **毎回必ず現れる脚の説明** がラベルの語釈と同じ語だと、そのラベルへのアンカーになる。
    //   よってフィールド名に対応する中立な呼び名(指値の脚 / ブレイク新規の脚)に言い換える。
    // ★「常に2本で組まれる」とは書かない(レビュー指摘): 同じプロンプトの
    //   【指値・ブレイク新規の距離(必須)】は「片方だけ(指値のみ/ブレイク新規のみ)」を明示的に許しており、
    //   JSON 契約も不採用レッグは省略させる。**事実として誤り** なうえ、走行中の A/B の主指標
    //   (両レッグ同幅率)とレッグ採用率に直接触る文言になる=記録専用の追加が測定対象を動かす。
    + '  ★選ぶのは **相場の読み** であって、注文の型ではない。この仕組みの計画は'
    + '「指値の脚(limitEntry)」と「ブレイク新規の脚(stopEntry)」の2本で組みうるので、'
    + '脚の機械的な種類から strategy を決めることはできない。いまの相場をどう読んでその脚を置いたのかを書くこと。\n'
    + `  ★どの語にも当てはまらないと感じたら「${SCALP_STRATEGY_OTHER}」と書き、`
    + 'strategyWhy に **何を狙ったのか** を必ず書くこと(無理に近い語へ寄せない)。\n'
    + '  ★strategyWhy には、なぜその読みにしたのかを1行で書く(根拠文 rationale とは別に、必ず書く)。\n'
    // ★★★ この3行は「事実の記述」であって指示ではない。表示の実装を変えたら必ず一緒に直すこと ★★★
    //   経緯(同じ場所で事実が4度動いている。戻しではなく、そのつど実装が変わっている):
    //     v0.9.85 まで … 記録専用だった → 「あとで返すための記録である」と書いていた
    //     v0.9.86     … strategy / strategyWhy を画面(シグナル枠)に描くようにした
    //     v0.9.87     … 上に合わせて「そのままトレーダーの画面に表示され」に直した
    //     v0.9.88(1) … 脚のラベルをコードが導出するようになり(core/entryLabel.ts)、strategy が
    //                   目線行から落ちる場合ができた =「そのまま表示され」は また嘘 になった
    //     v0.9.88(2=ここ) … ★**どのラベルが落ちるかを書くのをやめた**。
    //   ★(2)の理由(測定の汚染を避ける):
    //     いったんは「順張り/逆張りに触れているラベルは表示されないことがある」と条件まで書いた。
    //     事実ではあるが、これは **どの選択肢が画面から消えるかを AI に名指しで教える** ことになる。
    //     strategy の分布は **測定対象** で(最頻ラベルは実測65%)、そこが動くと過去との比較が切れる。
    //     ★このブロックの外側には「押し目/戻り」「ブレイク新規」が既に7箇所以上あり、ラベルの偏りの
    //       第一容疑はもともとアンカーである(上のブロック参照)。**その真上に語を足すのは最悪の位置**。
    //     ⇒ 条件も、コードが出す語(押し目買い/戻り売り/ブレイク新規/順張り/逆張り)も **書かない**。
    //       AI はそれらのラベルを自分では書かないので、知っても出力は1ビットも変えられない
    //       = 伝える価値はゼロで、アンカーになる危険だけが残る。
    //   ★「画面にも出る」は残す(嘘にしないため)。「そのまま表示される」とは約束しない。
    //   ★書いてよいのは 事実だけ。「順張り/逆張りの語を避けろ」等の指示にはしない。
    + '  ★この2つがどう使われるか(事実):\n'
    + '    ・記録に残り、あとで「どの読みが当たり、どの読みが外れたか」を集計してあなたに返す。\n'
    + '    ・トレーダーの画面にも出るが、どう表示するかはコードが決める。\n'
    + '    ・注文の採否・価格・損切り幅には使わない。\n';
}

/** ★v0.9.89: 質問文Ｂの対応表(目線 → 注文タイプ)を、JSON のフィールドへ割り当てる契約(SSOT)。
 *
 *  ■ なぜ要るか
 *    質問文Ｂ(ユーザーの文面)は「Ｘの逆指値買い注文」のように **注文の言葉** で書かれている。
 *    一方 JSON は limitEntry / stopEntry / range.upper / range.lower という **フィールドの言葉** を使う。
 *    「Ａに応じた」を成立させるには両者の対応が要るが、それを質問文の中に散文で足すと
 *    ユーザーの文面を書き換えることになる。よって対応表はここ(契約)だけが持つ。
 *
 *  ■ 新しい概念は作っていない
 *    ア)レンジ抜け = 既存の breakout の組(両側 type:"stop")、イ)レンジ継続 = 既存の fade の組(両側 type:"limit")と
 *    **同じもの**。RangeLeg は元から脚ごとに side / type を持つので、脚ごとに売買方向が違うア/イは
 *    どちらもそのまま表現できる(新しいフィールドも新しい direction も要らない)。
 *
 *  ■ 上下2脚の関係(将来の予定を含む事実)
 *    上下の2脚は将来 OCO(片方が約定したら他方はキャンセル)になる予定。monitor の仮想取引側は
 *    既にそう振る舞う(advance のレンジ約定分岐で、片側が約定した時点でブラケットごと建玉に置き換わる)。
 *    ★レンジ両面は過去に実験して既定OFFにした経緯があるため、既定は OFF のままにしてある。 */
export function scalpOrderTypeContract(rangeEnabled: boolean): string {
  return '\n★【Ａに応じた注文タイプ(Ｂの対応表 → フィールド)】質問文Ｂの「上の価格Ｘ」「下の価格Ｙ」を、この対応で JSON のフィールドへ入れる。\n'
    // ★v0.9.90: 条件ラベルを Ａ と同じ語(ブル/ベア/レンジ)にする。★日本語ラベルと direction の値を
    //   **同じ括弧で隣接** させ、さらに同じ行に注文の side を並べる=ブル→buy→買い注文 が1行で閉じる。
    + '  ブル(direction:"buy")  … Ｘの逆指値買い注文=stopEntry(+lcWidthForStop) / Ｙの指値買い注文=limitEntry(+lcWidthForLimit)\n'
    + '  ベア(direction:"sell") … Ｘの指値売り注文=limitEntry(+lcWidthForLimit) / Ｙの逆指値売り注文=stopEntry(+lcWidthForStop)\n'
    + (rangeEnabled
      ? '  レンジ(direction:"range")  … アまたはイのどちらか一方を丸ごと選ぶ(組を混ぜない)。\n'
        + '   ア）レンジ抜け … Ｘの逆指値買い注文=range.upper{side:"buy",type:"stop"} / Ｙの逆指値売り注文=range.lower{side:"sell",type:"stop"}(=上の breakout の組)\n'
        + '   イ）レンジ継続 … Ｘの指値売り注文=range.upper{side:"sell",type:"limit"} / Ｙの指値買い注文=range.lower{side:"buy",type:"limit"}(=上の fade の組)\n'
      : '')
    + '  価格Ｘ・Ｙの説明は、そのＸ/Ｙが入ったフィールドに対応する entryWhyForLimit / entryWhyForStop に書く'
    + (rangeEnabled ? '(レンジは脚別の欄が無いので rationale に書く)' : '') + '。\n';
}

/** ★lcWhyFor* の注記(SSOT)。**judgment=false は v1 と byte 一致**(既定・実取引経路はここを通っても不変)。
 *
 *  ■ 何を測る腕か(v1f・2026-08-20)
 *    実測: LC の理由の箱(lcWhyForLimit / lcWhyForStop)が **8割 検算で埋まる**。
 *    仮説(機構): selfCheckNote が「その引き算を rationale に書き、答えと **lcWidthFor…** の数値が一致しているか」と
 *    言っており、新設の箱 **lcWhyFor…** と1文字違いで隣接している。★**宛先の取り違え** が疑われる。
 *
 *  ■ ★文面の決め方(ユーザー指示・逐語「rationaleに書いたのち、検算に類するものを削除」)
 *    最初の案は「検算は rationale に書くので、**ここには書かない**」だった。これは **禁止(否定文)** で、
 *    このプロジェクトは「数値や語は **否定文の中でも供給される**」という実測を持つ
 *    (v0.9.64: 「LC幅の下限に5円を足す という意味ではない」という否定文が 5 の供給源になっていた)。
 *    ⇒ **禁止をやめ、手順にする**。「書かない」ではなく「書いたのち、削除する」= 命令形の作業であって
 *      否定ではない(★この注記には 〜ない / 禁止 / 不可 の語が1つも無い)。
 *  ■ ★手順に「何を書くか」を必ず含める(削除だけで終わらせない)
 *    いまこの箱は **8割が検算** なので、検算を取り除くだけだと **理由が入るのではなく空になる**。
 *    よって ②で書く中身(根拠に選んだ節目と なぜそこか)を手順の真ん中に置く。
 *    ★これは新しい規則ではない: 【導出の順序】① が既に「損切りの根拠にする節目を選ぶ」と要求しており、
 *      この箱はその **答え** を書く場所だと言い直しただけ(新しい数値も長さの指示も新語も足していない)。
 *    ★①で rationale を名指しするのは **宛先の明示**(肯定形の割り当て)。rationale 側の検算要求は
 *      1文字も外していない(外すと損切りの符号ミスが3倍という実測がある)。
 *  ★同じことをコードでやる案(core/rationaleDisplay.ts の stripLcArithmetic を lcWhyFor* にも当てる)は
 *    **今回は入れない**: コードは確実だが **理由を増やさない**(空欄になるだけ)。この腕が測りたいのは
 *    「判断が書かれるようになるか」なので、プロンプトで測る。 */
export function lcWhyNote(field: 'lcWidthForLimit' | 'lcWidthForStop', judgment: boolean): string {
  return judgment
    ? `幅の根拠を書く欄。順序=①検算は rationale に書く →②この欄には根拠に選んだ節目と なぜそこかを書く`
      + ` →③この欄に残った検算に類する記述は削除して出す。${field} と対で省略`
    : `なぜ ${field} をその幅にしたか(日本語)。${field} と対で省略`;
}

// LLM に構造化 JSON を強制するための出力指示。JSON モード非対応プロバイダでも効くよう厳格な文言で指示し、パースで検証する。
// LC 幅注記に floor/ceiling を反映する(テスト可能なよう export)。
export function scalpJsonInstruction(
  refPrice: number,
  floorYen: number = DEFAULT_LC_FLOOR_YEN,
  ceilingYen: number = DEFAULT_LC_CEILING_YEN,
  rangeEnabled = true,
  // ★v0.9.56: 上限が AI委任のときだけ提示の形を変える(既定=手動=従来と byte 一致)。
  lcCeil: LcCeilingPresentation = LC_CEIL_MANUAL,
  // ★v1f(2026-08-20): lcWhyForLimit / lcWhyForStop の **注記だけ** を差し替える候補腕のフラグ。
  //   **既定 false = v1 と byte 一致**(実取引につながる経路は1ミリも動かない)。理由は lcWhyNote を参照。
  lcWhyJudgment = false,
): string {
  // ★v0.9.56 ①: LC 幅の書き方だけが手動(保存値)/委任(実効上限までの範囲)で分かれる。
  // ★v0.9.60: 旧文言「本来のストップ位置から+5円外側」をこのフィールド注記から撤去した。
  //   実測(2026-08-04)で落ちたレッグの LC幅は中央値 5円 で、指値レッグは lcFloor・ブレイク新規レッグは
  //   stopSide(=エントリーの上/下 5円)に固まっていた。これは「+5円外側」を **エントリー価格** に対して適用し、
  //   かつ「外側」を直前の『ブレイク新規は節目の0〜5円外側(抜ける方向)』と同じ向きに読んだ結果と完全に整合する。
  //   フィールドのすぐ隣にある注記は最も強く効くので、ここには **向きと幅の判定条件だけ** を置き、
  //   緩衝(+5円)の説明は LC_BUFFER_NOTE / LC_DERIVATION_ORDER 側に一本化する。
  const lcWidth = lcCeil.delegated
    ? `LC幅は${floorYen}〜${ceilingYen}円の範囲で節目から導いてあなたが決める`
    : `LC幅${floorYen}〜${ceilingYen}円`;
  // ★v0.9.70: 先頭の向きの説明(買いは下/売りは上)を撤去する。向きはコードが付けるので、AI が向きを
  //   気にする余地は無い(残すと「では価格を出すのか」という誤読を生む)。代わりに「正の数の幅」を先頭に置く。
  const lcNote = `正の数の幅[円]・${lcWidth}・${floorYen}円未満は不可・レッグ独立で${ceilingYen}円超は出さない・エントリーからの固定距離(建値の隣のティック等)で決めない`;
  const dirEnum = rangeEnabled ? `"buy" | "sell" | "none" | "range"` : `"buy" | "sell" | "none"`;
  // レンジ両面ストラドルの JSON 形(direction:"range" の時のみ)。数値は円単位の実数。
  const rangeShape = rangeEnabled
    ? `  "range": {                  // direction:"range"(レンジ両面ストラドル)の時のみ。現在値の上下に1レッグずつ\n` +
      // ★lcWidth の条件は上の lcWidthFor… と同一。ここに再掲しない(下限・上限の数値の印字回数を増やさない=固着対策)。
      `    "upper": { "side": "buy"|"sell", "type": "limit"|"stop", "entry": number, "lcWidth": number },  // entry は現在値超・lcWidth は損切りの幅(条件は上の lcWidthFor… と同じ)\n` +
      `    "lower": { "side": "buy"|"sell", "type": "limit"|"stop", "entry": number, "lcWidth": number }   // entry は現在値未満・lcWidth は損切りの幅(条件は上の lcWidthFor… と同じ)\n` +
      `  },\n`
    : '';
  return `最終的な回答は、次のスキーマに厳密に一致する JSON オブジェクトのみを出力してください(前後の説明文・コードフェンス・マークダウンは一切付けない)。\n` +
    `{\n` +
    `  "regime": "trend_up" | "trend_down" | "range" | "unclear",  // まず自分で現在の相場レジームを判定して入れる\n` +
    `  "confidence": number,        // このレジーム判断と計画への確信度(0〜100の整数)\n` +
    // ★v0.9.84(記録専用): 狙い(相場の読み)を1語 + 1行で。語の一覧と選び方は下の【この計画の読み】が持つ
    //   (フィールドの隣に一覧を並べると印字が増えて固着源になるため、ここは名前と役割だけにする)。
    `  "strategy": string,          // この計画の相場の読み(【この計画の読み】の語から1つ・その語のまま)\n` +
    `  "strategyWhy": string,       // なぜその読みにしたか(1行・日本語)\n` +
    `  "direction": ${dirEnum},  // none=見送り(良い場面が無い)。none の時は下の4フィールドは不要(rationale と refPrice のみ)${rangeEnabled ? '。range=レンジ両面(range フィールドを使い buy/sell 用の4フィールドは不要)' : ''}\n` +
    // ★v0.9.88(記録+表示): 理由の箱を **それが説明するフィールドの隣** に1つずつ置く。
    //   ★実験(同じ断面)で、箱が1つのとき1脚あたり59字 → 2つのとき107字(+81%)。
    //   文言ではなく **箱の数** が理由の量を決めているという読みによる(本番データでは未検証)。
    //
    // ★★★ なぜ「1行」と書かないのか(★戻さないこと。実測で否定済み) ★★★
    //   最初の版は既存 strategyWhy に倣って `(1行・日本語)` と書いていた。**これは新規に入れた語** で
    //   (既存フィールドの語彙の再利用ではあっても、新しい箱に新しく書いた指示であることに変わりはない)、
    //   検証台で `1行・` の3文字だけを変えた対照を取ったところ:
    //
    //       directionWhy 50→76 / entryWhyForLimit 33→47 / entryWhyForStop 35→50
    //       lcWhyForLimit 37→55 / lcWhyForStop 37→50   [文字]
    //       平均 38字 → 56字 = ★**+47%。5フィールドすべてが増えた(例外なし)**
    //
    //   そして ★**改行の混入は両パスとも0件(全72フィールド)** = 「1行」が防ぐはずのものは
    //   書かなくても起きなかった。払っていたのは理由の 47% だった。
    //   ⇒ このプロジェクトの既知の性質「プロンプトの数値/量の指示はアンカーとして効く」の一例。
    //   ★「改行されたら困る」は表示側で受ける(paintPanel が splitRationaleLines で行に分ける)。
    //     **指示で防ぐのではなく、起きても壊れない実装で受ける**(「起きなかった」は「起きない」ではない)。
    //   ★退行が無いことも同時に確認済み: LC検算は rationale に 6/6 残存・新5フィールドへの流出0件 /
    //     パース0失敗・欠損0・型違反0・位置12/12・10円未満0件・5円刻み違反0件。
    `  "directionWhy": string,      // なぜその direction にしたか(日本語)\n` +
    `  "limitEntry": number,        // 指値(押し目/戻り側の新規)。none/range または指値レッグ不採用(ブレイク新規のみ)の時は省略(lcWidthForLimit と対で省く)\n` +
    `  "entryWhyForLimit": string,  // なぜ limitEntry をその価格にしたか(日本語)。limitEntry と対で省略\n` +
    `  "stopEntry": number,         // ブレイク新規(ブレイク側の新規エントリー。損切りではない)。none/range またはブレイク新規レッグ不採用(指値のみ)の時は省略(lcWidthForStop と対で省く)\n` +
    `  "entryWhyForStop": string,   // なぜ stopEntry をその価格にしたか(日本語)。stopEntry と対で省略\n` +
    // ★v0.9.70: 損切りは **幅** だけ。価格のフィールドは無い(向きはシステムが direction から付ける)。
    `  "lcWidthForLimit": number,   // 指値約定時の損切りの幅(${lcNote})。指値レッグを出さない/none の時は limitEntry と対で省略\n` +
    `  "lcWhyForLimit": string,     // ${lcWhyNote('lcWidthForLimit', lcWhyJudgment)}\n` +
    `  "lcWidthForStop": number,    // ブレイク新規約定時の損切りの幅(${lcNote})。ブレイク新規レッグを出さない/none の時は stopEntry と対で省略\n` +
    `  "lcWhyForStop": string,      // ${lcWhyNote('lcWidthForStop', lcWhyJudgment)}\n` +
    // ★v0.9.87: 「なぜこの価格なのか」を数値で残す。**新しい規則は足さない**(節目への置き方は既に上で
    //   決まっている)。ここで求めるのは「その規則で **実際に使った節目の価格**」だけ。
    //   文章の枠を増やさないのが要点(根拠文は実測で LC検算に埋め尽くされ、増やしても押し出される)。
    // ★★★ v0.9.88 でこの判断を **転回** した(次に読む人が両方を根拠に反対の判断をしないよう明記する) ★★★
    //   v0.9.87 が言う「増やしても押し出される」は **1本の箱(rationale)の中で枠を取り合う話**。
    //   v0.9.88 が増やしたのは **箱そのもの**(directionWhy / entryWhyFor* / lcWhyFor*)で、
    //   取り合いが起きない別のフィールドに分けた。実測(同じ断面・箱の数だけを変えた比較)は
    //     散文211字 / 箱1つ 59字 / 箱2つ 107字(+81%)  ※1脚あたり
    //   で、パース失敗0・欠損0・型違反0・位置/種別/SLの向き 24/24。
    //   ⇒ **同じ箱の中に文章を足す(v0.9.87 が否定した手)は今も否定されたまま**で、
    //     v0.9.88 が是としたのは **箱を分けること** だけ。両者は矛盾しない。
    //   ★ただし本番データでは未検証(検証台の測定であって、実運用の理由の字数はまだ測っていない)。
    `  "limitLevel": number,        // 指値を置くときに使った節目の価格(その節目の値そのもの)。指値レッグを出さない/none の時は省略\n` +
    `  "stopLevel": number,         // ブレイク新規を置くときに使った節目の価格(同上)。ブレイク新規レッグを出さない/none の時は省略\n` +
    rangeShape +
    // ★v0.9.64: 幅の申告 → 代入の式の申告(置換)。フィールド直下の注記は最も強く効くので、
    //   ここでも「式の答え=出力する数値」を要求する。併せて「省略」の定義(キーを書かない)を1句だけ添える。
    `  "rationale": string,         // 判断理由(日本語)。none の時は見送り理由。★「省略」と述べたレッグは そのキー自体を出力しない\n` +
    `  "refPrice": number           // 計画時に見た現在値(${refPrice})\n` +
    `}\n` +
    // ★v0.9.89: 質問文Ｂの「Ａに応じたエントリー注文」を **契約の言葉** に翻訳した対応表。
    //   質問文は注文の言葉(Ｘ/Ｙ・指値/逆指値)で書かれており、どのフィールドに入れるかは書いていない。
    //   その割り当てを持つのはここ1箇所(散文で2度書かない)。新しい規則は1つも足していない
    //   =ユーザーが書いた対応表を、既存のフィールド名に対応づけただけ。
    scalpOrderTypeContract(rangeEnabled) +
    // ★v1 系(v1 / v1d / v1e)の共通の土台に置く=距離の上限の A/B は両腕とも同じものを受け取る。
    // ★位置(レビュー指摘): **最末尾には置かない**。このプロジェクトは「フィールド直下・末尾の注記が
    //   最も強く効く」と実測しており、最末尾は最強の recency 位置である。そこを記録専用のブロックが
    //   占めると、従来そこにあった `refPrice は…` が数百字の下に埋没し、**記録のための追加が
    //   取引の指示を押し下げる**。よって契約は refPrice の1文の **前** に置き、最後は従来どおりにする。
    scalpStrategyContract() + '\n' +
    `refPrice は ${refPrice} を使うこと。数値はすべて円単位の実数(引用符なし)。`;
}

/** レンジ脚のパース結果。★失敗も「なぜ落ちたか」を持つ:
 *  - 'missing'  = AI がその脚を出していない/形が壊れている(side/type/entry が読めない)。
 *  - 'lcWidthInvalid' = 脚は出したが **幅の値が使えない**(負・0・非有限・建値と同じ点になる)。
 *    ★v0.9.95: 旧 'geometry'。上下の位置が不正な脚(upper が現在値の下 等)と区別できなかったので分離した。
 *  ★この区別が無いと、AI が出した脚が台帳と画面で「AIが提案せず」と **虚偽に** 記録される。 */
export type RangeLegParse =
  | { ok: true; leg: RangeLeg; source: LcWidthSource; signCorrected?: boolean }
  /** side は読めた分だけ載せる(注記を「上部(売り指値)」のように具体的に書くため)。 */
  | { ok: false; reason: Extract<NoneReason, 'missing' | 'lcWidthInvalid'>; side?: 'buy' | 'sell'; entry?: number; lcWidth?: number; stopLoss?: number };

/** レンジ両面ストラドルの1レッグを検証する純関数(幅の出所つき)。side/type の enum・entry の有限性、
 *  および損切りの **幅**(lcWidth・正の数。無ければ旧形式 stopLoss=価格から復元)を確認する。
 *  幾何(現在値の上下)の判定は呼び出し側の責務。
 *  ★stopLoss(価格)は side から一意に導く=脚の side と逆向きの損切りは表現できない。 */
export function parseRangeLegDetail(v: unknown): RangeLegParse {
  if (typeof v !== 'object' || v === null) return { ok: false, reason: 'missing' };
  const o = v as Record<string, unknown>;
  if (o.side !== 'buy' && o.side !== 'sell') return { ok: false, reason: 'missing' };
  if (o.type !== 'limit' && o.type !== 'stop') return { ok: false, reason: 'missing' };
  const entry = typeof o.entry === 'number' && Number.isFinite(o.entry) ? o.entry : null;
  if (entry === null) return { ok: false, reason: 'missing' };
  // 幅の指定が **1つも無い** なら「提案していない」(missing)。在るのに使えないなら「値が不正」(geometry)。
  if (!hasLcField(o.lcWidth, o.stopLoss)) return { ok: false, reason: 'missing', side: o.side, entry };
  const lc = resolveLcWidth({ side: o.side, entry, width: o.lcWidth, legacyStopLoss: o.stopLoss });
  if (lc.widthYen === null || lc.source === undefined) {
    const bad: RangeLegParse = { ok: false, reason: 'lcWidthInvalid', side: o.side, entry };
    if (lc.rawWidth !== undefined) bad.lcWidth = lc.rawWidth;
    if (lc.rawStopLoss !== undefined) bad.stopLoss = lc.rawStopLoss;
    return bad;
  }
  const out: RangeLegParse = {
    ok: true,
    leg: { side: o.side, type: o.type, entry, stopLoss: stopLossFromWidth(o.side, entry, lc.widthYen) },
    source: lc.source,
  };
  if (lc.signCorrected) out.signCorrected = true;
  return out;
}

/** 後方互換の薄いラッパ(脚だけが要る呼び出し用)。 */
export function parseRangeLeg(v: unknown): RangeLeg | null {
  const r = parseRangeLegDetail(v);
  return r.ok ? r.leg : null;
}

const SCALP_REGIMES = new Set(['trend_up', 'trend_down', 'range', 'unclear']);

/** AI 自己レジームを寛容にパース(enum 外/非文字列は undefined)。記録のみ=後方互換。 */
export function parseAiRegime(v: unknown): AiPlan['regime'] {
  return typeof v === 'string' && SCALP_REGIMES.has(v) ? v as AiPlan['regime'] : undefined;
}

/** AI 確信度を寛容にパース(有限数を 0-100 にクランプ・非有限/非数値は undefined)。記録のみ=後方互換。 */
export function parseAiConfidence(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, v));
}

/** 記録専用の自由文フィールドを寛容にパースする共通部(非文字列・空白のみ → undefined)。
 *  ★rationale と同じ扱い(trim するだけ・上限は掛けない)。上限はこの層ではなく台帳側(planLedger)の
 *    責務で、ここで削ると「④の材料そのもの」を発生源で失う。 */
function parseAiRecordText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

/** 戦略ラベルを寛容にパース。★一覧に無い語も **そのまま残す**(その他へ丸めない)。
 *  丸めると「用意したラベルが現実と合っていない」という証拠が台帳から消えるため。記録のみ=後方互換。 */
export function parseAiStrategy(v: unknown): string | undefined {
  return parseAiRecordText(v);
}

/** 「なぜその読みにしたか」を寛容にパース(空/非文字列は undefined)。記録のみ=後方互換。 */
export function parseAiStrategyWhy(v: unknown): string | undefined {
  return parseAiRecordText(v);
}

/** ★v0.9.87: 「その価格の根拠にした節目」を寛容にパースする(記録+表示・ゲートには使わない)。
 *  受け付けるのは **有限で正の数** だけ。非数値/NaN/Infinity/0以下(および数字の文字列)は undefined。
 *  ★丸めない・クランプしない: 生値のまま残す(丸めると「AI が節目でない価格を書いた」という
 *    いちばん知りたい事実が消える)。妥当性(本当に節目か)は台帳で後から検証する。
 *  ★欠落・不正でも計画は落とさない(parseAiStrategy と同じ後方互換の扱い)。 */
export function parseAiLevelPrice(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v;
}

/** 損切り(stopLoss)がエントリーの正しい外側にあるか(幾何・向き検証)。純関数。
 *  買い(long)は損切りがエントリーの「下」、売り(short)は「上」に置く(建玉を保護する向き)。
 *  境界(stopLoss===entry=幅0)は実質ストップにならないので不正(false)。
 *  ★実害バグ対策: 買いなのに損切りが上(逆側)のプランは trade2 のサニティが拒否し実取引ゼロになる。
 *    発生源(parse/enforce)でこの向きを検証し、違反レッグを落とすことで仮想取引エンジンと実取引を一致させる。
 *  ★実体は core/stopGeometry.ts(損切りの向きの規約の唯一の権威)。ここは従来の import 面を保つ再輸出。 */
export { stopSideOk };

/** エントリーが refPrice の正しい側にあるか(幾何・純関数)。
 *  limit(指値=押し目/戻り): buy は現在値より下・sell は現在値より上。
 *  stop(逆指値=ブレイク追随): buy は現在値より上・sell は現在値より下。
 *  境界(entry===refPrice=距離0)は即約定=不正。refPrice 非有限は検証しない(true=従来通り通す)。
 *  ★実体は core/entryLabel.ts(エントリー位置の規約の唯一の権威)。ここは従来の import 面を保つ再輸出
 *    (stopSideOk と同じ形)。**挙動は1ビットも変えていない**(境界・非有限の扱いを含めて移設しただけ)。 */
export { entryPositionOk as entrySideOk };

/** LLM のテキスト応答から AiPlan を抽出・検証する純関数。refPrice は monitor 側の現在値で必ず上書きする。
 *  コードフェンスや前後の説明文が混じっていても最初の { … } を拾ってパースする。失敗時は { ok:false }。 */
/** ★v0.9.59: レッグが最終プランに残らなかった理由の表示文(SSOT)。**非公開の決済数値は一切書かない**
 *  (下限/上限は「設定の下限/上限」と呼ぶだけで、値は設定画面にしか出さない)。
 *  語彙は NoneReason をそのまま使う(新しい理由を作らない)。実際に現れるのは
 *  missing / stopSide / geometry(parse 段)と stopSide / lcFloor / lc / trend / bias(enforce 段)。 */
const LEG_DROP_REASON_TEXT: Record<NoneReason, string> = {
  missing:       'AIが提案せず',
  ai:            'AIが提案せず',
  stopSide:      '損切りがエントリーの逆側',
  // ★v0.9.95(ユーザー指摘「『または』でなく、不採用の理由を特定して」): geometry を
  //   **エントリーが現在値の逆側** に限定し、幅の値の不正は 'lcWidthInvalid' へ分けた。
  //   ★'missing'(AIが提案せず)には **絶対に入れない**: AI は提案しているので、台帳と画面が嘘をつく。
  geometry:      'エントリーが現在値の逆側',
  lcWidthInvalid: '損切り幅の値が不正',
  lcFloor:       '損切り幅が設定の下限より狭い',
  lc:            '損切り幅が設定の上限より広い',
  trend:         'トレンドに逆行',
  bias:          'バイアス設定と逆',
  stale:         '現在値が既にエントリーを通過',
  rangeDisabled: 'レンジ設定が無効',
  // ★v0.9.97: この2つは **サイクル全体** の理由でレッグ単位では起きない。ただし Record<NoneReason,…> は
  //   全キーを要求するので、画面に undefined を出さないため文言を持たせる(無音の失敗を作らない)。
  aFailed:       '目線の判断が得られず',
  aiSilent:      'AIが理由も価格も返さず',
};

/** ★列挙に無い値が来たときの表示(防御)。型で塞がれていても、画面に `undefined` を出す経路は残さない。
 *  「理由が読めなかった」ことは黙って空文字にせず、必ず1語で見えるようにする(無音の失敗を作らない)。 */
const LEG_DROP_REASON_UNKNOWN = '理由不明';

/** ★脱落理由の表示文(SSOT の唯一の入口)。方向レッグもレンジ脚もここだけを通る
 *  = 同じ reason は必ず同じ日本語になる(台帳の reason から画面の言葉へ辿れる)。 */
export function legDropReasonText(reason: NoneReason): string {
  return LEG_DROP_REASON_TEXT[reason] ?? LEG_DROP_REASON_UNKNOWN;
}

/** 「AI がそもそも出さなかった」理由。ここだけ『なし』と書き、それ以外は『出したが不採用』と書き分ける
 *  (ユーザーにとって意味が違う: 前者は AI の判断・後者はコードの検証で落ちた)。 */
const LEG_NOT_PROPOSED: readonly NoneReason[] = ['missing', 'ai'];

/** レッグ1本ぶんの脱落注記(短文・純関数)。 */
function legDropPhrase(name: '指値' | '逆指値', reason: NoneReason): string {
  const text = legDropReasonText(reason);
  return LEG_NOT_PROPOSED.includes(reason)
    ? `（${name}なし: ${text}）`
    : `（${name}は不採用: ${text}）`;
}

/** ★表示整合(v0.7.41 / 文面刷新 v0.9.59): 最終 plan に **残らなかった** レッグの理由を、日本語の短い注記に
 *  する純関数。パネルは plan.rationale をそのまま表示するため、AI の自由文が「出していないレッグ(逆指値等)を
 *  置いた」と語っても、この注記を末尾に足すことで表示が実プランと矛盾しないようにする。
 *  ★v0.9.59(ユーザー指示): 「（実際の注文: 指値+逆指値）」のような **プラン内容の言い直しは書かない**
 *    (画面のシグナル欄を見れば分かるため)。書くのは「なぜ片方が無いのか」だけ。
 *  - hasLimit/hasStop: 最終 plan に指値/逆指値レッグが入っているか(plan.limitEntry/stopEntry != null)。
 *  - drops: そのステージが記録した LegDrop 群(記録専用の配列をそのまま渡す=表示と記録が同じ理由を指す)。
 *  両レッグ揃っている / 落ちた理由が分からない場合は空文字を返す(追記しない)。private 定数は一切出さない。 */
export function buildLegNote(
  args: { hasLimit: boolean; hasStop: boolean; drops?: readonly LegDrop[] },
): string {
  const { hasLimit, hasStop, drops } = args;
  if (hasLimit && hasStop) return '';   // 両方あるなら説明することは無い(シグナル表示そのもの)。
  const reasonOf = (name: LegDrop['name']): NoneReason | undefined =>
    drops?.find(d => d.name === name)?.reason;
  const parts: string[] = [];
  if (!hasLimit) {
    const r = reasonOf('limit');
    if (r) parts.push(legDropPhrase('指値', r));
  }
  if (!hasStop) {
    const r = reasonOf('stop');
    if (r) parts.push(legDropPhrase('逆指値', r));
  }
  return parts.join('');
}

export function parseScalpPlan(raw: string, refPrice: number): ScalpPlanResult {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'empty response' };
  // ```json … ``` を剥がし、最初の { から最後の } までを候補にする。
  const fenced = text.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON object found' };
  let obj: unknown;
  try {
    obj = JSON.parse(fenced.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof obj !== 'object' || obj === null) return { ok: false, error: 'not an object' };
  const o = obj as Record<string, unknown>;
  if (o.direction !== 'buy' && o.direction !== 'sell' && o.direction !== 'none' && o.direction !== 'range') return { ok: false, error: 'invalid direction' };
  const rationale = typeof o.rationale === 'string' ? o.rationale.trim() : '';
  if (!rationale) return { ok: false, error: 'missing rationale' };
  // ★AI自己レジーム/確信度(記録のみ)。寛容にパースし、成立した全 plan(none/range/directional)に載せる。
  //   ゲートには使わない=既存の direction/価格の検証挙動は完全に不変。
  const regime = parseAiRegime(o.regime);
  const confidence = parseAiConfidence(o.confidence);
  // ★戦略ラベル(v0.9.84・記録のみ)。regime/confidence と **同じ形**: 欠落・不正・一覧外でも
  //   計画は落とさず undefined にして先へ進む(採否・価格・脚落ち・noneReason は1バイトも変わらない)。
  const strategy = parseAiStrategy(o.strategy);
  const strategyWhy = parseAiStrategyWhy(o.strategyWhy);
  // ★v0.9.87(記録+表示): 価格の根拠にした節目。strategy と **同じ形**=欠落・不正でも計画は落とさない。
  const limitLevel = parseAiLevelPrice(o.limitLevel);
  const stopLevel = parseAiLevelPrice(o.stopLevel);
  // ★v0.9.88(記録+表示): レッグごとの理由。strategyWhy と **完全に同じパース**
  //   (parseAiRecordText = 非文字列/空白のみは undefined・trim のみ)。
  //   ★欠落・不正でも計画は落とさない=採否・価格・脚落ち・noneReason は1バイトも変わらない。
  const directionWhy = parseAiStrategyWhy(o.directionWhy);
  const entryWhyForLimit = parseAiStrategyWhy(o.entryWhyForLimit);
  const entryWhyForStop = parseAiStrategyWhy(o.entryWhyForStop);
  const lcWhyForLimit = parseAiStrategyWhy(o.lcWhyForLimit);
  const lcWhyForStop = parseAiStrategyWhy(o.lcWhyForStop);
  const withMeta = (p: AiPlan): AiPlan => {
    if (regime !== undefined) p.regime = regime;
    if (confidence !== undefined) p.confidence = confidence;
    if (strategy !== undefined) p.strategy = strategy;
    if (strategyWhy !== undefined) p.strategyWhy = strategyWhy;
    if (limitLevel !== undefined) p.limitLevel = limitLevel;
    if (stopLevel !== undefined) p.stopLevel = stopLevel;
    // ★v0.9.88: レッグごとの理由。**在るときだけ付ける**=書かれなかった回の AiPlan は従来と byte 一致。
    //   ★レッグが落ちても理由は消さない: 「AI は出したがコードが落とした」回の理由こそ
    //   台帳に残す価値がある(落ちた理由は leg_drops_json と並べて読む)。
    if (directionWhy !== undefined) p.directionWhy = directionWhy;
    if (entryWhyForLimit !== undefined) p.entryWhyForLimit = entryWhyForLimit;
    if (entryWhyForStop !== undefined) p.entryWhyForStop = entryWhyForStop;
    if (lcWhyForLimit !== undefined) p.lcWhyForLimit = lcWhyForLimit;
    if (lcWhyForStop !== undefined) p.lcWhyForStop = lcWhyForStop;
    return p;
  };
  // ★見送り(direction:"none"): 価格は不要。rationale + refPrice のみで ok:true の正当な「見送り」応答。
  //   これはエラー(ok:false)ではない=plan-failed とは区別される。
  if (o.direction === 'none') {
    return { ok: true, plan: withMeta({ direction: 'none', rationale, refPrice }), noneReason: 'ai' };
  }
  // ★レンジ両面ストラドル(direction:"range"): range.upper / range.lower を各レッグ検証。
  //   幾何(upper.entry>refPrice>lower.entry)を満たさない/壊れているレッグは落とす。片レッグでも残れば range として通す。
  //   両レッグとも無効なら「見送り(none)」として ok:true を返す(エラーにはしない)。
  if (o.direction === 'range') {
    const rangeObj = typeof o.range === 'object' && o.range !== null ? o.range as Record<string, unknown> : {};
    // ★v0.9.70: 脚の損切りは幅(lcWidth)から side で導く。旧形式(stopLoss=価格)はフォールバックで
    //   大きさだけを使い、向きはコードが付ける(=side と逆向きの損切りは構造的に作れない)。
    const upperParse = parseRangeLegDetail(rangeObj.upper);
    const lowerParse = parseRangeLegDetail(rangeObj.lower);
    let upper = upperParse.ok ? upperParse.leg : null;
    let lower = lowerParse.ok ? lowerParse.leg : null;
    // ★v0.9.44(記録専用): 落とす前の生数値を控える。none 化したときログ1行に出す(採否には使わない)。
    const upper0 = upper;
    const lower0 = lower;
    // ★脱落理由の記録(表示専用・v0.9.37): AI の rationale は「上下両面に置いた」と語るのに画面は片側だけ、
    //   という「理由の無い片面」を無くす。落とす前の side を控え、enforcePlanConstraints と同じ流儀
    //   (rangeDropNote + \n 連結)で rationale に追記する。採否ロジック(何を落とすか)は一切変えない。
    //   ★v0.9.70: 脚が成立しなかった回も、読めた side は注記に使う(「上部(売り指値)は不採用」)。
    const upperSide0 = upper?.side ?? (upperParse.ok ? undefined : upperParse.side);
    const lowerSide0 = lower?.side ?? (lowerParse.ok ? undefined : lowerParse.side);
    // AI がそもそも脚を出さなかった(missing)のか、出したが **幅の値が使えない**(geometry)のかを書き分ける。
    // ★v0.9.70: 以前はどちらも 'missing'(=画面に「AIが提案せず」)にしていたため、AI が
    //   lcWidth:-55 を出した回まで「提案せず」と **虚偽に** 記録されていた(値も残らず件数も数えられなかった)。
    let upperReason: RangeDropReason | null = upperParse.ok ? null : upperParse.reason;
    let lowerReason: RangeDropReason | null = lowerParse.ok ? null : lowerParse.reason;
    // 現在値の上下の幾何を満たさないレッグは落とす(upper は現在値超・lower は現在値未満)。
    if (upper && !(upper.entry > refPrice)) { upper = null; upperReason = 'geometry'; }
    if (lower && !(lower.entry < refPrice)) { lower = null; lowerReason = 'geometry'; }
    // ★損切りの向き検証: 各レッグは自分の side を持つ → buy レッグは stopLoss<entry・sell レッグは stopLoss>entry。
    //   内側/反対側(境界=幅0 も)の損切りを持つレッグは落とす(不正プランを出さない)。幾何(向き)のみ=LC 幅は enforce の責務。
    if (upper && !stopSideOk(upper.side, upper.entry, upper.stopLoss)) { upper = null; upperReason = 'stopSide'; }
    if (lower && !stopSideOk(lower.side, lower.entry, lower.stopLoss)) { lower = null; lowerReason = 'stopSide'; }
    // ★v0.9.57(記録専用): 脚1本ごとの脱落を、**片脚だけ落ちた回でも** 構造化して残す(採否は不変)。
    //   ★v0.9.70: 脚が成立しなかった場合は parse 結果が持つ生の値(entry / 書かれた幅 / 書かれた価格)を残す。
    const rangeLegDrops: LegDrop[] = [];
    pushLegDrop(rangeLegDrops, 'upper', upperReason,
      upper0?.entry ?? (upperParse.ok ? undefined : upperParse.entry),
      upper0?.stopLoss ?? (upperParse.ok ? undefined : upperParse.stopLoss),
      upperParse.ok ? undefined : upperParse.lcWidth);
    pushLegDrop(rangeLegDrops, 'lower', lowerReason,
      lower0?.entry ?? (lowerParse.ok ? undefined : lowerParse.entry),
      lower0?.stopLoss ?? (lowerParse.ok ? undefined : lowerParse.stopLoss),
      lowerParse.ok ? undefined : lowerParse.lcWidth);
    // ★RECORD-ONLY: AI の生出力(落とす前の2脚)に対して申告 LC幅と実出力を突き合わせる。
    //   レンジ脚は根拠文の見出し(指値/ブレイク新規)で区別できないので、多くは undeclared(=読めなかった)になる。
    //   それでよい: 「一致」と「未申告」を混ぜないことが要件で、読めないものを読めたことにはしない。
    const rangeLcAudit = lcAuditFor(rationale, [
      { leg: 'upper', entry: upper0?.entry, stopLoss: upper0?.stopLoss, side: upperSide0, widthSource: upperParse.ok ? upperParse.source : undefined, signCorrected: upperParse.ok ? upperParse.signCorrected : undefined },
      { leg: 'lower', entry: lower0?.entry, stopLoss: lower0?.stopLoss, side: lowerSide0, widthSource: lowerParse.ok ? lowerParse.source : undefined, signCorrected: lowerParse.ok ? lowerParse.signCorrected : undefined },
    ]);
    if (!upper && !lower) {
      // 両脚とも落ちた見送り(none)は rationale を据え置く(enforce の両脚落ちと同じ既存挙動)。
      return {
        ok: true, plan: withMeta({ direction: 'none', rationale, refPrice }),
        noneReason: pickNoneReason(upperReason, lowerReason),
        noneLegs: noneLegsFromRange(upper0, lower0),
        legDrops: rangeLegDrops,
        ...(rangeLcAudit ? { lcAudit: rangeLcAudit } : {}),
      };
    }
    // 片脚だけ残って range を出す場合、落ちた脚の理由を rationale に明記(表示専用テキスト)。
    const notes: string[] = [];
    if (upperReason) notes.push(rangeDropNote('上部', upperSide0, upperReason));
    if (lowerReason) notes.push(rangeDropNote('下部', lowerSide0, lowerReason));
    const rangeRationale = notes.length ? `${rationale}\n${notes.join('\n')}` : rationale;
    const range: { upper?: RangeLeg; lower?: RangeLeg } = {};
    if (upper) range.upper = upper;
    if (lower) range.lower = lower;
    const rangeOut: Extract<ScalpPlanResult, { ok: true }> =
      { ok: true, plan: withMeta({ direction: 'range', rationale: rangeRationale, refPrice, range }) };
    if (rangeLegDrops.length) rangeOut.legDrops = rangeLegDrops;
    if (rangeLcAudit) rangeOut.lcAudit = rangeLcAudit;
    return rangeOut;
  }
  const num = (v: unknown): number | null =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const limitEntry = num(o.limitEntry);
  const stopEntry = num(o.stopEntry);
  // ★v0.9.70: LLM から受け取るのは損切りの **幅(正の数)** だけ。損切り価格はここでコードが符号を付ける。
  //   旧フィールド(価格)しか無い応答はフォールバックで **大きさだけ** を使う=先祖返りしても逆位置にならない。
  const dir = o.direction;
  const limitLc = resolveLcWidth({ side: dir, entry: limitEntry, width: o.lcWidthForLimit, legacyStopLoss: o.stopLossForLimit });
  const stopLc = resolveLcWidth({ side: dir, entry: stopEntry, width: o.lcWidthForStop, legacyStopLoss: o.stopLossForStop });
  const stopLossForLimit = limitEntry !== null && limitLc.widthYen !== null ? stopLossFromWidth(dir, limitEntry, limitLc.widthYen) : null;
  const stopLossForStop = stopEntry !== null && stopLc.widthYen !== null ? stopLossFromWidth(dir, stopEntry, stopLc.widthYen) : null;
  // ★レッグ単位の検証: 指値レッグ=limitEntry+lcWidthForLimit の対、逆指値レッグ=stopEntry+lcWidthForStop の対。
  //   各レッグは「両方あり」か「両方なし」のみ有効(片方だけは不整合=invalid)。少なくとも1レッグあれば ok。
  //   LC≤95 等の数値強制はここではしない(trade2 側の責務)。ここは幾何的なレッグ対の整合のみ。
  const hasLimitLeg = limitEntry !== null && stopLossForLimit !== null;
  const hasStopLeg = stopEntry !== null && stopLossForStop !== null;
  // 片側だけ埋まっているレッグ(対の不整合)は不正。★「在るか」は新旧どちらのフィールドでも数値なら在る。
  //   在るのに使えない(非有限/0以下の幅)場合は対の不整合ではなく、そのレッグを落とす(下の limitReason)。
  if ((limitEntry !== null) !== hasLcField(o.lcWidthForLimit, o.stopLossForLimit)) {
    return { ok: false, error: 'invalid limit leg (limitEntry/lcWidthForLimit must be paired)' };
  }
  if ((stopEntry !== null) !== hasLcField(o.lcWidthForStop, o.stopLossForStop)) {
    return { ok: false, error: 'invalid stop leg (stopEntry/lcWidthForStop must be paired)' };
  }
  // 両レッグとも欠落(direction≠none なのに価格皆無)は不正。
  if (!hasLimitLeg && !hasStopLeg) {
    return { ok: false, error: 'invalid price field(s): at least one leg required' };
  }
  // ★損切りの向き検証(orientation): buy は損切りが各エントリーの下・sell は上。境界(SL==entry=幅0)も不正。
  //   加えて★エントリー位置の向き検証(entrySideOk): refPrice(現在値=SSOT)に対し 指値/逆指値が正しい側にあるか。
  //   買いは 指値=現在値より下・逆指値=現在値より上/売りは 指値=現在値より上・逆指値=現在値より下(逆置きは即約定=不正)。
  //   レッグは stopSideOk と entrySideOk の両方を満たすときだけ有効。違反レッグは落とす(既存の「片レッグ落とし」と同じ
  //   機構=entry+SL を省く)。ここは幾何(向き)のみで、LC 幅≤上限の強制は enforce の責務(不変)。
  //   両レッグとも違反で落ちたら「見送り(none)」を ok:true で返す。
  const limitLegOk = hasLimitLeg && stopSideOk(o.direction, limitEntry!, stopLossForLimit!) && entryPositionOk(o.direction, 'limit', limitEntry!, refPrice);
  const stopLegOk = hasStopLeg && stopSideOk(o.direction, stopEntry!, stopLossForStop!) && entryPositionOk(o.direction, 'stop', stopEntry!, refPrice);
  // ★v0.9.44(記録専用): どの検証で落ちたかをレッグ単位で判定して残す(採否は不変)。
  //   検証順(stopSideOk → entrySideOk)に合わせ、レッグ不在=missing / SL 向き違反=stopSide / 残りは geometry。
  // ★v0.9.57: 判定を **両レッグ落ちの分岐の外** へ出した(値は従来と同一・null=そのレッグは落ちていない)。
  //   片レッグだけ落ちた回にも同じ理由が要るため。両レッグ落ちの分岐では従来どおり必ず非 null になる
  //   (=noneReason の値は一切変わらない)。
  // ★v0.9.70: stopSide('損切りがエントリーの逆側')は **発火しない**(向きは stopLossFromWidth が direction から
  //   一意に決め、導出価格が建値と同じ数になる幅は resolveLcWidth が無効にする)。それでも検証と理由を残すのは、
  //   発火したらそれが **コードのバグ** の証拠になるから(消すと将来の回帰が無言で通る)。テストで固定してある。
  // ★'missing' は **AI が出さなかった** レッグ専用。幅の欄に書いたが値が使えない(負・0・非有限・
  //   建値と同じ点になる)場合は 'geometry'(=出した値が不正)にする。ここを 'missing' にすると
  //   画面が「（指値なし: AIが提案せず）」と **虚偽** を語り、生の値も残らず件数すら数えられなかった。
  const limitProposed = limitEntry !== null || hasLcField(o.lcWidthForLimit, o.stopLossForLimit);
  const stopProposed = stopEntry !== null || hasLcField(o.lcWidthForStop, o.stopLossForStop);
  // ★v0.9.95: 「幅の値が使えない」を 'geometry' から **分離** した('lcWidthInvalid')。
  //   ここで一意に分けられる理由: 直前の対の整合チェックで「entry だけ在る/幅だけ在る」は ok:false で
  //   弾かれているので、この時点で !hasLimitLeg かつ 提案あり ⟺ **幅の値が使えなかった** だけになる
  //   (entry が非有限なら対の不整合として既に弾かれている)。よって残る 'geometry' は
  //   **エントリーが現在値の逆側** だけを指す(entryPositionOk 違反)。
  const limitReason: NoneReason | null =
    limitLegOk ? null
    : !hasLimitLeg ? (limitProposed ? 'lcWidthInvalid' : 'missing')
    : !stopSideOk(o.direction, limitEntry!, stopLossForLimit!) ? 'stopSide' : 'geometry';
  const stopReason: NoneReason | null =
    stopLegOk ? null
    : !hasStopLeg ? (stopProposed ? 'lcWidthInvalid' : 'missing')
    : !stopSideOk(o.direction, stopEntry!, stopLossForStop!) ? 'stopSide' : 'geometry';
  const legDrops: LegDrop[] = [];
  //   ★落とした生の値も残す: 導出できた損切り価格が無いときは、AI が幅の欄に書いた値(rawWidth)/
  //     旧形式で書いた価格(rawStopLoss)を載せる=後から「何を書いて落ちたか」を数えられる。
  pushLegDrop(legDrops, 'limit', limitReason, limitEntry, stopLossForLimit ?? limitLc.rawStopLoss, limitLc.rawWidth);
  pushLegDrop(legDrops, 'stop', stopReason, stopEntry, stopLossForStop ?? stopLc.rawStopLoss, stopLc.rawWidth);
  // ★RECORD-ONLY: 申告 LC幅 と 実出力 |entry − stopLoss| の突き合わせ。
  //   ★AI の **生の値**(この検証で落ちるレッグも、後段 enforce で lcFloor 落ちするレッグも含む)に対して行う。
  //   採否・価格・legDrops には一切影響しない(この配列を読む側は台帳だけ)。
  const lcAudit = lcAuditFor(rationale, [
    { leg: 'limit', entry: limitEntry, stopLoss: stopLossForLimit, side: dir, widthSource: limitLc.source, signCorrected: limitLc.signCorrected },
    { leg: 'stop', entry: stopEntry, stopLoss: stopLossForStop, side: dir, widthSource: stopLc.source, signCorrected: stopLc.signCorrected },
  ]);
  if (!limitLegOk && !stopLegOk) {
    return {
      ok: true, plan: withMeta({ direction: 'none', rationale, refPrice }),
      noneReason: pickNoneReason(limitReason, stopReason),
      noneLegs: noneLegsFromDirectional(o.direction, { limitEntry, stopLossForLimit, stopEntry, stopLossForStop }, false, false),
      legDrops,
      ...(lcAudit ? { lcAudit } : {}),
    };
  }
  // refPrice は LLM の自己申告ではなく monitor の現在値を正とする。
  // 存在し、かつ向きが正しいレッグの価格のみ plan に入れる(欠落/向き違反レッグは省略=undefined)。
  const plan: AiPlan = { direction: o.direction, rationale, refPrice };
  if (limitLegOk) {
    plan.limitEntry = limitEntry!;
    plan.stopLossForLimit = stopLossForLimit!;
  }
  if (stopLegOk) {
    plan.stopEntry = stopEntry!;
    plan.stopLossForStop = stopLossForStop!;
  }
  // ★表示整合: 実際に採用したレッグを rationale 末尾に機械生成の注記として追記(directional のみ)。
  //   採用の有無は最終 plan から判定。AI が出したが検証で落ちたレッグは「不採用」タグを付す。none/range 経路は
  //   触らない(上で return 済み)。
  // ★★注記を足すのはこの1箇所だけ=「parseScalpPlan は AI の生応答に対して1回だけ呼ぶ」ことが前提(呼び出し側の責務)。
  //   注記済みの plan を JSON 化して再度この関数に通すと、注記は当然もう1回付く(=二重)。実際 v0.9.46 まで
  //   buildScalpPlan が「runScalpPlan(内部で parse 済) → JSON.stringify → parseScalpPlan」と2回通していたため、
  //   画面の根拠文が『（実際の注文: 指値のみ…）（逆指値レッグは…不採用） （実際の注文: 指値のみ…）』と二重になっていた
  //   (レンジ側も、既に落ちた脚が2回目には「AIが提示しなかった」と誤って追記されていた)。再 parse そのものを廃止して解消。
  //   ここで文字列を見て「もう付いているか」を判定するような対症療法はしない(生 rationale を汚さない)。
  // ★v0.9.59: 注記の理由は **記録用の legDrops と同じ配列** から引く(表示と台帳が同じ理由を指す)。
  const legNote = buildLegNote({
    hasLimit: plan.limitEntry != null,
    hasStop: plan.stopEntry != null,
    drops: legDrops,
  });
  if (legNote) plan.rationale = `${rationale} ${legNote}`;
  // ★v0.9.57(記録専用): 片レッグだけ落ちた回の理由を構造化して返す。上の buildLegNote は日本語の
  //   表示文にしかしないので、台帳では「AI が出さなかった(missing)」と「向き違反で落とした
  //   (geometry/stopSide)」が区別できなかった。plan・rationale・採否は一切変えない。
  const out: Extract<ScalpPlanResult, { ok: true }> = { ok: true, plan: withMeta(plan) };
  if (legDrops.length) out.legDrops = legDrops;
  if (lcAudit) out.lcAudit = lcAudit;
  return out;
}

/** マルチモーダルなユーザメッセージ content を組み立てる。画像があればテキスト+image_url の配列、
 *  無ければ従来どおりプレーン文字列(テキストのみ)を返す。OpenAI/Gemini(OpenAI 互換)共通形式。
 *  data URL は `data:image/png;base64,<...>`。テスト可能な純関数。 */
export function buildScalpUserContent(userPrompt: string, imageDataUrl?: string | null): any {
  if (!imageDataUrl) return userPrompt;
  return [
    { type: 'text', text: userPrompt },
    { type: 'image_url', image_url: { url: imageDataUrl } },
  ];
}

/**
 * ★「200 は返ったが、その応答からは計画が作れなかった」ことを **診断のためだけに** 名乗る例外。
 *
 * ■ providers.ts の UnusableResponseError と **意図的に別の型** にしている(2026-08-11 の決定)
 *   あちら(翻訳が使う)は tripCircuit が拾って「ポーズせず **次のプロバイダへ**」に落とす型。
 *   こちらは **フォールバックさせない**。tripCircuit はこの型を知らないので classifyLLMError(null)
 *   → callWithFallback の「429以外は再投げ」枝 → 1番目のプロバイダで打ち切る = **従来と完全に同じ挙動**。
 *
 * ■ ★なぜフォールバックさせないのか(頻度を測った結果・ここが要点)
 *   台帳 signal_plans 全1198件(2026-08-04〜08-11 の8日間)の内訳:
 *       400 invalid temperature ... 411件  ← v0.9.73(classifyLLMError に 400 を追加)で解決済み
 *       parse failed after retry ...  1件  ← この経路
 *       空応答 / no response ......... 0件
 *   **8日で1件**。しかもその1件が「別のモデルなら正しい JSON を返した」保証は無い。
 *   一方フォールバックの代償は:
 *     ・全滅時の外部呼び出しが 1サイクル 2回 → **最大 8回**(プロバイダ4 × (tool ループ + 厳格な再要求))
 *     ・★400 と違い、空応答/壊れた JSON は **トークンを実際に消費する**(400 は消費ゼロで即返る)
 *     ・planning ロックが4系列ぶん延びて次のサイクルが押し出される。**この経路に独自のタイムアウトが無い**
 *   そして払うのは「全滅が常態化したとき」= まさに事故の再発時。旧実装が1回で打ち切る場面で8回叩く
 *   = **事故のときに最も高くつく**。頻度1/1198 に対して代償が見合わないので、**入れない**。
 *   ★「400 と同型の穴が残っている」という構造の話だけで動くと、この判断を取り違える(一度取り違えた)。
 *     直す前に台帳で頻度を測ること。
 *
 * ■ では何を直したのか = **無音**
 *   この経路は失敗しても [LLM:*] の warn が1行も出なかった(tripCircuit が false で抜けるため)。
 *   1件しか起きないからこそ、起きた1件の原因が分からないと詰む。だから buildScalpPlan が
 *   **この型のときだけ** 1行 warn を出す(下の catch)。外部呼び出しは1回も増えない。
 *
 * firstLen / retryLen … 初回・再要求それぞれの応答の文字数。**本文は載せない**
 *   (モデルの生出力には非公開の決済ロジックの数値が混じりうる=同期フォルダ経由で機外へ出る)。
 *   長さだけで「空応答(0)」と「中身はあるが壊れた JSON(>0)」を区別できる。
 */
export class ScalpPlanUnparsableError extends NoFallbackError {
  constructor(message: string, readonly firstLen: number, readonly retryLen: number) {
    super(message);
    this.name = 'ScalpPlanUnparsableError';
  }
}

/** スキャルプラン生成の純ループ(LLM 非依存=テスト可能)。tool ループで回答→parse、失敗なら tools 無しで
 *  厳格に1回だけ再要求→再parse。成功で **parse 結果まるごと**(plan + noneReason/noneLegs)、失敗で例外。
 *  ★parseScalpPlan はこの関数の中でしか呼ばない=AI の生応答1つに対して parse は必ず1回(注記も1回)。
 *   呼び出し側(buildScalpPlan)は戻り値をそのまま使い、plan を JSON 化して再 parse してはならない(v0.9.46 の
 *   注記二重付与の真因)。create/handlers を注入してテストする。
 *  imageDataUrl を渡すと初回・再要求ともにチャート画像を添付する(ビジョン対応プロバイダ時のみ呼び出し側で渡す)。 */
export async function runScalpPlanResult(
  create: CreateFn, systemPrompt: string, userPrompt: string,
  tools: unknown[], handlers: ToolHandlers, refPrice: number,
  imageDataUrl?: string | null,
): Promise<Extract<ScalpPlanResult, { ok: true }>> {
  const userContent = buildScalpUserContent(userPrompt, imageDataUrl);
  const baseMessages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const first = await runChatWithTools(create, baseMessages, tools, handlers);
  const parsed = parseScalpPlan(first, refPrice);
  if (parsed.ok) return parsed;
  // パース失敗 → 厳格に1回だけ再要求(tools 無し・JSON のみ)。
  const retry = await create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
      { role: 'assistant', content: first },
      { role: 'user', content: `直前の応答は指定 JSON スキーマに一致していません(${parsed.error})。説明やコードフェンスを一切付けず、スキーマに厳密一致する JSON オブジェクトだけを出力し直してください。` },
    ],
  });
  const retryText = retry.choices?.[0]?.message?.content?.trim() ?? '';
  const parsed2 = parseScalpPlan(retryText, refPrice);
  if (parsed2.ok) return parsed2;
  // ★投げる型は ScalpPlanUnparsableError(= providers.ts の UnusableResponseError では **ない**)。
  //   意味: 「診断のために種別は名乗るが、**フォールバックはしない**」。理由はクラス定義のコメント。
  //   message は1バイトも変えない(台帳 signal_plans.error / trade2 の monitorError= に流れる既存の診断語彙)。
  throw new ScalpPlanUnparsableError(`parse failed after retry: ${parsed2.error}`, first.length, retryText.length);
}

/** runScalpPlanResult の薄いラッパ(後方互換)。plan だけを返す=既存の呼び出し/テストは不変。 */
export async function runScalpPlan(
  create: CreateFn, systemPrompt: string, userPrompt: string,
  tools: unknown[], handlers: ToolHandlers, refPrice: number,
  imageDataUrl?: string | null,
): Promise<AiPlan> {
  return (await runScalpPlanResult(create, systemPrompt, userPrompt, tools, handlers, refPrice, imageDataUrl)).plan;
}

export interface ScalpPlanInput {
  symbol?: string;
  prices?: Price[];
  news?: NewsItem[];
  technical?: string | null;
  /** チャート画像(data URL: `data:image/png;base64,<...>`)。渡されるとビジョン対応プロバイダに添付する。 */
  chartImageDataUrl?: string | null;
  /** 初期 LC(損切り)幅の下限[円]。未指定は monitor 設定(resolveScalpLcFloorYen・既定55)。
   *  ★設定値より **低い値は受け付けない**(clampRequestedLcFloor で床止め)。厳しくする方向のみ有効。
   *  プロンプトに反映され、かつ enforcePlanConstraints で実強制される(下限未満のレッグを落とす)。 */
  lcFloorYen?: number;
  /** 初期 LC(損切り)幅の上限[円]。未指定は monitor 設定(resolveScalpLcCeiling・既定65)。プロンプト指示＋コードで強制。 */
  lcCeilingYen?: number;
  /** エントリー方向のバイアス。未指定は monitor 設定(resolveScalpBias・既定'none')。'long'=売り新規veto / 'short'=買い新規veto。 */
  bias?: ScalpBias;
  /** レンジ両面ストラドルを許可するか。未指定は monitor 設定(resolveScalpRangeEnabled・既定true)。false=range を出させない/万一出ても none 化。 */
  rangeEnabled?: boolean;
  /** 生きたトレンド(勢い)のヒント。runner が barsFor から computeRegime で算出して渡す。
   *  strong のときトレンドに逆行するフェード新規を enforcePlanConstraints が落とす。未指定は veto なし(現行挙動)。 */
  trend?: TrendHint;
  /** ★v0.8.2: 設定プロファイル。未指定/'A'=グローバル設定(=現行挙動と byte 一致・実取引A) /
   *  'B'=System B の独立設定(signalB 優先→未設定はグローバルへフォールバック)。各 knob の解決だけが切り替わる。 */
  profile?: SignalProfile;
  /** ★ドテン(保有中の反転評価=held-eval)。渡すとプロンプトに保有中の建玉を注入し「反転が妥当な場面だけ反対 direction を返してよい」
   *  と促す。未指定(flat-plan)は注入なし=systemPrompt は従来と byte 一致。dotenEnabled=false は engine が呼ばないので常に未指定。 */
  heldPosition?: { dir: 'buy' | 'sell'; entry: number };
  /** ★レンジ再評価(未約定→ブレイク)。ARMED のレンジ両指値(fade)が平均約定所要を超えて未約定のとき、engine が渡す。
   *  渡すとプロンプトに「両逆指値(ブレイク追随)へ切替えてよい/現状維持/direction:none」の判断を促す。
   *  未指定(通常)は注入なし=systemPrompt は従来と byte 一致。rangeReevalEnabled=false は engine が渡さないので常に未指定。 */
  armedContext?: { mode: 'range-fade'; ageMs: number; avgMs: number };
  /** ★呼び出し元(LLM プロバイダ・プールの選択キー)。未指定は 'default' = 従来と完全に同じ経路・同じ状態。
   *  'generator'(分析用の分析用)のときだけ generator プールを使い、その 429 は default を止めない。
   *  ★プロンプト・パース・enforce には一切影響しない(どのプールを使うかだけが変わる)。 */
  caller?: LlmCaller;
  /** ★決済仕様の「名前付き変種」。**未指定は従来どおり**(describeExitLogic() を使う=プロンプト byte 不変)。
   *  指定するとその変種の決済仕様説明を AI に渡す(分析用の分析用②が候補仕様で提案させるため)。
   *  ★名前だけを受け取り、実数値は非公開側(signalTrade/exit/private.ts)が解決する=数値は外に出ない。
   *  ★プロンプトの決済ブロック **だけ** が変わる。parse/enforce/実際の決済計算には一切影響しない
   *    (実取引の決済は常に現行仕様の computeExitStop が算出する)。 */
  exitVariant?: ExitVariant;
  /** ★v0.9.75: 質問文の変種。**未指定は 'v1' = 従来と byte 一致**(実取引につながる全経路は不変)。
   *  'v2' のとき user プロンプト(質問文＋JSON契約)だけが差し替わる。system プロンプト・parse・enforce・
   *  実際の決済計算には一切影響しない。★ExitVariant とは **別の軸** なので、同時に指定してよい。 */
  promptVariant?: PromptVariant;
  /** ★v0.9.100(A/B 分割): **A(目線)に渡す文脈**。節目・アラート・長期高安を外したもの(abContext.buildTrendContext)。
   *  ★分割が無効なときは使われない。有効なのに未指定なら A は文脈なしで走る(嘘の文脈を渡さない)。 */
  technicalForTrend?: string | null;
  /** ★v0.9.100(記録専用): A/B 分割で得た測定材料を呼び出し側へ返す。段5 で台帳へ落とす。 */
  onSplitRecord?: (r: SplitRecord) => void;
  /** ★v0.9.100(A/B 分割): BB スクイーズ判定の生値と、使えなかった理由。版の選択に使う。 */
  squeezeState?: SqueezeState;
  squeezeUnavailable?: string;
  /** ★v0.9.61: バンドウォークの判定結果(server/bandwalk.ts)。runner が算出して渡す。
   *  成立中のときだけプロンプト末尾に緩和注記(buildBandwalkNote)を足す。
   *  未指定/null(非成立)では systemPrompt は従来と **byte 一致**(緩和は一切起きない)。 */
  bandwalk?: Bandwalk | null;
  /** ★RECORD-ONLY: 組み上がったプロンプトの **指紋** を1回だけ受け取るコールバック(未指定なら何もしない)。
   *  ・渡すのは `sp1:<16桁hex>` の指紋だけ。**本文は関数の外へ出さない**(非公開の決済仕様が本文に入るため)。
   *  ・プロンプトの中身・採否・価格・parse・enforce には一切影響しない(呼ぶだけ)。
   *  ・LLM 呼び出しの **前** に1回呼ぶ(どのプロバイダが答えたかに依存しない=同じ入力なら同じ指紋)。 */
  onPromptFingerprint?: (fingerprint: string) => void;
}

/** トレンド veto に渡す最小形。openai を signalTrade/regime に依存させないため、Regime 全体ではなく
 *  {dir,strong} のみ受ける(構造的タイピング)。strong=false または未指定なら veto は完全に無効(現行挙動一致)。 */
export interface TrendHint { dir: 'up' | 'down' | 'flat'; strong: boolean; }

/** AIエントリー制御のハード適用(純関数・最終保証)。monitor 設定の最大初期LC(ceilingYen)・バイアス(bias)・
 *  生きたトレンド(trend)をコードで強制する。プロンプト指示の保険ではなく確定的保証。
 *  合成順は **トレンド veto → バイアス veto → LC上限 → 空なら none**(トレンド veto を先行ステージとして追加)。
 *  0. トレンド veto: trend.strong のとき、トレンドに逆行する side の脚を落とす。
 *     dir='up' → side='sell' を落とす(上昇の高値を売らない)/ dir='down' → side='buy' を落とす。
 *     directional(buy/sell)は side=direction なので、逆行なら plan 全体を direction:'none' にする(順行は維持)。
 *     range は各脚の side で個別に落とす(強上昇なら上=売り指値を落とし、下=買い側を残す=実質片面)。
 *     trend 未指定 or !strong は null=無効で、以降は従来と完全一致(後方互換)。
 *  1. LC上限: 各レッグの初期LC幅 = |entry − stopLoss| が ceilingYen を「超える」ならそのレッグを落とす(境界=ちょうどは許可)。
 *     両レッグとも落ちたら direction:'none'(見送り)。
 *  2. バイアス: bias='long' かつ direction='sell' → 'none' / bias='short' かつ direction='buy' → 'none' / 'none'は素通し。
 *  direction==='none' は何もしない。 */
/** ★v0.7.56: LC安全上限(policy とは独立の安全系)。enabled のとき手動/AI とも超過レッグを落とす。 */
export interface LcHardMax { enabled: boolean; value: number; }

/** ★v0.7.58: 戦略ロジックを「定数込みで完全に」AI へ渡す仕様ブロック。エントリー全定数(LC/±5円/50円距離/
 *  トレンド閾値/クールダウン/バイアス/レンジ)＋各項目の委任状態(手動=固定 / AI=あなたが決める)＋決済ロジック
 *  (phase-exit の実数値・describeExitLogic は private が在れば実数値・無ければ定性)を1ブロックに集約する。
 *  「何を委任するか」は設定に従い【】で明示する(委任=制約を外すだけでなくロジックを渡す)。純関数。 */
export interface StrategySpecInput {
  floor: { mode: KnobSource; value: number };
  ceiling: { mode: KnobSource; value: number };
  trendVeto: { mode: KnobSource; value: number };
  cooldown: { mode: KnobSource; value: number };
  bias: { mode: KnobSource; value: ScalpBias };
  range: { mode: KnobSource; value: boolean };
  hardMax: LcHardMax;
  exitDesc: string;   // describeExitLogic()(private 在れば実数値つき)
  /** ★v1d(2026-08-17): 「最低距離(現在値から50円)」の箇条書きを **1行だけ** 落とす。
   *  未指定/false = 従来と byte 一致。距離の上限(400/200)の行はこのフラグでも残る。
   *  ★v1d は実測で悪化(不採用)につき候補腕からは降りたが、フラグ自体は残す(過去台帳・テスト用)。 */
  omitMinDistance?: boolean;
  /** ★v1e(2026-08-18): 「指値・ブレイク新規の距離の**上限**(片レッグ200円/両レッグ幅400円)」の箇条書きを
   *  **1行だけ** 落とす。未指定/false = 従来と byte 一致。最低距離50円の行はこのフラグでも残る
   *  (v1d の実測で「最低距離は消すと悪化=効いている」と決着済みのため=同時に2つ動かさない)。 */
  omitMaxDistance?: boolean;
}
function knobTag(mode: KnobSource): string {
  return mode === 'ai' ? '【AI委任=あなたが決めてよい】' : '【手動=固定・厳守】';
}
/** ★LC下限のタグ。下限は委任対象外(常に強制)なので mode を取らない固定文にする。
 *  ★v0.9.61: 旧 '【強制=委任対象外・コードで必ず適用】' は **責任の所在を外に置いていた**。上限には
 *  【手動=固定・厳守】と「厳守」があるのに、下限だけ「コードで必ず適用」=「あなたが守らなくてもシステムがやる」
 *  と読める形で提示されていた(実測: 自己検算に幅を入れた後でも下限割れ 61件/日)。コードが強制する事実は残すが、
 *  それが免責に読まれないよう「あなたが必ず満たす」を先頭に置く。 */
const LC_FLOOR_TAG = '【最優先・厳守=あなたが必ず満たす(AI委任にしても外れない)】';
/** ★バイアスの提示(純関数・SSOT)。委任(mode==='ai')のときは **保存値を印字しない**。
 *  最大初期LC の resolveLcPresentation と同じ手当て。委任した項目の保存値を見せると
 *  「買い中心【AI委任=あなたが決めてよい】」+ 委任ノート「売買方向: あなたが自由に決めてよい」= 正面から矛盾する
 *  プロンプトになる(実測)。委任時に実際に効いている値は 'none'(方向veto なし)なので、保存値は宛先が無い。 */
export function biasSpecLabel(bias: ScalpBias, mode: KnobSource): string {
  if (mode === 'ai') return 'あなたが決める(買い/売り/両方向のどれでもよい)';
  return bias === 'long' ? '買い中心(売り新規は見送り)' : bias === 'short' ? '売り中心(買い新規は見送り)' : '両方向';
}
export function buildStrategySpec(i: StrategySpecInput): string {
  const cap = i.hardMax.enabled ? `安全上限 ${i.hardMax.value}円(有効=手動でもAIでも絶対に超えない)` : '安全上限 無効';
  // ★v0.9.56: 上限が AI委任のときは保存値を印字しない。実効上限(安全上限 or 背骨)を範囲として提示する。
  const lcPres = resolveLcPresentation({
    floorYen: i.floor.value, ceilingYen: i.ceiling.value, ceilingMode: i.ceiling.mode, lcHardMax: i.hardMax,
  });
  const lcLine = lcPres.ceil.delegated
    ? `- 初期LC(損切り)幅: 下限${i.floor.value}円${LC_FLOOR_TAG} / 上限=あなたが決める${knobTag(i.ceiling.mode)} / ${cap}`
      + `。★提示する許容範囲は 下限${i.floor.value}円〜${lcPres.ceil.capLabel}${lcPres.ceilingYen}円。この範囲の中から相場構造(節目/スイングの位置)に応じて選ぶこと(下限や上限に貼り付ける目安ではない)`
    : `- 初期LC(損切り)幅: 下限${i.floor.value}円${LC_FLOOR_TAG} / 上限${i.ceiling.value}円${knobTag(i.ceiling.mode)} / ${cap}`;
  const biasLabel = biasSpecLabel(i.bias.value, i.bias.mode);
  return [
    '',
    '【戦略ロジック仕様(完全版・定数込み)】以下のロジックと数値をすべて理解した上で計画すること。各項目末尾の【】は現在の委任設定(手動=固定・厳守 / AI=あなたが決めてよい)。AI委任の項目はその値を自分で決め、手動の項目は記載の値・ルールを厳守する。',
    '■ エントリー',
    lcLine,
    // ★v0.9.61: 「コードが自動で落とす」だけの書き方をやめる(免責に読める)。責任は AI 側にあると先に言い、
    //   意味と理由(lcFloorReason)は **モードに依らず常に** ここで出す(旧実装は委任時しか出していなかった)。
    // ★v0.9.70: 絶対値表記 |エントリー − 損切り| を撤去(損切りの価格は出力に存在しない)。幅そのものの不等式にする。
    `- ★初期LC下限(${i.floor.value}円)は あなたが必ず満たす条件: 損切りの幅(lcWidthFor…) ≥ ${i.floor.value}円 をレッグごとに独立に満たすこと。`
      + `${lcFloorReason(i.floor.value)}`
      + `満たせないレッグは出さないこと。`,
    // ★v0.9.56 ②③: +5円 が何に加わるのか / 導出の順序(節目 → ストップ位置 → 幅)。A(委任)・B(手動)で完全に同一。
    // ★v1d(2026-08-17): この1行が「最低距離」の3箇所目。落とすときは **行ごと** 消す
    //   (空文字を残すと join('\n') が空行を作り、距離以外の見た目も変わってしまう=1変数でなくなる)。
    ...(i.omitMinDistance
      ? []
      : ['- 指値/ブレイク新規は現在値からそれぞれ最低 50円 離す(この最低距離は buy/sell のみ。range の各レッグには適用しない=レンジは上下の反応帯の位置で決める)']),
    // ★v0.9.44: 語彙は system prompt / question と統一する(stopEntry=ブレイク新規 / stopLossFor*=損切り)。
    //   ただし spec は「設定値＋委任タグ」が役割なので、規則の全文は重複させず不等式(最重要)だけを置く
    //   (用語の区別・ブレイク新規の置き場所・出力前の自己検算は system prompt と question に完全な形で入る)。
    '- ★最優先: 価格の向き(無条件・例外なし) 現在値(refPrice)に対して次の不等式を必ず満たすこと。'
      + ' 売り: stopEntry < refPrice < limitEntry / 買い: limitEntry < refPrice < stopEntry。'
      + '節目・トレンド・ニュースなど他のどんな理由よりもこの不等式を優先する。この不等式を満たさない数値は出力しないこと。'
      + '言い換えると 買いは 指値=現在値より下 / ブレイク新規=現在値より上、売りは 指値=現在値より上 / ブレイク新規=現在値より下。逆に置くと即約定・不正なので厳禁',
    // ★v0.9.60: 損切りの向きも spec に置く。従来この spec には SL の向きが1文も無く(=不等式はエントリーだけ)、
    //   「同じことが3箇所に書かれるエントリー」と「1箇所も無い損切り」で指示の格が決定的に違っていた。
    `- ${SL_SIDE_RULE}`,
    // ★v0.9.60(圧縮): 末尾の『★選んだ節目に置いた結果が…』は、規則の全文(どちら側の節目を選び直すかの
    //   例示)を system prompt と question が持つので、spec では結論の1文だけに縮める。
    // ★v0.9.61(圧縮): [買い=サポート+5〜10円 / 売り=…]の内訳は system prompt と question が完全な形で持つ重複。
    //   spec は数値(5〜10 / 0〜5)と「外側」の2義の切り分けだけを残す。
    // ★v0.9.63(削除): 「※この『外側』は抜ける方向の意味で、損切りの『外側』(建玉を守る向き)とは別物」は question に
    //   同じ1文が残る(spec の役割は設定値＋委任タグで、規則の全文は system/question が持つ=このファイル内の既存方針)。
    // ★v0.9.64: ブレイク新規のずらし量(0〜5円)を撤去=量を持たない表現へ(question / system prompt と同じ理由)。
    // ★v0.9.92: 3箇所目の位置の規則も **同じ構造(Ｃ)** に揃える。方向の語は使わない=位置は Ｘ/Ｙ が持つ。
    '- ★Ｃ: Ｘ・Ｙ の価格の決め方(位置の規則・現在価格(refPrice)だけを基準にする。内側=現在価格に近づく向き / 外側=現在価格から遠ざかる向き): Ｘ(現在価格より上に置く注文)=現在価格より上の節目を1つ選び、指値なら その 5〜10円 内側 / ブレイク新規(stopEntry)なら その すぐ外側(量は決めない)。Ｙ(現在価格より下に置く注文)=現在価格より下の節目を1つ選び、同じ規則を適用する。狙う節目ちょうどには置かない。選べる節目が無ければ その脚を省く',
    // ★v0.9.60(削除): 『逆張り指値の節目選び』(約190字)も system prompt と question に同文が入る重複。
    //   spec 自身のコメントが宣言しているとおり、規則の全文は system/question が持ち、spec は設定値＋委任タグを担う。
    // ★v0.9.61(圧縮): 距離ルールの不等式の再掲(直上の『最優先: 価格の向き』と同文)と括弧内の理由づけを外し、
    //   spec には数値の上限(400/200)と条件語(片方だけ・間)だけを残す。
    // ★v1e(2026-08-18): この1行が「距離の上限」の3箇所目。落とすときは **行ごと** 消す
    //   (omitMinDistance と同じ作法。空文字を残すと join('\n') が空行を作る)。
    ...(i.omitMaxDistance
      ? []
      : ['- ★指値・ブレイク新規の距離(必須): 両方を出すときは現在値が2つの価格の間に入るように置き、指値とブレイク新規の価格差は400円以内。片方だけ(指値のみ/ブレイク新規のみ)を出すときは、その1本を向き通りに置いた上で現在値から200円以内に収める']),
    // ★v0.9.64: 逆向き(省略と述べたら価格を出さない)を1文だけ足す。規則の全文は system prompt / question が持つ。
    '- ★rationale(説明文)は実際に出力したレッグだけ説明すること(両方向): 出していないレッグを「置いた」と書かない。「省略する」と述べたレッグは その対のフィールドを JSON に書かない=省略とはフィールドを出さないこと',
    // ★v0.9.61(圧縮): 合議の3条件の書き下しは system prompt / question の【レジーム/勢い】に同内容がある。
    //   spec には閾値の数値(±X / ±2X)と禁止事項・委任タグだけを残す。
    `- トレンド判定: 10分・30分・MA20傾き の合議(10分で±${i.trendVeto.value}円以上 / 30分で±${i.trendVeto.value * 2}円以上)でトレンド`
      + `=それに逆行するフェード新規(順トレンドの高値売り/安値買いの戻り売買)は禁止。`
      + `10分と長い時間軸が逆向きなら どちらとも断定せず見送り(direction:"none")を基本にする。`
      // ★存在しない安全網を委任時に告げない(2026-08-18): 「コード側の自動見送り」は手動(mode==='manual')かつ
      //   閾値>0のときだけ実在する(委任時はこの数値veto自体が無効=閾値0。実測: veto_fired は全プランで0)。
      //   委任または値0のときは、この1文を出さない(手動に戻せば従来どおりの文言に戻る)。
      //   knobTag は文の有無に関わらず常に出す(委任状態の表示は別の役割=既存テスト固定)。
      + (i.trendVeto.mode === 'manual' && i.trendVeto.value > 0
        ? `※自動見送り(veto)は直近10分の±${i.trendVeto.value}円だけで判定する=長い時間軸のトレンドに逆行しないのはあなたの判断による`
        : '')
      + knobTag(i.trendVeto.mode),
    `- クールダウン: 決済後 ${i.cooldown.value}秒 は再エントリー抑止${knobTag(i.cooldown.mode)}`,
    `- バイアス: ${biasLabel}${knobTag(i.bias.mode)}`,
    `- レンジ両面(direction:"range"=現在値の上下に1レッグずつ置く両面ストラドル): ${i.range.value ? '有効' : '無効'}${knobTag(i.range.mode)}`,
    // ★レンジ無効時に死んだ条項を出さない(2026-08-18): range 自体を禁止しているのに、range だけの距離規則
    //   (上下2本/片面の距離)を出すのは、禁止した機能の規則を無条件で語ることになる。i.range.value(実効の
    //   range 許可)が真のときだけ出す(range OFF では従来この行が無条件に残っていた=死んだ条項)。
    ...(i.range.value
      ? ['- ★レンジの距離: 上下2本(upper/lower)を出すときは 上と下の価格差を400円以内にする(幅が広すぎるレンジは出さない)。片方だけのレンジは その1本を現在値から200円以内に置く']
      : []),
    '■ 決済(この建玉の決済逆指値はこう動く=エントリー計画時に前提とすること)',
    i.exitDesc,
  ].join('\n');
}

/** enforce の opts。ceilingMode/lcHardMax は v0.7.56 の追加(いずれも省略時は現状=manual/上限なし)。
 *  - ceilingMode: 'manual'(既定)→設定した上限で落とす / 'ai'→設定上限は外すが、実効上限は
 *    lcHardMax(有効時)、無効なら LC_YEN_MAX まで残る(★上限が完全消滅することはない)。
 *  - lcHardMax: 有効時は ceilingMode に関係なく |entry−SL| が value 超のレッグを落とす(最後の安全網)。
 *  - floorYen: ★初期LC幅の**下限**(円)。渡すと下限未満のレッグを落とす。**委任(scalpLcFloorSource)の
 *    対象外**=AI委任でも必ず効く(下限は設定の好みではなく、決済ロジックが成立するための前提条件)。
 *    省略すると下限判定は一切行わない(=旧挙動。直呼びの既存テスト/呼び出しは不変)。 */
export interface EnforceOpts {
  ceilingYen: number;
  bias: ScalpBias;
  trend?: TrendHint;
  ceilingMode?: KnobSource;
  lcHardMax?: LcHardMax;
  floorYen?: number;
}

export function enforcePlanConstraints(plan: AiPlan, opts: EnforceOpts): AiPlan {
  // 後方互換の薄いラッパ。挙動(返る plan)は enforcePlanConstraintsReport と完全一致=既存の全呼び出し/テスト不変。
  return enforcePlanConstraintsReport(plan, opts).plan;
}

/** ★実効上限[円](純関数)。「委任すると上限がゼロになる」穴を塞ぐための単一の真実。
 *  - 安全網(lcHardMax)が有効ならその値、無効なら **LC_YEN_MAX(=設定として受理しうる LC 幅の絶対上限)** を背骨に使う。
 *  - ceilingMode==='ai'(委任): 設定した上限は外す(委任の意味は保つ)が、上の背骨は残す=上限は完全には消えない。
 *  - ceilingMode!=='ai'(手動・既定): 設定上限と背骨の **厳しい方**。
 *  既定(mode 省略=manual・lcHardMax 省略)では ceilingYen(≤LC_YEN_MAX)そのもの=従来と完全一致。 */
export function lcEffectiveCeiling(opts: { ceilingYen: number; ceilingMode?: KnobSource; lcHardMax?: LcHardMax }): number {
  const backstop = opts.lcHardMax?.enabled ? opts.lcHardMax.value : LC_YEN_MAX;
  return opts.ceilingMode === 'ai' ? backstop : Math.min(opts.ceilingYen, backstop);
}

/** ★v0.7.56: レッグの初期LC幅 w が「広すぎ」でドロップ対象か(境界=ちょうどは許可)。
 *  実効上限は lcEffectiveCeiling に一本化した(委任時も背骨が残る)。 */
export function lcLegExceeds(w: number, opts: { ceilingYen: number; ceilingMode?: KnobSource; lcHardMax?: LcHardMax }): boolean {
  return w > lcEffectiveCeiling(opts);
}

/** ★レッグの初期LC幅 w が「狭すぎ」(下限未満)でドロップ対象か(境界=ちょうど下限は許可)。
 *  floorYen 未指定/非有限/0以下では常に false(=下限判定なし・旧挙動)。
 *  ★この判定に委任(mode)の分岐は無い。下限は「AI に委任できる好み」ではなく、決済ロジック
 *  (含み益が一定に達して初めて利益ロックの床が発動する)が成立するための前提条件だから。
 *  下限より狭い初期LCは床が発動する前に被弾しやすく、決済ロジックが構造的に働かない。 */
export function lcLegBelowFloor(w: number, opts: { floorYen?: number }): boolean {
  const f = opts.floorYen;
  return typeof f === 'number' && Number.isFinite(f) && f > 0 && w < f;
}

/** レンジ脚がコード側で落とされた理由(rationale 明記用)。
 *  trend/lc/bias は enforcePlanConstraints(制約適用)由来、geometry/missing は parseScalpPlan(AI応答の検証)由来、
 *  stopSide は両方で起きうる(parse で落ちた脚は enforce では既に無いので注記は重複しない)。
 *  ★語彙は NoneReason の部分集合(別の列挙を作らない)。 */
type RangeDropReason = Extract<NoneReason, 'trend' | 'stopSide' | 'lc' | 'lcFloor' | 'bias' | 'geometry' | 'lcWidthInvalid' | 'missing'>;

/** 脱落したレンジ脚の位置(上部/下部)・side・理由から、rationale へ追記する注記文を組み立てる。
 *  例: `※下部(買い指値)は不採用: バイアス設定と逆` / `※上部(売り指値)は不採用: 損切り幅が設定の上限より広い`。
 *  テキスト整形のみ(取引ロジックには一切関与しない)。
 *
 *  ★v0.9.66(語彙の統一): 理由の日本語は **方向レッグと同じ文字列**(legDropReasonText)を使う。
 *    以前はここだけ別系統の短縮語(`SL向き不正` / `LC下限未満` / `トレンド逆行` …)を持っていたため、
 *    同じ reason が画面で2つの言葉に見え、台帳の reason から画面へ辿れなかった。
 *    レンジ固有の文脈(どちらの脚か・side)は **前置き** で表し、理由の部分は1文字も変えない。
 *  ★引数 reason は NoneReason 全体を受ける(型の外の値=未来の理由が来ても
 *    `undefined` を画面に出さない。legDropReasonText が必ず1語を返す)。
 *  ★bias の向き(買い優先/売り優先)は文言に出さない: 方向レッグ側が出していないため
 *    (出すと同じ reason が再び2つの言葉になる)。向きは設定画面と台帳(settings_json)に在る。 */
export function rangeDropNote(
  pos: '上部' | '下部',
  side: 'buy' | 'sell' | undefined,
  reason: NoneReason,
): string {
  const text = legDropReasonText(reason);
  // AI がそのレッグを出していない(欠落/壊れた形)場合は side が無いので、位置だけの専用文にする。
  //   方向レッグの `（逆指値なし: AIが提案せず）` と同じ書き分け(『なし』= AI の判断 / 『不採用』= コードの検証)。
  if (LEG_NOT_PROPOSED.includes(reason)) return `※${pos}のレッグなし: ${text}`;
  const sideLabel = side === 'sell' ? '売り指値' : side === 'buy' ? '買い指値' : '指値';
  return `※${pos}(${sideLabel})は不採用: ${text}`;
}

/** enforcePlanConstraints と同一の enforce を行い、さらに **トレンド veto が発火したか(vetoFired)** を surface する
 *  (v0.7.54・計測フック)。返る plan は enforcePlanConstraints と byte 単位で同一(挙動不変)。
 *  vetoFired=true は「トレンド veto ステージが 脚を落とした or plan 全体を none に強制した」場合のみ。
 *  LC上限/バイアス由来の drop/none は vetoFired に含めない(veto の効き目だけを計測するため)。 */
export function enforcePlanConstraintsReport(
  plan: AiPlan,
  opts: EnforceOpts,
): { plan: AiPlan; vetoFired: boolean; noneReason?: NoneReason; noneLegs?: NoneLegs; legDrops?: readonly LegDrop[] } {
  if (plan.direction === 'none') return { plan, vetoFired: false };
  const { ceilingYen, bias, trend, ceilingMode, lcHardMax, floorYen } = opts;
  // ★v0.7.56: レッグの LC 幅ドロップ判定(mode 分岐 + 安全網)。既定(引数省略)は従来と完全一致。
  const lcExceeds = (w: number): boolean => lcLegExceeds(w, { ceilingYen, ceilingMode, lcHardMax });
  // ★LC 下限の実強制。floorYen 省略なら常に false=旧挙動。委任(mode)の分岐は無い=強制が委任に勝つ。
  const lcBelow = (w: number): boolean => lcLegBelowFloor(w, { floorYen });
  // 上限超(広すぎ)/下限未満(狭すぎ)の判定を1つにまとめる。落とし方は上限側と同じ=**そのレッグを落とす**。
  //   クランプ(下限まで損切りを広げる)にしない理由: AI が選んだ損切り位置は「節目/スイングの外側」という
  //   根拠に紐づく。機械的に広げると、誰も検証していない価格に損切りを置き直すことになり、しかも
  //   下限未満のレッグは「節目からの距離の見立てそのものが崩れている」= 幅だけ直しても前提は直らない。
  const lcReason = (w: number): 'lc' | 'lcFloor' | null =>
    lcExceeds(w) ? 'lc' : lcBelow(w) ? 'lcFloor' : null;

  // ★トレンド veto(最優先ステージ): 生きた強トレンドに逆行する side を落とす。
  //   up→sell を落とす / down→buy を落とす。trend 未指定 or !strong なら null=無効(現行挙動と完全一致)。
  const dropSide: 'buy' | 'sell' | null =
    trend && trend.strong
      ? (trend.dir === 'up' ? 'sell' : trend.dir === 'down' ? 'buy' : null)
      : null;

  // ★レンジ両面ストラドル: 各レッグに (0)トレンド veto・(a)LC上限・(b)バイアス veto を独立適用。両レッグ落ちたら none、
  //   片レッグ残れば その単レッグの range(=実質片面)として通す。既存の buy/sell 強制とは別経路。
  if (plan.direction === 'range') {
    let upper = plan.range?.upper;
    let lower = plan.range?.lower;
    // ★v0.9.44(記録専用): 落とす前の生数値を控える。両脚落ち=none のときログ1行に出す(採否には使わない)。
    const upper0 = upper;
    const lower0 = lower;
    // ★脚の脱落理由を記録(rationale 明記用)。AI の rationale は両脚を説明するが、以降のコード側 drop で
    //   片脚だけ表示される場合に「なぜ消えたか」を rationale に追記する。表示ロジック/脚/価格/veto は不変。
    const upperSide0 = upper?.side;
    const lowerSide0 = lower?.side;
    let upperReason: RangeDropReason | null = null;
    let lowerReason: RangeDropReason | null = null;
    // (0) トレンド veto: トレンドに逆行する side の脚を落とす(bias/LC より先)。存在した脚を落としたら vetoFired。
    let vetoFired = false;
    if (dropSide) {
      if (upper?.side === dropSide) { upper = undefined; vetoFired = true; upperReason = 'trend'; }
      if (lower?.side === dropSide) { lower = undefined; vetoFired = true; lowerReason = 'trend'; }
    }
    // (a') 向きの二重防御: 損切りがエントリーの内側/反対側(境界=幅0 含む)のレッグを落とす(parse で落ちている想定=冪等)。
    //      これはトレンド veto ではないので vetoFired には計上しない(veto の効き目だけを計測する)。
    if (upper && !stopSideOk(upper.side, upper.entry, upper.stopLoss)) { upper = undefined; upperReason = 'stopSide'; }
    if (lower && !stopSideOk(lower.side, lower.entry, lower.stopLoss)) { lower = undefined; lowerReason = 'stopSide'; }
    // (a) 初期LC幅 |entry−stopLoss| が上限超 or 下限未満のレッグを落とす(境界=ちょうどは許可)。
    //     ★v0.7.56: 上限は manual→ceilingYen 超 / ai→実効上限(安全網 or LC_YEN_MAX)まで緩む。
    //     ★下限は委任に関係なく常に強制(floorYen を渡した時のみ=直呼びの既存経路は不変)。
    if (upper) {
      const r = lcReason(Math.abs(upper.entry - upper.stopLoss));
      if (r) { upper = undefined; upperReason = r; }
    }
    if (lower) {
      const r = lcReason(Math.abs(lower.entry - lower.stopLoss));
      if (r) { lower = undefined; lowerReason = r; }
    }
    // (b) バイアス veto: long→sell レッグ落とし / short→buy レッグ落とし。
    if (bias === 'long') {
      if (upper?.side === 'sell') { upper = undefined; upperReason = 'bias'; }
      if (lower?.side === 'sell') { lower = undefined; lowerReason = 'bias'; }
    } else if (bias === 'short') {
      if (upper?.side === 'buy') { upper = undefined; upperReason = 'bias'; }
      if (lower?.side === 'buy') { lower = undefined; lowerReason = 'bias'; }
    }
    // ★v0.9.57(記録専用): 脚1本ごとの脱落を、**片脚だけ落ちた回でも** 構造化して残す(採否は不変)。
    //   ここで理由が付くのは「enforce が受け取った時点で在った脚」だけ(上の各分岐が脚の存在を確認している)。
    const rangeLegDrops: LegDrop[] = [];
    pushLegDrop(rangeLegDrops, 'upper', upperReason, upper0?.entry, upper0?.stopLoss);
    pushLegDrop(rangeLegDrops, 'lower', lowerReason, lower0?.entry, lower0?.stopLoss);
    // 両脚とも落ちたら none(既存挙動: rationale は元のまま据え置き)。
    if (!upper && !lower) {
      return {
        plan: { direction: 'none', rationale: plan.rationale, refPrice: plan.refPrice }, vetoFired,
        noneReason: pickNoneReason(upperReason, lowerReason),
        noneLegs: noneLegsFromRange(upper0, lower0),
        ...(rangeLegDrops.length ? { legDrops: rangeLegDrops } : {}),
      };
    }
    // 片脚だけ残って range を出す場合、落ちた脚の理由を rationale に明記(表示専用テキスト)。
    const notes: string[] = [];
    if (upperReason) notes.push(rangeDropNote('上部', upperSide0, upperReason));
    if (lowerReason) notes.push(rangeDropNote('下部', lowerSide0, lowerReason));
    const rationale = notes.length
      ? `${plan.rationale}\n${notes.join('\n')}`
      : plan.rationale;
    const range: { upper?: RangeLeg; lower?: RangeLeg } = {};
    if (upper) range.upper = upper;
    if (lower) range.lower = lower;
    return {
      plan: { direction: 'range', rationale, refPrice: plan.refPrice, range }, vetoFired,
      ...(rangeLegDrops.length ? { legDrops: rangeLegDrops } : {}),
    };
  }

  // ★directional(buy/sell): leg side === direction。逆行(dropSide===direction: 強上昇の sell / 強下降の buy)なら
  //   plan 全体を見送り(none)に。順行はそのまま以降の LC・バイアス処理へ進む。
  if (dropSide && dropSide === plan.direction) {
    return {
      plan: { direction: 'none', rationale: plan.rationale, refPrice: plan.refPrice }, vetoFired: true,
      noneReason: 'trend',
      // レッグ自体は妥当でも plan 全体が veto されるので ok:false(=最終プランに残らなかった)で記録する。
      noneLegs: noneLegsFromDirectional(plan.direction, plan, false, false),
    };
  }

  const out: AiPlan = { ...plan };

  // 1. レッグ単位の LC 上限(境界=ちょうどは許可)+ 向きの二重防御。上限超 or 向き違反のレッグは対で落とす。
  //    向き(stopSideOk): directional は leg side === direction。損切りが内側/反対側(境界=幅0 含む)なら落とす
  //    (parse で落ちている想定=冪等)。既に向きが正しい正常プランには影響しない。
  const limitOk =
    out.limitEntry != null && out.stopLossForLimit != null &&
    lcReason(Math.abs(out.limitEntry - out.stopLossForLimit)) === null &&
    stopSideOk(plan.direction, out.limitEntry, out.stopLossForLimit);
  const stopOk =
    out.stopEntry != null && out.stopLossForStop != null &&
    lcReason(Math.abs(out.stopEntry - out.stopLossForStop)) === null &&
    stopSideOk(plan.direction, out.stopEntry, out.stopLossForStop);
  if (!limitOk) { out.limitEntry = undefined; out.stopLossForLimit = undefined; }
  if (!stopOk) { out.stopEntry = undefined; out.stopLossForStop = undefined; }

  // ★v0.9.57(記録専用): 片レッグだけ落ちた回も理由を残す。**enforce が受け取った時点で在ったレッグだけ**
  //   を対象にする(parse で既に落ちた/AI が出さなかったレッグはここでは何も落としていない=二重に数えない。
  //   その 'missing' は parse 段の legDrops が持っている)。判定順は下の legReason と同一。
  const dirForLegDrop = plan.direction;
  const dropReason = (ok: boolean, entry?: number, sl?: number): NoneReason | null =>
    ok || entry == null || sl == null ? null
    : !stopSideOk(dirForLegDrop, entry, sl) ? 'stopSide'
    : lcReason(Math.abs(entry - sl)) ?? 'lc';
  const legDrops: LegDrop[] = [];
  pushLegDrop(legDrops, 'limit', dropReason(limitOk, plan.limitEntry, plan.stopLossForLimit), plan.limitEntry, plan.stopLossForLimit);
  pushLegDrop(legDrops, 'stop', dropReason(stopOk, plan.stopEntry, plan.stopLossForStop), plan.stopEntry, plan.stopLossForStop);
  const legDropsField = legDrops.length ? { legDrops } : {};

  // 両レッグ落ちたら見送り(価格を持たない none)。
  if (out.limitEntry == null && out.stopEntry == null) {
    // ★v0.9.44(記録専用): レッグ不在=missing / SL 向き違反=stopSide / それ以外は LC 幅(上限超=lc / 下限未満=lcFloor)。
    const dir = plan.direction;   // クロージャ内では絞り込みが効かないので const に束ねる。
    const legReason = (entry?: number, sl?: number): NoneReason =>
      entry == null || sl == null ? 'missing'
      : !stopSideOk(dir, entry, sl) ? 'stopSide'
      : lcReason(Math.abs(entry - sl)) ?? 'lc';
    return {
      plan: { direction: 'none', rationale: out.rationale, refPrice: out.refPrice }, vetoFired: false,
      noneReason: pickNoneReason(legReason(plan.limitEntry, plan.stopLossForLimit), legReason(plan.stopEntry, plan.stopLossForStop)),
      noneLegs: noneLegsFromDirectional(plan.direction, plan, false, false),
      ...legDropsField,
    };
  }

  // 2. バイアス veto。
  if ((bias === 'long' && out.direction === 'sell') ||
      (bias === 'short' && out.direction === 'buy')) {
    return {
      plan: { direction: 'none', rationale: out.rationale, refPrice: out.refPrice }, vetoFired: false,
      noneReason: 'bias',
      // ここまで残ったレッグは幾何/LC を満たしている(=bias だけで消えた)ので ok:true で記録する。
      noneLegs: noneLegsFromDirectional(plan.direction, out, true, true),
      ...legDropsField,
    };
  }

  return { plan: out, vetoFired: false, ...legDropsField };
}

/** レンジ無効設定なのに direction:"range" が返った場合の防御多重化(純関数・プロンプト指示の保険)。
 *  rangeEnabled=false かつ range のときだけ none 化し、記録専用の noneReason='rangeDisabled' を添える。
 *  それ以外は plan をそのまま返す(参照も維持=挙動不変)。
 *
 *  ★★集計するときの注意(A/B 分割で **語の意味が変わる**):
 *    いま(〜v0.9.97)   'rangeDisabled' = 「1回の呼び出しで AI が range を返した。設定が不許可なので none 化した」
 *    分割後(段3以降)   'rangeDisabled' = 「目線を決める呼び出しが range と答えたので、**注文側を呼ばなかった**」
 *    ★同じ語で母集団が変わる(前者は AI が価格まで出したかもしれない回・後者は価格を一度も聞いていない回)。
 *    ★**app_version で切らないと2つが混ざります。** 版をまたいで単純に COUNT すると、
 *    「レンジで見送った率が変わった」ように見えるが、それは定義が変わっただけ。
 *    分割後は b_variant='none' と組で見ること(signal_plans の列・v0.9.97 で追加済)。 */
export function enforceRangeEnabled(
  plan: AiPlan, rangeEnabled: boolean,
): { plan: AiPlan; noneReason?: NoneReason; noneLegs?: NoneLegs } {
  if (rangeEnabled || plan.direction !== 'range') return { plan };
  return {
    plan: { direction: 'none', rationale: plan.rationale, refPrice: plan.refPrice },
    noneReason: 'rangeDisabled',
    noneLegs: noneLegsFromRange(plan.range?.upper, plan.range?.lower),
  };
}

// LC 幅の下限/上限の受理可能レンジ(サニタイズ用)。この範囲外・非有限・floor>ceiling は既定に戻す。
export const LC_YEN_MIN = 20;
export const LC_YEN_MAX = 300;

// ─── refPrice(計画の基準価格)の鮮度ゲート ─────────────────────────────
//
// ★これが無いと何が起きたか(実測 2026-07-23):
//     21:42:01→21:56:52 sell 指値@66725(その時の実勢 65795・乖離 930円)= trade2 が131回連続で拒否・一度も約定せず。
//     22:44:35→22:59:30 sell 指値@66990(その時の実勢 65995・乖離 995円)= 130回連続で拒否。
//   bars_1m では 66,725 の最終到達は同日 14:45、66,990 は 10:16 = **7〜12時間前の水準** だった。
//   従来の実装は `prices.find(...)?.price ?? 0` で、(a) stale フラグを見ない (b) 取得失敗を静かに 0 にする
//   の二重の穴があった。0 は checkSanity で弾かれるが、「古いまま持ち越された価格」は素通りして
//   その価格を中心にプランが組まれ、そのまま武装される。
//
// ★stale フラグだけでは塞がらない実在の穴:
//   priceLoop.tick() は取引時間外に **setPrices を呼ばずに** 早期 return する。つまり時間外はキャッシュに
//   「最後の場中価格が stale:false のまま」残り続ける。engine 経路は inPollWindow でゲートされるが、
//   POST /api/scalp-plan は時間外でも到達する。よって **経過時間の上限** も要る。
//   ※旧記述「trade2 が叩く」は誤り(2026-08-02 に実確認して訂正)。trade2 は monitor のシグナルを
//     SSE/`/api/current-signal` で追従するだけで /api/scalp-plan は叩かない(コード上のヒットはコメントのみ)。
//     現在この route を叩くのは手動診断と、これから追加する分析用(caller='generator')。
//
/** refPrice として許容する価格の最大経過時間[ms]。
 *  根拠: 価格取得間隔 pricePollMs の設定上限が 60,000ms、全滅時のバックオフ PRICE_BACKOFF_MS の最大も
 *  60,000ms。つまり **正常に回っている限り 60秒より古い非 stale 価格は存在しない**。これを超える値は
 *  「ループが止まっている/時間外のキャッシュが凍っている」ことの証拠なので、計画の基準にしない。 */
export const REF_PRICE_MAX_AGE_MS = 60_000;

export type RefPriceResult = { ok: true; refPrice: number } | { ok: false; reason: string };

/** 計画の基準価格(refPrice)を解決する純関数。使えない時は **理由付きで失敗** する(0 へ黙って落ちない)。
 *  条件: ①その銘柄の見積りが在る ②stale でない ③有限かつ正 ④取得から REF_PRICE_MAX_AGE_MS 以内。 */
export function resolveRefPrice(prices: Price[], symbol: string, now: number): RefPriceResult {
  const q = prices.find(p => p.symbol === symbol);
  if (!q) return { ok: false, reason: `${symbol} の現在値がキャッシュに無い` };
  if (q.stale) return { ok: false, reason: `${symbol} の現在値が stale(フィード断で前回値を持ち越し中)` };
  if (!Number.isFinite(q.price) || q.price <= 0) return { ok: false, reason: `${symbol} の現在値が不正(${q.price})` };
  const age = now - q.timestamp;
  if (!(age <= REF_PRICE_MAX_AGE_MS)) {
    return {
      ok: false,
      reason: `${symbol} の現在値が古い(取得から${Math.round(age / 1000)}秒経過・上限${Math.round(REF_PRICE_MAX_AGE_MS / 1000)}秒)`,
    };
  }
  return { ok: true, refPrice: q.price };
}

/** lcFloorYen/lcCeilingYen をサニタイズ・クランプして [floor, ceiling] を返す。
 *  非数値/非有限、LC_YEN_MIN..LC_YEN_MAX の範囲外、floor>ceiling のいずれかなら既定(55/65)へフォールバック。 */
export function resolveLcRange(
  floorYen?: number,
  ceilingYen?: number,
): { floorYen: number; ceilingYen: number } {
  const inRange = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= LC_YEN_MIN && v <= LC_YEN_MAX;
  const floor = inRange(floorYen) ? floorYen : DEFAULT_LC_FLOOR_YEN;
  const ceiling = inRange(ceilingYen) ? ceilingYen : DEFAULT_LC_CEILING_YEN;
  // ceiling を既定 floor(55)より小さく締めた場合、floor を ceiling まで下げて **ユーザーの厳しい上限を尊重** する。
  // ★従来は両方を既定(55/65)へ戻していたため、締めた上限が黙って無視され「緩む方向」へサイレント失敗するフットガンだった
  //   (呼び出し側は floor 未指定=既定下限 で呼ぶため、ceiling をそれより小さくすると発火)。ceiling を単一の真実として優先する。
  if (floor > ceiling) return { floorYen: ceiling, ceilingYen: ceiling };
  return { floorYen: floor, ceilingYen: ceiling };
}

/** 外部(HTTP `/api/scalp-plan` の body/query など)から要求された初期 LC 下限を、**設定値の下限で床止め**する純関数。
 *
 *  ★なぜ必要か: 下限はプロンプトに `【強制=委任対象外・コードで必ず適用】` と書いてあり、AI にも委任しない
 *    唯一の制約になっている。にもかかわらず `/api/scalp-plan` は body/query の lcFloorYen をそのまま
 *    buildScalpPlan へ渡しており、resolveLcRange は LC_YEN_MIN(=20)まで受理するので、
 *    **呼び出し側(trade2 や curl)が 20 を送れば床が 20 に下がっていた**。設定画面には設定値(既定 55)と表示されたまま
 *    実際の強制は 20 になる=文言が嘘になる形。
 *
 *  ★クランプの向き(下限側だけ・上げるのは許可):
 *    - 下げる方向は禁止。下限の根拠は決済ロジック(含み益が一定に達して初めて利益ロックの床が発動する方式)で、
 *      これより狭い初期 LC は床が働く前に被弾する=**戦略が構造的に成立しない**。緩められては意味がない。
 *    - 上げる方向は許可。より広い初期 LC は上の前提を壊さず、効果は「下限未満のレッグをより多く落とす」=
 *      提案が減るだけで安全側。呼び出し側が自分の口座事情でより慎重にするのを妨げる理由がない
 *      (上限 lcCeilingYen 側で別途弾かれるので、無制限に広い建玉になるわけでもない)。
 *  非数値/非有限は「要求なし」= 設定値をそのまま使う。 */
export function clampRequestedLcFloor(requested: number | undefined, configFloorYen: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return configFloorYen;
  return Math.max(configFloorYen, requested);
}

/** ★段5続き(2026-08-22・リーダー指摘への対応): A/B 分割の B(価格と損切幅)に渡す文脈へ
 *  ★旧経路(1回呼び出し)にはあったのに配線されていなかった2つを足す純関数
 *  (多資産の現在価格board + ニュース)。★A(technicalForTrend)はこの関数を通さない=呼び出し側の責務。
 *
 *  ■ ①ニュース: なぜ要るか(誰も決めていない挙動変更だった)
 *    旧経路の systemPrompt は末尾に必ず '■ 関連ニュース:' を追記していた(news.length===0 でも
 *    formatNewsForChat が '(ニュースなし)' を返すので行自体は必ず出る)。★A/B 分割では
 *    「ニュースは A には渡さない」と決めただけで、B に渡すかは誰も決めておらず、結果として
 *    B にも1文字も渡らなくなっていた(旧と揃えるのが既定のところ、無言で消えていた)。
 *    queryText を空にする理由: 旧経路は bigram 関連度フィルタの queryText に scalpQuestion(汎用の
 *    指示文)を渡していたが、汎用語はニュース見出しと bigram が一致しにくく、実質 news.slice(0,15)
 *    (直近フォールバック)に落ちていた。B は4版に分かれ「その版の問い」を1つの文で代表できないため、
 *    空文字にする(= 常にフォールバック経路と同じ=旧経路の実質的な挙動と揃う)。
 *  ■ ②多資産の現在価格board: なぜ要るか(ニュースと全く同じ形の欠測)
 *    旧経路は systemPrompt の先頭側で '■ 現在価格:' に formatPricesForChat(全銘柄の現値・前日比)を
 *    書いていたが、分割経路の B には1文字も渡っていなかった。★server/llm/abContext.ts 自身の
 *    コメントが「現在価格は呼び出し側が別ブロックで付ける」としていたのに、実際には誰も配線して
 *    いなかった(buildOrderContext という専用関数まで用意されていたのに1回も呼ばれていなかった)。
 *    ★A には入れない(ユーザー指示「A にはトレンド判断に有用なものだけ」に従う。他銘柄の現値・
 *    前日比は A の問い=目線の有無には不要)。
 *  ■ ★monitorCtx(直近アラート60分・本日高安の簡易サマリ)は据え置き
 *    既存の節目ブロック(B)・ボラ/レンジブロック(本日高安)と内容の重複が大きく、実害が小さいと
 *    判断したため、意図的にここへは足していない(=欠測のままだが、忘れているのではない)。
 *  ■ 記録・採否・veto には無関係(プロンプトの中身が増えるだけ)。 */
export function buildOrderContextExtras(
  technical: string | null | undefined, prices: Price[], news: NewsItem[], now: number,
): string {
  const priceBlock = `■ 現在価格:
${formatPricesForChat(prices, now)}`;
  const newsBlock = `■ 関連ニュース:
${formatNewsForChat(news, now, '')}`;
  return [priceBlock, technical, newsBlock].filter((s) => Boolean(s)).join('\n\n');
}

/** 固定のスキャル質問で LLM を走らせ、構造化 AiPlan を返す。既存の chat と同じ tool ループ・プロバイダ選択・
 *  キー解決を再利用する。キー未設定は { ok:false, error:'LLM未設定' }。パース失敗は1回だけ厳格に再要求する。
 *  refPrice は monitor の現在 NIY=F 価格。 */
/** ★段6続き(2026-08-22・エバリュエーター指摘への対応): 「分割ONでも黙って無視される」を構造で塞ぐ。
 *
 *  ■ 何を検出するか(overrides を1つずつ確認した結果。当初「3つで全部」と報告したのは誤りだった)
 *    A/B 分割の B(buildBSystemPrompt/buildBUserPrompt)は、次の3つを一切受け取らない:
 *      ・heldPosition(ドテン評価)  … buildHeldNote は旧経路の systemPrompt でしか呼ばれない
 *      ・armedContext(レンジ再評価) … buildArmedNote も同様
 *      ・promptVariant(候補腕)    … v1 以外を指定しても B は常に固定の4版の文面を使う
 *    ★見落としていた4つ目: exitVariant(決済仕様の名前付き変種)も同様に B に届かない
 *      (B の戦略仕様=strategySpec は既に仕様書で「損切幅の範囲だけ残す」と意図的に圧縮済みで、
 *       exitDesc を差し込む場所が最初から無い)。★ただし「宛先が無いから届かない」だけでは済まない:
 *      分析用(caller='generator')が exitVariant を腕として使う実験(現行/候補仕様の比較)がある以上、
 *      黙って両腕とも同じ扱いになれば実験が無効化される。★よって記録・ガード対象に含める。
 *  ■ ★5つ目にして最重要: caller(呼び出し元)
 *    分析用(server/generator/cycle.ts)は caller='generator' を渡し、その腕(v1=対照 / v2=候補、
 *    exitVariant も同様)を比較する **測定器そのもの**。もし分割 ON のとき、
 *    「promptVariant が既定(v1)の対照腕」だけが分割経路(A+B・新プロンプト)を通り、
 *    「v2 の候補腕」だけが上のガードでバイパスされて旧経路(旧プロンプト)を通ると、
 *    ★2本の腕の差が「質問文 v1 vs v2」ではなく「分割 vs 旧経路」にすり替わる(エラーは出ない)。
 *    ★分析用(measurement rig)に新しい変数(分割の有無)を無断で混ぜてはいけない。
 *    分割そのものを測りたければ、分割を明示的な腕として立てるのが筋(既定で混ぜない)。
 *    ★よって caller が 'default' 以外(=現状は 'generator' のみ。LlmCaller 型で列挙・
 *    server/generator/cycle.ts が唯一の非 default 呼び出し元であることをコードで確認済み)なら、
 *    値に関わらず無条件でバイパスする。
 *  ■ ★6つ目: emptyTrendContext(文脈構築の失敗・空文脈)
 *    buildRichScalpContextResult が失敗(currentPrice 未確定 / 例外)すると、A の文脈
 *    (technicalForTrend)が空になる。A は判断材料ゼロで「確信が持てない」→ range と答え、
 *    レンジ不許可(既定)の運用では B を呼ばず全サイクル見送りに倒れる。
 *    ★旧経路なら基礎テクニカル・勢い1行・現在価格・ニュースは引き続き利用できたので計画が出ていた
 *    (=これは無言の失敗そのもの)。★catch を握り潰さず、文脈が空だった事実を旧経路への
 *    フォールバックと同じ仕組みで数えられる形にする(buildRichScalpContextResult 自体は変更しない
 *    ——分割 OFF でも technicalForTrend は undefined になるが、その場合はそもそもこの分岐に
 *    入らないので誤検出しない)。
 *  ■ なぜコードで塞ぐか(「運用ルール」では足りない・規範「無言の失敗は欠陥」)
 *    黙って無視する/黙って空文脈で判断させるより、その回だけ旧経路(1回呼び出し)へ
 *    フォールバックするほうが安全(旧経路はこれらを最初から正しく扱える・計画を出し続けられる)。
 *  ■ 例外で止めない理由
 *    サイクルが丸ごと落ちるより、旧経路へ落として計画を出し続けるほうが安全側(可用性を落とさない)。
 *  ★新しい閾値は作らない(既存フィールドの有無 / 既存の LlmCaller 列挙 / 既存の文脈欠落を見るだけ)。 */
export function resolveSplitBypassReasons(input: {
  heldPosition?: unknown;
  armedContext?: unknown;
  promptVariant?: PromptVariant;
  exitVariant?: unknown;
  caller?: LlmCaller;
  technicalForTrend?: string | null;
}): string[] {
  const reasons: string[] = [];
  if (input.heldPosition !== undefined) reasons.push('heldPosition');
  if (input.armedContext !== undefined) reasons.push('armedContext');
  if (input.promptVariant !== undefined && input.promptVariant !== DEFAULT_PROMPT_VARIANT) reasons.push('promptVariant');
  if (input.exitVariant !== undefined) reasons.push('exitVariant');
  if (input.caller !== undefined && input.caller !== DEFAULT_CALLER) reasons.push('caller');
  if (input.technicalForTrend == null || input.technicalForTrend.trim() === '') reasons.push('emptyTrendContext');
  return reasons;
}

export async function buildScalpPlan(input: ScalpPlanInput = {}): Promise<ScalpPlanResult> {
  if (!isLLMEnabled()) return { ok: false, error: 'LLM未設定' };
  // ★v0.7.58: 決済ロジック(phase-exit)の実数値説明を AI に渡すため private 実装をロード(冪等・キャッシュ)。
  //   private 不在(公開配布)は定性フォールバックのまま。プランの成否・enforce には影響しない。
  await loadExitImpl();
  const now = Date.now();
  const symbol = typeof input.symbol === 'string' && input.symbol ? input.symbol : NIKKEI_SYMBOL;
  const prices = input.prices ?? getPrices();
  const news = input.news ?? [];
  // ★refPrice の鮮度ゲート(resolveRefPrice)。従来の `?? 0` は stale を見ず取得失敗を静かに 0 にしていた。
  //   古い/壊れた基準価格で計画を組ませない=ここで失敗させる。失敗は必ず1行ログに残す(無言で見送りにしない)。
  const refResolved = resolveRefPrice(prices, symbol, now);
  if (!refResolved.ok) {
    console.warn(`[scalp-plan] refPrice 不採用: ${refResolved.reason} → 計画を作らない`);
    return { ok: false, error: `現在値が使えない(${refResolved.reason})` };
  }
  const refPrice = refResolved.refPrice;
  // ★v0.7.56: 各 knob の directive(manual/ai)を解決。既定は全て manual=現状の挙動を一切変えない。
  //   manual は数値/enum を強制(従来どおり)/ ai は該当制約を課さず AI に委任する。LC安全上限は独立の安全系。
  // ★v0.8.2: プロファイル(A|B)で knob を解決。未指定=A=グローバル(現行と byte 一致)。
  const profile = input.profile;
  const floorD = resolveScalpLcFloorDirective(profile);
  const ceilingD = resolveScalpLcCeilingDirective(profile);
  const biasD = resolveScalpBiasDirective(profile);
  const rangeD = resolveScalpRangeDirective(profile);
  const trendD = resolveScalpTrendVetoDirective(profile);
  const hardMax = resolveScalpLcHardMax(profile);
  // 初期 LC 幅の上限とバイアスは、要求で明示されなければ monitor 設定を既定に使う(＝直呼びのシグナルエンジンも
  // monitor 設定に従う=単一の真実)。上限はサニタイズ・クランプ後にプロンプトへ反映し、最終保証は enforcePlanConstraints。
  const ceilingMode = ceilingD.mode;
  const ceilingInput = input.lcCeilingYen ?? ceilingD.value;
  // バイアス/レンジ: manual は設定(override 優先)を適用 / ai は制約なし(bias='none'・range 許可)。
  const bias: ScalpBias = biasD.mode === 'manual' ? (input.bias ?? biasD.value) : 'none';
  const rangeEnabled = resolveEffectiveRangeEnabled(profile, input.rangeEnabled);
  // ★LC下限は【強制=委任対象外】= 設定値が絶対の床。外部要求(HTTP body/query)で **緩める(下げる)ことは許さない**。
  //   厳しくする(上げる)方向だけ受理する(clampRequestedLcFloor の注記に根拠)。
  const { floorYen, ceilingYen } = resolveLcRange(clampRequestedLcFloor(input.lcFloorYen, floorD.value), ceilingInput);
  // ★v0.9.56: プロンプトに **印字してよい** 上限を決める(enforce は従来どおり ceilingYen + ceilingMode + hardMax)。
  //   手動 → 保存値そのまま(従来と byte 一致)/ 委任 → 保存値を印字せず実効上限(安全上限 or 背骨)を範囲として提示。
  const lcPres = resolveLcPresentation({ floorYen, ceilingYen, ceilingMode, lcHardMax: hardMax });
  const promptCeilingYen = lcPres.ceilingYen;
  const lcCeil = lcPres.ceil;
  // レジーム/トレンド veto の閾値[円](0=無効)。manual は閾値・ai は数値veto無効(=0)。プロンプト文言に反映し、
  // トレンド veto 自体は input.trend で駆動する(0 のとき trend を渡さない=veto なし)。
  const trendVetoYen = trendD.mode === 'manual' ? trendD.value : 0;
  // ★委任ノート: AI に委任した knob だけ「この値はあなたが決める(自由・根拠を述べよ)」を追記する。
  //   全 knob 手動(既定)では '' = プロンプトは従来と byte 単位で不変(回帰なし)。
  const cooldownD = resolveScalpCooldownDirective(profile);
  const delegationNote = buildDelegationNote(
    { lcFloor: floorD.mode, lcCeiling: ceilingD.mode, trendVeto: trendD.mode,
      cooldown: cooldownD.mode, bias: biasD.mode, range: rangeD.mode },
    { floorYen, ceilingYen, hardMax, rangeEnabled },
  );
  const biasNote = buildBiasNote(bias);
  // ★v0.9.75: 質問文の変種。**未指定/'v1' は従来と byte 一致**(実取引につながる全経路はここを通っても変わらない)。
  //   'v2' は user プロンプトの本体(質問文+JSON契約)だけを差し替える。system プロンプト側の規則
  //   (buildScalpSystemPrompt / strategySpec / delegationNote)は **触らない** = 動かす変数を1つに保つ。
  //   ★v2 は自前で JSON 契約を持つので、v1 の scalpJsonInstruction は連結しない(2つ並べると契約が二重になる)。
  //   ★'v1d'(2026-08-17〜08-18) は v1 から **「現在値から最低50円離す」の記述だけ** を落とす候補だった
  //     (設計書 §5 層1の第一手)。209件の実測で **主指標が悪化**(両レッグ同幅率 76.4%→84.7%)し不採用
  //     になったため候補腕からは降りたが、フラグ自体(omitMinDistance)は過去台帳を読むために残す。
  //   ★'v1e'(2026-08-18) は v1 から **「距離の上限(片レッグ200円/両レッグ幅400円)」の記述だけ** を落とす。
  //     この規則はプロンプト中の3箇所(質問文② / system prompt / strategySpec)に載っているので、
  //     v2 と違い **system プロンプト側も** 動かす。それでも動かす変数は1つ(=同じ1つの規則の全掲載)。
  //     最低距離50円(omitMinDistance)はこの変種でも残る(同時に2つは動かさない)。
  //     ★ゆえに変種の解決は strategySpec / bandwalkNote を組む **前** に置く必要がある。
  const promptVariant = input.promptVariant ?? DEFAULT_PROMPT_VARIANT;
  const omitMinDistance = promptVariant === 'v1d';
  const omitMaxDistance = promptVariant === 'v1e';
  // ★v0.7.58: 戦略ロジックを定数込みで完全に AI へ渡す(エントリー全定数＋各項目の委任状態＋決済ロジックの実数値)。
  //   「何を委任するか」は設定(各 directive の mode)に従い【】で明示。決済数値は describeExitLogic()=private 実行時注入。
  const strategySpec = buildStrategySpec({
    floor: { mode: floorD.mode, value: floorYen },
    ceiling: { mode: ceilingD.mode, value: ceilingYen },
    trendVeto: { mode: trendD.mode, value: trendD.value },
    cooldown: { mode: cooldownD.mode, value: cooldownD.value },
    bias: { mode: biasD.mode, value: biasD.value },
    range: { mode: rangeD.mode, value: rangeEnabled },
    hardMax,
    // ★決済仕様: 変種 **未指定なら従来の describeExitLogic() をそのまま**(この経路は byte 不変)。
    //   指定時だけ名前 → 非公開定義から説明文を解決する(数値はプロセス内に留まる)。
    exitDesc: input.exitVariant === undefined ? describeExitLogic() : describeExitLogicVariant(input.exitVariant),
    omitMinDistance,
    omitMaxDistance,
  });
  // ★AIテクニカル許可(RSI/BB をエントリーの"タイミング"判断に使ってよい)。既定 ON。OFF では system prompt は従来と byte 一致。
  //   ※決済(手仕舞い)は既定の決済ロジックが担当する=AI に決済判断は委ねない。
  const aiTechnicalEnabled = resolveScalpAiTechnicalEnabled(profile);
  // ★ドテン(保有中の反転評価=held-eval): heldPosition が渡された時だけ注入する。flat-plan(未指定)では '' = 従来と byte 一致。
  const heldNote = buildHeldNote(input.heldPosition);
  // ★レンジ再評価(未約定→ブレイク): armedContext が渡された時だけ注入する。未指定(通常)では '' = 従来と byte 一致。
  const armedNote = buildArmedNote(input.armedContext);
  // ★バンドウォーク成立中だけの緩和注記(距離と節目のみ)。非成立/未指定は '' = 従来と byte 一致。
  //   ★v1d: ①の免除文(「最低距離は課さない」)は 本則が消えると宛先を失うので、同じフラグで整合させる。
  //   ★v1e: 「距離の上限は変わらない」の参照も、本則(200/400円)が消えると宛先を失うので、同じフラグで整合させる。
  const bandwalkNote = buildBandwalkNote(input.bandwalk, omitMinDistance, omitMaxDistance);
  const monitorCtx = buildMonitorContext(now);
  const scalpQuestion = promptVariant === 'v2'
    ? buildScalpQuestionV2({ floorYen, ceilYen: promptCeilingYen, rangeEnabled, refPrice })
    : buildScalpQuestion(floorYen, promptCeilingYen, rangeEnabled, trendVetoYen, lcCeil, omitMinDistance, omitMaxDistance);
  const systemPrompt =
    // ★bandwalkNote は strategySpec / delegationNote の **後ろ**(= 距離50円・節目起点を書いている
    //   ブロックより後)に置く。緩和は「直前の指示を上書きする」形なので、読み順で後に来る必要がある。
    `${buildScalpSystemPrompt(floorYen, promptCeilingYen, rangeEnabled, trendVetoYen, aiTechnicalEnabled, lcCeil, omitMaxDistance)}${biasNote}${strategySpec}${delegationNote}${bandwalkNote}${heldNote}${armedNote}\n\n` +
    // ★ここは **壁時計を秒の粒度で** system プロンプトに埋める(唯一の箇所)。
    //   ■ 副作用: 同じ入力で2回組み立てても、**秒の境界をまたぐと byte 一致しない**。
    //     scalpPlanPromptVariant.test.ts の「未指定 と v1 は byte 一致」が ときどき赤くなるのは
    //     ★これが真因で、**自分の変更のせいではない**(2026-08-22 に特定)。同テストは
    //     vi.useFakeTimers({ toFake: ['Date'] }) で時計だけ凍らせてある。
    //   ■ ★同じ直し方をするときの落とし穴(実際に踏んだ):
    //     ・setTimeout まで差し替えると LLM 経路の await が進まず固まる → toFake は ['Date'] に限る
    //     ・日付を別の日に動かすと取引時間の判定が変わり、create が1度も呼ばれない別経路に入る
    //       → 動かさず「いまの時刻をそのまま凍らせる」。
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(prices, now)}\n\n` +
    (input.technical ? `${input.technical}\n\n` : '') +
    (monitorCtx ? `${monitorCtx}\n\n` : '') +
    `■ 関連ニュース:\n${formatNewsForChat(news, now, scalpQuestion)}`;

  // chat と同じデータツール(常時有効)+ web_search(Gemini グラウンディング・キーがある時のみ)。
  const tools: unknown[] = [EXPLAIN_MOVE_TOOL, QUERY_ALERTS_TOOL, PRICE_HISTORY_TOOL];
  const handlers: ToolHandlers = buildDataToolHandlers();
  if (isWebSearchEnabled()) {
    tools.push(WEB_SEARCH_TOOL);
    handlers.web_search = async (a: { query?: string }) => {
      const q = typeof a.query === 'string' ? a.query : '';
      return q ? await webSearch(q) : '(クエリ空)';
    };
  }

  // ★v0.9.70(A/B の成立条件): 「画像を送るか」は **プロンプトを組み立てる前** に決める。
  //   旧実装は buildVisionNote(!!img) を **プロバイダ選択より前** に1回だけ評価していたため、
  //   テキスト専用プロバイダ(groq/kimi)へフォールバックして画像が外れた回でも
  //   「添付のチャート画像も判断材料にすること」と言い続けていた=**存在しない画像を参照させていた**。
  //   よって user プロンプトは「その試行で画像を実際に送るか」の関数にする。
  //   ★2群の違いは【画像の有無】と【この1行の有無】だけ。画像なし側に説明を足さない(足すと交絡する)。
  const img = input.chartImageDataUrl && input.chartImageDataUrl.startsWith('data:image/')
    ? input.chartImageDataUrl : null;
  // ★v1f(2026-08-20): 候補腕。lcWhyFor* の注記 **だけ** を差し替える(質問文・system・strategySpec は v1 と同一)。
  const jsonInstruction = scalpJsonInstruction(
    refPrice, floorYen, promptCeilingYen, rangeEnabled, lcCeil, promptVariant === 'v1f',
  );
  const userPromptFor = (withImage: boolean): string =>
    promptVariant === 'v2'
      // v2 は質問文の中に JSON 契約を持つ。ここで v1 の jsonInstruction を足すと契約が2つ並び、
      // 「短くした」はずの質問文が結局 v1 の分量に戻る(=何も測っていないことになる)。
      ? `${scalpQuestion}\n\n${buildVisionNote(withImage)}`.trimEnd()
      : `${scalpQuestion}\n\n${buildVisionNote(withImage)}${jsonInstruction}`;
  // ★RECORD-ONLY: 実際に画像を送ったか。**送るつもりだったか ではない**(A/B の群の記録に使う)。
  //   1度も LLM を呼べなかった回(プロバイダ不在)は false のまま=「送っていない」が正しい。
  let imageSent = false;
  // ★RECORD-ONLY: **答えを返した** プロバイダ。runScalpPlanResult が解決した直後にだけ入れる
  //   (送る前に入れると「送ろうとした先」になり、全滅した回に嘘が残る)。
  let answeredBy: AnsweringProvider | null = null;
  // ★段6続き(RECORD-ONLY): 分割ONでも黙って無視される3つ(ドテン評価・レンジ再評価・候補腕)を検出する。
  //   ★catch 節(異常終了)でも記録できるよう、try の外(関数スコープ)で計算する。
  const splitBypassReasons = resolveSplitBypassReasons(input);
  const splitBypassReason = isPlanSplitEnabled() && splitBypassReasons.length > 0
    ? splitBypassReasons.join(',') : undefined;

  try {
    // ★v0.9.46 修正: parse は runScalpPlanResult の中で1回だけ走らせ、その結果をここで受け取る。
    //   以前は「plan を JSON 化 → callWithFallback の string 契約で受け取り → parseScalpPlan で再パース」して
    //   おり、parse 段の機械生成注記(レッグ注記/レンジ脚の脱落理由)が2回連結されて画面に二重表示されていた。
    //   採否ロジックは parse も enforce も一切変えていない(注記の連結回数だけが 2→1 に戻る)。
    let planResult: Extract<ScalpPlanResult, { ok: true }> | null = null;

    // ═══ ★A/B 分割(段4・v0.9.100) ═══════════════════════════════════════════════
    //   ★切り替えは planSplitConfig.ts の1箇所だけ(PLAN_SPLIT_DEFAULT / 環境変数 JP225_PLAN_SPLIT)。
    //   ★ここが false のとき、下の従来経路は **1バイトも変わらずに** 走る(この if の外は無改造)。
    //   ★分割経路も、得た plan を planResult に入れるだけ = **下流(enforce/veto/legDrops/台帳/SSE)は共通**。
    // ★段6続き: 分割ONでも黙って無視される3つ(ドテン評価・レンジ再評価・候補腕)を検出し、
    //   1つでも該当する回はこの if へ入らせない(=旧経路に落ちる)。記録は下の3箇所で行う。
    if (isPlanSplitEnabled() && splitBypassReasons.length === 0) {
      const outcome = await runSplitPlan({
        // ── A(目線): ★ツールを1つも付けない・max_tokens は小さい ──
        callTrend: async (sys, usr) => {
          const text = await callWithFallback(async (p) => {
            const r = await p.client!.chat.completions.create({
              model: p.config.chatModel, temperature: 0.4, max_tokens: TREND_MAX_TOKENS,
              messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
            } as any);
            answeredBy = { name: p.config.name, model: p.config.chatModel };
            return (r as any).choices?.[0]?.message?.content?.trim() ?? '';
          }, 'scalp-plan-trend', input.caller ?? DEFAULT_CALLER, sys.length + usr.length);
          // ★A のツール呼び出しは **数えて 0**(undefined=数えていない とは別物)。
          return { text, toolCalls: 0, ...(answeredBy ? { provider: answeredBy } : {}) };
        },
        // ── B(価格と損切幅): ツールは従来どおり3本(+キーがあれば web_search)・画像も従来どおり ──
        callOrder: async (sys, usr) => {
          let calls = 0;
          const counting: ToolHandlers = Object.fromEntries(
            Object.entries(handlers).map(([k, fn]) => [k, async (a: unknown) => { calls++; return fn(a as never); }]),
          );
          const text = await callWithFallback(async (p) => {
            const create: CreateFn = (params) => p.client!.chat.completions.create({
              model: p.config.chatModel, temperature: 0.4, max_tokens: 8000, ...params,
            } as any);
            const imgForThis = img && isVisionCapableProvider(p.config.name, p.config.chatModel) ? img : null;
            imageSent = !!imgForThis;
            // ★エバリュエーター指摘C: 旧経路は「画像を実際に送る試行だけ」buildVisionNote(true) を
            //   userプロンプトへ足していた(送らない試行では1文字も触れない=存在しない画像を参照させない)。
            //   分割経路の B にはこの注記が無かったため、画像を添付しているのにプロンプトが一言も
            //   触れない逆向きの事故になっていた。★ここで旧経路と同じ「その試行で実際に送るか」の
            //   関数として付け直す(usr 自体・buildBUserPrompt は変えない=位置は末尾になるが、
            //   送った/送っていないの対応は旧実装と同じ性質を保つ)。
            const usrWithVision = [usr, buildVisionNote(!!imgForThis)].filter(Boolean).join('\n\n').trimEnd();
            try {
              input.onPromptFingerprint?.(promptFingerprint(sys, usrWithVision));
            } catch (e) {
              console.warn('[scalp-plan] プロンプト指紋の記録に失敗(計画は続行):', e instanceof Error ? e.message : String(e));
            }
            const out = await runChatWithTools(
              create, [{ role: 'system', content: sys }, { role: 'user', content: buildScalpUserContent(usrWithVision, imgForThis) }],
              tools, counting,
            );
            answeredBy = { name: p.config.name, model: p.config.chatModel };
            return out;
          }, 'scalp-plan', input.caller ?? DEFAULT_CALLER, sys.length + usr.length);
          return { text, toolCalls: calls, ...(answeredBy ? { provider: answeredBy } : {}) };
        },
      }, {
        refPrice,
        // ★A には **節目・アラート・長期高安を外した** 文脈を渡す(runner が組み立てて渡す)。
        //   未指定なら文脈なしで走らせる=B 用の全部入りを A に流用して「渡していない」を嘘にしない。
        trendContext: input.technicalForTrend ?? '',
        // ★リーダー指摘(2026-08-22): 旧経路(1回呼び出し)は systemPrompt の末尾に必ずニュースを
        //   付けていたが、分割経路の B にはニュースが1文字も渡っていなかった——
        //   「A には渡さない」は決めたが「B に渡すか」は誰も決めておらず、旧と揃えるのが既定のところ
        //   無言で消えていた挙動変更。★ここで旧と揃える(B にだけ・A には付けない)。
        //   queryText は空にする(B は4版に分かれ「その版の問い」を単一のクエリ文で代表できない。
        //   旧経路の scalpQuestion も汎用の指示文で bigram 一致はほぼ無く、実質 news.slice(0,15) に
        //   フォールバックしていたため、空文字でも挙動はほぼ同値)。
        orderContext: buildOrderContextExtras(input.technical, prices, news, now),
        floorYen, ceilingYen: promptCeilingYen, rangeEnabled,
        squeezeState: input.squeezeState ?? null,
        ...(input.squeezeUnavailable ? { squeezeUnavailable: input.squeezeUnavailable } : {}),
        // ★2026-08-22 訂正(リーダー指摘): delegationNote を B へ渡す配線はここに一度あったが、取り消した。
        //   理由: buildDelegationNote の文面は「上のロジック」「上の2択」「direction」「regime」
        //   「confidence」など B に存在しないブロック/フィールドへの参照を含み、分割の芯(side は
        //   AI に返させない)と衝突する。実測で B が契約外の JSON を返し aiSilent に化けることを確認した。
        //   詳細は docs/superpowers/specs/2026-08-21-ab-split-prompts.md を参照。
      });
      planResult = outcome.parsed;
      if (outcome.provider) answeredBy = outcome.provider;
      // ★記録は握りつぶさない(失敗しても計画は続けるが、失敗した事実は1行残す)。
      try { input.onSplitRecord?.(outcome.record); }
      catch (e) { console.warn('[scalp-plan] A/B 記録の受け渡しに失敗(計画は続行):', e instanceof Error ? e.message : String(e)); }
    }
    // ═══════════════════════════════════════════════════════════════════════════

    const raw = planResult ? '' : await callWithFallback(async (p) => {
      const create: CreateFn = (params) => p.client!.chat.completions.create({
        model: p.config.chatModel, temperature: 0.4, max_tokens: 8000, ...params,
      } as any);
      // ビジョン非対応プロバイダに切り替わった場合は画像を外す(image_url をテキスト専用モデルへ送らない)。
      const imgForThis = img && isVisionCapableProvider(p.config.name, p.config.chatModel) ? img : null;
      // ★この試行で実際に送る内容に合わせて user プロンプトを組む(注記と画像を必ず一致させる)。
      const userPrompt = userPromptFor(!!imgForThis);
      imageSent = !!imgForThis;
      // ★RECORD-ONLY: 指紋は **この試行で実際に送る内容** から取る(判断は下の設計注記を参照)。
      //   記録の失敗で計画を止めない(握りつぶすが、握りつぶした事実は必ず1行残す)。
      try {
        input.onPromptFingerprint?.(promptFingerprint(systemPrompt, userPrompt));
      } catch (e) {
        console.warn('[scalp-plan] プロンプト指紋の記録に失敗(計画は続行):', e instanceof Error ? e.message : String(e));
      }
      try {
        planResult = await runScalpPlanResult(create, systemPrompt, userPrompt, tools, handlers, refPrice, imgForThis);
      } catch (e) {
        // ★無音の失敗を潰す(2026-08-11): 「200 は返ったが計画が作れなかった」回に **1行だけ** 残す。
        //   この経路は tripCircuit が false で抜けるため [LLM:*] の warn が1行も出ず、事故が起きても
        //   台帳の error 列以外に手がかりが無かった(実測: 8日で1件・その1件の原因が追えない)。
        //
        //   ★ログを出すだけ = **外部呼び出しは1回も増えない**。ここでは再要求もフォールバックもせず、
        //     受け取った例外を **そのまま** 投げ直す(= callWithFallback から見て挙動は従来と1ミリも変わらない。
        //     ScalpPlanUnparsableError は NoFallbackError を継承しており、tripCircuit が **文字列の分類より
//     先に型で見て** false を返すので次のプロバイダへは進まない。★型で申告するのが要点で、
//     「知らない型だから null に落ちて再投げ」に頼ると 'refPrice 66,500' の 500 が
//     50[0-4] に当たって transient に化け、フォールバック+30秒ポーズが起きる(実測)。)
        //   ★他の例外(HTTP 400/429/413/5xx 等)はここで **握らない**: あれらは tripCircuit が
        //     既に [LLM:*] へ1行出しているので、ここで出すと同じ故障が2行になる。
        if (e instanceof ScalpPlanUnparsableError) {
          // 本文は載せない(モデルの生出力には非公開の決済数値が混じりうる)。長さだけで
          // 「空応答(len=0)」と「中身はあるが壊れた JSON(len>0)」を区別できる。
          // formatErrForLog = 伏字 → アプリデータ断片の除去 → 切り詰め(providers.ts が SSOT)。
          console.warn(`[LLM:${p.config.name}] scalp-plan unparsable (${formatErrForLog(e.message)}) `
            + `len1=${e.firstLen} len2=${e.retryLen} — フォールバックしない(頻度1/1198・代償が見合わない)`);
        }
        throw e;
      }
      // ★ここまで来た＝このプロバイダが使える答えを返した。例外で抜けた試行では記録されない。
      answeredBy = { name: p.config.name, model: p.config.chatModel };
      // 成功時は整形済み plan JSON 文字列を返す(callWithFallback は string 契約)。戻り値そのものは使わない。
      return JSON.stringify(planResult.plan);
      // ★第3引数(caller)= プロバイダ・プールの選択。未指定は 'default'(既存経路は byte 不変)。
      // ★v0.9.79: この要求のおおよその大きさ[文字]を渡す。413(TPM超過)を返したプロバイダを
      //   同じ大きさで叩き直さないため(実測: groq が 1日 1,100〜1,300回すべて 413)。
      //   画像は文字数に入らないが、判定は「この大きさ以上」なので過小に見積もる方へ倒してよい。
    }, 'scalp-plan', input.caller ?? DEFAULT_CALLER, systemPrompt.length + userPromptFor(false).length);
    // task が一度も走らなかった場合(callWithFallback がプロバイダ不在の定型文を返す経路)だけ raw を読む。
    // 通常は planResult が入っているので再パースは起きない。
    const parsed: ScalpPlanResult = planResult ?? parseScalpPlan(raw, refPrice);
    if (!parsed.ok) return { ...parsed, imageSent, ...(answeredBy ? { provider: answeredBy } : {}), ...(splitBypassReason ? { splitBypassReason } : {}) };
    // トレンド veto: 閾値>0 かつ runner が trend を渡した時だけ効かせる(未指定/0=ai は現行挙動=veto なし)。
    const trend = trendVetoYen > 0 ? input.trend : undefined;
    // ★v0.7.56: LC上限は ceilingMode(manual→設定上限 / ai→実効上限=安全網 or LC_YEN_MAX)で分岐し、
    //   LC安全上限(hardMax)は mode 無関係に常時適用(有効時)。バイアスは ai なら 'none'(上で解決済)=veto なし。
    // ★LC下限(floorYen)は **委任設定 scalpLcFloorSource に関係なく常に渡す**=強制が委任に勝つ(安全側)。
    //   下限は「設定の好み」ではなく決済ロジック(利益ロックの床)が成立するための前提条件のため。
    const enforced = enforcePlanConstraintsReport(parsed.plan, {
      ceilingYen, bias, trend, ceilingMode, lcHardMax: hardMax, floorYen,
    });
    // 防御多重化: レンジ無効設定で万一 range が返っても none に落とす(プロンプト指示の保険)。
    const guarded = enforceRangeEnabled(enforced.plan, rangeEnabled);
    const finalPlan = guarded.plan;
    // AI 自己レジーム/確信度(記録のみ)を最終 plan に保持する。enforce/none 化で新規オブジェクトになり
    // 落ちることがあるため parsed.plan から再付与する(ゲートには使わない=挙動不変)。
    if (parsed.plan.regime !== undefined) finalPlan.regime = parsed.plan.regime;
    if (parsed.plan.confidence !== undefined) finalPlan.confidence = parsed.plan.confidence;
    // ★戦略ラベル(記録のみ)も同じ理由で再付与する(enforce/none 化で新規オブジェクトになり落ちるため)。
    if (parsed.plan.strategy !== undefined) finalPlan.strategy = parsed.plan.strategy;
    if (parsed.plan.strategyWhy !== undefined) finalPlan.strategyWhy = parsed.plan.strategyWhy;
    // ★v0.9.87: 価格の根拠にした節目も同じ理由で再付与する(enforce/none 化で新規オブジェクトになるため)。
    //   ★レッグが落ちた回も落とさずそのまま残す: 表示側は「エントリーと節目が両方在る脚」だけを描くので
    //     画面には出ず、台帳には「AI はこの節目から導いたと言ったが、そのレッグは落ちた」が残る。
    if (parsed.plan.limitLevel !== undefined) finalPlan.limitLevel = parsed.plan.limitLevel;
    if (parsed.plan.stopLevel !== undefined) finalPlan.stopLevel = parsed.plan.stopLevel;
    // ★v0.9.59(表示専用): **enforce 段で落ちたレッグ**の理由も根拠文へ足す。
    //   parse 段の注記(buildLegNote)は AI 応答の幾何しか説明できず、実データで最多の脱落理由
    //   (損切り幅が設定の下限より狭い=lcFloor / 上限より広い=lc)は画面に何の説明も残らなかった。
    //   しかも旧文言では parse 時点の「（実際の注文: 指値+逆指値）」がそのまま残り、片レッグが
    //   enforce で消えた回に **実プランと矛盾する** 表示になっていた。
    //   drops は enforce が受け取った時点で在ったレッグだけ=parse 段の注記と二重にならない。
    //   採否・価格・legDrops の記録内容は一切変えない(足すのは表示文字列だけ)。
    if (finalPlan.direction === 'buy' || finalPlan.direction === 'sell') {
      const enforceNote = buildLegNote({
        hasLimit: finalPlan.limitEntry != null,
        hasStop: finalPlan.stopEntry != null,
        drops: enforced.legDrops,
      });
      if (enforceNote) finalPlan.rationale = `${finalPlan.rationale} ${enforceNote}`;
    }
    const out: Extract<ScalpPlanResult, { ok: true }> = { ok: true, plan: finalPlan, imageSent, vetoFired: enforced.vetoFired };
    if (answeredBy) out.provider = answeredBy;
    if (splitBypassReason) out.splitBypassReason = splitBypassReason;
    // ★v0.9.44(記録専用): レンジの規約違反は **parsed.plan(AI の生出力)** に対して判定する。
    //   enforce 後の plan で判定すると、トレンド veto / バイアスで片脚が落ちた回が upper/lower 不揃いになり
    //   null=観測不能になる。「プロンプトが効いていない」ことを知りたい母集団はまさにそこなので生出力を見る。
    const anomaly = describeRangeAnomaly(parsed.plan);
    if (anomaly) out.rangeAnomaly = anomaly;
    // ★v0.9.57(記録専用): レッグ1本ごとの脱落を parse 段 → enforce 段の順に連結して載せる。
    //   ここは **none でなくても** 載せるのが要点(片レッグだけ落ちた回=最終プランは成立している回が
    //   まさに記録できていなかった)。同じレッグを二重に数えないことは各段の実装が担保する
    //   (enforce は自分が受け取った時点で在ったレッグしか記録しない)。判定・採否には一切影響しない。
    const legDrops: LegDrop[] = [...(parsed.legDrops ?? []), ...(enforced.legDrops ?? [])];
    if (legDrops.length) out.legDrops = legDrops;
    // ★RECORD-ONLY: 申告 LC幅の突き合わせは **parse 段(AI の生出力)** の結果をそのまま運ぶ。
    //   enforce 後の plan で作り直すと、故障が集中している「落ちたレッグ」が消えて観測できなくなる。
    if (parsed.lcAudit?.length) out.lcAudit = parsed.lcAudit;
    // ★RECORD-ONLY(v0.9.66): 「そのレッグは出さない」と述べたレッグ vs **実際に発注されるレッグ**。
    //   ここだけは最終 plan を見る(知りたいのは「出さないと言ったのに出た」= 素通りした回)。
    //   根拠文は最終 plan のもの(機械生成の脱落注記が末尾に付く)。注記は表明の語(省略/見送 等)を
    //   1つも含まず、しかも **全ての表明より後ろ** に足されるので、割り当ては生の根拠文と同じになる
    //   (この不変条件は scalpPlanOmissionAudit.test.ts が毎回確かめる)。
    const omissionAudit = omissionAuditFor(finalPlan.rationale, {
      limit: finalPlan.limitEntry != null,
      stop: finalPlan.stopEntry != null,
    });
    if (omissionAudit) out.omissionAudit = omissionAudit;
    // ★v0.9.44(記録専用): 見送り(none)の経路と落としたレッグの生数値を surface する。
    //   下流(rangeDisabled)→ enforce → parse の順に「最後に none 化したステージ」の理由を採る。
    if (finalPlan.direction === 'none') {
      const noneReason = guarded.noneReason ?? enforced.noneReason ?? parsed.noneReason;
      const noneLegs = guarded.noneLegs ?? enforced.noneLegs ?? parsed.noneLegs;
      if (noneReason) out.noneReason = noneReason;
      if (noneLegs) out.noneLegs = noneLegs;
    }
    return out;
  } catch (e) {
    // ★sanitize は必須(切り詰めはしない): この error は /api/scalp-plan の応答に**そのまま**載り、
    //   trade2 が受け取って chrono_kabu.log に `monitorError=` として記録し、同期フォルダへ出す。
    //   実測(同期フォルダ): 401 のキーエコー 1,758件 / 413 1,019件。実キー文字が出ていないのは
    //   **提供元が `****` で伏せてくれていたから**で、こちら側の防御は無かった(=運任せ)。
    //   ★落とすのは2種: ①APIキー ②V8 が埋め込むモデル生出力の断片。②は
    //     **非公開の決済ロジックの数値**(describeExitLogic がプロンプトへ実行時注入し、モデルが
    //     根拠文で言い直しうる)を同期フォルダへ運びうるため。長さは触らない(診断値を落とさない)。
    return { ok: false, error: sanitizeErrorForOutput(e instanceof Error ? e.message : String(e)), imageSent, ...(answeredBy ? { provider: answeredBy } : {}), ...(splitBypassReason ? { splitBypassReason } : {}) };
  }
}
