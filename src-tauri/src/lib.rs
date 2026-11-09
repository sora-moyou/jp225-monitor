use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
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

// ★サイドカー spawn の成否を1行だけ残す(%APPDATA%/jp225-monitor/sidecar-spawn.log)。
//
//   これまで spawn の失敗は eprintln! だけ = Rust のコンソール止まりで、運用PC(別マシン)からは
//   「そもそも起動されたのか」すら分からなかった。生成器が動かない件の切り分けで最初に要る事実なので、
//   ファイルに残す。**このファイルを別PCへ運ぶのは monitor(server/spawnLog.ts が読んで meta に載せ、
//   trade2 の30分スナップショットに乗る)**= Rust は書き出しフォルダの解決を知らなくてよい。
//
//   ★失敗しても絶対にアプリを止めない(すべて let _ = で握る)。
//   ★上限行数で切り詰める(毎起動 数行なので、末尾 200 行あれば十分に遡れる)。
const SPAWN_LOG_MAX_LINES: usize = 200;

fn spawn_log_path() -> Option<std::path::PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let dir = std::path::Path::new(&appdata).join("jp225-monitor");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("sidecar-spawn.log"))
}

fn log_spawn(line: &str) {
    eprintln!("{line}");   // 従来どおりコンソールにも出す(挙動を減らさない)
    let Some(path) = spawn_log_path() else { return };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .lines()
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .collect();
    lines.push(format!("{stamp} {line}"));
    let start = lines.len().saturating_sub(SPAWN_LOG_MAX_LINES);
    let out = lines[start..].join("\n") + "\n";
    let _ = std::fs::write(&path, out);
}

// ★本体の実行ファイル名。**両 variant で同じ**。
//
//   NSIS の MAINBINARYNAME は Cargo の package name(jp225-monitor)由来で、
//   productName("JP225 Monitor2" / "JP225 Monitor")ではない。実際に走るプロセスは
//   full も lite も `jp225-monitor.exe`(実測: `taskkill /IM jp225-monitor.exe` で配布アプリが落ちる)。
//
//   ここは以前 productName を返していた = tasklist が **1件も一致しない** = 生存判定が常に false
//   = 相互排他が完全に死んでいた(full は lite を kill せず、lite は full が居ても起動した)。
//
//   ★イメージ名では variant を区別できない(同名だから)。variant はロックファイルの
//     `variant` フィールドが唯一の出どころで、イメージ名は **pid 再利用の誤 kill を防ぐ検証にだけ** 使う。
//   ★literal で持たない: NSIS の MAINBINARYNAME は Cargo の package name そのものなので、
//     同じ出どころ(CARGO_PKG_NAME)から作る = パッケージ名を変えても勝手に追従する。
const MAIN_IMAGE: &str = concat!(env!("CARGO_PKG_NAME"), ".exe");

// 相互排他の判断結果。★純粋に決めてからでないと「誰を kill するか」を間違える。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Exclusion {
    /// 何もしない(自分がロックを取るだけ)。
    Proceed,
    /// lite が生きている → kill してから自分が取る(full だけ)。
    KillOther(u32),
    /// full が生きている → 自分は起動しない(lite だけ)。
    Yield,
}

// 相互排他の判断(純関数=テストできる)。★誤 kill をここで防ぐ:
//   ・ロックが無い/壊れている → Proceed(何も殺さない)
//   ・ロックの pid が **自分自身** → Proceed(pid 再利用で自分の pid が書かれていても自殺しない)
//   ・pid が生きていない、またはイメージ名が本体と違う(pid 再利用の別プロセス)→ Proceed
//   ・同じ variant 同士 → Proceed(相互排他は monitor2 と monitor の間の話)
fn decide_exclusion(
    variant: &str,
    existing: Option<&InstanceLock>,
    our_pid: u32,
    alive: &dyn Fn(u32) -> bool,
) -> Exclusion {
    let Some(lock) = existing else { return Exclusion::Proceed };
    if lock.pid == our_pid {
        return Exclusion::Proceed;
    }
    if !alive(lock.pid) {
        return Exclusion::Proceed;
    }
    match (variant, lock.variant.as_str()) {
        ("full", "lite") => Exclusion::KillOther(lock.pid),
        ("lite", "full") => Exclusion::Yield,
        _ => Exclusion::Proceed,
    }
}

// ★譲る(Yield)ときは窓を1枚も作らせない。ここが「窓を作らない」の唯一の効く場所。
//
//   Tauri は config の windows を **user setup フックより前** に生成する
//   (tauri 2.11.2 / src/app.rs fn setup: `WebviewWindowBuilder::from_config` のループ →
//    そのあとに `(setup)(app)`)。したがって setup の中で何をしても
//   ── 早期 return しても、その場で exit しても ── 窓はもう出来ている。
//
//   実測(是正前): lite が「起動できません」のダイアログを出しながら
//     hwnd class="Tauri Window" title="JP225 Monitor" visible=True + 子プロセス msedgewebview2.exe
//   を開いていた。ダイアログは別スレッドなので窓を塞がず、OK を押す前にその窓を触れてしまう。
//   中身は **走っているフル版のサーバ(:3000)** に繋がった操作可能な2枚目のUIで、
//   そこでの設定変更は実弾を動かしている側へ飛ぶ。
//
//   窓の生成を止められるのは `build()` に渡す **前** の Context の config だけ。
//   `WindowConfig::create=false` は Tauri 自身が用意している「起動時に作らない」フラグ
//   (上のループが `.filter(|w| w.create)` で見ている)。窓を後から閉じるのではなく
//   **一度も作らせない**。
fn apply_window_suppression(
    windows: &mut [tauri::utils::config::WindowConfig],
    decision: Exclusion,
) {
    if decision != Exclusion::Yield {
        return;
    }
    for w in windows.iter_mut() {
        w.create = false;
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

// ── collector の自動再起動 ──────────────────────────────────────────────────────────
//
// ★なぜ要るか(2026-10-27/28 の実事故): collector は起動時に1回 spawn するだけで、終了を誰も見ていなかった。
//   08:05 に `database is locked` で exit code=1 になったあと **13日間** 再起動されず、ticks が止まった
//   (monitor の collectorWatch は DEAD を記録していたが、何もしなかった)。
//
// ★再起動するのは **終了コードが 0 以外のときだけ**:
//   ・PID ロックを別インスタンス(前回のアプリが上げて生き残っている collector)に取られているときは、
//     抜けずに **60秒ごとに再判定して待つ**(collector/lock.ts waitForCollectorLock)。保持者が消えたら
//     ロックを取って収集を始める = 生き残りの collector が落ちても、この監視下の子が引き継ぐ。
//   ・待機者は1人だけ: より新しい待機者(次のアプリ起動の子)が来たら、古い待機者は **exit 0** で身を引く。
//     それを再起動すると待機者が積み上がる/取り合いになるので、0 は再起動しない。
//   ・SIGINT/SIGTERM で while を抜けた通常停止も 0。
//   ・unhandledRejection / uncaughtException は server/processLog.ts が記録してから exit(1)。
// ★「完全終了」(stop_collector = taskkill /F)は Windows では exit code 1 に見える。
//   そのまま再起動すると止めたものが10秒後に生き返るので、停止要求フラグを先に立てて区別する。
// ★間隔は 10秒から倍々で上限5分。10分以上動いてから落ちたら「安定していた」とみなして 10秒に戻す
//   (一度だけの事故は早く戻し、起動直後に落ち続ける場合はログと CPU を食い潰さない)。
static COLLECTOR_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
/// 配布版で走る collector のイメージ名(インストーラの `taskkill /IM "jp225-collector.exe"` と同じ)。
const COLLECTOR_IMAGE: &str = "jp225-collector.exe";
const COLLECTOR_RESTART_MIN: Duration = Duration::from_secs(10);
const COLLECTOR_RESTART_MAX: Duration = Duration::from_secs(300);
const COLLECTOR_STABLE_RUN: Duration = Duration::from_secs(600);
/// 再起動時の spawn そのものが連続でこの回数失敗したら諦める(実行ファイルが無い等。ログを埋め尽くさない)。
const COLLECTOR_MAX_SPAWN_FAILURES: u32 = 5;

// 終了したら再起動するか(純関数=テストできる)。
fn should_restart_collector(code: Option<i32>, stop_requested: bool) -> bool {
    if stop_requested {
        return false;
    }
    // code=None はシグナル終了(Windows では来ない)= 正常終了ではないので再起動する。
    code != Some(0)
}

// 今回の待ち時間と、次回の待ち時間(純関数)。
fn collector_restart_delay(current: Duration, ran_for: Duration) -> (Duration, Duration) {
    let delay = if ran_for >= COLLECTOR_STABLE_RUN { COLLECTOR_RESTART_MIN } else { current };
    let delay = delay.min(COLLECTOR_RESTART_MAX);
    let next = (delay * 2).min(COLLECTOR_RESTART_MAX);
    (delay, next)
}

// tokio を依存に足さずに眠る(Cargo.toml を触らない)。async ランタイムのワーカーは塞がない。
async fn sleep_async(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

// collector を spawn し、異常終了したら再起動し続ける監視タスク。
// ★「アプリを閉じても生き続ける」は従来どおり: 子は SidecarState に入れず drop する(=Exit で kill しない)。
//   アプリが終了すれば監視タスクも消えるだけで、collector 本体には触らない。
fn supervise_collector(app: tauri::AppHandle, variant: &'static str) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = COLLECTOR_RESTART_MIN;
        let mut generation: u32 = 0;      // 0 = アプリ起動時の初回 spawn
        let mut spawn_failures: u32 = 0;
        loop {
            let spawned = match app.shell().sidecar("jp225-collector") {
                Ok(cmd) => cmd.env("MONITOR_VARIANT", variant).spawn().map_err(|e| e.to_string()),
                Err(e) => {
                    // 実行ファイルの解決ができないのは再試行しても直らない(従来どおり記録して終わる)。
                    log_spawn(&format!("[collector] sidecar resolve failed: {e}"));
                    return;
                }
            };
            let (mut crx, cchild) = match spawned {
                Ok(v) => v,
                Err(e) => {
                    log_spawn(&format!("[collector] spawn failed: {e}"));
                    if generation == 0 {
                        return;   // 初回の spawn 失敗は従来どおり(記録して終わる)
                    }
                    spawn_failures += 1;
                    if spawn_failures >= COLLECTOR_MAX_SPAWN_FAILURES {
                        log_spawn(&format!("[collector] ★再起動を断念: spawn が {spawn_failures} 回連続で失敗"));
                        return;
                    }
                    let (delay, next) = collector_restart_delay(backoff, Duration::ZERO);
                    backoff = next;
                    log_spawn(&format!("[collector] {}秒後に再起動を再試行します", delay.as_secs()));
                    sleep_async(delay).await;
                    continue;
                }
            };
            spawn_failures = 0;
            let started = Instant::now();
            if generation == 0 {
                log_spawn(&format!("[collector] spawned pid={}", cchild.pid()));
            } else {
                log_spawn(&format!("[collector] spawned pid={} (再起動 {generation} 回目)", cchild.pid()));
            }
            // kill せず drop に任せる(=生存)。イベント(stderr・終了)は rx で引き続き届く。
            drop(cchild);
            let mut exit: Option<Option<i32>> = None;
            while let Some(event) = crx.recv().await {
                match event {
                    CommandEvent::Stderr(line) => {
                        eprintln!("[collector:err] {}", String::from_utf8_lossy(&line).trim_end());
                    }
                    CommandEvent::Terminated(payload) => {
                        exit = Some(payload.code);
                        break;
                    }
                    _ => {}
                }
            }
            let ran_for = started.elapsed();
            let Some(code) = exit else {
                // 終了を見ないままチャネルが閉じた(通常は起きない)。判断材料が無いので再起動しない。
                log_spawn("[collector] event channel closed without Terminated - not restarting");
                return;
            };
            let stop_requested = COLLECTOR_STOP_REQUESTED.load(Ordering::SeqCst);
            log_spawn(&format!(
                "[collector] terminated code={:?} after {}s{}",
                code,
                ran_for.as_secs(),
                if stop_requested { " (stop requested)" } else { "" }
            ));
            if !should_restart_collector(code, stop_requested) {
                if code == Some(0) && !stop_requested {
                    // ロックが他インスタンスにある(=既に誰かが収集している)/ 通常停止。
                    log_spawn("[collector] exit code 0 - not restarting (superseded by a newer waiter, or normal stop)");
                } else {
                    log_spawn("[collector] stop requested - not restarting");
                }
                return;
            }
            let (delay, next) = collector_restart_delay(backoff, ran_for);
            backoff = next;
            generation += 1;
            log_spawn(&format!(
                "[collector] ★異常終了 code={:?} - {}秒後に再起動します(再起動 {generation} 回目)",
                code,
                delay.as_secs()
            ));
            sleep_async(delay).await;
            if COLLECTOR_STOP_REQUESTED.load(Ordering::SeqCst) {
                log_spawn("[collector] stop requested during backoff - not restarting");
                return;
            }
        }
    });
}

// 完全終了用。collector の PID ファイル(%APPDATA%/jp225-monitor/collector.pid)を読み taskkill。
// 通常終了では呼ばれない(collector はデタッチ起動で生存し続ける)。
// ★taskkill /F は exit code 1 に見えるので、先に停止要求を立てて自動再起動を止める。
#[tauri::command]
fn stop_collector() -> Result<(), String> {
    COLLECTOR_STOP_REQUESTED.store(true, Ordering::SeqCst);
    let appdata = std::env::var("APPDATA").map_err(|e| e.to_string())?;
    // ★ロック待ちの collector(collector.wait.pid)を **先に** 止める。保持者だけ止めると、
    //   待機者が次の再判定でロックを取って収集を再開してしまう(=完全終了にならない)。
    //   pid 再利用の誤 kill を防ぐため、イメージ名が collector のときだけ kill する。
    //   ★TS 側の生存判定(collector/lock.ts isCollectorAlive)は node.exe も collector とみなすが、ここは
    //     **jp225-collector.exe だけ** にしている(意図的な非対称)。生存判定の誤りは「奪わない=待つ」に倒れる
    //     だけだが、kill の誤りは無関係のプロセスを殺す。node.exe は他の開発ツールでも常駐しうるので、
    //     stale な wait.pid が再利用された node.exe を指していたら殺してしまう。開発版(tsx)の待機者は
    //     このアプリの子ではないので、止めるのは開発者の手で行う。
    //   ★注意: 待機者が jp225-collector.exe の SEA 名は配布版での実名(インストーラの taskkill /IM と同じ)。
    let wait_path = std::path::Path::new(&appdata)
        .join("jp225-monitor")
        .join("collector.wait.pid");
    if let Ok(w) = std::fs::read_to_string(&wait_path) {
        if let Ok(wpid) = w.trim().parse::<u32>() {
            if is_alive_with_image(wpid, COLLECTOR_IMAGE) {
                log_spawn(&format!("[collector] stop: kill waiter pid={wpid}"));
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &wpid.to_string(), "/F", "/T"])
                    .output();
            }
        }
        let _ = std::fs::remove_file(&wait_path);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn lock(variant: &str, pid: u32) -> InstanceLock {
        InstanceLock { variant: variant.to_string(), pid }
    }
    fn alive_yes(_: u32) -> bool { true }
    fn alive_no(_: u32) -> bool { false }
    const ALIVE: &dyn Fn(u32) -> bool = &alive_yes;
    const DEAD: &dyn Fn(u32) -> bool = &alive_no;

    #[test]
    fn no_lock_proceeds() {
        assert_eq!(decide_exclusion("full", None, 100, ALIVE), Exclusion::Proceed);
        assert_eq!(decide_exclusion("lite", None, 100, ALIVE), Exclusion::Proceed);
    }

    #[test]
    fn full_kills_live_lite() {
        assert_eq!(
            decide_exclusion("full", Some(&lock("lite", 42)), 100, ALIVE),
            Exclusion::KillOther(42)
        );
    }

    #[test]
    fn lite_yields_to_live_full() {
        assert_eq!(
            decide_exclusion("lite", Some(&lock("full", 42)), 100, ALIVE),
            Exclusion::Yield
        );
    }

    #[test]
    fn dead_lock_is_ignored() {
        assert_eq!(decide_exclusion("full", Some(&lock("lite", 42)), 100, DEAD), Exclusion::Proceed);
        assert_eq!(decide_exclusion("lite", Some(&lock("full", 42)), 100, DEAD), Exclusion::Proceed);
    }

    // ★誤 kill 防止その1: pid 再利用で自分の pid がロックに書かれていても自殺しない。
    #[test]
    fn never_kills_self() {
        assert_eq!(decide_exclusion("full", Some(&lock("lite", 100)), 100, ALIVE), Exclusion::Proceed);
        assert_eq!(decide_exclusion("lite", Some(&lock("full", 100)), 100, ALIVE), Exclusion::Proceed);
    }

    // ★誤 kill 防止その2: 同じ variant 同士は相互排他の対象ではない(kill しない)。
    #[test]
    fn same_variant_is_not_excluded() {
        assert_eq!(decide_exclusion("full", Some(&lock("full", 42)), 100, ALIVE), Exclusion::Proceed);
        assert_eq!(decide_exclusion("lite", Some(&lock("lite", 42)), 100, ALIVE), Exclusion::Proceed);
    }

    // ★誤 kill 防止その3: 生存判定は「pid が居る」だけでは足りず本体のイメージ名と一致すること。
    //   ここでは alive クロージャがその検証(is_alive_with_image)の代役。
    #[test]
    fn alive_check_receives_the_locked_pid() {
        let seen = std::cell::Cell::new(0u32);
        let probe: &dyn Fn(u32) -> bool = &|pid| { seen.set(pid); true };
        assert_eq!(
            decide_exclusion("full", Some(&lock("lite", 777)), 100, probe),
            Exclusion::KillOther(777)
        );
        assert_eq!(seen.get(), 777);
    }

    // 本体のイメージ名は両 variant 共通(productName ではない)。
    #[test]
    fn main_image_is_the_cargo_binary_name() {
        assert_eq!(MAIN_IMAGE, "jp225-monitor.exe");
    }

    use tauri::utils::config::WindowConfig;

    // ★譲るときは窓を1枚も作らせない。setup から早期 return しても Tauri は
    //   その前に config の窓を作り終えているので、config を落とすしかない。
    #[test]
    fn yield_suppresses_every_window() {
        let mut windows = vec![WindowConfig::default(), WindowConfig::default()];
        assert!(windows.iter().all(|w| w.create), "既定は作る");
        apply_window_suppression(&mut windows, Exclusion::Yield);
        assert!(windows.iter().all(|w| !w.create));
    }

    // 譲らないときは窓の設定に触らない(通常起動を1ミリも変えない)。
    #[test]
    fn non_yield_leaves_windows_alone() {
        for decision in [Exclusion::Proceed, Exclusion::KillOther(42)] {
            let mut windows = vec![WindowConfig::default()];
            apply_window_suppression(&mut windows, decision);
            assert!(windows[0].create, "{decision:?} で窓を消してはいけない");
        }
    }

    // ★collector の再起動判定: 0 は再起動しない(PID ロックを他インスタンスが持つと 0 で抜ける=無限ループ防止)。
    #[test]
    fn collector_restarts_only_on_nonzero_exit() {
        assert!(!should_restart_collector(Some(0), false), "ロック競合/通常停止(0)は再起動しない");
        assert!(should_restart_collector(Some(1), false), "unhandledRejection 等(1)は再起動する");
        assert!(should_restart_collector(None, false), "シグナル終了は正常終了ではない");
        assert!(!should_restart_collector(Some(1), true), "完全終了(taskkill=1)は再起動しない");
    }

    #[test]
    fn collector_backoff_doubles_to_cap_and_resets_after_stable_run() {
        let short = Duration::from_secs(1);
        let (d1, n1) = collector_restart_delay(COLLECTOR_RESTART_MIN, short);
        assert_eq!(d1, Duration::from_secs(10));
        let (d2, n2) = collector_restart_delay(n1, short);
        assert_eq!(d2, Duration::from_secs(20));
        let (_, mut next) = collector_restart_delay(n2, short);
        for _ in 0..10 {
            next = collector_restart_delay(next, short).1;
        }
        assert_eq!(next, COLLECTOR_RESTART_MAX, "上限5分で止まる");
        let (d, _) = collector_restart_delay(COLLECTOR_RESTART_MAX, COLLECTOR_STABLE_RUN);
        assert_eq!(d, COLLECTOR_RESTART_MIN, "10分以上動いた後の終了は10秒に戻す");
    }

    // 窓が1枚も無い config でも落ちない(将来 windows を空にしても壊れない)。
    #[test]
    fn window_suppression_handles_empty_config() {
        let mut windows: Vec<WindowConfig> = vec![];
        apply_window_suppression(&mut windows, Exclusion::Yield);
        assert!(windows.is_empty());
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── 相互排他は **アプリを build する前** に決める ──
    //
    // ★理由: Tauri は config の windows を user setup フックより前に生成するので、
    //   「譲るときは窓を作らない」を成立させられるのは build() に渡す前の Context だけ
    //   (apply_window_suppression のコメント参照)。
    // ★判断は **1回だけ**。ここで判断して setup でもう一度判断すると、その隙にフル版が
    //   終了した場合に「窓は抑止済みなのに Proceed」= 窓の無いゾンビになる。
    // 型を明示するのは、まだ Builder に渡していない(=ランタイムが推論されない)ため。
    // tauri::Builder::default() と同じ既定ランタイム。
    let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();

    // 製品バリアント判定(identifier ベース・1 Web バンドルで二重管理なし)。
    // app.jp225monitor2 → full(monitor2)/ それ以外(app.jp225monitor)→ lite。
    let variant: &'static str = if context.config().identifier == "app.jp225monitor2" {
        "full"
    } else {
        "lite"
    };
    let our_pid = std::process::id();

    // 生存判定は pid 実在＋イメージ名一致(誤 kill 防止)。file/parse 失敗はロック無し扱い。
    let lock_path = instance_lock_path();
    let decision = match &lock_path {
        Some(path) => {
            let existing = read_instance_lock(path);
            let alive = |pid: u32| is_alive_with_image(pid, MAIN_IMAGE);
            decide_exclusion(variant, existing.as_ref(), our_pid, &alive)
        }
        // ロックのパスすら解決できない(APPDATA 無し)ときは相互排他を諦めて通常起動する。
        None => Exclusion::Proceed,
    };

    // ★譲るなら窓は1枚も作らせない(config を build 前に落とす)。
    apply_window_suppression(&mut context.config_mut().app.windows, decision);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![stop_collector])
        .manage(SidecarState(Mutex::new(None)))
        .setup(move |app| {
            // ── 相互排他(共有ロック・monitor2 優先)の **実行** ──
            // 判断(decision)は build 前に済ませてある。ここは結果に従うだけ。
            let mut yielded = false;
            match decision {
                Exclusion::KillOther(pid) => {
                    // full(monitor2)優先: 生きている lite を落としてから自分が取る。
                    log_spawn(&format!("[exclusion] full: kill lite pid={pid}"));
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/F", "/T"])
                        .output();
                    if let Some(path) = &lock_path {
                        write_instance_lock(path, variant, our_pid);
                    }
                }
                Exclusion::Yield => {
                    // lite: full(monitor2)が生きているので起動しない(理由を伝えて exit)。
                    //
                    // ここで両立させているのは3つ:
                    //
                    // (1) ★窓を作らない: build 前に WindowConfig.create=false へ落としてある
                    //     (apply_window_suppression)。setup から早期 return するだけでは
                    //     窓は既に出来ている = フル版のサーバに繋がった2枚目のUIが開く。
                    // (2) ★メインスレッドを塞がない: tauri-plugin-dialog は blocking_show を
                    //     「it cannot be executed on the main thread as it will freeze your
                    //     application」と明示的に禁じており、setup はメインスレッド。
                    //     だから別スレッドで出し、メインスレッドは即座にイベントループへ戻す。
                    // (3) ★理由が伝わる: そのダイアログを閉じた時点で exit する。
                    //     窓が無いので、ユーザーに見えるのはこのダイアログだけになる。
                    log_spawn("[exclusion] lite: monitor2 is running - not starting (no window will be created)");
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        // ダイアログが panic しても必ず exit する。ここで抜けないと
                        // 窓の無いプロセスが黙って残る(見えないゾンビ)。
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            handle.dialog()
                                .message("monitor2 が起動中のため monitor は起動できません。monitor2 を終了してから起動してください。")
                                .title("JP225 Monitor")
                                .blocking_show();
                        }));
                        log_spawn("[exclusion] lite: dialog closed - exiting");
                        std::process::exit(0);
                    });

                    // ★「メインスレッドが塞がっていない」ことを事実として残す。
                    //   run_on_main_thread はイベントループが回っているときにしか実行されない
                    //   ので、ダイアログを出したあとにこの行が出る = 固まっていない証拠。
                    //   固まったら(将来 依存を上げて blocking_show の実装が変わった等)
                    //   この行が **出ない** ことで気づける。
                    let probe = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        let _ = probe.run_on_main_thread(|| {
                            log_spawn("[exclusion] lite: main thread ran a task while the dialog was open - not blocked");
                        });
                    });
                    yielded = true;
                }
                Exclusion::Proceed => {
                    if let Some(path) = &lock_path {
                        write_instance_lock(path, variant, our_pid);
                    }
                }
            }
            // ★譲った(lite)ときは、ここから先(サイドカー / collector / 生成器の spawn)を一切やらない。
            if yielded {
                return Ok(());
            }

            // サイドカー名は "jp225-sidecar"。Rust クレート名 "jp225-monitor" と
            // 衝突しないよう意図的に変えてある (同名だと dev モードで Rust 本体が
            // sidecar として spawn され fork-bomb 化する)。
            // variant を環境変数で渡す=server が /api/version で web に伝播(lite は表示縮小)。
            //
            // ★spawn の成否は collector / 生成器と同じ経路(log_spawn)で残す。
            //   ここだけ eprintln! のままだと Rust のコンソール止まりで、運用PCからは
            //   「本体サーバがそもそも起動されたのか」が分からない(server.log が
            //   1行も無いとき、spawn 失敗なのか起動直後に死んだのか切り分けられない)。
            //   ★失敗時に panic する挙動は従来どおり(記録してから panic する)。
            let sidecar = match app.shell().sidecar("jp225-sidecar") {
                Ok(cmd) => cmd.env("MONITOR_VARIANT", variant),
                Err(e) => {
                    log_spawn(&format!("[sidecar] sidecar resolve failed: {e}"));
                    panic!("failed to create sidecar command: {e}");
                }
            };

            let (mut rx, child) = match sidecar.spawn() {
                Ok(v) => v,
                Err(e) => {
                    log_spawn(&format!("[sidecar] spawn failed: {e}"));
                    panic!("failed to spawn sidecar (binaries/jp225-sidecar-<target>.exe is missing?): {e}");
                }
            };
            log_spawn(&format!("[sidecar] spawned pid={}", child.pid()));

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
                        // ★終了も残す(生成器と同じ)。本体サーバが黙って死んだ事実を
                        //   コンソールだけに流さない。
                        CommandEvent::Terminated(payload) => {
                            log_spawn(&format!("[sidecar] terminated code={:?}", payload.code));
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
            // ★異常終了(code≠0)したら自動で再起動する(supervise_collector 参照・2026-10 の13日停止の再発防止)。
            supervise_collector(app.handle().clone(), variant);

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
                        Ok((mut grx, child)) => {
                            // ★spawn できた事実(と pid)を残す。ここが無いと「起動されたのか」が
                            //   別PCから一切分からない(生成器が動かない件で最初に要る事実)。
                            log_spawn(&format!("[generator] spawned pid={}", child.pid()));
                            // _child は kill せず drop に任せる(=生存)。
                            drop(child);
                            // ★終了と stderr を残す: 即死(SEA が起動できない等)を無音にしない。
                            tauri::async_runtime::spawn(async move {
                                while let Some(event) = grx.recv().await {
                                    match event {
                                        CommandEvent::Stderr(line) => {
                                            eprintln!("[generator:err] {}", String::from_utf8_lossy(&line).trim_end());
                                        }
                                        CommandEvent::Terminated(payload) => {
                                            log_spawn(&format!("[generator] terminated code={:?}", payload.code));
                                        }
                                        _ => {}
                                    }
                                }
                            });
                        }
                        Err(e) => log_spawn(&format!("[generator] spawn failed: {e}")),
                    },
                    Err(e) => log_spawn(&format!("[generator] sidecar resolve failed: {e}")),
                }
            } else {
                log_spawn("[generator] skipped (variant=lite)");
            }

            Ok(())
        })
        // ★上で判断済みの context を渡す(generate_context! をここで呼び直すと
        //   窓の抑止をしていない別物の config になる = 譲っても窓が開く)。
        .build(context)
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
