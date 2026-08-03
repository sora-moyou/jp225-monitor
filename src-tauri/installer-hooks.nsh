; インストール前に走るフック。
; 旧バージョンのサイドカー / 本体プロセスが残っているとファイルロックで
; 「Error opening file for writing」が出るため、明示的に kill しておく。
;
; v0.3.3 で追加。tauri.conf.json の bundle.windows.nsis.installerHooks
; から参照される。
;
; ★このファイルは UTF-8 BOM 付きで保存すること。
;   NSIS(Unicode)は BOM が無いスクリプトをシステムコードページとして読むため、
;   BOM が無いと日本語が化ける(コメントだけなら無害だが、下の MessageBox は画面に出る)。
;
; ─────────────────────────────────────────────────────────────────────────────
; ★「黙って古いまま」の時限爆弾を潰す
;
;   実測した事実:
;     ・NSIS の File は、対象がロックされていると **画面を出さないインストールでは
;       エラーを無視して次へ進む**。exit code は 0。つまり「成功したのに書かれていない」。
;         dummy(5 byte)を置いてロック無しで /S → 91,632,640 に上書きされる
;         dummy(5 byte)を置いてロック有りで /S → **5 byte のまま・exit=0・後続も継続**
;
;   ★本番の更新は `/S` ではない(ここを取り違えていた):
;     tauri.conf.json に installMode の指定が無い → tauri-plugin-updater の既定は **Passive** →
;     実際に渡るのは `/P /R /UPDATE /ARGS …`。したがって `${Silent}` は **偽** で、
;     `IfSilent` だけで守っていた分岐は本番では1度も通らない(= モーダルが出て無限に待つ)。
;     実測: ロック中 + /S なし → ★モーダルが出たまま 40 秒後も継続。
;     → 画面を出してよいかの判断は Tauri テンプレート自身の作法に合わせ、**$PassiveMode も見る**
;       (target/release/nsis/x64/utils.nsh:41 が `${IfThen} $PassiveMode != 1 ${|} MessageBox …`)。
;       $PassiveMode は installer.nsi が宣言・.onInit で `/P` から設定する変数(このフックは
;       installer.nsi に include されるので、マクロ展開時にそのまま参照できる)。
;     ・ここで kill していたのは sidecar / collector / monitor の3本だけで、
;       **jp225-generator.exe が抜けていた**。
;     ・生成器はアプリ終了後も生き残る設計(Rust が _child を kill しない)なので、
;       自分の exe を **常時ロックし続ける**。
;   ⇒ 生成器だけが毎回の更新で旧バイナリのまま残り、しかも「更新成功」と表示される。
;
;   是正は2つ。片方だけでは足りない:
;     ① jp225-generator.exe も kill する(既存3本と同じ流儀)。
;     ② ★それでもロックが残っていたら **黙って続けない**。File が書けないまま進むと
;        「成功したのに混在バージョン」という最悪の状態になる。ロックが解けるまで待ち、
;        解けなければ **インストールを中断**する(= 旧版がそのまま残る = 一貫した状態)。
;        中断は exit code に出る(更新側がエラーとして扱える)ので無音ではない。
;        さらに理由を %APPDATA%\jp225-monitor\sidecar-spawn.log に1行残す
;        (Rust が書き TS[server/spawnLog.ts]が読む既存のログ。meta に載って別PCまで届く)。
;
;   ★中断したときに何が起きるかを、メッセージにも記録にも書く(ここが抜けていた):
;     Abort すると `.onInstSuccess` が走らない → `/R` による **アプリの再起動もされない**。
;     直前に JP225_KILL_RUNNING が monitor / collector / 生成器 / サイドカーを全部 taskkill しているので、
;     **中断＝全部止まったまま**で、人が手で起動するまで収集も監視も復帰しない。
;     だから「関連プロセスを終了してからもう一度」という助言は行き止まり(もう全部終了させてある)。
;     正しい助言は「しばらく待ってから、または PC を再起動してから、もう一度」。
; ─────────────────────────────────────────────────────────────────────────────

; ロック解除待ちの上限。1秒 × 20回 = 最大20秒。
; (更新は「アプリ自身がインストーラを起動 → 自分が kill される」順序なので、
;  ハンドルが実際に閉じるまで少し遅れることがある。待てば解ける。)
!define JP225_UNLOCK_TRIES 20
!define JP225_UNLOCK_WAIT  1000

; 停止対象。★ここが「kill する対象」の唯一の一覧。
!macro JP225_KILL_RUNNING
  nsExec::Exec 'taskkill /F /T /IM "jp225-sidecar.exe"'
  nsExec::Exec 'taskkill /F /T /IM "jp225-collector.exe"'
  ; ★生成器。アプリ終了後も生き残るので、ここで殺さないと自分の exe をロックし続ける。
  nsExec::Exec 'taskkill /F /T /IM "jp225-generator.exe"'
  nsExec::Exec 'taskkill /F /T /IM "jp225-monitor.exe"'
  ; 旧名(productName を実行ファイル名にしていた頃の残骸)。
  nsExec::Exec 'taskkill /F /T /IM "JP225 Monitor.exe"'
!macroend

; 中断の理由を1行残す。**失敗しても絶対にインストーラを落とさない**
; (理由を残せないことが新しい障害になってはいけない)。
;
; ★時刻を必ず付ける。この共用ログの他の行は Rust/TS が `<epoch_ms> <line>` を書いており、
;   インストーラの行だけ時刻が無かった = 「いつ中断したのか」が後から分からなかった。
;   NSIS から epoch ms は安価に作れないので **ローカル時刻**(YYYY-MM-DD HH:MM:SS)を書く。
;   読み手(server/spawnLog.ts の readSpawnLogTail)は行をそのまま返すだけなので解釈は壊れない
;   (この差異は spawnLog.ts の冒頭に明記してある)。
; ★${GetTime} は FileFunc.nsh(installer.nsi が include 済み)の CallArtificialFunction 版なので、
;   こちらで !insertmacro GetTime を書く必要は無い(=関数の二重定義が起きない)。
!macro JP225_REPORT_LOCKED FILE ID
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  ; $R3=日 $R4=月 $R5=年 $R6=曜日 $R7=時 $R8=分 $R9=秒
  ${GetTime} "" "L" $R3 $R4 $R5 $R6 $R7 $R8 $R9
  CreateDirectory "$APPDATA\jp225-monitor"
  ClearErrors
  FileOpen $R2 "$APPDATA\jp225-monitor\sidecar-spawn.log" a
  IfErrors jp225_rep_done_${ID}
  FileSeek $R2 0 END
  FileWrite $R2 "$R5-$R4-$R3 $R7:$R8:$R9 [installer] ABORTED: ${FILE} is locked and was NOT updated (old version kept). Monitor/collector/generator were already killed and are NOT restarted (.onInstSuccess and the /R relaunch are skipped on abort).$\r$\n"
  FileClose $R2
jp225_rep_done_${ID}:
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
!macroend

; $INSTDIR\<FILE> が **書ける** ことを確かめる。書けなければ待つ。それでも駄目なら中断。
;   ・存在しない(新規インストール)なら何もしない。
;   ・FileOpen "a" は中身を壊さない(追記モードで開いて即閉じるだけ)。
;   ・${ID} はラベル名の重複を避けるための一意な数字。
!macro JP225_REQUIRE_WRITABLE FILE ID
  Push $R0
  Push $R1
  IfFileExists "$INSTDIR\${FILE}" 0 jp225_w_done_${ID}
  StrCpy $R1 0
jp225_w_try_${ID}:
  ClearErrors
  FileOpen $R0 "$INSTDIR\${FILE}" a
  IfErrors 0 jp225_w_ok_${ID}
  IntOp $R1 $R1 + 1
  IntCmp $R1 ${JP225_UNLOCK_TRIES} jp225_w_fail_${ID} 0 jp225_w_fail_${ID}
  DetailPrint "  ${FILE} is still locked - waiting ($R1/${JP225_UNLOCK_TRIES})"
  Sleep ${JP225_UNLOCK_WAIT}
  Goto jp225_w_try_${ID}
jp225_w_ok_${ID}:
  FileClose $R0
  Goto jp225_w_done_${ID}
jp225_w_fail_${ID}:
  ; ★ここで進むと「成功したのに書かれていない」になる。だから進まない。
  DetailPrint "ABORT: ${FILE} is locked by another process - installation cancelled (old version kept)."
  !insertmacro JP225_REPORT_LOCKED "${FILE}" ${ID}
  ; ★人が見ていない更新(サイレント /S ・**本番の Passive /P**)ではモーダルを出さない。
  ;   出すと誰も押せず、インストーラが無限にブロックする(実測: /S 無しで 40 秒後も継続)。
  ;   $PassiveMode を見るのは Tauri テンプレート自身の作法(utils.nsh:41)に合わせたもの。
  IfSilent jp225_w_abort_${ID}
  StrCmp $PassiveMode "1" jp225_w_abort_${ID} 0
  MessageBox MB_ICONSTOP "${FILE} が他のプロセスに使用中のため、更新できませんでした。$\r$\n(旧バージョンはそのまま残ります)$\r$\n$\r$\nしばらく待ってから、または PC を再起動してから、もう一度インストールしてください。$\r$\n$\r$\n★注意: 更新の前に JP225 Monitor・収集デーモン・提案生成器はすべて停止させています。中断したため自動での再起動は行われません(監視も収集も止まったままです)。手動でアプリを起動してください。"
jp225_w_abort_${ID}:
  SetErrorLevel 4
  Abort "${FILE} is locked - installation aborted"
jp225_w_done_${ID}:
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping any running JP225 Monitor instance..."
  !insertmacro JP225_KILL_RUNNING
  Sleep 1500
  ; ★kill しただけで満足しない。実際に **書けること** を確認してから File に進む。
  DetailPrint "Verifying that the executables can be replaced..."
  !insertmacro JP225_REQUIRE_WRITABLE "jp225-sidecar.exe"   1
  !insertmacro JP225_REQUIRE_WRITABLE "jp225-collector.exe" 2
  !insertmacro JP225_REQUIRE_WRITABLE "jp225-generator.exe" 3
  !insertmacro JP225_REQUIRE_WRITABLE "jp225-monitor.exe"   4
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping any running JP225 Monitor instance before uninstall..."
  !insertmacro JP225_KILL_RUNNING
  Sleep 1500
!macroend
