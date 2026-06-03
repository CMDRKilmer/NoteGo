//! NoteGo 库入口
//!
//! 启动 Tauri 2.x 应用，注册：
//!   - 官方插件：dialog / updater
//!   - 业务命令：见 `commands` 模块
//!
//! 子模块：
//!   - [`fs`]      Vault 打开与文件 CRUD
//!   - [`index`]   SQLite 索引（FTS5 全文搜索 / 反向链接 / 标签）
//!   - [`parser`]  Markdown / wikilink / tag 解析（占位）
//!   - [`sync`]    S3 同步（占位）
//!   - [`watcher`] notify 文件系统监听
//!   - [`commands`] Tauri command 集合

mod commands;
mod fs;
mod index;
mod parser;
mod sync;
mod watcher;

use commands::WatcherSlot;
use fs::VaultState;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// 初始化日志（默认按 `RUST_LOG` 环境变量过滤）
fn init_tracing() {
    let _ = tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer().with_target(false))
        .try_init();
}

/// Tauri 应用启动入口
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tracing::info!("NoteGo starting…");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(VaultState::default())
        .manage(WatcherSlot::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_vault_dialog,
            commands::open_vault,
            commands::create_vault,
            commands::get_current_vault,
            commands::list_notes,
            commands::read_note,
            commands::write_note,
            commands::create_note,
            commands::delete_note,
            commands::rename_note,
            commands::get_backlinks,
            commands::search_notes,
            commands::rebuild_index,
            commands::list_tags,
            commands::notes_with_tag,
            commands::resolve_link,
            commands::get_unresolved_links,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
