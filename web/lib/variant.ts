// 製品バリアントに応じた UI 表示制御(lite=一部 UI を隠す・full=全表示)。
// /api/version の variant を読み、lite なら詳細設定系 UI を DOM から隠す。
// server 挙動・設定値は不変(monitor2 が設定した値で同一動作)=見せない/触らせないだけ。

export type Variant = 'full' | 'lite';

// /api/version の variant を正規化。'lite' のみ lite・欠落/不明は full(安全側=全表示)。
export function normalizeVariant(v: unknown): Variant {
  return v === 'lite' ? 'lite' : 'full';
}

// hidden プロパティと style を持つ最小要素インターフェース(null 許容)。
// jsdom を導入せずに純関数としてテストできるよう HTMLElement ではなくこの形にする。
export interface ToggleableEl {
  hidden: boolean;
  style: { display: string };
}

// 複数要素(null 混在可)。lite で一括して隠す/出すグループに使う。
export type ToggleableEls = readonly (ToggleableEl | null | undefined)[] | null;

// ★lite: 詳細設定(🎛️)の「AIエントリー」を 4項目(初期LC下限/最大初期LC/バイアス/LC安全上限)の
//   A系統だけに絞るための CSS セレクタ。index.html のマークアップと main.ts の収集を
//   この 1か所に集約する(テストも同じ定数で index.html を検証するのでセレクタがずれない)。
export const LITE_SCALP = {
  fieldset:   '#ai-entry-fieldset',
  keepRow:    '.setting-row[data-lite="1"]',         // lite で残す 4行
  dropRow:    '.setting-row:not([data-lite="1"])',   // lite で隠す残りの行
  inRowHide:  '.ab-col-b, .knob-mode, .ab-tag',      // 残す行のうち隠す部品(B系統 / 委任モード / A タグ)
  modeSelect: '.knob-mode',                          // 残す行の A側 委任モード select(先頭)
  fullHint:   '.exit-hint:not(.lite-hint)',          // full 向けの説明(A/B・AI委任) = lite では隠す
  liteHint:   '.lite-hint',                          // lite 専用の簡潔な説明 = lite でだけ出す
  aiNote:     '.lite-ai-note',                       // 「AIにおまかせ中で編集不可」注記(条件付き表示)
} as const;

export interface VariantElements {
  alertsHistoryBtn?: ToggleableEl | null; // ④ アラート履歴(📊)
  openLogsBtn?: ToggleableEl | null;       // ④ サーバログ(📋)
  // lite は履歴の A/B 系統セレクタを隠す(B の成績は full のみで確認)。
  //   B のライブパネルは廃止済み(#signal-panel-b は存在しない)。
  signalTradesSystem?: ToggleableEl | null; // 履歴の A/B 系統セレクタ行(#signal-trades-system-row)
  // ★v0.8.2(ユーザー指示): lite は Web検索モデル設定 と データ(DB管理) fieldset も隠す(API キーは表示のまま)。
  webSearchModelFieldset?: ToggleableEl | null; // 設定「Web検索モデル」fieldset(#websearch-model-fieldset)
  dataFieldset?: ToggleableEl | null;           // 設定「データ」fieldset(#data-fieldset)
  // ★基礎データ公開(225labo)fieldset は monitor2 メンテナ専用=lite で非表示(#basedata-publish-fieldset)。
  basedataPublishFieldset?: ToggleableEl | null;
  // ★lite(ユーザー指示): 詳細設定(🎛️)は開けるようにし、「AIエントリー」の 4項目だけを A系統で見せる。
  //   ボタン(#params-btn)と fieldset(#ai-entry-fieldset)自体は隠さない=ここでは触らない。
  paramsOtherCol?: ToggleableEl | null;   // 詳細設定の右カラム(#params-col2: ポーリング/急変閾値/節目/データ)
  scalpHideRows?: ToggleableEls;          // AIエントリーのうち 4項目以外の行
  scalpHideInRows?: ToggleableEls;        // 残す行の B列 / 委任モード select / A タグ
  scalpFullHints?: ToggleableEls;         // full 向けの説明(A/B・AI委任)
  scalpLiteHints?: ToggleableEls;         // lite 専用の簡潔な説明(index.html では既定 hidden)
}

function hide(el?: ToggleableEl | null): void {
  if (!el) return;
  el.hidden = true;
  el.style.display = 'none';
}
function show(el?: ToggleableEl | null): void {
  if (!el) return;
  el.hidden = false;
  el.style.display = '';
}

// variant に応じて表示/非表示を切り替える純関数。
// full は何も隠さない/出さない(要素は触らない=現行と完全同一)。lite は指定要素を隠し、lite 専用説明だけ出す。
// null 要素はスキップ(部分 DOM/テストでも安全)。
export function applyVariantVisibility(variant: Variant, els: VariantElements): void {
  if (variant !== 'lite') return; // full=全表示。安全側。
  const targets = [
    els.alertsHistoryBtn, els.openLogsBtn,
    els.signalTradesSystem,   // 履歴の A/B セレクタを lite で非表示。
    els.webSearchModelFieldset, els.dataFieldset,   // ★v0.8.2(ユーザー指示): モデル設定 と データ を lite で非表示。
    els.basedataPublishFieldset,   // ★基礎データ公開(225labo)は monitor2 メンテナ専用=lite で非表示。
    els.paramsOtherCol,   // ★lite: 詳細設定の右カラム(ポーリング/急変閾値/節目/データ)は見せない。
  ];
  for (const el of targets) hide(el);
  // ★lite: AIエントリーを 4項目(A系統)だけに絞る。
  for (const el of els.scalpHideRows ?? []) hide(el);
  for (const el of els.scalpHideInRows ?? []) hide(el);
  for (const el of els.scalpFullHints ?? []) hide(el);
  for (const el of els.scalpLiteHints ?? []) show(el);
}

// ★lite: 委任モード select を隠すので、AI委任(mode='ai')の項目は値入力が無効(灰色)になる理由が見えない。
//   該当行にだけ「AIにおまかせ中」の注記を出して、黙って触れない入力を見せることを避ける。
//   full は何もしない(注記は index.html で hidden のまま=表示は現状と完全同一)。
export interface LiteKnobNote {
  mode?: { value: string } | null;   // 委任モード select(値だけ読む・未検出は manual 扱い)
  note?: ToggleableEl | null;        // 行内の注記要素(既定 hidden)
}
export function applyLiteKnobNotes(variant: Variant, notes: readonly LiteKnobNote[]): void {
  if (variant !== 'lite') return;
  for (const n of notes) {
    if (!n.note) continue;
    if (n.mode?.value === 'ai') show(n.note); else hide(n.note);
  }
}
