# scalp-plan: 損切りの向き検証(不正プラン発生源を断つ) (design)

日付: 2026-07-18 / 対象: monitor のみ(trade2は無改修) / ★実害バグ修正 / 版=v0.7.55

## 症状(実データ・Documents/trade で確定)
直近24hで trade2 の **sanity fail 1,880件が全て「損切りが逆側(不正プラン)」**・sanity pass 5・実発注5・
**最後の実発注 07-17 20:05 以降 約5.5時間 実弾ゼロ**。スモーキングガン:
`dir=buy limit=64565 stop=64665 指値ストップ(stopLossForLimit)=64610` → 買いなのに指値64565の損切りが
64610(=エントリーの上)=ロングの損切りが上=構造的に不正。trade2 のサニティは正しく拒否。

## 根本原因
- AIが2つの損切り(stopLossForLimit/stopLossForStop)を取り違え/逆側に置くことがある(64610=64665-55=逆指値レッグの正しい損切り値が指値レッグに入っている)。
- **monitor の `parseScalpPlan`/`enforcePlanConstraints` が「損切りの向き」を検証していない**ため素通し→arm→currentSignal。
- **紙エンジンは向きを検証せず擬似約定**(紙にトレード記録)/ **trade2は向きを検証して拒否**(実弾0)→ 紙と実弾が乖離。
  = trade2は正常(資金保護)。バグは monitor が不正プランを出し紙が通す点。

## 方針
発生源(monitor parse)で**損切りの向きを検証**し、違反レッグを落とす。→ 不正プランを出さなくなり、紙エンジンも
trade2実弾も同じく「不正レッグは無い」状態になり **一致**する。既存の幾何検証(レッグ対の整合・range側)と同列の追加。

## 実装(monitor)
### parseScalpPlan(server/llm/openai.ts) — 向き検証を追加
既存のレッグ対整合チェックの後に、**各レッグの損切り向き**を検証:
- **directional**: buy → `stopLossForLimit < limitEntry` かつ `stopLossForStop < stopEntry`(損切りはエントリーの下)。
  sell → 各損切り > 各エントリー(上)。**違反レッグは落とす**(該当 entry+SL を undefined 化・既存の「片レッグ落とし」と同じ)。
  両レッグとも落ちたら(direction≠none なのに有効レッグ皆無)→ **`none`**(ok:true 見送り)。
- **range**: 各レッグは自分の side を持つ → buy レッグ `stopLoss < entry` / sell レッグ `stopLoss > entry`。違反レッグを落とす。
  両落ち→ none。片落ち→ 片面range(v0.7.51既存経路)。
- 境界(SL==entry=幅0)は不正として落とす(実質ストップにならない)。数値未確定は既存どおり。
- ★既存の「LC幅≤上限」等は enforce の責務のまま不変。ここは**幾何(向き)の検証のみ**。

### enforcePlanConstraints — 二重防御(任意・軽)
parse を通っても万一 向き不正が残れば、enforce の先頭 or LC段で同じ向き検証で落とす(冪等)。主修正は parse。

### 紙エンジン(engine.ts) — 発生源修正で自動一致
parse で不正レッグが除かれるため planToArmed は有効レッグのみ受け取る=紙も不正約定しない。追加の防御として
`planToArmed`/`detectFill` で「損切りが約定サイドの正しい向き」を assert して不正なら該当レッグを armed に含めない(belt-and-suspenders・挙動は正常時不変)。

### プロンプト(補助)
scalpJsonInstruction/systemPrompt に明示: 「指値レッグの損切りはエントリーの外側(buyは下・sellは上)、逆指値レッグの
損切りも同様に外側。損切りをエントリーの内側/反対側に置かない」。コードで担保するが遵守を促す。

## 非対象/不変
- **trade2 無改修**(サニティは既に正しい=そのまま。monitorが正しいプランを出せば実弾が follow する)。
- 既存の directional/range/none/LC/bias/trend-veto/勢い注入/richデータ(v0.7.54)は不変=向き検証の追加のみ。
- 私的exit不変。版=monitor v0.7.55 単独。

## テスト/受入
- parseScalpPlan 向き検証: buy で SL>entry のレッグ落とし / sell で SL<entry 落とし / 両違反→none / 片違反→片レッグ /
  range buy-leg SL>entry 落とし・sell-leg SL<entry 落とし / 正しい向きは不変(既存テスト緑) / 境界SL==entry落とし。
- enforce 二重防御が正常プランを変えない(byte一致)。planToArmed/detectFill が不正レッグをarmしない。
- ★スモーキングガン再現テスト: `{buy, limitEntry:64565, stopLossForLimit:64610, stopEntry:64665, stopLossForStop:64610}`
  相当 → 指値レッグ落とし(逆指値のみ)or 逆指値も不正なら none、を確認。
- 既存全テスト緑・tsc0・build緑。**受入の肝**: 不正な向きのSLを持つ計画が二度と armed/currentSignal に載らない=紙と実弾が一致する。
