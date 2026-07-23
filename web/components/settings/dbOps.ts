// データ操作(別PC DBマージ / このPCのDBコピー / DB置換)セクションの配線。
// settingsModal.ts から純粋に切り出したもの(挙動・確認文・Tauri ガードは不変)。

import { pickDbFile, mergeDbFromFile, relaunchApp, isTauri, saveDbFile, exportDbToFile, replaceDbFromFile } from '../../lib/dbMerge.js';
import { escapeHtml } from './util.js';
import type { SettingsElements } from './types.js';

export function wireDbSection(el: SettingsElements): void {
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
}
