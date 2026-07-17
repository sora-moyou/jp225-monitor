# scalp-plan: 構造化データ厚盛り＋AI自己レジーム/確信度＋トレード履歴フィードバック (design)

日付: 2026-07-17 / 対象: monitor のみ(trade2は追従で無改修) / 版=v0.7.54

## 方針(ユーザー哲学)
「AIには全データを与え、事前制約は最小にして自分で考えさせる方が良いものが出る」。
→ **思考系の制約を増やすのでなく、AIの土俵(データ)を広げ、判断はAIに返す**。ハードveto等の安全は当面残し、
richデータ＋AI自己判断で**vetoが不要になるか**を紙で並走計測する(vetoが自然に発火しなくなれば将来外す)。

## やること(3本柱)
### 1. 構造化データを厚く注入(画像依存→数値主軸)
scalp-plan の context に**数値の構造化ブロック**を追加(既存のチャート画像は補助として残す)。純関数で組み立て・DBの実OHLC(o/h/l/c/volume)を使う(realtime足はclose-onlyなのでDB `getRecentBars('NIY=F')` を優先):
- **直近の足(数値)**: 直近~15本の1分OHLC＋~8本の5分OHLC(時刻/O/H/L/C・必要ならvolume)。
- **節目(強度つき)**: `getLevelsSnapshot()` から 価格/種別(sup/res/pivot)/強度(タッチ回数等)/現在値からの距離(±円)。近い順 上位6-8。
- **ボラ/レンジ**: ATR(14 1分 or 5分)・本日セッション高安(H/L)・日中レンジ内の現在位置(%)・H/Lまでの距離。
- **スイング構造**: 直近の高値/安値スイング 2-3個(価格＋時刻)。
- **直近アラート＋その後**: 直近Nアラート(種別/方向/時刻)＋**発火後の結果**(ret5/15/30・prices.alerts または alertHistory)。「アラート後±X分でどう動いたか」。
- **セッション/時刻**: 日中/ナイト・JST時刻・セッション開始からの経過。
- 各ブロックはコンパクト(トークン節約)。組み立て失敗は当該ブロック省略(scalp-planを壊さない)。

### 2. AI自己レジーム＋確信度(構造化出力・当面は記録のみ)
- `AiPlan` に **`regime?: 'trend_up'|'trend_down'|'range'|'unclear'`** と **`confidence?: number(0-100)`** を追加。
- JSONスキーマ/プロンプトで「まず自分でレジームと確信度を述べてから計画を出せ」と要求(自己の判断を明示化=思考を促す)。
- `parseScalpPlan` が寛容に読む(欠落/不正は undefined・必須にしない=後方互換)。**当面ゲートには使わない**(記録のみ)。将来、信頼できれば外部computeRegimeの代わりに採用しAIの自己判断でゲート/サイジング(改善2の完成形)。

### 3. トレード履歴フィードバック(結果から学ばせる)
- context に**このシグナルエンジン自身の直近成績**を注入: `signal_trades` から直近~12件+集計。
  - 全体勝率・純pnl・**方向別(buy/sell)/mode別(range/directional)の勝率・pnl**。
  - **直近の負けトレード数例**(方向/エントリー/決済/pnl・可能なら直前の勢い等の文脈)。
  - 文言例: 「直近のあなた(本シグナル)の紙トレード成績。同じ失敗を繰り返さないよう改善に使え」。
- 純関数 `buildScalpTradeHistory(trades)`。件数少/DB無しは省略。コンパクト。

## 計測フック(並走A/Bのため)
- `enforcePlanConstraints` の trend veto が**発火したか(vetoFired)**を戻り値/フラグで surface(挙動は不変=従来どおり drop/none する。記録のみ追加)。
- 決済記録(`signal_trades.meta` JSON)に **`{regime, confidence, vetoFired, ctxV:'rich'}`** を保存。
  → 後で「AIの確信度は勝率と相関するか」「richデータでvetoの発火が減ったか」「自己regimeは実際と合うか」を実測。
- ハードveto/レンジ既定OFF/LC上限/バイアス/無防備禁止は**すべて不変**(安全・命令系は残す方針)。

## 実装の所在(monitor)
- `server/llm/openai.ts`: AiPlan に regime/confidence 追加・`parseScalpPlan` 寛容パース・スキーマ/プロンプト更新・`enforcePlanConstraints` に vetoFired surface。
- 新 `server/llm/scalpContext.ts`(または chatContext 拡張): `buildScalpMarketData(db, now)` と `buildScalpTradeHistory(trades)` 純関数。DB bars/levels/alerts/vol/swing を数値整形。
- `server/llm/scalpPlanRunner.ts`: 上記を context に組み込み、regime/confidence/vetoFired を engine へ返せるようにする。
- `server/signalTrade/engine.ts`: armed/position に AIの regime/confidence と vetoFired を持ち回り、決済時 `signal_trades.meta` に保存。
- 既存 computeRegime/勢い注入(v0.7.52)は残す(vetoの根拠＋richデータの一部)。

## 非対象/不変
- **trade2 無改修**(SignalProposal は regime/confidence を無視して従来追従・実行部不変)。
- 私的exit・range配線・LC/バイアス/無防備/サニティ・ハードveronの挙動は不変(記録の追加のみ)。
- 版=monitor v0.7.54 単独。

## テスト/受入
- buildScalpMarketData(足/節目/ボラ/スイング/アラート結果の整形・欠損時の省略)、buildScalpTradeHistory(集計/方向・mode別/負け例/少数時省略)、parseScalpPlan(regime/confidence 寛容・欠落OK・後方互換=既存テスト不変)、enforcePlanConstraints vetoFired surface(drop/none挙動はbyte不変)、engine が meta に {regime,confidence,vetoFired} を保存・取得できる。
- 既存 directional/range/none/trend-veto テスト不変。tsc0/vitest緑/build緑。
- 受入の肝: (a)context に数値ブロック＋履歴が入る(トークン過大でない)、(b)AIが regime/confidence を返し記録される、(c)veto挙動は不変で発火だけ記録、(d)DB/足/levels 欠損でscalp-planが壊れない、(e)trade2は無改修で従来追従。
