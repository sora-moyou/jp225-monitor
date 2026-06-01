; インストール前に走るフック。
; 旧バージョンのサイドカー / 本体プロセスが残っているとファイルロックで
; 「Error opening file for writing」が出るため、明示的に kill しておく。
;
; v0.3.3 で追加。tauri.conf.json の bundle.windows.nsis.installerHooks
; から参照される。

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping any running JP225 Monitor instance..."
  nsExec::Exec 'taskkill /F /T /IM "jp225-sidecar.exe"'
  nsExec::Exec 'taskkill /F /T /IM "jp225-collector.exe"'
  nsExec::Exec 'taskkill /F /T /IM "jp225-monitor.exe"'
  nsExec::Exec 'taskkill /F /T /IM "JP225 Monitor.exe"'
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping any running JP225 Monitor instance before uninstall..."
  nsExec::Exec 'taskkill /F /T /IM "jp225-sidecar.exe"'
  nsExec::Exec 'taskkill /F /T /IM "jp225-collector.exe"'
  nsExec::Exec 'taskkill /F /T /IM "jp225-monitor.exe"'
  nsExec::Exec 'taskkill /F /T /IM "JP225 Monitor.exe"'
  Sleep 1500
!macroend
