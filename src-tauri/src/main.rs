// Windows GUIアプリ: コンソールウィンドウを抑制 (release時のみ)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jp225_monitor_lib::run()
}
