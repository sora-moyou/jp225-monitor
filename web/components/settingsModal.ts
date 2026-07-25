// 設定モーダルの合成(composer)。実体はセクション別モジュール(settings/*)に分割済み。
// ここは配線と開閉/保存フローのみを担い、DOM 参照は id ベースなのでモーダルの所在に依存しない。

import { fetchSettings, saveSettings } from './settings/api.js';
import { applySettingsToForm, syncKnobDisabled, syncKnobDisabledB, buildSavePayload } from './settings/form.js';
import { wireUpdateSection } from './settings/update.js';
import { wireDbSection } from './settings/dbOps.js';
import { wireKeyTestSection } from './settings/keyTest.js';
import type { SettingsElements, SettingsController } from './settings/types.js';

// 公開 API 面を維持: main.ts などが従来どおり型を import できるよう re-export。
export type { SettingsElements, SettingsController } from './settings/types.js';

// ★v0.8.3: 設定モーダル分割後、🎛️(詳細設定)側からも移設フィールド(Web検索モデル/AIエントリー/データ)を
//   読み込み/保存できるよう、全入力の load(refresh) と save(doSave) を戻り値として公開する。
//   入力は id 参照(getElementById)なので DOM がどちらのモーダルにあっても同じハンドラで動く。
export function initSettingsModal(el: SettingsElements): SettingsController {
  async function refresh() {
    const current = await fetchSettings();
    applySettingsToForm(el, current);
  }

  // 更新(アプリ+基礎データ)・データ操作・キー検証の各セクションを配線。
  const { loadCurrentVersion, clearUpdateResult } = wireUpdateSection(el);
  wireDbSection(el);
  wireKeyTestSection(el);

  // ★v0.7.56: 委任モード select / LC安全上限チェックを変えたら即座に入力の有効/無効を同期。
  for (const s of [el.selectLcFloorMode, el.selectLcCeilingMode, el.selectTrendVetoMode,
                   el.selectCooldownMode, el.selectBiasMode, el.selectRangeMode]) {
    s.addEventListener('change', () => syncKnobDisabled(el));
  }
  el.checkScalpLcHardMaxEnabled.addEventListener('change', () => syncKnobDisabled(el));
  // ★v0.8.2: System B の mode/tri-state を変えたら B の入力有効/無効を同期。
  for (const s of [el.selectLcFloorModeB, el.selectLcCeilingModeB, el.selectTrendVetoModeB,
                   el.selectCooldownModeB, el.selectBiasModeB, el.selectRangeModeB, el.selectHardMaxEnabledB]) {
    s.addEventListener('change', () => syncKnobDisabledB(el));
  }

  async function open() {
    el.modal.classList.remove('hidden');
    await refresh();
    clearUpdateResult();
    void loadCurrentVersion();
    el.inputGemini.focus();
  }
  function close() {
    el.modal.classList.add('hidden');
    el.inputGemini.value = '';
    el.inputGroq.value = '';
    el.inputKimi.value = '';
    el.inputOpenai.value = '';
    el.inputWebSearch.value = '';
    // ★Web検索モデル欄は🎛️(詳細設定)へ移設済み=⚙️の閉じるでクリアしない(閉じる度に空になり
    //   保存で既定へ戻る事故を防ぐ。ライフサイクルは🎛️の open→refresh が管理)。
  }

  el.openBtn.addEventListener('click', () => { void open(); });
  el.closeBtn.addEventListener('click', close);
  el.backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modal.classList.contains('hidden')) close();
  });

  // ★v0.8.3: 全入力(APIキー＋移設した Web検索モデル/AIエントリー/データ操作は id 参照)を1回の POST で保存する。
  //   ⚙️保存ボタンと 🎛️保存ボタンの両方から呼ぶ(どちらから押しても同じ項目・同じ /api/settings/keys で byte 等価)。
  async function doSave(): Promise<void> {
    el.saveBtn.disabled = true;
    const originalText = el.saveBtn.textContent ?? '保存';
    el.saveBtn.textContent = '保存中...';
    try {
      const body = buildSavePayload(el);
      const result = await saveSettings(body);
      if (!result.ok) {
        el.statusArea.innerHTML = `<div class="settings-status err">${result.error ?? '保存失敗'}</div>`;
        return;
      }
      el.inputGemini.value = '';
      el.inputGroq.value = '';
      el.inputOpenai.value = '';
      el.inputWebSearch.value = '';
      await refresh();
    } finally {
      el.saveBtn.disabled = false;
      el.saveBtn.textContent = originalText;
    }
  }

  el.saveBtn.addEventListener('click', () => { void doSave(); });

  // 初回起動時にプロバイダ未設定なら自動オープン
  void (async () => {
    const s = await fetchSettings();
    if (s && !s.providers.some(p => p.enabled)) {
      void open();
    }
  })();

  // ★v0.8.3: 🎛️(詳細設定)側からも移設フィールドを読み込み/保存できるよう公開。
  return { refresh, save: doSave };
}
