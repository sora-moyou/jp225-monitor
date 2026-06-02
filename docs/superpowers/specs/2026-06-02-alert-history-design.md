# SP: アラート履歴 ＋ 事後値動き 設計

作成日: 2026-06-02
対象: ロードマップ「SP3(元): アラート履歴 ＋ 事後値動き(+5/15/30分) ＋ チューニング分析」。
前提: SP1 の `bars_1m`(SQLite, NIY=F 1分足) と SSE broker、既存のアラート emit 経路。

---

## 1. 目的
発火したアラートと、その**後の値動き(+5/15/30分)**を DB に記録し、「どの検知がよく当たる/外れる」を
データで可視化して閾値チューニングに使う。

## 2. 既存の発火経路(確認済み)
アラートは 3 箇所で `broadcast({ type:'alert', payload })`:
`server/loops/alertLoop.ts:93`(1分burst), `:166`(5分trend), `server/tickDetector.ts:82`(超短期tick)。
`AlertEventPayload` = { symbol, symbolLabel, changePercent, windowSeconds, detectionKind('slope'|'magnitude'),
direction('up'|'down'), triggeredAt, change15min, pa15min, range1h, zscore }。

## 3. データモデル
`alerts` テーブル(store.ts に追加):
```sql
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL, triggered_at INTEGER NOT NULL,
  direction TEXT, detection_kind TEXT, window_seconds INTEGER,
  change_percent REAL, price REAL,             -- price = 発火時の現値
  session_date TEXT, session TEXT,
  ret5 REAL, ret15 REAL, ret30 REAL            -- 発火後 +5/15/30分の発火価格比リターン(%)。未確定は NULL
);
```
- `price` = 発火時の最新tick価格(`getLatestTick`)。
- `ret{N}` = `(発火+N分の価格 − price)/price × 100`。発火方向に動けば direction=up なら正、down なら負が「当たり寄り」。

## 4. コンポーネント
### 4.1 `server/alertHistory.ts`
- `recordAlert(db, payload, price)` — payload と発火価格から `alerts` に 1 行 insert(session は `classifySession(triggeredAt)`)。
- `emitAlert(payload)` — `broadcast({type:'alert',payload})` ＋ `recordAlert(...)` をまとめるラッパ。3 つの発火箇所はこれを呼ぶ(DB記録漏れを防ぐ単一経路)。価格は記録時に `getLatestTick` で取得。
- `followupTick(db, now)` — `ret30 IS NULL` かつ `triggered_at + 30分 <= now` の行について、`getBarCloseAt(db,symbol,triggered_at+offset)` で +5/15/30分価格を引き、ret を計算して UPDATE。部分的に確定できる ret(例 +5分だけ経過)も都度埋める設計にする(各 ret を個別に NULL チェック)。
- `startAlertHistoryLoop()/stop` — 自前 DB ハンドルを開き、30秒ごとに `followupTick`。

### 4.2 `store.ts` 追加
- `insertAlert(db, row)`、`getBarCloseAt(db, symbol, t): number|null`(`SELECT c FROM bars_1m WHERE symbol=? AND t<=? ORDER BY t DESC LIMIT 1`)、
  `getAlertsNeedingFollowup(db, now)`、`updateAlertReturns(db, id, ret5, ret15, ret30)`、
  `getRecentAlerts(db, limit)`。

### 4.3 ルート `server/routes/alerts.ts`
- `GET /api/alerts/history?limit=100` → `{ alerts: [...最新], stats: 種別×方向ごとの的中率 }`。
  - **的中**の定義: direction=up は `ret15 >= HIT_PCT`、down は `ret15 <= -HIT_PCT`(既定 `HIT_PCT=0.1`%)。集計は ret15 確定分のみ対象。
  - stats: detection_kind(+windowSeconds で 3 種に判別) ごとに {件数, 的中率(15分基準), 平均ret5/15/30}。

### 4.4 UI
- ツールバーに **📊 ボタン**(`#alerts-history-btn`、`.topbar-btn`)→ 履歴モーダル(`#alerts-history-modal`)。
- モーダル: 上部に**種別別サマリ**(超短期/1分/5分 ごとの 件数・的中率・平均+15分)、下に**一覧テーブル**
  (時刻 / 方向 / 種別 / 発火価格 / +5分 / +15分 / +30分、ret の符号で色)。
- `web/components/alertsHistoryModal.ts` で `GET /api/alerts/history` を取得して描画。開く度に再取得。

## 5. 種別の表示名
`windowSeconds` で判別: ≤15→「超短期(値幅)」、≤90→「短期(1分)」、それ以上→「長期(5分)」(既存の検知窓に対応。実値は実装時に確認)。

## 6. エラー処理・運用
- DB が開けない/書けない場合はログのみでアラート自体は継続(emitAlert は broadcast を先に行い、記録失敗で UI を止めない)。
- `alerts` は無制限に増えるが 1 日数十件程度で軽微。将来 prune は別途(本SP外)。
- 事後値動きは bars_1m がある時間帯のみ確定。場をまたぐ/欠損で価格が無ければ ret は NULL のまま。

## 7. テスト
- `store.test.ts`: insertAlert/getBarCloseAt(<=t の最新close)/updateAlertReturns/getRecentAlerts。
- `alertHistory.test.ts`: recordAlert(payload→行, session付与)、followupTick(注入barsで +5/15/30 の ret 計算、未経過は NULL のまま、部分確定)。
- ルートの集計(的中率)の純粋関数 `summarize(alerts)` を切り出して単体テスト。

## 8. 完了条件
1. `alerts` テーブル＋store ヘルパ(テスト緑)。
2. `emitAlert` 経由で発火が記録され、`followupTick` が +5/15/30分 ret を埋める(テスト緑)。
3. 3 つの発火箇所が `emitAlert` を使用、`startAlertHistoryLoop` が index で起動。
4. `GET /api/alerts/history` が一覧＋種別別的中率を返す。
5. 📊 モーダルでサマリ＋一覧が見られる。
6. 全テスト緑・typecheck・build:web 通過。

## 9. 調整ノブ
`HIT_PCT=0.1`(的中判定%)、followup 間隔 30秒、offsets [5,15,30]分、一覧 limit 100。

Related: SP1/SP2/basedata の各 spec。
