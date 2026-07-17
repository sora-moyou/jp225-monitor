# scalp-plan レジーム/転換ガード＋勢い注入 (design)

日付: 2026-07-17 / 対象: monitor のみ(trade2は追従で無改修) / 実データ診断由来

## 背景(実データ)
monitor紙 signal_trades 38件＋trade2実弾trades を解析:
- range を乱発(36/38)し、**強トレンド(≥100円/10分)中に range を27件=うち20負け**(生きたトレンドを「レンジ」と誤読して両側フェード)。
- 実弾directionalも「下落トレンド→戻り売り」を**転換後も引きずり**(12分間売り続け反発に轢かれ)、フェード勝率22%/順張り36%。
- rationale が証拠: +420円急騰直後でも「トレンドなし→レンジ」/ 底打ち反発中でも「下落トレンド継続」。
- 勝率: 直前10分の値動き **中(30-100)=40%勝** vs **強(100-250)=21%勝**。→「弱い動き=真レンジ」は機能、「強い動き=トレンド」をフェードして負ける。
結論: **AIが直近の勢い/転換を数値で持たず、少し前のトレンド像を語って直近の動きに逆張りする**。directional/range 共通の根。

## 方針(推奨=B+A・monitorのscalp-plan=脳に入れる)
AIの目視判断に頼らず**コードで「生きたトレンドはフェードさせない」を決定的に強制**＋**勢いを数値で注入**。閾値初期=**100円/10分**。

## A. 勢い/転換の数値注入
- 新純関数 `computeRegime(bars, now, {thresholdYen})` → `{ ret10, ret30, ma20Slope, swingHigh, swingLow, posPct, dir:'up'|'down'|'flat', strong }`(`server/signalTrade/regime.ts`・テスト)。
  - ret10=close(now)−close(now−10分)・ret30=同30分・ma20Slope=MA20(now)−MA20(now−5分)(1分足close)・swingHigh/Low=直近30分の高安・posPct=レンジ内位置。
  - dir: ret10≥+T→'up' / ≤−T→'down' / それ以外'flat'。strong=(dir≠'flat')。足不足はnull→flat(vetoしない)。
- `barsFor('NIY=F')`(chatContext・実足)から算出。`buildNikkeiTechnical` の技術文字列末尾に1行追記:
  `直近の勢い: 10分{±X}円 / 30分{±Y}円 / MA20傾き{±Z} / 直近30分高安[{L}-{H}]内{pos}% → {上昇/下降トレンド|横ばい(レンジ可)}({強|弱})`。
- runner(`scalpPlanRunner`)/`buildScalpPlan` で regime を1回算出し、注入と下記 enforce の両方へ渡す(一貫)。

## B. レジーム/転換ガード(決定的・enforcePlanConstraints型)
`enforcePlanConstraints(plan, {ceilingYen, bias, trend})` に **trend veto** を追加(既存 LC上限/bias veto と合成):
- **trend.strong のとき、トレンドに逆行する side の脚を落とす**:
  - dir='up' → **side='sell' の脚を落とす**(上昇の高値を売らない)。買い脚(buy-stopブレイク/buy-limit押し目)は残す。
  - dir='down' → **side='buy' の脚を落とす**。
  - directional(buy/sell): side=direction ゆえ逆行なら**両脚落ち→direction:'none'**(=強上昇でのsell/強下降でのbuyは見送り)。順行は残す。
  - range: 各脚の side で個別に落とす(強上昇なら上=売り指値を落とし、下=買い指値/買い順張りは残る=実質トレンド方向の片面へ)。
- flat(|ret10|<T) → trend veto なし(既存挙動=真レンジのフェード可。中30-100帯は40%勝ゆえ潰さない)。
- 合成順: **trend veto → bias veto → LC上限 → 空なら none**。純関数・網羅テスト(up/down/flat×range/directional×片落ち/両落ち)。

## 設定
- `scalpTrendVetoYen?:number`(config+⚙️UI+`resolveScalpTrendVetoYen`・**既定100**・PARAM_BOUNDS 0..1000・**0で無効化**)。説明必須(「直近10分でこの円以上動いていたらトレンドと見なし逆行フェードを禁止」)。

## プロンプト(補助・遵守はBで担保)
- buildScalpQuestion/systemPrompt に: 「『レンジ』は直近10〜30分がほぼ横ばい(±{veto}円未満)のときだけ。直近が一方向に強く動いていればレンジではない=トレンド方向の順張り か direction:'none'。トレンドに逆行する新規(順トレンドの高値売り/安値買いの戻り売買)は出さない。」＋注入した勢い数値を判断に使うよう明記。

## 非対象/不変
- trade2 は monitor の(トレンド調整済み)シグナルを追従するだけ=**無改修**。実行部・engine擬似約定・私的exit・range配線(v0.7.51)は不変。directional/range とも同じ veto を通る。
- 版=**monitor v0.7.52 単独**。

## テスト/受入
- computeRegime(ret10/30・MA傾き・swing・dir/strong・足不足→flat)、enforce trend veto(up→sell脚落とし/down→buy脚落とし/directional逆行→none/range片面化/flat=素通し/bias・LCと合成)、resolveScalpTrendVetoYen既定100・0で無効、勢い注入文字列、runner が regime を注入と enforce の両方へ渡す。
- 既存 directional/range/none テスト不変(trend=flat または veto無効時は現行と完全一致)。tsc0/vitest緑/build緑。
- 受入の肝: (a)強トレンド中に逆行フェード脚が確実に落ちる、(b)flatでは現行と完全一致、(c)0で機能停止(現行復帰)、(d)directional逆行→none・順行維持、(e)range が強トレンドで片面(順張り)化 or none。
