// 製品バリアントに応じた UI 表示制御(lite=一部 UI を隠す・full=全表示)。
// /api/version の variant を読み、lite なら詳細設定系 UI を DOM から隠す。
// server 挙動・設定値は不変(monitor2 が設定した値で同一動作)=見せない/触らせないだけ。

export type Variant = 'full' | 'lite';

// /api/version の variant を正規化。'lite' のみ lite・欠落/不明は full(安全側=全表示)。
export function normalizeVariant(v: unknown): Variant {
  return v === 'lite' ? 'lite' : 'full';
}

// ★製品名の反映(タイトル + ヘッダ見出し)。full=JP225 Monitor2 / lite=JP225 Monitor。
//   名前を決めるのは server(/api/version の name)1箇所だけ。ここで variant から組み立て直さないのは、
//   2箇所で決めると片方だけ直したときに黙ってズレるため(製品名は 4つの版ファイルとも整合が要る)。
//   name が来ない(古い server / 取得失敗)ときは HTML の静値のまま = lite 名 = 安全側。
export interface ProductNameEls {
  title: { textContent: string | null } | null;
  heading: { firstChild: { nodeValue: string | null } | null } | null;
}

/** name があればタイトルと見出しへ反映する。見出しは版タグ(span)を壊さないよう先頭テキストだけ差し替える。 */
export function applyProductNameTo(els: ProductNameEls, name: unknown): void {
  if (typeof name !== 'string' || name.trim() === '') return;   // 欠落は静値のまま(=lite 名・安全側)
  const n = name.trim();
  if (els.title) els.title.textContent = n;
  const head = els.heading?.firstChild;
  if (head) head.nodeValue = `${n} `;   // 末尾の空白は版タグとの間隔(HTML の静値と同じ形)
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
//   ★委任モード select(.knob-mode)は lite でも表示する(手動/AI委任をユーザーが選べる)ので
//     inRowHide には入れない。B側の .knob-mode は .ab-col-b ごと隠れるので個別指定は不要。
export const LITE_SCALP = {
  fieldset:   '#ai-entry-fieldset',
  keepRow:    '.setting-row[data-lite="1"]',         // lite で残す 4行
  dropRow:    '.setting-row:not([data-lite="1"])',   // lite で隠す残りの行
  inRowHide:  '.ab-col-b, .ab-tag',                  // 残す行のうち隠す部品(B系統 / A タグ)
  modeSelect: '.knob-mode',                          // A側 委任モード select(残す 4行のうち 3行が持つ)
  fullHint:   '.exit-hint:not(.lite-hint)',          // full 向けの説明(A/B・AI委任) = lite では隠す
  liteHint:   '.lite-hint',                          // lite 専用の簡潔な説明 = lite でだけ出す
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
  // ★提案生成器(分析用)の fieldset = **2つ目の API キー欄と日次予算欄**(#generator-keys-fieldset)。
  //   lite は生成器そのものを走らせない(server 側 analysisGate)ので、キーを入れる場所も出さない。
  //   server も /api/settings から generator* を返さないため、隠すのは「見せない」だけでなく整合でもある。
  generatorKeysFieldset?: ToggleableEl | null;
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
    els.generatorKeysFieldset,     // ★提案生成器(分析用)の2つ目の API キー欄/日次予算欄は lite で非表示。
    els.paramsOtherCol,   // ★lite: 詳細設定の右カラム(ポーリング/急変閾値/節目/データ)は見せない。
  ];
  for (const el of targets) hide(el);
  // ★lite: AIエントリーを 4項目(A系統)だけに絞る。
  for (const el of els.scalpHideRows ?? []) hide(el);
  for (const el of els.scalpHideInRows ?? []) hide(el);
  for (const el of els.scalpFullHints ?? []) hide(el);
  for (const el of els.scalpLiteHints ?? []) show(el);
}
