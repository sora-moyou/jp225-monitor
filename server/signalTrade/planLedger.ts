// 計画サイクルの台帳(signal_plans)の行ビルダー。**純関数のみ**(DB もエンジン状態も触らない)。
//
// ■ なぜ要るか(実測)
//   signal_trades は「約定して決済された」ときにしか1行入らない。だから A/B 実験の主要指標である
//     ・見送り率(なぜ入らなかったか)
//     ・レッグが落ちた理由の内訳
//   が DB に **1行も** 残っていなかった。実運用機の書き出しでは、サーバログに
//   plan-suppress が A=212 / B=203 件、plan-legdrop が A=32 / B=16 件あるのに、signal_trades には
//   それに対応する行が存在しない。しかもサーバログはローテートするので、1年の実験では消える。
//   → 計画サイクルのたびに1行、A/B 両方について DB に残す(約定/見送りに関わらず必ず1行)。
//
// ■ ★語彙を増やさない
//   direction / noneReason / vetoFired / regime / confidence / legDrops は
//   すべて ScalpPlanResult(server/llm/scalpPlan.ts)に既に在る値をそのまま写すだけ。
//   leg_drops_json の書き方は分析用の台帳(proposals.leg_drops_json)と同じ = LegDrop[] をそのまま JSON 化する。
//   settings は signal_trades.meta に入れているものと **同じ組み立て**(persist.ts の buildSettingsSnapshot)を
//   呼び出し側から受け取る(この関数は二重に組み立てない)。
//
// ■ RECORD-ONLY
//   ここで作った行は記録にしか使わない。採否・価格・SSE・決済には一切影響しない。

// ★2026-08-31: 脚の名札(記録専用)の唯一の出所。web(signalPanel)と同じ1つの関数を見る
//   = 名札の規約をここで再実装しない(core は依存ゼロの葉モジュール)。
import { entryLabel } from '../../core/entryLabel.js';
import type { SignalSettingsSnapshot } from '../types.js';
import type { ScalpPlanResult } from '../llm/scalpPlan.js';
import type { SignalPlanInsert } from '../db/store.js';
import type { ArmWaitDecision } from './armWait.js';

/** rationale(AI の判断理由)の上限文字数 = **暴走止めの安全弁**であって、整形の道具ではない。
 *
 *  ■ なぜ 240 をやめたか(2026-08-17・実測)
 *   根拠文は表示の飾りではなく **シグナルの正しさの一部**(なぜその向きか・なぜその価格か・LC の検算)。
 *   記録側で削ると、後から「その計画が正しかったか」を検証する材料そのものが欠ける。
 *   旧 240 文字は実測で次の状態だった(generator_proposals_kabu.db・plan_json の rationale 12,043件・
 *   2026-08-03〜08-17):
 *     - 中央値 76 / p90 163 / p99 224 / **最長 319** 文字。240 超は 61件(0.51%)。
 *       (buy/sell かつ prompt-v2 を除く母集団では 2,722件中 2件 = 0.1%)
 *     - v0.9.70 以前は 1.7%(3,466件中59件)が 240 を超えていた。
 *   つまり **いまは効いていないが、理由文が長くなった瞬間に効き始める** 罠だった。
 *   ★2026-08-17 時点では、根拠文を複数行にする変更は入っていない(いったん撤回した)。
 *   上限を上げておく理由は「将来そうするから」ではなく、**記録は削らないという原則**そのもの。
 *   理由が長くなった回を無言で削るのは、④の材料を失うことに直結する。
 *
 *  ■ なぜ「無制限」でなく 2000 にしたか
 *   上限を外すと、LLM が壊れた出力(同じ文の反復・プロンプトの丸写し)を返した回に台帳が無制限に膨らむ。
 *   実測の最長が 319 文字なので **2000 は桁で余裕がある**(実測の 6 倍)= 正常な根拠文には事実上効かず、
 *   異常出力だけを止める。容量: 2000文字が仮に毎行入っても UTF-8 で約 6KB/行 だが、
 *   実測平均(約 250バイト)で年 44,000行 ≒ 33MB/年 のまま変わらない(裾が伸びても上限で頭打ち)。
 *   ★切られた回を後から見分けられるよう、切ったときだけ末尾に省略記号を付ける(下記)。 */
export const PLAN_RATIONALE_MAX_CHARS = 2000;

/** 切り詰めが起きたときだけ末尾に付く印(=「この行は削られている」と台帳から読めるようにする)。 */
export const PLAN_RATIONALE_TRUNCATED_MARK = '…[切詰]';

/** 根拠文を **改行を保ったまま** 正規化する。空/未指定は null。
 *
 *  ★改行を潰さない: `\s+ → ' '` の1行化は、根拠文が複数行になった回に構造を壊す
 *    (実害があったのはこちら。上限より先に外すべき部分)。AI が改行を使うかは版によって変わるので、
 *    「いまは1行だから潰してよい」とはしない=記録側は受け取った形を保つ。
 *  ★残す正規化は「意味を壊さないもの」だけ:
 *    - CRLF/CR → LF(DB に混在した改行コードを入れない)
 *    - 各行の行末の空白を落とす
 *    - 3行以上の連続空行 → 空行1つに圧縮(段落の区切りは残す)
 *    - 全体の前後の空白を落とす
 *  ★上限(max)は安全弁。超えたときだけ切り、切ったことが分かるよう印を付ける。 */
export function trimRationale(s: string | null | undefined, max = PLAN_RATIONALE_MAX_CHARS): string | null {
  if (typeof s !== 'string') return null;
  const normalized = s
    .replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.replace(/[ \t　]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return null;
  if (normalized.length <= max) return normalized;
  // 印のぶんも含めて max に収める(列の想定長を超えない)。
  return normalized.slice(0, Math.max(0, max - PLAN_RATIONALE_TRUNCATED_MARK.length)) + PLAN_RATIONALE_TRUNCATED_MARK;
}

export interface SignalPlanRecordInput {
  /** 記録時刻(計画が解決した時刻)。 */
  t: number;
  /** 系統。A も明示的に 'A'(この表は NULL=A の後方互換規約を持たない)。 */
  system: 'A' | 'B';
  /** 計画の結果(ok=false もそのまま渡す=「計画が得られなかったサイクル」も1行残す)。 */
  result: ScalpPlanResult;
  /** ARM した回だけ采番値。見送り/不成立は null/未指定。 */
  signalId?: number | null;
  /** そのサイクルで有効だった実効設定(buildSettingsSnapshot の戻り値をそのまま)。 */
  settings?: SignalSettingsSnapshot | null;
  /** ★ARM した回だけ: 未約定待ち時間(armed-timeout までの猶予)の決定内訳。
   *  「なぜこの待ち時間になったか」を後から読めるようにするための記録(採否には一切影響しない)。 */
  armWait?: ArmWaitDecision | null;
  /** ★v0.9.96(RECORD-ONLY): ARM 直前のゲートの生数値。
   *  driftYen  … |plan.refPrice − ARM 時 live|[円]。live が取れない回は未指定(=NULL)。
   *  staleLegs … 「もう通過している」と判定されたレッグの本数(0/1/2)。判定を走らせなかった回は未指定。
   *  ★どちらも **閾値を超えたときだけ** ではなく **測れたら必ず** 入れる: 分布が見たい
   *    (200円という上限が妥当かを後から見直すため)。採否には一切影響しない。 */
  driftYen?: number | null;
  staleLegs?: number | null;
}

/** 1計画サイクルぶんの挿入行を組み立てる(純関数)。
 *  ok=false(画像が撮れない・LLM 失敗など)は direction を NULL にし、error にその理由を残す
 *  = 「見送り(none)」と「そもそも計画が出なかった」を後から必ず区別できるようにする。 */
export function buildSignalPlanInsert(input: SignalPlanRecordInput): SignalPlanInsert {
  const { t, system, result } = input;
  const row: SignalPlanInsert = { t, system };
  // ★凍結再生の突合(RECORD-ONLY): 「いつの断面から文脈を組んだか」と「送ったプロンプトの指紋」。
  //   error 分岐より **前** に載せる: 文脈は組んだが LLM で落ちた回(ok=false)こそ、
  //   「入力は在ったのに計画が出なかった」標本として時刻と指紋が要る(載せ忘れの経路を作らない)。
  //   ★指紋は一方向ハッシュ(`sp1:<16桁hex>`)で、プロンプト本文は台帳に1バイトも入らない。
  if (typeof result.contextAt === 'number') row.contextAt = result.contextAt;
  if (typeof result.promptFp === 'string') row.promptFp = result.promptFp;
  // ★v0.9.93(RECORD-ONLY): **この行を書いたのはどの版・どの文面か**。error 分岐より前に載せる
  //   =「計画が出なかった回はどの版で起きたか」も残る(版が記録に無いと解析が間接推定に落ちる)。
  //   ★prompt_build は pb1(固定の合成コンテキストで描いた文面の指紋)。sp1 と混ぜない。
  // ★v0.9.96(RECORD-ONLY): ARM 直前のゲートの生数値。error 分岐より前に載せる
  //   =「計画は出たが drift で落ちた」回も残る(この列が無いと console ログにしか出ない)。
  if (input.driftYen != null && Number.isFinite(input.driftYen)) row.driftYen = input.driftYen;
  if (input.staleLegs != null && Number.isFinite(input.staleLegs)) row.staleLegs = input.staleLegs;
  if (typeof result.appVersion === 'string') row.appVersion = result.appVersion;
  if (typeof result.promptBuild === 'string') row.promptBuild = result.promptBuild;
  // ★段5(RECORD-ONLY): A/B 分割の測定材料。error 分岐より前に載せる
  //   = 「A は答えたが B が呼べなかった」ような回(ok:false)にも、目線側の記録だけは残る。
  //   ★b_variant / squeeze_state は SplitRecord では必須(常に値を持つ)ので、in がある回は必ず writes する
  //   (undefined と null を混ぜない・既存の8列の規約と同じ)。
  const sr = result.splitRecord;
  if (sr) {
    if (sr.aDirection !== undefined) row.aDirection = sr.aDirection;
    if (sr.aWhy !== undefined) row.aWhy = sr.aWhy;
    row.bVariant = sr.bVariant;
    row.squeezeState = sr.squeezeState;
    if (sr.squeezeUnavailable !== undefined) row.squeezeUnavailable = sr.squeezeUnavailable;
    if (sr.bStrategy !== undefined) row.bStrategy = sr.bStrategy;
    if (sr.aiWhy !== undefined) row.aiWhy = sr.aiWhy;
    // ★段6: B が「判断に必要なデータが足りなかった」と自己申告した自由文。ai_why とは別列。
    if (sr.missingData !== undefined) row.missingData = sr.missingData;
    if (sr.toolCalls !== undefined) row.toolCalls = sr.toolCalls;
    // ★段5: A/B それぞれを答えたプロバイダ。callWithFallback は呼び出しごとにプールを引くため、
    //   A と B が別プロバイダで答える組み合わせが起こる。既存の provider/provider_model(単一)とは別列。
    if (sr.aProvider) { row.aProvider = sr.aProvider.name; row.aProviderModel = sr.aProvider.model; }
    if (sr.bProvider) { row.bProvider = sr.bProvider.name; row.bProviderModel = sr.bProvider.model; }
    // ★段5: A/B それぞれのプロンプトの型の指紋(pb1 と同じ作法・データを含まない)。
    if (sr.aPromptBuild !== undefined) row.aPromptBuild = sr.aPromptBuild;
    if (sr.bPromptBuild !== undefined) row.bPromptBuild = sr.bPromptBuild;
    // ★TP(利確・RECORD-ONLY・2026-08-30): **誰が TP幅を決めたか** の層別キー。
    //
    //   ■ ★設定(scalpTpWidthSource)を直接引かない(リーダー裁定)。
    //     記録として意味のある事実は「**この回、実際に AI に尋ねたか**」であって、
    //     「いまの設定がどうなっているか」ではない。設定は後からいくらでも変わるので、
    //     行を書いた後に設定を変えられると、台帳の値が過去の事実を表さなくなる。
    //     → SplitRecord.bAskTp(= B を呼ぶ直前に確定した実測値)から導く。
    //   ■ ★true → 'ai' / false → 'manual' / ★**未設定(B を呼んでいない)→ NULL**。
    //     b_variant='none' の回は「尋ねたかどうか」という事実自体が存在しないので、
    //     'manual' で埋めない(0 と NULL を分けるのと同じ規約)。
    //   ■ ★注意(誤読しやすい): tp_source='manual' は「TP が有効だった」を意味しない。
    //     TP そのものを切っている(scalpTpEnabled=false)回も askTp=false なので 'manual' になる。
    if (sr.bAskTp !== undefined) row.tpSource = sr.bAskTp ? 'ai' : 'manual';
    // ★TP幅の読み取り失敗(記録専用)。★脚は落とさないので、この列が無いと無音で消える。
    if (sr.tpReadIssue !== undefined) row.tpReadIssue = trimRationale(sr.tpReadIssue);
  }
  // ★段5続き(RECORD-ONLY): 文脈のどのブロックが実際に入ったか。error 分岐より前に載せる
  //   = 「計画は組めたが LLM で落ちた」回(ok:false)にも、その回の文脈が何を持っていたかが残る。
  //   ★sr(splitRecord)とは無関係(分割の有無に関わらず contextPresence は付く)ので独立に読む。
  if (result.contextPresence) row.contextPresenceJson = JSON.stringify(result.contextPresence);
  // ★段6続き(RECORD-ONLY): 分割ON設定なのに、この回だけ旧経路へ落とした理由。error 分岐より前に載せる。
  if (result.splitBypassReason) row.splitBypassReason = result.splitBypassReason;
  // ★v0.9.70(RECORD-ONLY): **答えを返した** プロバイダ/モデル。error 分岐より前に載せる=
  //   「答えは返ったが計画としては不成立(ok:false)」の回も、どのモデルが返したかが残る。
  //   答えが得られなかった回は result.provider が無い=列は NULL(=「誰も答えなかった」が形から読める)。
  if (result.provider) {
    row.provider = result.provider.name;
    row.providerModel = result.provider.model;
  }
  if (input.signalId != null) row.signalId = input.signalId;
  // ★v0.9.70: チャート画像の群を settings_json へ **結果から** マージする(列は増やさない)。
  //   ★設定(config)からではなく result から取るのが要点: 記録すべきは「実際に送ったか」であって
  //     「送る設定だったか」ではない(テキスト専用プロバイダへ落ちて画像が外れた回は sent=false)。
  //   settings が無い呼び出しでも群だけは残す(群の欠落=「その版で記録していない」と読めるように)。
  const settingsForRow = result.chartVision
    ? { ...(input.settings ?? {} as SignalSettingsSnapshot), chartVision: result.chartVision }
    : input.settings;
  if (settingsForRow) row.settingsJson = JSON.stringify(settingsForRow);
  // ★待ち時間の決定内訳(ARM した回のみ)。error 分岐より前に載せる: 「ARM したのに ok=false」は
  //   起こり得ないが、載せ忘れの経路を作らないため分岐の外で1回だけ書く。
  if (input.armWait) {
    row.armWaitMs = input.armWait.waitMs;
    row.armWaitDistance = input.armWait.distanceYen;
    row.armWaitSigma = input.armWait.sigma1m;
    row.armWaitReason = input.armWait.reason;
  }
  if (!result.ok) {
    row.error = result.error;
    return row;
  }
  const plan = result.plan;
  row.direction = plan.direction;
  row.refPrice = plan.refPrice;
  row.rationale = trimRationale(plan.rationale);
  if (plan.regime !== undefined) row.regime = plan.regime;
  if (plan.confidence !== undefined) row.confidence = plan.confidence;
  // ★v0.9.84(RECORD-ONLY): その計画の狙い(相場の読み)。**⑥がここを読んで初めて成立する**:
  //   pnl を持つのは signal_trades だけ、狙いを持つのはこの表だけなので、
  //   (system, signal_id) で結合して「押し目 12件 勝率33%」を作る。どちらか片方が欠けると作れない。
  //   ★一覧外のラベルもそのまま入れる(丸めない)。書かれなかった回は列ごと NULL=「欠測」が形から読める。
  //   ★rationale と違い trim/上限は掛けない: parse 段(parseAiStrategy)で既に trim 済みで、
  //     こちらに二重の整形を持ち込むと「台帳の値」と「plan の値」がずれる(突合できなくなる)。
  if (plan.strategy !== undefined) row.strategy = plan.strategy;
  if (plan.strategyWhy !== undefined) row.strategyWhy = plan.strategyWhy;
  // ★v0.9.87(RECORD-ONLY): **その価格の根拠にした節目**。画面にも出すが、記録がここに要る理由は別:
  //   「本当に節目から導いたのか」を後から検証できるようにするため。limit_entry / stop_entry と
  //   同じ行に並ぶので、|entry − level| を SQL で数えれば「5〜10円内側」の契約が守られているか、
  //   そもそも節目でない値を書いていないかが、画面を見ていなくても測れる。
  //   書かれなかった回は列ごと NULL=「申告なし」が形から読める(0 を捏造しない)。
  if (plan.limitLevel !== undefined) row.limitLevel = plan.limitLevel;
  if (plan.stopLevel !== undefined) row.stopLevel = plan.stopLevel;
  // ★v0.9.88(RECORD-ONLY): **レッグごとの理由**。strategy_why と同じ規約:
  //   ・在るときだけ入れる(書かれなかった回は列ごと NULL=「欠測」が形から読める)。
  //   ・★**rationale と同じ安全弁を通す**(trimRationale = 上限 PLAN_RATIONALE_MAX_CHARS + 切詰の印)。
  //     当初これを掛けなかったのは「理由の量を測るのが目的だから削らない」という判断だったが、
  //     それは **正常な出力の話** で、上限が守っているのは LLM の暴走出力(同じ文の反復・
  //     プロンプトの丸写し)である。実測の根拠文の最長が 319字 に対し 2000 は桁で余裕があり、
  //     正常な理由には事実上効かない=測定対象は削られない。上限が無いと台帳が無制限に膨らみ、
  //     画面には 5,000字が1行として描かれる。
  //   ・★切られた回は末尾の印(PLAN_RATIONALE_TRUNCATED_MARK)で分かる=無言で削らない。
  if (plan.directionWhy !== undefined) row.directionWhy = trimRationale(plan.directionWhy);
  if (plan.entryWhyForLimit !== undefined) row.entryWhyForLimit = trimRationale(plan.entryWhyForLimit);
  if (plan.entryWhyForStop !== undefined) row.entryWhyForStop = trimRationale(plan.entryWhyForStop);
  if (plan.lcWhyForLimit !== undefined) row.lcWhyForLimit = trimRationale(plan.lcWhyForLimit);
  if (plan.lcWhyForStop !== undefined) row.lcWhyForStop = trimRationale(plan.lcWhyForStop);
  // ★v0.9.88(RECORD-ONLY): 画面の「順張り/逆張り」を決めた値。plan ではなく **result** に載る
  //   (コードが測った値で、AI の応答ではないため)。無い回は列ごと NULL=「測れなかった」が形から読める。
  if (result.trendDir !== undefined) row.trendDir = result.trendDir;
  // ★2026-08-31(RECORD-ONLY): **画面から消した脚の名札**。ユーザー指示
  //   「指値押し目買い等の文字列は…表示しないようにして、記録のみにしてください」= 消さずに移す。
  //   ★値は core/entryLabel.ts の entryLabel() を呼んで作る(**再実装しない**)。
  //     同じ規約を2箇所に持つのが、この案件が繰り返している事故の型そのもの。
  //   ★脚が無い回は **入れない**(列ごと NULL)。空文字にしない=「無い」と「空」を混ぜない。
  //   ★direction が none/range の回は脚が立たないので、そもそも名札が存在しない(=NULL)。
  //   ★トレンドが取れない回(trendDir が flat/conflict/stale/未指定)は entryLabel が
  //     順張り/逆張りの語を付けない=脚の型の語だけが入る(「押し目買い」)。
  //     ★★NULL にはしない: その回も画面では「押し目買い」と **呼んでいた**ので、事実として残す。
  //   ★なぜ再計算に頼らないか(direction × 種別 × trend_dir から出せるのに列を足す理由)は
  //     store.ts の ALTER のコメントと meta(column_semantics_leg_label)に書いた。
  if (plan.direction === 'buy' || plan.direction === 'sell') {
    if (plan.limitEntry !== undefined) {
      row.legLabelLimit = entryLabel(plan.direction, 'limit', result.trendDir).text;
    }
    if (plan.stopEntry !== undefined) {
      row.legLabelStop = entryLabel(plan.direction, 'stop', result.trendDir).text;
    }
  }
  if (result.vetoFired !== undefined) row.vetoFired = result.vetoFired;
  if (result.noneReason !== undefined) row.noneReason = result.noneReason;
  if (plan.limitEntry !== undefined) row.limitEntry = plan.limitEntry;
  if (plan.stopEntry !== undefined) row.stopEntry = plan.stopEntry;
  if (plan.stopLossForLimit !== undefined) row.stopLossForLimit = plan.stopLossForLimit;
  if (plan.stopLossForStop !== undefined) row.stopLossForStop = plan.stopLossForStop;
  // ★TP(利確・RECORD-ONLY・2026-08-30): AI委任のときだけ plan に載る **幅**[円](価格ではない)。
  //   ★手動のときは計画に焼かれない(設定の現在値を毎tick 引き直す契約)ので、ここは NULL のままになる。
  //     実際に効いた幅は signal_trades.tp_width 側を見る。
  //   ★★この値は **5円ずらし(applyPivotNudge)の後** の幅です。ずらした脚は AI が言った幅より
  //     5円 狭い(TP の絶対価格を保つため)。「AI の申告そのもの」ではないことは meta に明記してある。
  //   ★書かれなかった回は列ごと NULL=「欠測」が形から読める(0 を捏造しない)。
  if (plan.tpWidthForLimit !== undefined) row.tpWidthForLimit = plan.tpWidthForLimit;
  if (plan.tpWidthForStop !== undefined) row.tpWidthForStop = plan.tpWidthForStop;
  // ★tp_why は **いまの経路では必ず undefined**(= 列は NULL)。★意図して設定していない(裁定2):
  //   ユーザー指定の自由文形式は「価格・LC幅・TP幅をまとめて1つの理由文」で書かせるので、
  //   その1文から「TP の理由だけ」を切り出せない。lc_why_for_* が分割経路で常に NULL なのと同じ。
  //   ★それでも配線を通しておくのは、理由欄を持つ経路が来た日に **書き忘れの経路を作らない** ため。
  if (plan.tpWhy !== undefined) row.tpWhy = trimRationale(plan.tpWhy);
  // ★分析用の台帳(proposals.leg_drops_json)と同じ書き方: LegDrop[] をそのまま JSON 配列にする。
  //   1本も落ちなければ列ごと NULL(= 空配列 '[]' は書かない。proposals と同じ規約)。
  if (result.legDrops?.length) row.legDropsJson = JSON.stringify(result.legDrops);
  // ★RECORD-ONLY: 根拠文で AI が申告した LC幅 と 実際に出力した |entry − stopLoss| の突き合わせ。
  //   対象は **AI の生出力の全レッグ**(落ちたレッグも採用レッグも)。leg_drops_json とは別列に置く:
  //   故障は落ちたレッグ側にしか残らないので、採用レッグという対照が同じ台帳に無いと率が読めない。
  //   1件も突き合わせられなければ列ごと NULL(空配列 '[]' は書かない=leg_drops_json と同じ規約)。
  if (result.lcAudit?.length) row.lcAuditJson = JSON.stringify(result.lcAudit);
  // ★RECORD-ONLY: 根拠文で「そのレッグは出さない」と述べたレッグ と **実際に発注されるレッグ** の突き合わせ。
  //   「省略した」と書きながら有効な価格対を出す(=コードが落とさないのでそのまま発注される)回を数えるため。
  //   判定には一切使わない。1件も表明が読めなければ列ごと NULL(空配列 '[]' は書かない=他の列と同じ規約)。
  if (result.omissionAudit?.length) row.omissionAuditJson = JSON.stringify(result.omissionAudit);
  return row;
}
