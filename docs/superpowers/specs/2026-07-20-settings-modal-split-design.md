# 設定モーダルの分割(APIキーと詳細設定を別画面に) (design)

日付: 2026-07-20 / 対象: monitor2 のみ(UIのみ・trade/engine不変) / 版=v0.8.3

## 目的(ユーザー)
⚙️「APIキー設定」画面が縦長。**APIキー関係以外の大きな設定を別画面(🎛️)へ独立**させて短くする。

## 現状
- **⚙️ #settings-modal**: APIキー(無料/有料)・Web検索モデル・**AIエントリー(A/B・約140行=最長)**・更新・終了・データ・トレードシグナル(音)。
- **🎛️ #params-modal**: 定期APIポーリング/アラート・急変アラート・主要レベル。

## 新レイアウト
- **⚙️ #settings-modal「設定(APIキー)」**(短く): APIキー(無料)・APIキー(有料)・**更新・終了・トレードシグナル(音)**(=lite でも必要な基本操作)。
- **🎛️ #params-modal「詳細設定」**(別画面): **Web検索モデル・AIエントリー(A/B)・データ** を移設 ＋ 既存(定期APIポーリング・急変アラート・主要レベル)。
  - 各 fieldset は **id を保持**したまま DOM を移動(#websearch-model-fieldset / #ai-entry-fieldset / #data-fieldset ＋ トレードシグナルは⚙️に残す)。
- ボタン: ⚙️ title 「設定」/ 🎛️ title 「詳細設定」に更新(任意)。

## 保存フロー(重要=設定が消えないこと)
- 移設したフィールド(Web検索モデル webSearchModel/webSearchOpenaiModel・AIエントリーの scalp*/signalB*・データ操作)は **🎛️ 側の保存/適用** で永続する。⚙️ 側の保存は APIキー＋(更新/終了は操作ボタン・音はlocalStorage)。
- 実装は既存の settingsModal.ts / paramsModal.ts の配線を**移動先に合わせて付け替える**。**POST /api/settings(/keys) の項目・挙動は不変**(どのボタンから押しても同じ値が保存されること)。両モーダルの入力は id で参照するので DOM 移動後も getElementById は通る。**保存対象の集合・APIは変えない**。
- データ操作(DBマージ/エクスポート/置換)ボタンのハンドラも🎛️へ移動(id保持で配線維持)。

## lite(表示縮小版)
- **挙動不変**: 🎛️(#params-btn)は lite で従来どおり非表示 → 移設した Web検索モデル/AIエントリー/データ も含め詳細設定は全て非表示(=これまでどおり細部を触らせない)。⚙️ は APIキー＋更新/終了/音 のみ表示。
- variant.ts の lite 非表示集合: **#params-btn を隠す**ことで移設分も隠れる。個別 id(#ai-entry-fieldset/#websearch-model-fieldset/#data-fieldset)の個別非表示は冗長になるが**残しても無害**(隠れた親モーダル内)。B関連(#signal-panel-b/#signal-trades-system-row)の非表示は不変。
- ★lite で ⚙️ に残す「更新・終了・トレードシグナル音」は表示(lite利用者が更新/終了/音操作できる)。

## 非対象/不変
- server API・トレードシグナル A/B エンジン・私的exit・trade2 連携は不変(UI/DOM 再配置と保存配線の付け替えのみ)。
- A/B の設定入力(AIエントリー行の A,B 横並び)はそのまま🎛️へ移設(内容不変)。

## テスト/受入
- 設定の保存/読込が**移設後も往復する**(keys は⚙️、Web検索モデル/AIエントリー/signalB/データは🎛️ から保存でき、GET /api/settings で反映)。
- ⚙️ が短くなり APIキー＋更新/終了/音 のみ。🎛️ に Web検索モデル/AIエントリー(A/B)/データ＋既存パラメータ。
- lite: 🎛️非表示で詳細全て隠れる・⚙️は keys＋更新/終了/音・B非表示は不変・A表示は不変。
- web build 緑・tsc0・既存 settings/variant テスト更新(移設後の id 所在・lite 非表示集合)。受入の肝: **保存項目・API・trade/engine は不変で、DOM 配置と保存ボタンの所在だけが変わる**。
