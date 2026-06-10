# 取引時間外ドーマント化（monitor）設計

- 日付: 2026-06-11
- 対象: Finance_Monitor（UIサーバの定期ループ）
- 関連: jp225-Trade 側の同名 spec（reconcile ゲート）。collector は既に `inPollWindow` でゲート済。

## 1. 背景・目的

監査で、UIサーバの定期ループが**取引時間に関係なく24/7全開**で回っていることが判明（collector はゲート済だがサーバは未ゲート）。最大の元凶は priceLoop(2s) と levelsLoop(8s)。取引時間外（夜間休場帯6:00–8:45・週末・祝日・昼休み帯）に CPU/ネット/DB を浪費する。

既存の `inPollWindow()`（collector/session.ts・セッション±マージン）でサーバ各ループをゲートし、時間外は処理をスキップして軽量化する。

## 2. 確定仕様（ユーザー承認済の方針）

- ゲート＝既存 `inPollWindow()`（collector/session.ts、Day/Night ± 前5分/後10分マージン）。新規ロジックなし。
- 時間外は**完全スキップ**（UIの価格等は時間外フリーズ＝市場が閉じているので妥当）。「市場時間外」表示の追加は今回スコープ外。
- 対象 6ループ: price / news / alert / correlation / levels / forecast。
- **除外**: alertHistory フォロー（30s・軽量。場末アラートの5/15/30分リターンを場後に埋めるため非ゲート）、collector（既にゲート済）。

## 3. スコープ

### やること
- 各対象ループの `tick()` 先頭に `inPollWindow(Date.now())` ゲートを追加。時間外は処理せず即戻る。
  - priceLoop（自己再スケジュール型・`tick` が次 wait を返す）: 時間外は **`OFFHOURS_IDLE_MS=30_000` を返して**フェッチ抑止（2s→30s バックオフ）。
  - news/alert/correlation/levels/forecast（`setTimeout(schedule, interval)` 型）: 時間外 early-return（interval 据え置き＝次回再判定。no-op wakeup は無視できる軽さ）。

### やらないこと（YAGNI）
- ループ間隔そのものの再設計 / 時間外用の別スケジューラ。
- alertHistory フォロー・collector のゲート（前者は場後リターン埋めで必要、後者は済）。
- 「市場時間外」UI バッジ・休場日テーブルの再設計。
- LLM 呼び出し経路（イベント駆動。検知ループがゲートされれば時間外アラート→explain も自然に止まる）。

## 4. 変更詳細（各ループ `tick` 先頭にガード追加）

import 追加（各ファイル）: `import { inPollWindow } from '../../collector/session.js';`（forecast/levels は既に `classifySession` を同所から import 済）。

| ファイル | tick 型 | ガード |
|---|---|---|
| `server/loops/priceLoop.ts` | `Promise<number>` | `if (!inPollWindow(Date.now())) return OFFHOURS_IDLE_MS;`（定数 `OFFHOURS_IDLE_MS = 30_000` を追加） |
| `server/loops/newsLoop.ts` | `Promise<void>` | `if (!inPollWindow(Date.now())) return;` |
| `server/loops/alertLoop.ts` | `Promise<void>` | `if (!inPollWindow(Date.now())) return;` |
| `server/loops/correlationLoop.ts` | `Promise<void>` | `if (!inPollWindow(Date.now())) return;` |
| `server/loops/levelsLoop.ts` | `void` | `if (!inPollWindow(Date.now())) return;`（最重要・8s。時間外DB読み停止の効果大） |
| `server/loops/forecastLoop.ts` | `void` | `if (!inPollWindow(Date.now())) return;` |

- ガードは `tick` の**最初**（try より前）に置く。priceLoop はバックオフ値を返すことで自己再スケジュールが伸びる。
- 既存のエラーバックオフ・状態管理には触れない。

## 5. 効果・データフロー
```
[取引時間内] inPollWindow=true → 各ループ通常動作(従来どおり)
[取引時間外] inPollWindow=false →
   priceLoop: フェッチせず 30s 後に再判定
   その他5ループ: 何もせず次 interval で再判定(no-op)
   → ネット(Yahoo/feed/RSS)・DB読み・相関/レベル計算・検知(→時間外explain)が停止
[セッション開始5分前] inPollWindow=true → 全ループ自動再開
```

## 6. エラー処理・安全策
- 時間外スキップは「何もしない」だけ（状態破壊なし）。再開はマージンで自動。
- `inPollWindow` は純関数（祝日/週末/マージンを `classifySession` で一元判定）。collector で実績あり。
- alertHistory フォローは非ゲート → 場末に出たアラートの5/15/30分リターンは場後も埋まる（正しさ維持）。

## 7. テスト
- `inPollWindow` は collector/session の既存関数（既存挙動）。境界の単体テストが無ければ `collector/session` 系テストに追記（セッション中=true / 平日朝休場=false / 開始5分前=true / 終了10分後=true・11分後=false）。
- 各ループの tick ガードは setInterval/ネットワーク依存のため tsc + 既存全テスト緑で担保（純粋判定は inPollWindow テストで検証）。
- 既存テスト緑・tsc クリーン。

## 8. リリース
- monitor 版 0.7.4 → **0.7.5**（package.json / tauri.conf.json / Cargo.toml）。署名鍵=無パスフレーズ。ブランチ=master。
- 検知“ロジック”変更ではなく実行ゲートのみ（発火頻度は時間内不変）→ `alert-audit.mts` 対象外。
- `npm run release:build` → `release:latest-json` → `gh release`（jp225-monitor・v0.7.5）。

## 9. 受け入れ基準
- 取引時間外（夜間休場帯・週末・祝日・昼休み帯）に、price/news/alert/correlation/levels/forecast の各ループがネット/DB/計算を行わない。
- 取引時間内は従来どおり（発火・表示・更新が不変）。
- セッション開始5分前から自動再開。
- 既存テスト緑・tsc クリーン・`inPollWindow` 境界テスト緑。
