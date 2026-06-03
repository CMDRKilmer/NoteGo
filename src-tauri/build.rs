/// Tauri 2.x 构建脚本入口
///
/// 在编译时执行 `tauri_build::build()`，负责：
///   - 解析 `tauri.conf.json` 并注入上下文
///   - 生成前端 IPC 所需的胶水代码
fn main() {
    tauri_build::build()
}
