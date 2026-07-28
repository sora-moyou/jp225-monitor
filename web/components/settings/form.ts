// 設定フォームの読み込み(反映)/有効無効同期/保存ペイロード構築。
// settingsModal.ts から純粋に切り出したもの(参照する input id・値の組み立て・条件は一切不変)。

import { renderStatus, setKeyStatus, providerMark } from './status.js';
import type { SettingsElements, SettingsResponse, SavePayload, KnobSource } from './types.js';

// サーバから取得した設定を全入力へ反映する(元 refresh の本体)。
export function applySettingsToForm(el: SettingsElements, current: SettingsResponse | null): void {
  el.statusArea.innerHTML = renderStatus(current);
  el.inputGemini.placeholder = current?.geminiSet
    ? '設定済み (上書きする場合のみ入力)'
    : current?.geminiFromEnv ? '環境変数から読込中 (上書きするにはここに入力)' : 'AIza...';
  el.inputGroq.placeholder = current?.groqSet
    ? '設定済み (上書きする場合のみ入力)'
    : current?.groqFromEnv ? '環境変数から読込中' : 'gsk_...';
  el.inputKimi.placeholder = current?.kimiSet
    ? '設定済み (上書きする場合のみ入力)'
    : current?.kimiFromEnv ? '環境変数から読込中' : 'sk-...';
  el.inputOpenai.placeholder = current?.openaiSet
    ? '設定済み (上書きする場合のみ入力)'
    : current?.openaiFromEnv ? '環境変数から読込中' : 'sk-...';
  el.inputWebSearch.placeholder = current?.webSearchKeySet
    ? '設定済み (上書きする場合のみ入力)'
    : '空欄なら Gemini キーを使用 (AIza... / 課金キー可)';
  // ★基礎データ公開(225labo)認証: 秘密フィールド(空欄=変更なし)。
  el.inputLaboUser.placeholder = current?.basedataUserSet ? '設定済み (上書きする場合のみ入力)' : '225labo ログイン ID';
  el.inputLaboPass.placeholder = current?.basedataPassSet ? '設定済み (上書きする場合のみ入力)' : '225labo パスワード';
  // ★保存先フォルダ: 可視フィールド(生の保存値を反映・空欄=既定 Downloads)。
  el.inputBasedataSaveDir.value = current?.basedataSaveDir ?? '';
  el.inputBasedataSaveDir.placeholder = '空欄で Downloads に保存';
  // ★GitHub PAT: 秘密フィールド(空欄=変更なし)。
  el.inputGithubToken.placeholder = current?.githubTokenSet ? '設定済み (上書きする場合のみ入力)' : 'ghp_... / github_pat_...(空欄=gh CLI 使用)';
  // ★自動公開: チェックボックス + 直近結果サマリ。
  el.checkBasedataAutoPublish.checked = current ? !!current.basedataAutoPublish : false;
  el.basedataAutoStatus.textContent = current?.basedataAutoLastRun ? `直近: ${current.basedataAutoLastRun}` : '';
  el.inputWebSearchModel.value = current?.webSearchModel ?? '';
  el.inputWebSearchModel.placeholder = 'gemini-flash-latest (既定)';
  el.inputWebSearchOpenaiModel.value = current?.webSearchOpenaiModel ?? '';
  el.inputWebSearchOpenaiModel.placeholder = 'gpt-4o-mini-search-preview (既定)';
  // 各キー行の個別マーク(🟢/🟡/⚪)。LLM 3種は providers から、Web検索は解決可否から。
  const byName = (n: string) => current?.providers.find(p => p.name === n);
  for (const n of ['gemini', 'groq', 'openai', 'kimi'] as const) {
    const m = providerMark(byName(n));
    setKeyStatus(`key-${n}-status`, m.mark, m.title);
  }
  // Web検索は Gemini(専用/共通キー) が使えれば grounding、無くても OpenAI キーがあれば OpenAI 検索で可能。
  const wsGemini = !!(current?.webSearchKeySet || current?.geminiSet || current?.geminiFromEnv);
  const wsOpenai = !!(current?.openaiSet || current?.openaiFromEnv);
  const wsResolvable = wsGemini || wsOpenai;
  setKeyStatus('key-websearch-status',
    wsResolvable ? '🟢' : '⚪',
    wsResolvable
      ? (current?.webSearchKeySet ? '専用キー設定済' : wsGemini ? '共通 Gemini キーを使用' : 'OpenAI で検索')
      : '未設定(Web検索は無効)');
  // AIエントリー: 現値を反映(可視フィールド)。
  el.inputScalpLcCeiling.value = current ? String(current.scalpLcCeilingYen) : '';
  el.selectScalpBias.value = current?.scalpBias ?? 'none';
  el.inputScalpCooldown.value = current ? String(current.scalpCooldownSec) : '';
  el.inputScalpTrendVeto.value = current ? String(current.scalpTrendVetoYen) : '';
  el.checkScalpRangeEnabled.checked = current ? current.scalpRangeEnabled : false;   // ★実験終了=既定OFF
  el.checkScalpDotenEnabled.checked = current ? !!current.dotenEnabled : false;   // ★ドテン(反転)許可=既定OFF
  el.checkScalpRangeReeval.checked = current ? current.rangeReevalEnabled !== false : true;   // ★レンジ再評価=既定ON(未設定/true=チェック)
  el.checkIndicatorsEnabled.checked = current ? current.indicatorsEnabled !== false : true;   // ★テクニカル指標(表示+AI文脈)=既定ON
  el.checkAiTechnicalEnabled.checked = current ? current.aiTechnicalEnabled !== false : true;   // ★AIテクニカル許可=既定ON
  el.checkScalpChartFallback.checked = current ? current.scalpChartFallbackText !== false : true;   // ★チャート撮影失敗テキスト縮退=既定ON
  // ★v0.7.56: 委任モード select + 初期LC下限 + LC安全上限を反映し、AI委任の項目は数値/enum入力を無効化(灰色)。
  el.inputScalpLcFloor.value = current ? String(current.scalpLcFloorYen) : '';
  el.selectLcFloorMode.value = current?.scalpLcFloorSource ?? 'manual';
  el.selectLcCeilingMode.value = current?.scalpLcCeilingSource ?? 'manual';
  el.selectTrendVetoMode.value = current?.scalpTrendVetoSource ?? 'manual';
  el.selectCooldownMode.value = current?.scalpCooldownSource ?? 'manual';
  el.selectBiasMode.value = current?.scalpBiasSource ?? 'manual';
  el.selectRangeMode.value = current?.scalpRangeSource ?? 'manual';
  el.checkScalpLcHardMaxEnabled.checked = current ? current.scalpLcHardMaxEnabled : true;   // 既定=有効(安全網ON)
  el.inputScalpLcHardMax.value = current ? String(current.scalpLcHardMaxYen) : '';
  // ★v0.8.2: System B(紙専用)を反映。value 系は raw(未設定=空欄=A追従)/ mode/tri-state は raw ?? ''(A追従)。
  //   プレースホルダ/選択初期値は effective(A フォールバック済み)を補助表示に使う。
  const b = current?.signalB ?? {};
  const be = current?.signalBEffective;
  const rawNum = (v?: number) => (v === undefined ? '' : String(v));
  const rawBoolSel = (v?: boolean) => (v === undefined ? '' : String(v));
  const ph = (n: number | undefined) => (n === undefined ? 'A追従' : `A追従 (${n})`);
  el.inputScalpLcFloorB.value = rawNum(b.scalpLcFloorYen);
  el.inputScalpLcFloorB.placeholder = ph(be?.scalpLcFloorYen);
  el.inputScalpLcCeilingB.value = rawNum(b.scalpLcCeilingYen);
  el.inputScalpLcCeilingB.placeholder = ph(be?.scalpLcCeilingYen);
  el.inputScalpTrendVetoB.value = rawNum(b.scalpTrendVetoYen);
  el.inputScalpTrendVetoB.placeholder = ph(be?.scalpTrendVetoYen);
  el.inputScalpCooldownB.value = rawNum(b.scalpCooldownSec);
  el.inputScalpCooldownB.placeholder = ph(be?.scalpCooldownSec);
  el.inputScalpLcHardMaxB.value = rawNum(b.scalpLcHardMaxYen);
  el.inputScalpLcHardMaxB.placeholder = ph(be?.scalpLcHardMaxYen);
  el.selectScalpBiasB.value = b.scalpBias ?? '';
  el.selectRangeEnabledB.value = rawBoolSel(b.scalpRangeEnabled);
  el.selectHardMaxEnabledB.value = rawBoolSel(b.scalpLcHardMaxEnabled);
  el.selectLcFloorModeB.value = b.scalpLcFloorSource ?? '';
  el.selectLcCeilingModeB.value = b.scalpLcCeilingSource ?? '';
  el.selectTrendVetoModeB.value = b.scalpTrendVetoSource ?? '';
  el.selectCooldownModeB.value = b.scalpCooldownSource ?? '';
  el.selectBiasModeB.value = b.scalpBiasSource ?? '';
  el.selectRangeModeB.value = b.scalpRangeSource ?? '';
  syncKnobDisabled(el);
  syncKnobDisabledB(el);
}

// ★v0.8.2: B の value 入力を、B mode が 'ai'(AI委任)または ''(A追従)のとき無効化(灰色)。manual のみ編集可。
//   B の LC安全上限 value は enabled tri-state が 'true' のときだけ編集可。bias/range の値は mode で連動。
export function syncKnobDisabledB(el: SettingsElements): void {
  const pairs: Array<[HTMLSelectElement, HTMLInputElement | HTMLSelectElement]> = [
    [el.selectLcFloorModeB, el.inputScalpLcFloorB],
    [el.selectLcCeilingModeB, el.inputScalpLcCeilingB],
    [el.selectTrendVetoModeB, el.inputScalpTrendVetoB],
    [el.selectCooldownModeB, el.inputScalpCooldownB],
    [el.selectBiasModeB, el.selectScalpBiasB],
    [el.selectRangeModeB, el.selectRangeEnabledB],
  ];
  for (const [mode, input] of pairs) {
    const off = mode.value === 'ai' || mode.value === '';   // AI委任 or A追従 は値入力不要
    input.disabled = off;
    input.style.opacity = off ? '0.4' : '';
  }
  const hardOn = el.selectHardMaxEnabledB.value === 'true';   // B の安全上限を明示的に「有効」にした時だけ値編集可
  el.inputScalpLcHardMaxB.disabled = !hardOn;
  el.inputScalpLcHardMaxB.style.opacity = hardOn ? '' : '0.4';
}

// AI委任(mode==='ai')の項目は数値/enum入力を無効化して「AI が決める」ことを視覚化する。
// LC安全上限は最大初期LCのモードと独立の安全系なので、有効チェックが外れた時だけ値入力を無効化する。
export function syncKnobDisabled(el: SettingsElements): void {
  const pairs: Array<[HTMLSelectElement, HTMLInputElement | HTMLSelectElement]> = [
    [el.selectLcFloorMode, el.inputScalpLcFloor],
    [el.selectLcCeilingMode, el.inputScalpLcCeiling],
    [el.selectTrendVetoMode, el.inputScalpTrendVeto],
    [el.selectCooldownMode, el.inputScalpCooldown],
    [el.selectBiasMode, el.selectScalpBias],
    [el.selectRangeMode, el.checkScalpRangeEnabled],
  ];
  for (const [mode, input] of pairs) {
    const ai = mode.value === 'ai';
    input.disabled = ai;
    input.style.opacity = ai ? '0.4' : '';
  }
  // LC安全上限の値入力は「有効」チェック時のみ編集可。
  const hardOn = el.checkScalpLcHardMaxEnabled.checked;
  el.inputScalpLcHardMax.disabled = !hardOn;
  el.inputScalpLcHardMax.style.opacity = hardOn ? '' : '0.4';
}

// 全入力から POST /api/settings/keys のペイロードを構築する(元 doSave の body 組み立て・byte 等価)。
export function buildSavePayload(el: SettingsElements): SavePayload {
  const body: SavePayload = {};
  const gv = el.inputGemini.value.trim();
  const grv = el.inputGroq.value.trim();
  const kv = el.inputKimi.value.trim();
  const ov = el.inputOpenai.value.trim();
  const wsk = el.inputWebSearch.value.trim();
  if (gv) body.geminiKey = gv;
  if (grv) body.groqKey = grv;
  if (kv) body.kimiKey = kv;
  if (ov) body.openaiKey = ov;
  if (wsk) body.webSearchKey = wsk;   // 秘密: 空欄は送らない(=変更なし)
  // ★基礎データ公開(225labo)認証: 秘密フィールド。空欄は送らない(=変更なし)。
  const laboUser = el.inputLaboUser.value.trim();
  const laboPass = el.inputLaboPass.value.trim();
  if (laboUser) body.basedataUser = laboUser;
  if (laboPass) body.basedataPass = laboPass;
  // ★保存先フォルダ: 可視フィールド。常に送る(空欄='' → サーバで既定 Downloads に戻る)。
  body.basedataSaveDir = el.inputBasedataSaveDir.value.trim();
  // ★GitHub PAT: 秘密フィールド。空欄は送らない(=変更なし)。
  const ghTok = el.inputGithubToken.value.trim();
  if (ghTok) body.githubToken = ghTok;
  // ★自動公開: チェックボックス。常に true/false を送る。
  body.basedataAutoPublish = el.checkBasedataAutoPublish.checked;
  // モデルは可視フィールド: 現在値を常に送る(空欄='' → サーバで既定 gemini-flash-latest に戻る)
  body.webSearchModel = el.inputWebSearchModel.value.trim();
  // OpenAI Web検索モデルも可視フィールド(空欄='' → サーバで既定 gpt-4o-mini-search-preview に戻る)
  body.webSearchOpenaiModel = el.inputWebSearchOpenaiModel.value.trim();
  // AIエントリー: 可視フィールド。空欄=既定(65)に戻す(null)。数値なら上書き。
  const lcRaw = el.inputScalpLcCeiling.value.trim();
  body.scalpLcCeilingYen = lcRaw === '' ? null : Number(lcRaw);
  // バイアスは select(常に値あり)。'none' はサーバ側で既定(未設定)扱い。
  body.scalpBias = (el.selectScalpBias.value as 'long' | 'short' | 'none');
  // クールダウン: 可視フィールド。空欄=既定(90)に戻す(null)。数値なら上書き(0で無効)。
  const cdRaw = el.inputScalpCooldown.value.trim();
  body.scalpCooldownSec = cdRaw === '' ? null : Number(cdRaw);
  // トレンド veto 閾値: 可視フィールド。空欄=既定(100)に戻す(null)。数値なら上書き(0で無効)。
  const tvRaw = el.inputScalpTrendVeto.value.trim();
  body.scalpTrendVetoYen = tvRaw === '' ? null : Number(tvRaw);
  // レンジ両面(実験・紙で別枠計測): チェックボックス(常に値あり)。true/false を送る。
  body.scalpRangeEnabled = el.checkScalpRangeEnabled.checked;
  // ★ドテン(反転)許可: チェックボックス(常に値あり)。true/false を送る。
  body.dotenEnabled = el.checkScalpDotenEnabled.checked;
  // ★レンジ再評価(未約定→ブレイク)許可: チェックボックス(常に値あり)。true/false を送る。
  body.rangeReevalEnabled = el.checkScalpRangeReeval.checked;
  // ★テクニカル指標(表示+AI文脈)/ AIテクニカル許可: チェックボックス(常に値あり)。true/false を送る。
  body.indicatorsEnabled = el.checkIndicatorsEnabled.checked;
  body.aiTechnicalEnabled = el.checkAiTechnicalEnabled.checked;
  body.scalpChartFallbackText = el.checkScalpChartFallback.checked;
  // ★v0.7.56: 委任 source(手動/AI)。select は常に値あり('manual'|'ai')。
  body.scalpLcFloorSource = el.selectLcFloorMode.value as KnobSource;
  body.scalpLcCeilingSource = el.selectLcCeilingMode.value as KnobSource;
  body.scalpTrendVetoSource = el.selectTrendVetoMode.value as KnobSource;
  body.scalpCooldownSource = el.selectCooldownMode.value as KnobSource;
  body.scalpBiasSource = el.selectBiasMode.value as KnobSource;
  body.scalpRangeSource = el.selectRangeMode.value as KnobSource;
  // 初期LC下限: 可視フィールド。空欄=既定(45)に戻す(null)。数値なら上書き。
  const lcFloorRaw = el.inputScalpLcFloor.value.trim();
  body.scalpLcFloorYen = lcFloorRaw === '' ? null : Number(lcFloorRaw);
  // LC安全上限: 有効/無効(チェック)＋値。空欄=既定(150)に戻す(null)。
  body.scalpLcHardMaxEnabled = el.checkScalpLcHardMaxEnabled.checked;
  const hardMaxRaw = el.inputScalpLcHardMax.value.trim();
  body.scalpLcHardMaxYen = hardMaxRaw === '' ? null : Number(hardMaxRaw);
  // ★v0.8.2: System B(紙専用)。value 系は空欄→null(=A追従で unset) / mode・tri-state は select 値をそのまま
  //   ('' A追従 / 'manual'|'ai' / 'true'|'false' / 'none'|'long'|'short')。サーバ側 buildSignalB で unset/明示保存を判定。
  const numOrNull = (v: string): number | null => (v.trim() === '' ? null : Number(v.trim()));
  body.signalB = {
    scalpLcFloorYen: numOrNull(el.inputScalpLcFloorB.value),
    scalpLcCeilingYen: numOrNull(el.inputScalpLcCeilingB.value),
    scalpTrendVetoYen: numOrNull(el.inputScalpTrendVetoB.value),
    scalpCooldownSec: numOrNull(el.inputScalpCooldownB.value),
    scalpLcHardMaxYen: numOrNull(el.inputScalpLcHardMaxB.value),
    scalpBias: el.selectScalpBiasB.value,
    scalpRangeEnabled: el.selectRangeEnabledB.value,
    scalpLcHardMaxEnabled: el.selectHardMaxEnabledB.value,
    scalpLcFloorSource: el.selectLcFloorModeB.value,
    scalpLcCeilingSource: el.selectLcCeilingModeB.value,
    scalpTrendVetoSource: el.selectTrendVetoModeB.value,
    scalpCooldownSource: el.selectCooldownModeB.value,
    scalpBiasSource: el.selectBiasModeB.value,
    scalpRangeSource: el.selectRangeModeB.value,
  };
  return body;
}
