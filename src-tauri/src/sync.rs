//! S3 同步模块
//!
//! 将 Vault 内的 Markdown 文件 + 索引快照同步至 S3 兼容存储
//! （AWS S3 / Cloudflare R2 / MinIO / 阿里 OSS 等）。
//!
//! **当前状态**：占位。Task 8 将实现：
//!   - 基于 `aws-sdk-rust` 的多线程上传
//!   - ETag 对比实现增量同步
//!   - 冲突检测与解决策略

use anyhow::Result;
use std::path::Path;

/// 同步配置（由 `tauri-plugin-store` 持久化）。
#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
}

/// 执行一次同步（上传 / 下载）。返回受影响文件数。
pub async fn run_sync(_vault: &Path, _config: &SyncConfig) -> Result<usize> {
    Ok(0)
}
