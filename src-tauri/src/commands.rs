//! Tauri command 集合
//!
//! 每个 `#[tauri::command]` 函数对应前端 `src/lib/ipc.ts` 中的一个 `invoke` 调用。
//!
//! 所有命令的 IO 实现位于 [`crate::fs`]，索引后端位于 [`crate::index`]，
//! 本模块负责：
//!   - 注入 [`crate::fs::VaultState`] 全局状态
//!   - 错误类型转换（`anyhow::Error` -> `String`）
//!   - 在 `open_vault` / `create_vault` 成功后启动 [`crate::watcher::VaultWatcher`]
//!
//! 文件监听器通过 [`WatcherSlot`]（`Mutex<Option<VaultWatcher>>`）存放：
//!   - 旧实例 drop 时 channel 关闭、后台线程退出
//!   - 替换为新实例时自动完成切换

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::fs::{NoteRecord, Vault, VaultState};
use crate::index::{BacklinkRow, SearchHit, UnresolvedLinkRow};
use crate::watcher::VaultWatcher;

/// 当前活跃的 [`VaultWatcher`]；`None` 表示未启动。
/// 旧实例 drop 时其内部 channel 自动断开，监听线程随即退出。
#[derive(Default)]
pub struct WatcherSlot(pub Mutex<Option<VaultWatcher>>);

/// 弹出系统对话框选择 Vault 目录，返回包含 `path / name` 的 Vault 结构。
#[tauri::command]
pub async fn open_vault_dialog(app: AppHandle) -> Result<Option<Vault>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择 / 创建 Vault 目录")
        .pick_folder(move |folder| {
            let _ = tx.send(folder.and_then(|f| f.into_path().ok()));
        });
    let result = rx.await.map_err(|e| e.to_string())?;
    match result {
        None => Ok(None),
        Some(path) => Vault::open(path).map(Some).map_err(err),
    }
}

/// 打开已存在的 Vault，保存到全局状态并启动文件监听。
#[tauri::command]
pub async fn open_vault(
    path: String,
    state: State<'_, VaultState>,
    watcher: State<'_, WatcherSlot>,
    app: AppHandle,
) -> Result<Vault, String> {
    let vault = Vault::open(PathBuf::from(&path)).map_err(err)?;
    state.set(Some(vault.clone()));
    start_watcher(&app, &watcher, &vault.path);
    Ok(vault)
}

/// 创建一个新 Vault（目录不存在则递归创建）。
#[tauri::command]
pub async fn create_vault(
    path: String,
    state: State<'_, VaultState>,
    watcher: State<'_, WatcherSlot>,
    app: AppHandle,
) -> Result<Vault, String> {
    let vault = Vault::create(PathBuf::from(&path)).map_err(err)?;
    state.set(Some(vault.clone()));
    start_watcher(&app, &watcher, &vault.path);
    Ok(vault)
}

/// 启动一个 VaultWatcher 并放入 [`WatcherSlot`]；失败仅记录 warn，不阻塞主流程。
fn start_watcher(app: &AppHandle, slot: &State<'_, WatcherSlot>, vault_path: &std::path::Path) {
    match VaultWatcher::start(app.clone(), vault_path.to_path_buf()) {
        Ok(w) => {
            if let Ok(mut g) = slot.0.lock() {
                *g = Some(w);
            }
            tracing::info!("vault watcher 启动: {}", vault_path.display());
        }
        Err(e) => tracing::warn!("启动 vault watcher 失败: {e}"),
    }
}

/// 取当前打开的 Vault；未设置返回 `None`。
#[tauri::command]
pub async fn get_current_vault(state: State<'_, VaultState>) -> Result<Option<Vault>, String> {
    Ok(state.current())
}

/// 列出 Vault 内所有笔记元数据。
#[tauri::command]
pub async fn list_notes(state: State<'_, VaultState>) -> Result<Vec<NoteRecord>, String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.list_notes().map_err(err)
}

/// 读取单个笔记的原始 Markdown 内容。
#[tauri::command]
pub async fn read_note(rel_path: String, state: State<'_, VaultState>) -> Result<String, String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.read_note(&rel_path).await.map_err(err)
}

/// 写入（覆盖）一个笔记。
#[tauri::command]
pub async fn write_note(
    rel_path: String,
    content: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.write_note(&rel_path, &content).await.map_err(err)
}

/// 创建一个新笔记，返回新建后的元数据。
#[tauri::command]
pub async fn create_note(
    rel_path: String,
    title: Option<String>,
    state: State<'_, VaultState>,
) -> Result<NoteRecord, String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault
        .create_note(&rel_path, title.as_deref())
        .map_err(err)
}

/// 删除一个笔记。
#[tauri::command]
pub async fn delete_note(rel_path: String, state: State<'_, VaultState>) -> Result<(), String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.delete_note(&rel_path).await.map_err(err)
}

/// 重命名 / 移动一个笔记。
#[tauri::command]
pub async fn rename_note(
    old_rel: String,
    new_rel: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.rename_note(&old_rel, &new_rel).await.map_err(err)
}

/// 获取某笔记的反向链接列表（按 `rel_path` 查询 SQLite links 表）。
#[tauri::command]
pub async fn get_backlinks(
    rel_path: String,
    state: State<'_, VaultState>,
) -> Result<Vec<BacklinkRow>, String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.index.get_backlinks(&rel_path).map_err(err)
}

/// FTS5 全文搜索。最多返回 50 条结果。
#[tauri::command]
pub async fn search_notes(
    query: String,
    state: State<'_, VaultState>,
) -> Result<Vec<SearchHit>, String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.index.search(&query, 50).map_err(err)
}

/// 全量重建索引。
#[tauri::command]
pub async fn rebuild_index(state: State<'_, VaultState>) -> Result<usize, String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.reindex_all().map_err(err)?;
    vault.index.count_notes().map_err(err)
}

/// 取所有标签及其计数（按 count 倒序）。
#[tauri::command]
pub async fn list_tags(
    state: State<'_, VaultState>,
) -> Result<Vec<(String, i64)>, String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.index.all_tags().map_err(err)
}

/// 按标签过滤：返回所有挂载该 tag 的笔记元数据。
///
/// 优先从 `list_notes()` 中匹配完整 `NoteRecord`；匹配失败时构造占位记录
/// （mtime/size/hash 留空，避免索引查询中再走一次全表扫描）。
#[tauri::command]
pub async fn notes_with_tag(
    tag: String,
    state: State<'_, VaultState>,
) -> Result<Vec<NoteRecord>, String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    let rows = vault.index.notes_with_tag(&tag).map_err(err)?;
    let all = vault.list_notes().map_err(err)?;
    let by_path: std::collections::HashMap<&str, &NoteRecord> =
        all.iter().map(|n| (n.path.as_str(), n)).collect();
    let mut out = Vec::with_capacity(rows.len());
    for (id, path, title) in rows {
        if let Some(r) = by_path.get(path.as_str()) {
            out.push((*r).clone());
        } else {
            out.push(NoteRecord {
                id,
                path,
                title,
                mtime: 0,
                size: 0,
                hash: String::new(),
            });
        }
    }
    Ok(out)
}

/// 解析一段双向链接文本（可带 `[[ ]]` / `#heading` / `|alias`），在索引中查找最匹配的笔记路径。
///
/// 返回 `Some(rel_path)` 或 `None`（无匹配）。
#[tauri::command]
pub async fn resolve_link(
    text: String,
    state: State<'_, VaultState>,
) -> Result<Option<String>, String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.index.resolve_link(&text).map_err(err)
}

/// 查询所有"未解决"的双向链接：`links.to_path` 不在 `notes.path` 集合内。
#[tauri::command]
pub async fn get_unresolved_links(
    state: State<'_, VaultState>,
) -> Result<Vec<UnresolvedLinkRow>, String> {
    let vault = state
        .current()
        .ok_or_else(|| "尚未打开 Vault".to_string())?;
    vault.index.unresolved_links().map_err(err)
}

/// 统一错误转换：`anyhow::Error` -> 字符串。
fn err(e: anyhow::Error) -> String {
    // 取最底层错误以保留上下文
    format!("{e:#}")
}
