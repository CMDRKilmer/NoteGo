//! 文件系统监听器：使用 notify 监听 Vault 目录
//!
//! 启动一个后台线程，将 `notify::Event` 转换为前端友好的 `VaultEvent`，
//! 再通过 `AppHandle::emit` 推送到前端。
//!
//! 前端事件名：`vault://note`
//! 负载结构：`{ "event": VaultEvent }`
//!
//! **当前 Task**：仅做事件透传；解析 / 重建索引留给 Task 3。

use anyhow::{Context, Result};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use tauri::{AppHandle, Emitter};

/// 推送给前端的事件枚举。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum VaultEvent {
    Created { path: String },
    Modified { path: String },
    Deleted { path: String },
    Renamed { old_path: String, new_path: String },
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
    ///   3. 通过 `AppHandle::emit("vault://note", ...)` 推送给前端
    ///
    /// 调用方必须**持有**返回的 `VaultWatcher`，否则 drop 时 channel 关闭，线程退出。
    pub fn start(app: AppHandle, vault_path: PathBuf) -> Result<Self> {
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
        thread::Builder::new()
            .name("notego-vault-watcher".into())
            .spawn(move || {
                while let Ok(res) = rx.recv() {
                    match res {
                        Ok(event) => {
                            if let Some(v) = map_event(&vault_path, event) {
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
            Some(VaultEvent::Created { path: rel(root, &p) })
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
                        });
                    }
                    return None;
                }
                // 单个 Rename(From|To) - 难以区分，退化为 Modify
                let p = first_md(&event.paths)?;
                Some(VaultEvent::Modified { path: rel(root, &p) })
            } else {
                let p = first_md(&event.paths)?;
                Some(VaultEvent::Modified { path: rel(root, &p) })
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
