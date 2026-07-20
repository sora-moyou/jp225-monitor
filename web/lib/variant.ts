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

export interface VariantElements {
  alertsHistoryBtn?: ToggleableEl | null; // ④ アラート履歴(📊)
  openLogsBtn?: ToggleableEl | null;       // ④ サーバログ(📋)
  paramsBtn?: ToggleableEl | null;         // ④ 詳細パラメータ(🎛️)
  scalpFieldset?: ToggleableEl | null;     // ⑤ 設定モーダル「AIエントリー」fieldset
  // lite は履歴の A/B 系統セレクタを隠す(B の成績は full のみで確認)。
  //   B のライブパネルは廃止済み(#signal-panel-b は存在しない)。
  signalTradesSystem?: ToggleableEl | null; // 履歴の A/B 系統セレクタ行(#signal-trades-system-row)
  // ★v0.8.2(ユーザー指示): lite は Web検索モデル設定 と データ(DB管理) fieldset も隠す(API キーは表示のまま)。
  webSearchModelFieldset?: ToggleableEl | null; // 設定「Web検索モデル」fieldset(#websearch-model-fieldset)
  dataFieldset?: ToggleableEl | null;           // 設定「データ」fieldset(#data-fieldset)
}

// variant に応じて表示/非表示を切り替える純関数。
// full は何も隠さない(要素は触らない=現行と完全同一)。lite は指定要素を隠す。
// null 要素はスキップ(部分 DOM/テストでも安全)。
export function applyVariantVisibility(variant: Variant, els: VariantElements): void {
  if (variant !== 'lite') return; // full=全表示。安全側。
  const targets = [
    els.alertsHistoryBtn, els.openLogsBtn, els.paramsBtn, els.scalpFieldset,
    els.signalTradesSystem,   // 履歴の A/B セレクタを lite で非表示。
    els.webSearchModelFieldset, els.dataFieldset,   // ★v0.8.2(ユーザー指示): モデル設定 と データ を lite で非表示。
  ];
  for (const el of targets) {
    if (!el) continue;
    el.hidden = true;
    el.style.display = 'none';
  }
}
