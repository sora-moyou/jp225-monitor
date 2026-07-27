# AI駆動ドテン(反転)設計 — monitor が保有中に反転をAI判断しシグナルを出す

日付: 2026-07-24 / 対象: monitor(signal engine + scalp-plan)+ trade2(signal 追従) / 前提: シグナル完全一致([[project_refactor_validation_plan]])

## 1. 目的・原則

trade2 は monitor のシグナルに**完全追従・独自判断ゼロ**(v0.1.42 で range/独自ドテンを撤去済)。ドテン(反転=決済+反対建て)も **monitor の設定と AI 判断**で決め、シグナルとして出す。trade2 は doten シグナルを受けて実行するだけ。

**ユーザー確定仕様**:
- **ドテン許可 = AI判断**(許可時は常時ドテンではなく、ドテンが必要かをAIが**都度判断**)。
- AIが「決済と同時に反転すべき」と判断した場合のみ monitor が **doten シグナル**を出す。そうでなければ通常決済(exitStop)のみ。
- monitor の紙 と trade2 の実弾が**完全一致**(monitor 側もドテンで紙建玉を反転させ、同じ doten シグナルを trade2 に出す)。

## 2. doten シグナル契約(monitor⇔trade2 の IF)

`SignalTradeState.signal`(currentSignal・SSE `signalTrade`)に **`doten?: true`** を追加(既存フィールド不変=在るときだけ付与):
- `doten:true` のシグナル = **反転指示**。保有中に emit される。direction は**保有と反対**。limit/stop/SL は新規(反対)建玉のもの。signalId は新規採番。
- 無い(従来)= 通常のエントリーシグナル(flat 時のみ trade2 が follow)。

## 3. monitor 側の変更

### 3.1 設定
- `dotenEnabled` ノブを config に追加(scalpRangeEnabled と同型・profile対応)。**ON=「AIがドテンを判断してよい」**(=AI判断)。OFF(既定)=ドテンを出さない。
- 設定スナップショット(entry_meta)にも doten 委任状態を載せる(記録)。

### 3.2 AIプロンプト注入(scalp-plan)
- **doten評価用の追記**: 保有中の doten 評価時、プロンプトに「現在 {long/short}@{建値} を保有。ドテン許可時、**決済が妥当かつ反対方向の強い場面**なら direction を反対にした反転プランを返してよい(doten)。常にではなく、その場面だけ。反転不要なら direction:"none"(保有継続)。」を注入。dotenEnabled=false は doten を出させない。

### 3.3 保有中の反転評価(新機構=肝)★レビュー反映
- 現状 `maybeRequestPlan` は `this.planning || state.phase !== 'flat'` で return。feed() の順序は `advance()`(=filled→flat の exitStop決済を先に処理)→ `maybeRequestPlan`。
- **追加(filled分岐)**: `state.phase === 'filled'` かつ dotenEnabled のとき、**held-eval** を AI に要求。**必ず守るガード(#3)**:
  - `this.planning`(in-flight)を**共有**(flat-plan と doten-eval が同時にAIを叩かない)。
  - `inPollWindow` で時間外は要求しない。
  - クールダウン/間隔(**flat plan間隔以上**・held は spend が倍化しやすいので長め)。
  - **★async 同一性再チェック**: 要求時に評価対象の建玉識別(`position.at` + direction + signalId)を控え、**AI応答解決時に「まだ filled かつ同一建玉」でなければ破棄**(解決までに exitStop で決済/別建玉に入替わっている可能性=幽霊を反転させない)。
- AI応答が **保有と反対方向(#5: `direction === opposite(held.direction)` を checkSanity とは別の第一級ガードで確認)の actionable プラン**(checkSanity 通過)なら → **doten として反映**(§3.4)。none/同方向/サニティ不通過 → 何もしない(保有継続・従来 exitStop 決済)。
- **held-context 配線(#5)**: `runScalpPlanWithChart` に `heldPosition?:{dir,entry}` を追加し、プロンプト(§3.2)へ注入する。

### 3.4 doten の反映(monitor 紙 + シグナル)★最重要(#2)
- **monitor 紙は「即時約定」しない**。paper engine には即時建て primitive が無く、`detectFill` が NIY=F の交差で filled になる。ドテン反転は:
  1. 現保有 P を**決済**(exitStop 早出し or 直接 close・pnl を signal_trades に記録)。
  2. 反対ブラケットを**arm**(currentSignal を doten シグナルに更新・`doten:true`・反対 direction・**新 signalId を1回だけ採番**[engine の既存採番をミラー])+ broadcast。
  3. 反対建玉は **trade2 と同じ交差ルール**(`detectFill`)で filled になる=**paper と live が同じタイミング/価格ソースで約定**。
- ★これにより「紙が即約定・trade2 が交差待ち」の乖離(#2)を防ぐ。実質は「exitStop決済→新ARM」を、**doten フラグ付き・保有中に早出し**する形。
- doten もサニティゲート(checkSanity・v0.9.6)を通す。checkSanity は**新反対ブラケット**の妥当性を見る(反転自体の妥当性は §3.3 の opposite ガードで担保)。
- **★doten の SSE フィールドは add-only(#6)**: `doten?:true` は**実 doten の時だけ**付与(`toSignalTradeState` / trade2 `normalizeSignal` の両方)。非 doten の JSON は不変=dotenEnabled OFF で byte一致・dedupe 不変。

## 4. trade2 側の変更 ★レビュー反映(#1/#3/#4)

**★ユーザー確定追記(2026-07-27)**:
- **実行は必ず「決済 + 新規」の2ステップ**(実売買の送信に対応)。**単一のネット反転(建玉を跨ぐ成行1本)は使わない**=決済送信→ブローカーで flat 確認→反対新規、の順(=下の close-confirm-then-open と同一)。実発注は「返済(決済)」と「新規(反対)」の2注文として送る。
- **シグナルは『ドテン』と明記する**(表示・記録の両方)。`doten:true` を立てるだけでなく、**パネルの表示に「ドテン」を明示**(目線/シグナル行に「🔃 ドテン(反転)」等)し、**記録(entry_meta / exit-decision / entry-decision のタグ)にも doten を残す**。通常の「決済→別の新規」と人間・突合の両方で区別可能にする。

- **doten の判定は FILLED 分岐の独立経路**(#3): trade2 の FILLED 分岐は currentSignal を見ず、`shouldFollowSignal` は `flat && monitorPhase==='armed'` を要求し、`reconcileState` は保有中 `pendingSignal` を捨てる。doten はこれらを通さず、**「`doten:true` + 新 signalId + trade2 が FILLED」**を専用トリガーにする(monitor 反転後は `monitorPhase==='filled'` なので armed ゲートは使えない)。
- **★NEVER-NAKED = close-confirm-then-open(#1・必須)**:
  1. 保有側を**決済(flatten)送信**し、**ブローカーで flat になった確認**(tracker `no-position`/board-update)を待つ。
  2. **その後**に反対ブラケットを発注(逐次OCO)。
  - ★**保有中に反対を先に出さない**(決済前に反対を出すと reconcile が両側を見て `flattenHedge` が発火=両建てを全flatten→反転が黙って消える+monitor紙は反転済み=乖離)。「反対約定で相殺」も**禁止**(micro は建玉ベース・成行反対は原子的に相殺しない・重なると flattenHedge)。
  - ★この close→open を **postAbortVerify と同型の「reconciler-aware サブ状態」**として実装(2つのバラバラな tick でなく1つの管理状態)。orphan-adopt/independent-stop churn の轍を踏まない。
- **★half-done reversal の意味論(#4)**: 決済成功・反対発注が失敗(dead/reject)したら trade2 は **FLAT で止める**(無防備な新規は強制しない=liveExec に open失敗のフェイルセーフは無い/作らない)。ただし monitor 紙は反転済み=乖離。→ この事象を **記録**(doten相関id付き)し検証で突合可能に。retry するかは記録優先で保守的に FLAT。
- **★記録(#4)**: doten は **決済(P の exit)+ エントリー(反対の entry)** の2側面。`emitExitStop`/`emitEntryDecision` は片方前提なので、**doten の2行フットプリント**(close の exit-decision + flip の entry-decision・共有の doten 相関id)を定義し paper/live を突合可能に。
- doten フラグが**無い**通常シグナルは従来どおり(保有中は取らず flat 復帰後に follow)。
- 安全網(never-naked/flattenHedge/checkRangeSanity/引け全決済)不変。

## 5. 段階・検証

- monitor `dotenEnabled` 既定 OFF = **既定で挙動不変**(doten を出さない)。ON にしたときだけ新経路。
- ユーザーは検証で dotenEnabled を ON にして、monitor 紙の doten と trade2 の doten を signal_id で突合(検証③④)。
- exit_stop_history / entry_decisions / signal_exit_stops に doten を記録(反転の時刻・方向を突合可能に)。

## 6. リスク・要確認(設計レビュー観点)

- **保有中に AI を叩く頻度**(コスト・レート)。クールダウンで抑制。
- **doten の NEVER-NAKED**: 決済と反対建ての間の無防備窓。決済約定確認→反対発注 or 反対約定で相殺、のどちらでも無防備を作らない実装。
- **monitor 紙の doten 反転**が signal_trades/決済記録と整合するか(pnl・signalId)。
- **completeMatch**: monitor 紙が doten で反転した建玉と trade2 実弾の反転が signal_id で一致するか。
- **既定 OFF で完全に挙動不変**(dotenEnabled=false のとき、保有中の AI 評価経路も走らない=コスト増なし)。
