// 設定フォームの読み込み(反映)/有効無効同期/保存ペイロード構築。
// settingsModal.ts から純粋に切り出したもの(参照する input id・値の組み立て・条件は一切不変)。

import { renderStatus, setKeyStatus, providerMark, generatorKeyLabel, setKeySourceLabel } from './status.js';
import { applyLlmModelsToForm, collectLlmModels } from './llmModels.js';
import { GENERATOR_PROVIDERS } from './types.js';
import type {
  SettingsElements, SettingsResponse, SavePayload, KnobSource,
  GeneratorProviderName,
} from './types.js';

// ★分析用のキー欄(プロバイダ → 入力要素)。apply/save の両方がこの1か所を使う。
function genKeyInputs(el: SettingsElements): Record<GeneratorProviderName, HTMLInputElement> {
  return { gemini: el.inputGenGemini, groq: el.inputGenGroq, openai: el.inputGenOpenai, kimi: el.inputGenKimi };
}

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
  // ★LLM プロバイダのモデル欄(APIキーの直下・id 参照)。空欄=既定。
  applyLlmModelsToForm(current);
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
  // ★分析用(実取引 A とは別プール): プロバイダごとに「実際にどのキーを使うか」を出す。
  //   専用キー未設定なら黙って共通キーへ落ちる=この表示が無いと分離できていないことが分からない。
  const genSrc = current?.generatorKeySources;
  const genInputs = genKeyInputs(el);
  for (const n of GENERATOR_PROVIDERS) {
    const label = generatorKeyLabel(genSrc?.[n]);
    setKeyStatus(`genkey-${n}-status`, label.mark, label.text);
    setKeySourceLabel(`genkey-${n}-src`, label.text, label.title, label.shared);
    genInputs[n].placeholder = genSrc?.[n] === 'own'
      ? '専用キー設定済み (上書きする場合のみ入力)'
      : genSrc?.[n] === 'env' ? '環境変数の専用キーを使用中 (上書きするにはここに入力)'
      : '空欄なら共通キーを使用 (=上流クォータは実取引と共有)';
    genInputs[n].value = '';   // 秘密フィールド: 反映のたびに空へ戻す(値はサーバから来ない)
  }
  el.checkGenKeysClear.checked = false;   // 消去チェックは毎回オフから(誤って消さない)
  el.checkKeysClear.checked = false;     // ★共通キーの消去チェックも毎回オフから(同上)
  // ★分析用サイドカーの有効/無効: 既定オフ(=同梱されていても、明示的にオンにするまで走らない)。
  el.checkGeneratorEnabled.checked = current ? current.generatorEnabled === true : false;
  // 日次予算: 可視フィールド。実効値を出し、空欄で既定に戻せる。
  el.inputGeneratorBudget.value = current?.generatorDailyBudget === undefined ? '' : String(current.generatorDailyBudget);
  el.inputGeneratorBudget.placeholder = `${current?.generatorDailyBudgetDefault ?? 200} (既定)`;
  if (current?.generatorDailyBudgetMax !== undefined) el.inputGeneratorBudget.max = String(current.generatorDailyBudgetMax);
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
  // ★AIにチャート画像を送るか。未設定/不正は 'off'(既定=送らない)。課金が効く側へ倒れる既定は作らない。
  el.selectScalpChartVisionMode.value = current?.scalpChartVisionMode === 'ab' ? 'ab' : 'off';
  // ★v0.7.56: 委任モード select + 初期LC下限 + LC安全上限を反映し、AI委任の項目は数値/enum入力を無効化(灰色)。
  el.inputScalpLcFloor.value = current ? String(current.scalpLcFloorYen) : '';
  el.selectLcCeilingMode.value = current?.scalpLcCeilingSource ?? 'manual';
  el.selectTrendVetoMode.value = current?.scalpTrendVetoSource ?? 'manual';
  el.selectCooldownMode.value = current?.scalpCooldownSource ?? 'manual';
  el.selectBiasMode.value = current?.scalpBiasSource ?? 'manual';
  el.selectRangeMode.value = current?.scalpRangeSource ?? 'manual';
  el.checkScalpLcHardMaxEnabled.checked = current ? current.scalpLcHardMaxEnabled : true;   // 既定=有効(安全網ON)
  el.inputScalpLcHardMax.value = current ? String(current.scalpLcHardMaxYen) : '';
  // ★v0.8.2: System B(仮想取引専用)を反映。value 系は raw(未設定=空欄=A追従)/ mode/tri-state は raw ?? ''(A追従)。
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
// ★初期LC下限(inputScalpLcFloor)はここに **入れない**: 委任対象外でモード select 自体が無く、
//   入れた数値はモードに関係なくコードが必ず強制する=常に編集できなければならない。
//   (旧: [selectLcFloorMode, inputScalpLcFloor] を対にしていたため、「AI委任」を選ぶと
//    実際には強制され続ける値が灰色になって編集できない、という正反対の表示になっていた。)
export function syncKnobDisabled(el: SettingsElements): void {
  const pairs: Array<[HTMLSelectElement, HTMLInputElement | HTMLSelectElement]> = [
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
  // ★秘密フィールドの規約は不変: 入力があれば保存 / 空欄は **送らない**(=変更なし)。
  //   「消去」チェックが入っているときだけ、空欄の欄を null で送って消せる(=未設定に戻す)。
  //   分析用キー(下)と同じ作法。これが無いと、誤って貼ったキーを撤回する手段が
  //   設定ファイルの手編集しか無かった(空欄保存では消えない=仕様どおり動いてしまう)。
  const clearKeys = el.checkKeysClear.checked;
  const keyField = (value: string, set: (v: string | null) => void): void => {
    if (value) set(value);
    else if (clearKeys) set(null);
  };
  keyField(gv, v => { body.geminiKey = v; });
  keyField(grv, v => { body.groqKey = v; });
  keyField(kv, v => { body.kimiKey = v; });
  keyField(ov, v => { body.openaiKey = v; });
  keyField(wsk, v => { body.webSearchKey = v; });
  // ★分析用の専用キー(秘密)。入力があれば保存、消去チェックが入っていれば未入力分を null で消去。
  //   どちらも無ければフィールドごと送らない(=変更なし)。
  const genInputs = genKeyInputs(el);
  const clearGen = el.checkGenKeysClear.checked;
  const genKeys: Partial<Record<GeneratorProviderName, string | null>> = {};
  for (const n of GENERATOR_PROVIDERS) {
    const v = genInputs[n].value.trim();
    if (v) genKeys[n] = v;
    else if (clearGen) genKeys[n] = null;   // 明示クリア=共通キーへ戻す
  }
  if (Object.keys(genKeys).length > 0) body.generatorKeys = genKeys;
  // 分析用の日次予算: 可視フィールド。空欄=既定に戻す(null)。0 は「分析用を無効化」の意味で有効な値。
  const genBudgetRaw = el.inputGeneratorBudget.value.trim();
  body.generatorDailyBudget = genBudgetRaw === '' ? null : Number(genBudgetRaw);
  // ★分析用サイドカーの有効/無効: チェックボックスなので常に true/false を送る(既定=false)。
  body.generatorEnabled = el.checkGeneratorEnabled.checked;
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
  // ★LLM プロバイダのモデル欄も可視フィールド(空欄='' → サーバで既定に戻る)。
  collectLlmModels(body);
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
  // レンジ両面(実験・仮想取引で別枠計測): チェックボックス(常に値あり)。true/false を送る。
  body.scalpRangeEnabled = el.checkScalpRangeEnabled.checked;
  // ★ドテン(反転)許可: チェックボックス(常に値あり)。true/false を送る。
  body.dotenEnabled = el.checkScalpDotenEnabled.checked;
  // ★レンジ再評価(未約定→ブレイク)許可: チェックボックス(常に値あり)。true/false を送る。
  body.rangeReevalEnabled = el.checkScalpRangeReeval.checked;
  // ★テクニカル指標(表示+AI文脈)/ AIテクニカル許可: チェックボックス(常に値あり)。true/false を送る。
  body.indicatorsEnabled = el.checkIndicatorsEnabled.checked;
  body.aiTechnicalEnabled = el.checkAiTechnicalEnabled.checked;
  body.scalpChartFallbackText = el.checkScalpChartFallback.checked;
  body.scalpChartVisionMode = el.selectScalpChartVisionMode.value === 'ab' ? 'ab' : 'off';
  // ★v0.7.56: 委任 source(手動/AI)。select は常に値あり('manual'|'ai')。
  // ★初期LC下限は委任対象外=UI にモード select が無い。保存のたびに 'manual' へ正規化する
  //   (過去に 'ai' を保存した config が残っていると、書き出し[entry_meta の knob スナップショット]に
  //    「委任」と記録され続けるが、実際には常に強制されている=記録が嘘になるため)。
  body.scalpLcFloorSource = 'manual';
  body.scalpLcCeilingSource = el.selectLcCeilingMode.value as KnobSource;
  body.scalpTrendVetoSource = el.selectTrendVetoMode.value as KnobSource;
  body.scalpCooldownSource = el.selectCooldownMode.value as KnobSource;
  body.scalpBiasSource = el.selectBiasMode.value as KnobSource;
  body.scalpRangeSource = el.selectRangeMode.value as KnobSource;
  // 初期LC下限: 可視フィールド。空欄=既定(55)に戻す(null)。数値なら上書き。
  const lcFloorRaw = el.inputScalpLcFloor.value.trim();
  body.scalpLcFloorYen = lcFloorRaw === '' ? null : Number(lcFloorRaw);
  // LC安全上限: 有効/無効(チェック)＋値。空欄=既定(159)に戻す(null)。
  body.scalpLcHardMaxEnabled = el.checkScalpLcHardMaxEnabled.checked;
  const hardMaxRaw = el.inputScalpLcHardMax.value.trim();
  body.scalpLcHardMaxYen = hardMaxRaw === '' ? null : Number(hardMaxRaw);
  // ★v0.8.2: System B(仮想取引専用)。value 系は空欄→null(=A追従で unset) / mode・tri-state は select 値をそのまま
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
    scalpLcFloorSource: '',   // ★委任対象外=B にもモード select は無い(''=A追従で unset)
    scalpLcCeilingSource: el.selectLcCeilingModeB.value,
    scalpTrendVetoSource: el.selectTrendVetoModeB.value,
    scalpCooldownSource: el.selectCooldownModeB.value,
    scalpBiasSource: el.selectBiasModeB.value,
    scalpRangeSource: el.selectRangeModeB.value,
  };
  return body;
}
