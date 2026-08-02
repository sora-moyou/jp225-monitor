use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// サイドカー Child を保持。Drop 任せだと Tauri 終了後も子プロセスが残るため、
// RunEvent::Exit/ExitRequested で明示的に kill する。
struct SidecarState(Mutex<Option<CommandChild>>);

// 相互排他ロックの内容(%APPDATA%/jp225-monitor/app-instance.lock)。
// 両製品(monitor2=full / monitor=lite)で共通パス=同時起動不可(monitor2 優先)。
#[derive(Serialize, Deserialize)]
struct InstanceLock {
    variant: String,
    pid: u32,
}

// ロックファイルのパス。%APPDATA%/jp225-monitor/ が無ければ作る。失敗時 None。
fn instance_lock_path() -> Option<std::path::PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let dir = std::path::Path::new(&appdata).join("jp225-monitor");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("app-instance.lock"))
}

// variant に対応する exe イメージ名。pid 再利用の誤 kill を防ぐ検証に使う。
fn expected_image_for(variant: &str) -> &'static str {
    if variant == "full" {
        "JP225 Monitor2.exe"
    } else {
        "JP225 Monitor.exe"
    }
}

// pid が生存し、かつイメージ名が一致するかを tasklist で確認。
// 両方満たすときだけ true(pid 再利用の別プロセスを「生存」と誤認して kill しない)。
fn is_alive_with_image(pid: u32, image: &str) -> bool {
    let output = std::process::Command::new("tasklist")
        .args([
            "/FI",
            &format!("PID eq {}", pid),
            "/FO",
            "CSV",
            "/NH",
        ])
        .output();
    let output = match output {
        Ok(o) => o,
        Err(_) => return false,
    };
    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    let image = image.to_lowercase();
    // CSV 行例: "jp225 monitor.exe","1234","console","1","50,000 k"
    // イメージ名と "pid" の両方を含む行があれば生存かつ一致。
    text.lines()
        .any(|line| line.contains(&image) && line.contains(&format!("\"{}\"", pid)))
}

// ロックを読む。ファイル無し/パース失敗は None(=ロック無し扱い=続行・クラッシュしない)。
fn read_instance_lock(path: &std::path::Path) -> Option<InstanceLock> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<InstanceLock>(&content).ok()
}

// 自分(variant, pid)でロックを書く。失敗は無視(防御的)。
fn write_instance_lock(path: &std::path::Path, variant: &str, pid: u32) {
    let lock = InstanceLock {
        variant: variant.to_string(),
        pid,
    };
    if let Ok(json) = serde_json::to_string(&lock) {
        let _ = std::fs::write(path, json);
    }
}

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
            // ── 製品バリアント判定(identifier ベース・1 Web バンドルで二重管理なし)──
            // app.jp225monitor2 → full(monitor2)/ それ以外(app.jp225monitor)→ lite。
            let variant: &'static str = if app.config().identifier == "app.jp225monitor2" {
                "full"
            } else {
                "lite"
            };
            let our_pid = std::process::id();

            // ── 相互排他(共有ロック・monitor2 優先)──
            // 生存判定は pid 実在＋イメージ名一致(誤 kill 防止)。file/parse 失敗はロック無し扱い。
            if let Some(lock_path) = instance_lock_path() {
                let existing = read_instance_lock(&lock_path);
                if variant == "full" {
                    // full(monitor2): lite が生きていれば kill して優先。
                    if let Some(lock) = &existing {
                        if lock.variant == "lite"
                            && is_alive_with_image(lock.pid, expected_image_for("lite"))
                        {
                            let _ = std::process::Command::new("taskkill")
                                .args(["/PID", &lock.pid.to_string(), "/F", "/T"])
                                .output();
                        }
                    }
                    // 有無に関わらず自分でロックを上書き取得(=優先)。
                    write_instance_lock(&lock_path, variant, our_pid);
                } else {
                    // lite: full(monitor2)が生きていれば起動しない(ダイアログ→exit)。
                    if let Some(lock) = &existing {
                        if lock.variant == "full"
                            && is_alive_with_image(lock.pid, expected_image_for("full"))
                        {
                            app.dialog()
                                .message("monitor2 が起動中のため monitor は起動できません。monitor2 を終了してから起動してください。")
                                .title("JP225 Monitor")
                                .blocking_show();
                            std::process::exit(0);
                        }
                    }
                    // full が居ない/死んでいれば自分で取得。
                    write_instance_lock(&lock_path, variant, our_pid);
                }
            }

            // サイドカー名は "jp225-sidecar"。Rust クレート名 "jp225-monitor" と
            // 衝突しないよう意図的に変えてある (同名だと dev モードで Rust 本体が
            // sidecar として spawn され fork-bomb 化する)。
            // variant を環境変数で渡す=server が /api/version で web に伝播(lite は表示縮小)。
            let sidecar = app
                .shell()
                .sidecar("jp225-sidecar")
                .expect("failed to create sidecar command")
                .env("MONITOR_VARIANT", variant);

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
            // ★collector にも variant を渡す(サイドカーと同じ環境変数)。渡さないと collector は
            //   自分が公開版(lite)か monitor2(full)かを判別できず、分析専用のティック長期保管を
            //   公開版でも回してしまう(ディスクを永久に食う)。
            match app.shell().sidecar("jp225-collector") {
                Ok(cmd) => match cmd.env("MONITOR_VARIANT", variant).spawn() {
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

            // 提案生成器(分析用)をデタッチ起動。collector と同じ流儀(SidecarState に入れない=
            // Exit で kill しない)。monitor 本体の起動を遅らせないよう、spawn するだけで待たない。
            //
            // ★lite(公開版)では spawn しない。生成器は決済パラメータの分析専用で、公開版のユーザーの
            //   PC で LLM 予算とディスクを黙って消費させてはいけない。判定材料は collector へ渡すのと
            //   同じ variant(identifier 由来)だけ=新しい設定機構を作らない。
            // ★full でも「起動しただけでは走らない」: 生成器は設定 generatorEnabled(既定 false)が
            //   true になるまで待機するだけで、LLM も台帳も触らない(server/generator/sidecar.ts)。
            if variant == "full" {
                match app.shell().sidecar("jp225-generator") {
                    Ok(cmd) => match cmd.env("MONITOR_VARIANT", variant).spawn() {
                        Ok((mut grx, _child)) => {
                            // _child は kill せず drop に任せる(=生存)。stderr のみログ。
                            tauri::async_runtime::spawn(async move {
                                while let Some(event) = grx.recv().await {
                                    if let CommandEvent::Stderr(line) = event {
                                        eprintln!("[generator:err] {}", String::from_utf8_lossy(&line).trim_end());
                                    }
                                }
                            });
                        }
                        Err(e) => eprintln!("[generator] spawn failed: {e}"),
                    },
                    Err(e) => eprintln!("[generator] sidecar resolve failed: {e}"),
                }
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
                // 自分が取得したロックだけ削除(他インスタンスのロックは消さない)。
                if let Some(lock_path) = instance_lock_path() {
                    if let Some(lock) = read_instance_lock(&lock_path) {
                        if lock.pid == std::process::id() {
                            let _ = std::fs::remove_file(&lock_path);
                        }
                    }
                }
            }
        });
}
