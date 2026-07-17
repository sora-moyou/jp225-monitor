# scalp設定を項目別に「手動(数値)/AI委任」で選択＋設定スナップショット記録＋履歴に設定を渡す (design)

日付: 2026-07-18 / 対象: monitor + trade2 / 版=monitor v0.7.56 / trade2 v0.1.31

## 目的(ユーザー指示)
「AIに任せられる可能性のある設定は、項目別に **手動(数値) / AI委任** を選べるようにし、徐々にAIの割合を増やす。
書き出しで**どの設定でエントリーしたか**分かるようにする。過去履歴に**設定値も含めてAIに渡し**て考えさせる。」
= 制約より入力・実測して外す(v0.7.54哲学)を、**ユーザーが項目別に手動→AIへ倒せる枠組み**に一般化。

## 委任可能な全項目(policy系。★安全系は委任不可=常時ハード)
| knob | config | 手動の意味 | AI委任の意味 |
|---|---|---|---|
| 初期LC下限 | `scalpLcFloorYen`(新) | 損切り幅の下限(プロンプト) | AIが下限を決める(強制なし) |
| 最大初期LC | `scalpLcCeilingYen` | 損切り上限で超過レッグ落とし | AIが損切り幅を決める(上限強制なし・ただし下記ハード上限は別) |
| トレンドveto閾値 | `scalpTrendVetoYen` | 数値(円/10分)で逆行フェード禁止 | 数値veto無効=AIの自己レジーム/確信度(v0.7.54)に委ねる |
| クールダウン | `scalpCooldownSec` | 決済後の再ARM抑止秒 | 抑止無効=AIの選択性(none見送り)に委ねる |
| バイアス | `scalpBias` | long/short強制veto | veto無効(='none'相当)=AIが方向を自由決定 |
| レンジ両面 | `scalpRangeEnabled` | on/off固定 | AIがrange採用可否を決める |
- 各 knob に **`<knob>Source: 'manual'|'ai'`(新・既定'manual')**。**既定は全て手動=現状の挙動を一切変えない**(ユーザーが1つずつAIへ)。

## ★LC安全上限(実弾暴走防止・有効/無効を選択可)
- `scalpLcHardMaxYen`(新・既定例150) + **`scalpLcHardMaxEnabled`(新・既定true)**。
- **有効時**: 最大初期LCが**手動でもAIでも**、|entry−SL| がこのハード上限を超えるレッグは必ず落とす(最後の安全網)。
- **無効時**: ハード上限なし(AI完全自由・ユーザーが明示的に選んだ場合のみ)。
- これは policy の scalpLcCeiling とは別の**安全系**。scalpLcCeiling=AI でもハード上限は独立に効く。

## ★委任不可(常時ハード=安全系・今回の対象外で不変)
損切りの向き検証(v0.7.55)・サニティ(現値が両建ての間・stop向き)・無防備禁止・OCO・建玉照会クリア・
ヘッジガード・二重建玉防止。これらは絶対に手動/AI選択にしない。

## monitor 実装
### 設定/リゾルバ
- 各 knob の `<knob>Source` + 既存/新規の値フィールド。`scalpLcHardMaxYen`/`scalpLcHardMaxEnabled` 追加。
- リゾルバは **`{mode:'manual'|'ai', value}`** を返す(例 `resolveScalpLcCeilingDirective()`)。既存の値リゾルバは後方互換で残す。
### プラン生成/enforce(mode で分岐)
- `buildScalpPlan`/`enforcePlanConstraints` に各 knob の directive を渡す:
  - LC上限: manual→従来の超過レッグ落とし / ai→上限で落とさない。**両モードとも `scalpLcHardMaxEnabled` 時は hardMax 超を落とす**(安全網)。
  - バイアス: manual→従来veto / ai→veto無効。
  - トレンドveto: manual→従来の数値veto(v0.7.52) / ai→数値veto無効(AI自己判断)。
  - クールダウン: manual→従来ゲート / ai→ゲート無効(maybeRequestPlan)。
  - レンジ: manual(off)→range→none / manual(on)→従来 / ai→AIが採用可否(range許可)。
  - LC下限: manual→プロンプトに下限 / ai→下限を課さない。
- ★安全系(向き検証・pairing・range side幾何・LC hardMax)は mode に関係なく常時適用。
### プロンプト
- 各 knob が **AIのとき**「この値はあなたが決める(自由・根拠を述べよ)」、**手動のとき**「この制約に従え(値)」を動的に注入。AI項目が増えるほどAIの裁量が広がる。
### 設定スナップショット(記録の核心)
- 各シグナル発生時の**実効設定**を1オブジェクトに: 
  `settings:{ lcFloor:{mode,value}, lcCeiling:{mode,value}, lcHardMax:{enabled,value}, trendVeto:{mode,value}, cooldown:{mode,value}, bias:{mode,value}, range:{mode,value} }`。
  AI委任項目で**実現値が測れるもの(LC幅=|entry−SL|)は value に実測を入れる**(例 lcCeiling ai なら採用レッグの実LC)。
- monitor 紙: `signal_trades.meta` に `settings` を追加(既存の {ctxV,regime,confidence,vetoFired,mode} とマージ)。
- **`currentSignal`/SSE に `settings` スナップショットを露出**(trade2 が記録に使う)。
### 履歴に設定を渡す(AIに考えさせる)
- `buildScalpTradeHistory`(v0.7.54)を拡張: 各過去トレードの `meta.settings` を読み、**設定つきで**要約
  (例「buy LC=120(AI) veto=AI bias=手動long → +65」)。**AI委任項目別の勝率/pnl 集計**も付ける
  (例「LC=AI: n=8 勝率X% / LC=手動: n=12 勝率Y%」)→ AIが「どの設定が効いたか」を自分で学べる。

## trade2 実装(v0.1.31・記録のみ・実行不変)
- SSE/`GET /api/current-signal` の `settings` スナップショットを sseFeed で受け取り、**採用エントリーの `entry_meta` に記録**
  (forward.db・既存 entry_meta 経路)。→ 実弾の書き出しにも「どの設定で入ったか」が残る。
- ★実行部(発注/OCO/サニティ/リコンサイル/exitStop追従/ヘッジガード)は無改修。settings は表示/記録専用。

## 非対象/不変
- 既定は全 knob 手動=**現状の挙動を変えない**(切替と記録の配管だけ先に用意)。
- 私的exit・向き検証(v0.7.55)・脳強化(v0.7.54)・実行部は不変。

## テスト/受入
- リゾルバ directive(mode/value・既定manual)、enforce の mode 分岐(ai時に該当制約を課さない・**hardMaxは常時**・安全系常時)、
  スナップショット生成(全項目・AI実現値)、meta/currentSignal 露出、history に設定＋設定別集計、
  trade2 が settings を entry_meta に記録(実行不変)。
- ★受入の肝: (a)全 knob 既定manualで**挙動byte不変**(回帰なし)、(b)各 knob を ai にすると該当制約だけ外れる、
  (c)LC hardMax は mode 無関係に効く(有効時)、(d)安全系(向き/サニティ/無防備/OCO)は常時ハード、
  (e)書き出し(紙meta・実弾entry_meta)に settings が残る、(f)AIに履歴＋設定＋設定別成績が渡る。
  両リポ tsc0/vitest緑/build緑。
