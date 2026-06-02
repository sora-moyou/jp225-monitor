# アラート履歴＋事後値動き Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 発火アラートと事後値動き(+5/15/30分)を DB に記録し、種別別の的中率を 📊 モーダルで見られるようにする。
**Spec:** `docs/superpowers/specs/2026-06-02-alert-history-design.md`
**前提:** `bars_1m`(NIY=F 1分足) と SSE broker、アラート発火3箇所(alertLoop:93/:166, tickDetector:82)。

## Tasks
1. `store.ts`: `alerts` テーブル＋ヘルパ(insertAlert/getBarCloseAt/getAlertsNeedingFollowup/updateAlertReturns/getRecentAlerts) ＋ tests。
2. `server/alertHistory.ts`: recordAlert / emitAlert / followupTick / start-stop loop / summarize ＋ tests。
3. 配線: 3発火箇所を emitAlert に置換、`server/routes/alerts.ts`(GET /api/alerts/history)、index.ts で route 登録＋loop起動。
4. UI: ツールバー 📊 ＋ 履歴モーダル(`web/components/alertsHistoryModal.ts`) ＋ index.html ＋ main.ts 配線 ＋ styles。

各タスクで TDD(該当時)、`npm run typecheck`、関連テスト緑、commit。詳細コード/SQL/シグネチャは spec を参照(subagent には controller が全文を渡す)。

Final: `npx vitest run` 全緑、`npm run build:web` 緑。リリースは v0.4.16(署名ビルド＋GitHub)。
