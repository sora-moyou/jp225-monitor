use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// サイドカー Child を保持。Drop 任せだと Tauri 終了後も子プロセスが残るため、
// RunEvent::Exit/ExitRequested で明示的に kill する。
struct SidecarState(Mutex<Option<CommandChild>>);

// 完全終了用。collector の PID ファイル(%APPDATA%/jp225-monitor/collector.pid)を読み taskkill。
// 通常終了では呼ばれない(collector はデタッチ起動で生存し続ける)。
#[tauri::command]
fn stop_collector() -> Result<(), String> {
    let appdata = std::env::var("APPDATA").map_err(|e| e.to_string())?;
    let pid_path = std::path::Path::new(&appdata)
        .join("jp225-monitor")
        .join("collector.pid");
    let pid = std::fs::read_to_string(&pid_path).map_err(|e| e.to_string())?;
    let pid = pid.trim();
    if !pid.is_empty() {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", pid, "/F", "/T"])
            .output();
    }
    let _ = std::fs::remove_file(&pid_path);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![stop_collector])
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            // サイドカー名は "jp225-sidecar"。Rust クレート名 "jp225-monitor" と
            // 衝突しないよう意図的に変えてある (同名だと dev モードで Rust 本体が
            // sidecar として spawn され fork-bomb 化する)。
            let sidecar = app
                .shell()
                .sidecar("jp225-sidecar")
                .expect("failed to create sidecar command");

            let (mut rx, child) = sidecar
                .spawn()
                .expect("failed to spawn sidecar — binaries/jp225-sidecar-<target>.exe is missing?");

            app.state::<SidecarState>()
                .0
                .lock()
                .unwrap()
                .replace(child);

            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            println!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[sidecar:err] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[sidecar] terminated, code={:?}", payload.code);
                        }
                        _ => {}
                    }
                }
            });

            // 収集デーモンをデタッチ起動。SidecarState に入れない=Exit で kill しない→
            // モニター「通常終了」後も生存しバックグラウンド収集を続ける。collector 側が
            // PID ロックで単一インスタンスを保証するので毎起動 spawn して良い。
            match app.shell().sidecar("jp225-collector") {
                Ok(cmd) => match cmd.spawn() {
                    Ok((mut crx, _child)) => {
                        // _child は kill せず drop に任せる(=生存)。stderr のみログ。
                        tauri::async_runtime::spawn(async move {
                            while let Some(event) = crx.recv().await {
                                if let CommandEvent::Stderr(line) = event {
                                    eprintln!("[collector:err] {}", String::from_utf8_lossy(&line).trim_end());
                                }
                            }
                        });
                    }
                    Err(e) => eprintln!("[collector] spawn failed: {e}"),
                },
                Err(e) => eprintln!("[collector] sidecar resolve failed: {e}"),
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
