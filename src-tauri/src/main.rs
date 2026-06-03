// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// NoteGo 二进制入口
///
/// 真正的 Tauri 启动逻辑放在 `notego_lib::run()` 中，
/// 这样移动端（iOS/Android）也能复用同一份库代码。
fn main() {
    notego_lib::run();
}
