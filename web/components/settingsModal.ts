import { apiUrl } from '../lib/apiBase.js';
import { getUpdateStatus, installUpdate } from '../lib/updater.js';
import { pickDbFile, mergeDbFromFile, relaunchApp, isTauri, saveDbFile, exportDbToFile, replaceDbFromFile } from '../lib/dbMerge.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

type KnobSource = 'manual' | 'ai';

interface SettingsResponse {
  geminiSet: boolean; groqSet: boolean; openaiSet: boolean;
  geminiFromEnv: boolean; groqFromEnv: boolean; openaiFromEnv: boolean;
  webSearchKeySet: boolean; webSearchModel: string; webSearchOpenaiModel: string;
  scalpLcCeilingYen: number; scalpBias: 'long' | 'short' | 'none'; scalpCooldownSec: number;
  scalpRangeEnabled: boolean; scalpTrendVetoYen: number;
  // ★v0.7.56: 委任 source + 初期LC下限 + LC安全上限
  scalpLcFloorYen: number;
  scalpLcFloorSource: KnobSource; scalpLcCeilingSource: KnobSource; scalpTrendVetoSource: KnobSource;
  scalpCooldownSource: KnobSource; scalpBiasSource: KnobSource; scalpRangeSource: KnobSource;
  scalpLcHardMaxEnabled: boolean; scalpLcHardMaxYen: number;
  pricePollMs: number; newsPollMs: number; port: number; cooldownMin: number;
  providers: Array<{ name: string; enabled: boolean; paused: boolean; pausedUntil: number }>;
  configFile: string;
}

interface SaveResponse {
  ok: boolean;
  portRequiresRestart?: boolean;
}

interface BasedataStatus {
  ok: boolean;
  published?: boolean;
  available?: boolean;
  lastBar?: string | null;
  count?: number | null;
  error?: string;
}

async function fetchSettings(): Promise<SettingsResponse | null> {
  try {
    const res = await fetch(apiUrl('/api/settings'));
    if (!res.ok) return null;
    return await res.json() as SettingsResponse;
  } catch { return null; }
}

interface SavePayload {
  geminiKey?: string | null;
  groqKey?: string | null;
  openaiKey?: string | null;
  webSearchKey?: string | null;
  webSearchModel?: string | null;
  webSearchOpenaiModel?: string | null;
  scalpLcCeilingYen?: number | null;
  scalpBias?: 'long' | 'short' | 'none' | null;
  scalpCooldownSec?: number | null;
  scalpRangeEnabled?: boolean | null;
  scalpTrendVetoYen?: number | null;
  // ★v0.7.56: 委任 source + 初期LC下限 + LC安全上限
  scalpLcFloorYen?: number | null;
  scalpLcFloorSource?: KnobSource;
  scalpLcCeilingSource?: KnobSource;
  scalpTrendVetoSource?: KnobSource;
  scalpCooldownSource?: KnobSource;
  scalpBiasSource?: KnobSource;
  scalpRangeSource?: KnobSource;
  scalpLcHardMaxEnabled?: boolean | null;
  scalpLcHardMaxYen?: number | null;
}

async function saveSettings(body: SavePayload): Promise<{ ok: boolean; error?: string; portRequiresRestart?: boolean }> {
  try {
    const res = await fetch(apiUrl('/api/settings/keys'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as SaveResponse & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, portRequiresRestart: data.portRequiresRestart };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}

function renderStatus(s: SettingsResponse | null): string {
  if (!s) return '<div class="settings-status err">設定取得失敗</div>';
  const items = s.providers.map(p => {
    const dot = p.enabled
      ? (p.paused ? '🟡' : '🟢')
      : '⚪';
    const note = p.paused
      ? ` (${Math.max(0, Math.round((p.pausedUntil - Date.now()) / 1000))}秒待機中)`
      : p.enabled ? '' : ' 未設定';
    return `<div>${dot} ${p.name}${note}</div>`;
  }).join('');
  return `<div class="settings-status">${items}</div>`;
}

export interface SettingsElements {
  openBtn: HTMLButtonElement;
  modal: HTMLElement;
  closeBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  inputGemini: HTMLInputElement;
  inputGroq: HTMLInputElement;
  inputOpenai: HTMLInputElement;
  inputWebSearch: HTMLInputElement;        // Web検索(Gemini グラウンディング)専用キー
  inputWebSearchModel: HTMLInputElement;   // Web検索用 Gemini モデル
  inputWebSearchOpenaiModel: HTMLInputElement;  // OpenAI Web検索モデル
  inputScalpLcCeiling: HTMLInputElement;   // AIエントリー: 最大初期LC(円)
  selectScalpBias: HTMLSelectElement;      // AIエントリー: バイアス
  inputScalpCooldown: HTMLInputElement;    // AIエントリー: クールダウン(秒)
  inputScalpTrendVeto: HTMLInputElement;   // AIエントリー: トレンド veto 閾値(円・0で無効)
  checkScalpRangeEnabled: HTMLInputElement; // AIエントリー: レンジ両面ストラドル(実験・紙で別枠計測)
  // ★v0.7.56: 委任モード select + 初期LC下限 + LC安全上限
  inputScalpLcFloor: HTMLInputElement;
  selectLcFloorMode: HTMLSelectElement;
  selectLcCeilingMode: HTMLSelectElement;
  selectTrendVetoMode: HTMLSelectElement;
  selectCooldownMode: HTMLSelectElement;
  selectBiasMode: HTMLSelectElement;
  selectRangeMode: HTMLSelectElement;
  checkScalpLcHardMaxEnabled: HTMLInputElement;
  inputScalpLcHardMax: HTMLInputElement;
  statusArea: HTMLElement;
  backdrop: HTMLElement;
  checkUpdateBtn: HTMLButtonElement;
  updateResult: HTMLElement;
  currentVersion: HTMLElement;
  mergeDbBtn: HTMLButtonElement;
  mergeResult: HTMLElement;
  exportDbBtn: HTMLButtonElement;
  exportResult: HTMLElement;
  replaceDbBtn: HTMLButtonElement;
  replaceResult: HTMLElement;
  testKeysBtn: HTMLButtonElement;
  testResult: HTMLElement;
}

interface KeyTestResponse {
  results?: Array<{ name: string; ok: boolean; notset?: boolean; error?: string }>;
  error?: string;
}

// 各キー行の左に付く状態マークを更新する(id は index.html の key-<name>-status)。
function setKeyStatus(id: string, mark: string, title: string): void {
  const node = document.getElementById(id);
  if (node) { node.textContent = mark; node.title = `キー状態: ${title}`; }
}
// プロバイダ状態(providers)→ マーク。🟢有効 / 🟡待機中(429) / ⚪未設定。
function providerMark(p: { enabled: boolean; paused: boolean } | undefined): { mark: string; title: string } {
  if (!p || !p.enabled) return { mark: '⚪', title: '未設定' };
  if (p.paused) return { mark: '🟡', title: '待機中(429=枠切れで一時休止・自動フォールバック中)' };
  return { mark: '🟢', title: '有効(設定済)' };
}

export function initSettingsModal(el: SettingsElements): void {
  let current: SettingsResponse | null = null;

  async function refresh() {
    current = await fetchSettings();
    el.statusArea.innerHTML = renderStatus(current);
    el.inputGemini.placeholder = current?.geminiSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.geminiFromEnv ? '環境変数から読込中 (上書きするにはここに入力)' : 'AIza...';
    el.inputGroq.placeholder = current?.groqSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.groqFromEnv ? '環境変数から読込中' : 'gsk_...';
    el.inputOpenai.placeholder = current?.openaiSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.openaiFromEnv ? '環境変数から読込中' : 'sk-...';
    el.inputWebSearch.placeholder = current?.webSearchKeySet
      ? '設定済み (上書きする場合のみ入力)'
      : '空欄なら Gemini キーを使用 (AIza... / 課金キー可)';
    el.inputWebSearchModel.value = current?.webSearchModel ?? '';
    el.inputWebSearchModel.placeholder = 'gemini-flash-latest (既定)';
    el.inputWebSearchOpenaiModel.value = current?.webSearchOpenaiModel ?? '';
    el.inputWebSearchOpenaiModel.placeholder = 'gpt-4o-mini-search-preview (既定)';
    // 各キー行の個別マーク(🟢/🟡/⚪)。LLM 3種は providers から、Web検索は解決可否から。
    const byName = (n: string) => current?.providers.find(p => p.name === n);
    for (const n of ['gemini', 'groq', 'openai'] as const) {
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
    syncKnobDisabled();
  }

  // AI委任(mode==='ai')の項目は数値/enum入力を無効化して「AI が決める」ことを視覚化する。
  // LC安全上限は最大初期LCのモードと独立の安全系なので、有効チェックが外れた時だけ値入力を無効化する。
  function syncKnobDisabled() {
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

  async function loadCurrentVersion() {
    el.currentVersion.textContent = '…';
    try {
      const res = await fetch(apiUrl('/api/version'));
      const data = await res.json() as { version: string };
      el.currentVersion.textContent = `v${data.version}`;
    } catch {
      el.currentVersion.textContent = 'v?';
    }
  }

  function clearUpdateResult() {
    el.updateResult.className = 'update-result';
    el.updateResult.innerHTML = '';
  }

  // 統合された更新セクション: 1つの「更新をチェック」で アプリ本体 と 基礎データ を
  // 同時に確認し、行ごとにラベル付きの状態文 + それぞれに適切なアクションを出す。
  function setRow(rowId: 'upd-app-row' | 'upd-base-row', cls: 'ok' | 'warn' | 'err', html: string) {
    const row = el.updateResult.querySelector<HTMLElement>(`#${rowId}`);
    if (row) { row.className = `upd-row ${cls}`; row.innerHTML = html; }
  }

  // アプリ本体: 結果行内の「更新」ボタン → DL+再起動 (Tauri)。
  function wireInstallButton() {
    const btn = el.updateResult.querySelector<HTMLButtonElement>('.update-now-btn:not(.basedata-import-btn)');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const label = el.updateResult.querySelector<HTMLElement>('.update-progress');
      try {
        await installUpdate((dl, total) => {
          if (label) {
            label.textContent = total && total > 0
              ? ` ダウンロード中… ${Math.round((dl / total) * 100)}%`
              : ' ダウンロード中…';
          }
        });
        // installUpdate 内で relaunch されるため通常ここには来ない。
      } catch (err) {
        setRow('upd-app-row', 'err', `アプリ: ❌ 更新失敗: ${escapeHtml(err instanceof Error ? err.message : 'unknown')}`);
      }
    });
  }

  // 基礎データ: 結果行内の「取り込み」ボタン → DBへ追記/更新。
  function wireBasedataImport() {
    const btn = el.updateResult.querySelector<HTMLButtonElement>('.basedata-import-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const prog = el.updateResult.querySelector<HTMLElement>('.basedata-progress');
      if (prog) prog.textContent = ' 取り込み中…';
      try {
        const res = await fetch(apiUrl('/api/basedata/import'), { method: 'POST' });
        const d = await res.json() as { ok: boolean; applied?: number; skipped?: number; from?: string; to?: string; error?: string };
        setRow('upd-base-row', d.ok ? 'ok' : 'err', d.ok
          ? `基礎データ: ✅ ${d.applied}件取り込み (${escapeHtml(d.from ?? '?')}〜${escapeHtml(d.to ?? '?')})${d.skipped ? ` / 休場スキップ${d.skipped}` : ''}`
          : `基礎データ: ❌ ${escapeHtml(d.error ?? '失敗')}`);
      } catch (err) {
        setRow('upd-base-row', 'err', `基礎データ: ❌ ${escapeHtml(err instanceof Error ? err.message : 'failed')}`);
      }
    });
  }

  async function checkAll() {
    el.checkUpdateBtn.disabled = true;
    const originalText = el.checkUpdateBtn.textContent ?? '更新をチェック';
    el.checkUpdateBtn.textContent = 'チェック中...';
    el.updateResult.className = 'update-result';
    el.updateResult.innerHTML =
      `<div class="upd-row" id="upd-app-row">アプリ: 確認中…</div>`
      + `<div class="upd-row" id="upd-base-row">基礎データ: 確認中…</div>`;
    const current = el.currentVersion.textContent ?? '';
    try {
      const [appStatus, baseStatus] = await Promise.all([
        getUpdateStatus(),
        fetch(apiUrl('/api/basedata/status'))
          .then(r => r.json() as Promise<BasedataStatus>)
          .catch((err: unknown): BasedataStatus => ({ ok: false, error: err instanceof Error ? err.message : 'failed' })),
      ]);

      // --- アプリ本体 ---
      if (appStatus.state === 'latest') {
        setRow('upd-app-row', 'ok', `アプリ: ✅ 最新です (${escapeHtml(current)})`);
      } else if (appStatus.state === 'available') {
        const notes = appStatus.info.notes
          ? `<span class="update-notes">${escapeHtml(appStatus.info.notes)}</span>` : '';
        setRow('upd-app-row', 'ok',
          `アプリ: 🆙 v${escapeHtml(appStatus.info.version)} があります`
          + `<button type="button" class="update-now-btn">更新</button>`
          + `<span class="update-progress"></span>${notes}`);
        wireInstallButton();
      } else if (appStatus.state === 'unsupported') {
        setRow('upd-app-row', 'warn', 'アプリ: ⚠️ 開発モードのため確認できません（パッケージ版でのみ動作）');
      } else {
        setRow('upd-app-row', 'err', `アプリ: ❌ 確認失敗: ${escapeHtml(appStatus.message)}`);
      }

      // --- 基礎データ ---
      const s = baseStatus;
      if (!s.ok) {
        setRow('upd-base-row', 'err', `基礎データ: ❌ ${escapeHtml(s.error ?? '確認失敗')}`);
      } else if (!s.published) {
        setRow('upd-base-row', 'warn', '基礎データ: ⚠️ 未公開（先に publish が必要）');
      } else {
        const label = s.available
          ? `基礎データ: 🆙 新着（${escapeHtml(s.lastBar ?? '?')}まで・${s.count ?? '?'}件）`
          : `基礎データ: ✅ 取り込み済み（最新・${escapeHtml(s.lastBar ?? '?')}まで）`;
        const btnText = s.available ? '取り込み' : '再取り込み';
        // 取り込み済み(再取り込み)時は通常不要なので、ボタンを背面無色の控えめ表示にして
        // ユーザーが毎回反射的にクリックしないようにする。新着(取り込み)時は目立つ緑のまま。
        const btnClass = s.available
          ? 'update-now-btn basedata-import-btn'
          : 'update-now-btn basedata-import-btn muted';
        setRow('upd-base-row', 'ok',
          `${label}<button type="button" class="${btnClass}">${btnText}</button>`
          + `<span class="basedata-progress"></span>`);
        wireBasedataImport();
      }
    } finally {
      el.checkUpdateBtn.disabled = false;
      el.checkUpdateBtn.textContent = originalText;
    }
  }

  el.checkUpdateBtn.addEventListener('click', () => { void checkAll(); });

  // --- 別PCのDBをマージ(ファイル選択→停止→バックアップ→OR IGNORE 統合→再起動) ---
  function setMergeResult(cls: 'ok' | 'warn' | 'err', html: string) {
    el.mergeResult.className = `update-result ${cls}`;
    el.mergeResult.innerHTML = html;
  }

  // 非Tauri(開発ブラウザ)では dialog/relaunch 不可。ボタン無効化+案内。
  if (!isTauri()) {
    el.mergeDbBtn.disabled = true;
    setMergeResult('warn', 'パッケージ版でのみ利用可');
  }

  el.mergeDbBtn.addEventListener('click', async () => {
    if (!isTauri()) { setMergeResult('warn', 'パッケージ版でのみ利用可'); return; }
    const path = await pickDbFile();
    if (!path) return;   // キャンセル
    if (!window.confirm('collector と jp225-Trade を停止してマージし、自動で再起動します。よろしいですか?')) return;
    el.mergeDbBtn.disabled = true;
    setMergeResult('warn', 'マージ中…(数十秒かかる場合があります)');
    try {
      const res = await mergeDbFromFile(path);
      if (res.ok) {
        const i = res.inserted ?? { alerts: 0, bars_1m: 0, ticks: 0 };
        setMergeResult('ok', `✅ 統合: alerts +${i.alerts} / bars +${i.bars_1m} / ticks +${i.ticks}。再起動します`);
        setTimeout(() => { void relaunchApp(); }, 1500);
      } else {
        setMergeResult('err', `❌ 失敗: ${escapeHtml(res.error ?? '不明')}`);
        el.mergeDbBtn.disabled = false;
      }
    } catch (err) {
      setMergeResult('err', `❌ 失敗: ${escapeHtml(err instanceof Error ? err.message : 'unknown')}`);
      el.mergeDbBtn.disabled = false;
    }
  });

  // --- このPCのDBをコピー(保存ダイアログ→VACUUM INTO エクスポート。停止・再起動なし) ---
  function setExportResult(cls: 'ok' | 'warn' | 'err', html: string) {
    el.exportResult.className = `update-result ${cls}`;
    el.exportResult.innerHTML = html;
  }
  if (!isTauri()) {
    el.exportDbBtn.disabled = true;
    setExportResult('warn', 'パッケージ版でのみ利用可');
  }
  el.exportDbBtn.addEventListener('click', async () => {
    if (!isTauri()) { setExportResult('warn', 'パッケージ版でのみ利用可'); return; }
    const dest = await saveDbFile();
    if (!dest) return;   // キャンセル
    el.exportDbBtn.disabled = true;
    setExportResult('warn', 'コピー中…');
    try {
      const res = await exportDbToFile(dest);
      if (res.ok) {
        const mb = ((res.size ?? 0) / 1024 / 1024).toFixed(1);
        setExportResult('ok', `✅ 保存しました: ${escapeHtml(res.dest ?? dest)}(${mb} MB)`);
      } else {
        setExportResult('err', `❌ 失敗: ${escapeHtml(res.error ?? '不明')}`);
      }
    } catch (err) {
      setExportResult('err', `❌ 失敗: ${escapeHtml(err instanceof Error ? err.message : 'unknown')}`);
    } finally {
      el.exportDbBtn.disabled = false;
    }
  });

  // --- DBを置き換え(インポート): 選んだDBの内容で現在のDBを丸ごと置換→自動再起動(破壊的・バックアップ後) ---
  function setReplaceResult(cls: 'ok' | 'warn' | 'err', html: string) {
    el.replaceResult.className = `update-result ${cls}`;
    el.replaceResult.innerHTML = html;
  }
  if (!isTauri()) {
    el.replaceDbBtn.disabled = true;
    setReplaceResult('warn', 'パッケージ版でのみ利用可');
  }
  el.replaceDbBtn.addEventListener('click', async () => {
    if (!isTauri()) { setReplaceResult('warn', 'パッケージ版でのみ利用可'); return; }
    const path = await pickDbFile();
    if (!path) return;
    if (!window.confirm('現在のDBを、選んだDBの内容で完全に置き換えます(既存データは消えます)。自動バックアップ後に置換し、collector と jp225-Trade を停止して自動再起動します。よろしいですか?')) return;
    el.replaceDbBtn.disabled = true;
    setReplaceResult('warn', '置き換え中…(数十秒かかる場合があります)');
    try {
      const res = await replaceDbFromFile(path);
      if (res.ok) {
        const i = res.replaced ?? { alerts: 0, bars_1m: 0, ticks: 0 };
        setReplaceResult('ok', `✅ 置き換え完了: alerts ${i.alerts} / bars ${i.bars_1m} / ticks ${i.ticks}。再起動します`);
        setTimeout(() => { void relaunchApp(); }, 1500);
      } else {
        setReplaceResult('err', `❌ 失敗: ${escapeHtml(res.error ?? '不明')}`);
        el.replaceDbBtn.disabled = false;
      }
    } catch (err) {
      setReplaceResult('err', `❌ 失敗: ${escapeHtml(err instanceof Error ? err.message : 'unknown')}`);
      el.replaceDbBtn.disabled = false;
    }
  });

  // --- APIキーの実効性検証(各プロバイダへ1トークンの ping。保存済みキーが対象) ---
  el.testKeysBtn.addEventListener('click', async () => {
    el.testKeysBtn.disabled = true;
    const originalText = el.testKeysBtn.textContent ?? 'キーを検証';
    el.testKeysBtn.textContent = '検証中…';
    el.testResult.className = 'update-result';
    el.testResult.innerHTML = '検証中…';
    try {
      const res = await fetch(apiUrl('/api/settings/test'));
      const data = await res.json() as KeyTestResponse;
      if (!res.ok || data.error) {
        el.testResult.className = 'update-result err';
        el.testResult.innerHTML = `❌ 検証失敗: ${escapeHtml(data.error ?? `HTTP ${res.status}`)}`;
        return;
      }
      const lines = (data.results ?? []).map(r => {
        // 各キー行の個別マークも検証結果(✅/❌/⚪)で更新する。
        if (r.notset) setKeyStatus(`key-${r.name}-status`, '⚪', '未設定');
        else if (r.ok) setKeyStatus(`key-${r.name}-status`, '✅', '検証OK(実際に通った)');
        else setKeyStatus(`key-${r.name}-status`, '❌', `無効: ${(r.error ?? 'エラー').slice(0, 80)}`);
        if (r.notset) return `<div>⚪ ${escapeHtml(r.name)}: 未設定</div>`;
        if (r.ok) return `<div>✅ ${escapeHtml(r.name)}: 有効</div>`;
        return `<div>❌ ${escapeHtml(r.name)}: ${escapeHtml(r.error ?? 'エラー')}</div>`;
      });
      el.testResult.className = 'update-result';
      el.testResult.innerHTML = lines.length > 0 ? lines.join('') : '(プロバイダなし)';
    } catch (err) {
      el.testResult.className = 'update-result err';
      el.testResult.innerHTML = `❌ 検証失敗: ${escapeHtml(err instanceof Error ? err.message : 'unknown')}`;
    } finally {
      el.testKeysBtn.disabled = false;
      el.testKeysBtn.textContent = originalText;
    }
  });

  // ★v0.7.56: 委任モード select / LC安全上限チェックを変えたら即座に入力の有効/無効を同期。
  for (const s of [el.selectLcFloorMode, el.selectLcCeilingMode, el.selectTrendVetoMode,
                   el.selectCooldownMode, el.selectBiasMode, el.selectRangeMode]) {
    s.addEventListener('change', syncKnobDisabled);
  }
  el.checkScalpLcHardMaxEnabled.addEventListener('change', syncKnobDisabled);

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
    el.inputOpenai.value = '';
    el.inputWebSearch.value = '';
    el.inputWebSearchModel.value = '';
    el.inputWebSearchOpenaiModel.value = '';
  }

  el.openBtn.addEventListener('click', () => { void open(); });
  el.closeBtn.addEventListener('click', close);
  el.backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modal.classList.contains('hidden')) close();
  });

  el.saveBtn.addEventListener('click', async () => {
    el.saveBtn.disabled = true;
    const originalText = el.saveBtn.textContent ?? '保存';
    el.saveBtn.textContent = '保存中...';
    try {
      const body: SavePayload = {};
      const gv = el.inputGemini.value.trim();
      const grv = el.inputGroq.value.trim();
      const ov = el.inputOpenai.value.trim();
      const wsk = el.inputWebSearch.value.trim();
      if (gv) body.geminiKey = gv;
      if (grv) body.groqKey = grv;
      if (ov) body.openaiKey = ov;
      if (wsk) body.webSearchKey = wsk;   // 秘密: 空欄は送らない(=変更なし)
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
  });

  // 初回起動時にプロバイダ未設定なら自動オープン
  void (async () => {
    const s = await fetchSettings();
    if (s && !s.providers.some(p => p.enabled)) {
      void open();
    }
  })();
}
