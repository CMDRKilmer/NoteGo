//! Vault（笔记库）与 Note（笔记）的文件系统管理
//!
//! 提供：
//!   - [`Vault`]：打开 / 创建 / 列举 / 读写 Markdown 文件
//!   - [`VaultState`]：Tauri 全局状态，持有当前打开的 Vault
//!   - [`NoteRecord`]：轻量级笔记元数据（不含正文），用于前端列表 / 文件树
//!
//! 路径策略：
//!   - 所有外部输入（前端传入的 `rel_path`）先经 [`Vault::resolve`] 校验，
//!     阻止 `..` 等跳出 Vault 根的相对路径
//!   - 写文件使用 `tempfile` 在同目录创建临时文件再 rename，实现原子替换
//!
//! **当前 Task**：实现 Vault 基础 IO + 路径安全 + 原子写。
//! **Task 3** 集成 [`crate::index::Index`]：Vault 内部持有 `Arc<Index>`，
//! 打开时打开索引并触发全量重建；CRUD 同步更新索引。

use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::NamedTempFile;
use tokio::io::AsyncWriteExt;
use walkdir::WalkDir;

use crate::index::Index;
use crate::parser;

/// NoteGo 内部元数据目录（包含索引数据库 / 缓存等），不应被当作笔记扫描。
pub const NOTEGO_DIR: &str = ".notego";

/// Tauri 全局状态：当前打开的 Vault（`None` 表示尚未选择）。
#[derive(Default)]
pub struct VaultState(pub Mutex<Option<Vault>>);

impl VaultState {
    /// 取当前 Vault 的克隆；若无返回 `None`。
    pub fn current(&self) -> Option<Vault> {
        self.0.lock().ok().and_then(|g| g.clone())
    }

    /// 替换为新 Vault。
    pub fn set(&self, vault: Option<Vault>) {
        if let Ok(mut g) = self.0.lock() {
            *g = vault;
        }
    }
}

/// 笔记库：磁盘上的一个目录。
#[derive(Debug, Serialize, Deserialize)]
pub struct Vault {
    /// Vault 根目录绝对路径
    pub path: PathBuf,
    /// 显示名（默认取目录名）
    pub name: String,
    /// SQLite 索引（`Arc` 共享，跨线程安全）
    #[serde(skip)]
    pub index: Arc<Index>,
}

/// 手动实现 `Clone`：`Arc<Index>` 走引用计数，避免复制 `Mutex<Connection>`。
impl Clone for Vault {
    fn clone(&self) -> Self {
        Self {
            path: self.path.clone(),
            name: self.name.clone(),
            index: self.index.clone(),
        }
    }
}

impl Vault {
    /// 打开一个已存在的 Vault，同时打开并按需重建 SQLite 索引。
    ///
    /// 行为：
    ///   - 路径必须存在且为目录，否则报错
    ///   - 名称取目录的 `file_name`
    ///   - 索引文件首次创建时执行全量 `rebuild`；若索引非空则跳过
    pub fn open(path: PathBuf) -> Result<Self> {
        if !path.exists() {
            anyhow::bail!("Vault 路径不存在: {}", path.display());
        }
        if !path.is_dir() {
            anyhow::bail!("Vault 路径不是目录: {}", path.display());
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Vault")
            .to_string();
        let index = Index::open(&path).context("打开 SQLite 索引失败")?;
        // 索引为空：触发全量重建
        let count = index.count_notes().context("读取索引计数失败")?;
        if count == 0 {
            let vault = Self {
                path: path.clone(),
                name: name.clone(),
                index: Arc::new(index),
            };
            vault.reindex_all().context("首次打开 Vault 全量建索引失败")?;
            return Ok(vault);
        }
        Ok(Self {
            path,
            name,
            index: Arc::new(index),
        })
    }

    /// 创建一个新的 Vault（目录可不存在，会递归创建）并初始化空索引。
    pub fn create(path: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&path)
            .with_context(|| format!("无法创建 Vault 目录: {}", path.display()))?;
        // 复用 open：首次会自动 reindex（空目录 → 空索引，无副作用）
        Self::open(path)
    }

    /// 解析并校验 Vault 内的相对路径。
    ///
    /// 拒绝：
    ///   - 绝对路径
    ///   - 包含 `..` 段
    ///   - 解析后跳到 Vault 之外的最终路径
    pub fn resolve(&self, rel_path: &str) -> Result<PathBuf> {
        let rel = Path::new(rel_path);
        if rel.is_absolute() {
            anyhow::bail!("相对路径禁止为绝对路径: {rel_path}");
        }
        for comp in rel.components() {
            use std::path::Component;
            if matches!(comp, Component::ParentDir) {
                anyhow::bail!("相对路径禁止包含 '..': {rel_path}");
            }
        }
        let full = self.path.join(rel);
        let canon_root = self
            .path
            .canonicalize()
            .with_context(|| format!("无法规范化 Vault 根: {}", self.path.display()))?;
        // 文件可能尚未存在，canonicalize 父目录
        let probe = if full.exists() {
            full.canonicalize()?
        } else {
            full.parent()
                .unwrap_or(&canon_root)
                .canonicalize()?
                .join(full.file_name().unwrap_or_else(|| std::ffi::OsStr::new("")))
        };
        if !probe.starts_with(&canon_root) {
            anyhow::bail!("路径逃出 Vault 根: {rel_path}");
        }
        Ok(probe)
    }

    /// 递归扫描 Vault 下所有 `.md` 文件，跳过 `.notego/`。
    pub fn list_notes(&self) -> Result<Vec<NoteRecord>> {
        let mut out = Vec::new();
        let root = self.path.clone();
        for entry in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                // 跳过 .notego 整棵子树
                let name = e.file_name().to_string_lossy();
                !(e.depth() > 0 && (name == NOTEGO_DIR || name.starts_with('.')))
            })
        {
            let entry = entry.with_context(|| "遍历 Vault 失败".to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            if entry.path().extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            match build_record(&root, entry.path()) {
                Ok(r) => out.push(r),
                Err(e) => tracing::warn!("跳过笔记 {}: {e}", entry.path().display()),
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// 读取单个笔记内容（UTF-8 文本）。
    pub async fn read_note(&self, rel_path: &str) -> Result<String> {
        let full = self.resolve(rel_path)?;
        tokio::fs::read_to_string(&full)
            .await
            .with_context(|| format!("读取笔记失败: {}", full.display()))
    }

    /// 写入笔记（原子：tempfile + rename），同时刷新索引。
    pub async fn write_note(&self, rel_path: &str, content: &str) -> Result<()> {
        self.write_note_inner(rel_path, content).await?;
        // 写盘后立即同步索引
        if let Err(e) = self.reindex_note(rel_path) {
            tracing::warn!("更新索引失败（write_note）: {e}");
        }
        Ok(())
    }

    /// 写文件的内部实现（不触发索引更新），便于 `rename_note` 等复合操作复用。
    async fn write_note_inner(&self, rel_path: &str, content: &str) -> Result<()> {
        let full = self.resolve(rel_path)?;
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await.with_context(|| {
                format!("无法创建父目录: {}", parent.display())
            })?;
        }
        // 同步创建临时文件以拿到路径，再异步写入
        let parent = full
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| self.path.clone());
        let tmp = NamedTempFile::new_in(&parent)
            .with_context(|| format!("创建临时文件失败: {}", parent.display()))?;
        let tmp_path = tmp.path().to_path_buf();
        {
            let mut f = tokio::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&tmp_path)
                .await
                .with_context(|| format!("打开临时文件失败: {}", tmp_path.display()))?;
            f.write_all(content.as_bytes()).await?;
            f.flush().await?;
            f.sync_all().await?;
        }
        // 保留 NamedTempFile 直到 rename 成功
        tmp.persist(&full)
            .map_err(|e| anyhow::anyhow!("原子写入失败: {e}"))?;
        Ok(())
    }

    /// 创建一个新笔记（不存在则创建空内容，存在则报错），并写入索引。
    pub fn create_note(&self, rel_path: &str, title: Option<&str>) -> Result<NoteRecord> {
        let full = self.resolve(rel_path)?;
        if full.exists() {
            anyhow::bail!("笔记已存在: {rel_path}");
        }
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let title = title
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                full.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Untitled")
                    .to_string()
            });
        let content = format!("# {title}\n\n");
        std::fs::write(&full, &content)?;
        let rec = build_record(&self.path, &full)?;
        // 同步索引
        if let Err(e) = self.reindex_note(&rec.path) {
            tracing::warn!("更新索引失败（create_note）: {e}");
        }
        Ok(rec)
    }

    /// 删除笔记（文件不存在时忽略），并清理索引。
    pub async fn delete_note(&self, rel_path: &str) -> Result<()> {
        let full = self.resolve(rel_path)?;
        match tokio::fs::remove_file(&full).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("删除笔记失败: {}", full.display())),
        }
        if let Err(e) = self.index.remove_note_by_path(rel_path) {
            tracing::warn!("清理索引失败（delete_note）: {e}");
        }
        Ok(())
    }

    /// 重命名 / 移动笔记（不可跨出 Vault 根），并同步更新索引与反向链接引用。
    ///
    /// 索引侧：
    ///   1. [`Index::rename_note`] 更新 `notes.path`
    ///   2. [`Index::resolve_link_targets`] 批量替换所有 `links.to_path` 中
    ///      `old_rel` → `new_rel`（让"指向被改名笔记"的反向链接仍能命中）
    ///
    /// 文本侧（TODO，未实现）：扫描所有笔记正文，把 `[[old]]` 替换为 `[[new]]` 并写回。
    /// 成本较高（需遍历全库），留作后续 Task。
    pub async fn rename_note(&self, old_rel: &str, new_rel: &str) -> Result<()> {
        let old = self.resolve(old_rel)?;
        let new = self.resolve(new_rel)?;
        if !old.exists() {
            anyhow::bail!("源笔记不存在: {old_rel}");
        }
        if let Some(parent) = new.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(&old, &new)
            .await
            .with_context(|| format!("重命名失败: {} -> {}", old.display(), new.display()))?;
        // 同步索引：先更新自身 path，再批量更新指向该路径的 links.to_path
        if let Err(e) = self.index.rename_note(old_rel, new_rel) {
            tracing::warn!("更新索引失败（rename_note notes）: {e}");
        }
        if let Err(e) = self.index.resolve_link_targets(old_rel, new_rel) {
            tracing::warn!("更新 links 引用失败（rename_note）: {e}");
        }
        // TODO (Task 4.6 后续增强): 扫描所有笔记 body，把 [[old]] 替换为 [[new]] 并写回。
        Ok(())
    }

    // ---- 索引辅助 ---------------------------------------------------------

    /// 全量重建索引：扫描所有 `.md`，逐条 `upsert_note` + `set_tags`/`set_links`。
    ///
    /// 供 `open` 时使用，也可由前端 `rebuild_index` 命令触发。
    ///
    /// 流程：先 `rebuild` 批量插入 notes 行；随后用 [`parser::parse`]
    /// 解析每篇正文，把标签 / 出链回填到 `tags` / `links` 表。
    pub fn reindex_all(&self) -> Result<()> {
        let notes = self.list_notes()?;
        let mut files: Vec<(i64, String, String, i64, i64, String, String)> =
            Vec::with_capacity(notes.len());
        for n in &notes {
            let full = self.resolve(&n.path)?;
            let body = std::fs::read_to_string(&full).unwrap_or_default();
            files.push((
                n.id,
                n.path.clone(),
                n.title.clone(),
                n.mtime,
                n.size,
                n.hash.clone(),
                body,
            ));
        }
        self.index.rebuild(&files)?;
        // 标签/出链：解析每篇正文后回填
        for n in &notes {
            // 重新读取 body（rebuild 已将 body 写入 notes 表，但 parser 需要原始文本）
            let full = self.resolve(&n.path)?;
            let body = std::fs::read_to_string(&full).unwrap_or_default();
            let parsed = match parser::parse(&body) {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("解析笔记失败（reindex_all）{}: {e}", n.path);
                    continue;
                }
            };
            if let Err(e) = self.index.set_tags(n.id, &parsed.tags) {
                tracing::warn!("回填 tags 失败: {e}");
            }
            let link_rows: Vec<(String, String, i64)> = parsed
                .links
                .iter()
                .map(|l| (l.target.clone(), l.raw.clone(), l.line as i64))
                .collect();
            if let Err(e) = self.index.set_links(n.id, &link_rows) {
                tracing::warn!("回填 links 失败: {e}");
            }
        }
        Ok(())
    }

    /// 增量索引单条笔记（读盘后 upsert，并回填 tags / links）。
    pub fn reindex_note(&self, rel_path: &str) -> Result<()> {
        let full = self.resolve(rel_path)?;
        if !full.exists() {
            // 文件已被删除：清理索引
            self.index.remove_note_by_path(rel_path)?;
            return Ok(());
        }
        let rec = build_record(&self.path, &full)?;
        let body = std::fs::read_to_string(&full).unwrap_or_default();
        self.index
            .upsert_note(rec.id, &rec.path, &rec.title, rec.mtime, rec.size, &rec.hash, &body)?;
        // 解析后回填 tags / links
        let parsed = match parser::parse(&body) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("解析笔记失败（reindex_note）{rel_path}: {e}");
                return Ok(());
            }
        };
        self.index.set_tags(rec.id, &parsed.tags)?;
        let link_rows: Vec<(String, String, i64)> = parsed
            .links
            .iter()
            .map(|l| (l.target.clone(), l.raw.clone(), l.line as i64))
            .collect();
        self.index.set_links(rec.id, &link_rows)?;
        Ok(())
    }
}

/// 笔记元数据（不含正文，供前端列表 / 文件树渲染）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRecord {
    /// 稳定 ID：使用文件路径 SHA-256 前 8 字节 -> i64
    pub id: i64,
    /// 相对 Vault 根的 POSIX 路径
    pub path: String,
    /// 笔记标题（默认 = 文件名去后缀）
    pub title: String,
    /// 最后修改时间（Unix 毫秒）
    pub mtime: i64,
    /// 字节数
    pub size: i64,
    /// 内容 SHA-256（hex），用于脏检查
    pub hash: String,
}

/// 从文件元数据构造 `NoteRecord`（读 mtime / size / content hash）。
pub(crate) fn build_record(root: &Path, full: &Path) -> Result<NoteRecord> {
    let meta = std::fs::metadata(full)
        .with_context(|| format!("读取元数据失败: {}", full.display()))?;
    let rel = full
        .strip_prefix(root)
        .unwrap_or(full)
        .to_string_lossy()
        .replace('\\', "/");
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(|| Utc::now().timestamp_millis());
    let size = meta.len() as i64;
    let bytes = std::fs::read(full).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = hex::encode(hasher.finalize());
    // 稳定 ID：取 hash 前 8 字节 -> i64
    let id = i64::from_be_bytes(hash.as_bytes()[..8].try_into().unwrap_or([0; 8]));
    let title = full
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();
    Ok(NoteRecord {
        id,
        path: rel,
        title,
        mtime,
        size,
        hash,
    })
}
