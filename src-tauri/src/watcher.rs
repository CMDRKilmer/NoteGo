//! 文件系统监听器：使用 notify 监听 Vault 目录
//!
//! 启动一个后台线程，将 `notify::Event` 转换为前端友好的 `VaultEvent`，
//! 再通过 `AppHandle::emit` 推送到前端。
//!
//! 前端事件名：`vault://note`
//! 负载结构：`{ "event": VaultEvent }`
//!
//! **增量 upsert（M2.3）**：监听线程在收到 `Created` / `Modified` / `Renamed`
//! 事件后，立即对受影响文件做一次 `reindex_note`（走 `Arc<Index>`），
//! 并把更新后的 `NoteRecord` 一并写入事件的 `note` 字段。前端收到事件
//! 即可拿到最新元数据，不必再发 `list_notes` 拉一次。
//! `Deleted` 事件无对应文件，事件 payload 不带 `note` 字段。

use anyhow::{Context, Result};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};

use crate::fs::{build_record, NoteRecord};
use crate::index::Index;
use crate::parser;

/// 推送给前端的事件枚举。
///
/// 三个"存在类"变体（Created / Modified / Renamed）都携带 `note: Option<NoteRecord>`，
/// 由 watcher 线程在 emit 前同步 `reindex_note` 后填入。
/// `Deleted` 事件无对应文件，`note` 始终为 `None`。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum VaultEvent {
    Created {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<NoteRecord>,
    },
    Modified {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<NoteRecord>,
    },
    Deleted {
        path: String,
    },
    Renamed {
        old_path: String,
        new_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<NoteRecord>,
    },
}

/// 文件监听器：内部持有 `RecommendedWatcher` 以维持后台线程存活。
pub struct VaultWatcher {
    /// 保活字段，drop 时停止监听
    _watcher: RecommendedWatcher,
}

impl VaultWatcher {
    /// 启动对 `vault_path` 的递归监听。
    ///
    /// 工作流程：
    ///   1. 创建 `notify` watcher 与 `mpsc::channel`
    ///   2. 在新线程中循环 `recv()`，将 `notify::Event` 映射为 `VaultEvent`
    ///   3. 对 Created/Modified/Renamed 事件做一次 `reindex_one` 获取最新 `NoteRecord`
    ///   4. 通过 `AppHandle::emit("vault://note", ...)` 推送给前端
    ///
    /// `index` 用于在 emit 前获取增量 `NoteRecord`；它不参与监听逻辑。
    /// 调用方必须**持有**返回的 `VaultWatcher`，否则 drop 时 channel 关闭，线程退出。
    pub fn start(
        app: AppHandle,
        vault_path: PathBuf,
        index: Arc<Index>,
    ) -> Result<Self> {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            // notify 回调可能在任意线程中触发，统一通过 channel 转发到我们的工作线程
            let _ = tx.send(res);
        })
        .context("创建 notify watcher 失败")?;
        watcher
            .watch(&vault_path, RecursiveMode::Recursive)
            .with_context(|| format!("监听目录失败: {}", vault_path.display()))?;

        // 后台接收线程
        let app_handle = app.clone();
        let root = vault_path.clone();
        thread::Builder::new()
            .name("notego-vault-watcher".into())
            .spawn(move || {
                while let Ok(res) = rx.recv() {
                    match res {
                        Ok(event) => {
                            if let Some(mut v) = map_event(&root, event) {
                                // 增量 upsert：补全 note 字段
                                enrich_with_note(&index, &root, &mut v);
                                if let Err(e) =
                                    app_handle.emit("vault://note", &EmitPayload { event: v })
                                {
                                    tracing::warn!("emit vault://note 失败: {e}");
                                }
                            }
                        }
                        Err(e) => tracing::warn!("notify 事件错误: {e}"),
                    }
                }
                tracing::info!("vault watcher 接收线程退出");
            })
            .context("启动 watcher 线程失败")?;

        Ok(Self { _watcher: watcher })
    }
}

/// 对 `Created` / `Modified` / `Renamed` 事件补全 `note` 字段。
///
/// `Renamed` 取 `new_path` 作为索引键；如 `reindex_note` 失败（极少见），
/// `note` 保持 `None`，前端降级到 `list_notes` 拉取。
fn enrich_with_note(index: &Arc<Index>, root: &Path, ev: &mut VaultEvent) {
    let rel: Option<&str> = match ev {
        VaultEvent::Created { path, .. } | VaultEvent::Modified { path, .. } => Some(path.as_str()),
        VaultEvent::Renamed { new_path, .. } => Some(new_path.as_str()),
        VaultEvent::Deleted { .. } => None,
    };
    let Some(rel) = rel else { return };
    if let Some(rec) = reindex_one(index, root, rel) {
        match ev {
            VaultEvent::Created { note, .. }
            | VaultEvent::Modified { note, .. }
            | VaultEvent::Renamed { note, .. } => *note = Some(rec),
            VaultEvent::Deleted { .. } => {}
        }
    }
}

/// 增量更新单条笔记并返回最新 `NoteRecord`。
///
/// 行为与 [`crate::fs::Vault::reindex_note`] 相同，但接收 `Arc<Index>` 引用，
/// 避免在 watcher 线程里访问 `Vault`（后者要持锁 clone）。
fn reindex_one(index: &Arc<Index>, root: &Path, rel: &str) -> Option<NoteRecord> {
    let full = root.join(rel);
    if !full.exists() {
        if let Err(e) = index.remove_note_by_path(rel) {
            tracing::warn!("watcher 清理索引失败: {rel}: {e}");
        }
        return None;
    }
    let rec = match build_record(root, &full) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("watcher build_record 失败: {rel}: {e}");
            return None;
        }
    };
    let body = std::fs::read_to_string(&full).unwrap_or_default();
    if let Err(e) = index.upsert_note(rec.id, &rec.path, &rec.title, rec.mtime, rec.size, &rec.hash, &body) {
        tracing::warn!("watcher upsert_note 失败: {rel}: {e}");
    }
    // 解析后回填 tags / links（失败不致命，warn 即可）
    if let Ok(parsed) = parser::parse(&body) {
        if let Err(e) = index.set_tags(rec.id, &parsed.tags) {
            tracing::warn!("watcher set_tags 失败: {rel}: {e}");
        }
        let link_rows: Vec<(String, String, i64)> = parsed
            .links
            .iter()
            .map(|l| (l.target.clone(), l.raw.clone(), l.line as i64))
            .collect();
        if let Err(e) = index.set_links(rec.id, &link_rows) {
            tracing::warn!("watcher set_links 失败: {rel}: {e}");
        }
    }
    Some(rec)
}

/// emit 的顶层负载：固定为 `{ "event": VaultEvent }`。
#[derive(Serialize)]
struct EmitPayload {
    event: VaultEvent,
}

/// 将 `notify::Event` 归并为一条 `VaultEvent`（仅处理 `.md` 文件）。
fn map_event(root: &Path, event: Event) -> Option<VaultEvent> {
    match event.kind {
        EventKind::Create(_) => {
            let p = first_md(&event.paths)?;
            Some(VaultEvent::Created {
                path: rel(root, &p),
                note: None,
            })
        }
        EventKind::Modify(modify) => {
            use notify::event::ModifyKind;
            if matches!(modify, ModifyKind::Name(_)) {
                // 改名 / 移动：paths 通常成对 [old, new]
                if event.paths.len() >= 2 {
                    let old = &event.paths[0];
                    let new = &event.paths[1];
                    if is_md(old) || is_md(new) {
                        return Some(VaultEvent::Renamed {
                            old_path: rel(root, old),
                            new_path: rel(root, new),
                            note: None,
                        });
                    }
                    return None;
                }
                // 单个 Rename(From|To) - 难以区分，退化为 Modify
                let p = first_md(&event.paths)?;
                Some(VaultEvent::Modified {
                    path: rel(root, &p),
                    note: None,
                })
            } else {
                let p = first_md(&event.paths)?;
                Some(VaultEvent::Modified {
                    path: rel(root, &p),
                    note: None,
                })
            }
        }
        EventKind::Remove(_) => {
            let p = first_md(&event.paths)?;
            Some(VaultEvent::Deleted { path: rel(root, &p) })
        }
        _ => None,
    }
}

fn is_md(p: &Path) -> bool {
    p.extension().and_then(|s| s.to_str()) == Some("md")
}

fn first_md(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|p| is_md(p)).cloned()
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}
