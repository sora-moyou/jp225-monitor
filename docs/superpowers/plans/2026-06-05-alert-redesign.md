# アラート再設計 実装プラン (v0.6.0)

date: 2026-06-05
spec: ./../specs/2026-06-05-alert-redesign.md

各フェーズ末: typecheck緑・全テスト緑・evaluatorサブエージェント通過を必須。リリースは完成時 v0.6.0 一括(途中の中間リリースはしない)。

## P1 シグナル基盤(挙動維持の足場)
- `server/signals/types.ts`: `AlertSignal` 型 + `SignalDetector` インターフェース。
- `server/signals/aggregate.ts`: `aggregateSignals(signals, params)` = 重複排除(同 reference ±tol)→ 同方向・同局面コンフルエンス統合(score加算/scoreParts結合)→ score しきい値 → `AlertEventPayload[]` 写像。純粋関数 + ユニットテスト。
- `detectionKind` union に新type追加(double/ma_sr/level_sr/pivot/trend)。旧(dtb/swingdtb/granville/ma)は当面併存。
- まだ検知器は載せ替えず、型と aggregator を用意(テスト先行)。

## P2 5シグナル整備
- **2e double 一本化**: micro dtb(doublePattern + levelsLoop の dtb 経路)を廃止。swingDouble を `double` シグナル化(forming/confirmed)。micro 用テスト削除/置換。
- **2a level_sr 新規**: `server/levelHold.ts` = 意識水準にタッチ後 reclaim 反発で「支持/抵抗された」検知(break の補集合)。levelsLoop で break と出し分け(同水準は片方のみ)。
- **2b ma_sr**: granville 継続を `ma_sr` シグナルへ改称、note に現値+MA値併記。
- **2c pivot 新規**: extractSwingPivots が新規確定したピボットを検知(前回確定との差分)。levelsLoop。方向語(押し安値/戻り高値)許可。
- **2d trend 統合**: granville 転換 + ma 単純クロスを `trend` シグナルに統合(alertEngine)。
- 各 detector は `AlertSignal[]` を返し、loop は aggregator 経由で emit に一本化。

## P3 スコア/しきい値/抑制
- 各シグナルに score 構成(意識度×確認強度×整合本数×鮮度)。
- score しきい値未満は emit しない(③ 非イベント抑制)。
- 全 note に基準値(価格/MA)を併記。configStore に score しきい値ノブ。

## P4 ① AI 判定
- `openai.ts`: news 窓を lastShockAt 起点に。explain 入力に「直近L2状態要約」追加。
- 関連ニュース無し → 「テクニカル要因の可能性(該当ニュースなし)」+ L2状態併記。lastShockAt の供給元(alertHistory or alertEngine)を配線。

## P5 履歴/的中率再設計
- `db/store.ts`: alerts に `reference_kind` / `reference_price` カラム追加(migration)。recordAlert で保存。
- `alertHistory.ts`: シグナル別成功定義(支持/抵抗=反転継続、抜け/転換/DTB=順行継続)。configStore にシグナル別しきい値(既定同値)。summarize を シグナル×基準種別 内訳に拡張。
- 検証シート UI(現行パネル内)に内訳列。
- `collector` バックテスト・ハーネス: 蓄積barsで各シグナルの過去成功率算出 → しきい値較正の材料。

## P6 仕上げ
- ⑤ 文言統一の最終確認(全シグナルの定型文)。
- 旧 detectionKind の履歴後方互換(rowKind)確認。
- 総合整合チェック(全経路 plumbing 漏れ無し、テスト緑) → 4manifest bump 0.6.0 → 署名ビルド → latest.json → push → gh release → 記録(memory/Obsidian)。

## リスク/注意
- detectionKind の switch 横断箇所(types×2, openai union+kindLabel+isTechnical, explain route, alertHistory rowKind+MONITOR_ONLY_KINDS, web main isTechnical+technicalExplanation, alertBanner isTechKind)を毎回確認。
- collector と monitor の二重書き(MONITOR_ONLY_KINDS)。L2 は levelsLoop=monitor専用。trend/ma_sr は alertEngine=collector も検知 → 非 monitor-only。
- 後方互換: 旧 kind の履歴行は rowKind で表示維持。
