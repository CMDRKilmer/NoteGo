//! SQLite 索引模块
//!
//! 维护笔记库内的元数据 / 标签 / 反向链接 / 全文搜索索引。
//!
//! **数据流**：
//!   - `Vault::open` / `Vault::create` 启动时调用 [`Index::open`] 打开 `<vault>/.notego/index.sqlite`
//!   - 全量重建 [`Index::rebuild`] 在首次创建 / 索引丢失时执行
//!   - 增量更新通过 [`Index::upsert_note`] / [`Index::remove_note`] / [`Index::rename_note`]
//!   - 标签 / 出链由调用方（Task 4 parser）解析后通过 [`Index::set_tags`] / [`Index::set_links`] 写入
//!
//! **并发**：内部 `Mutex<Connection>` 串行化所有读写，调用方拿到的 `&Index` 即可
//! 跨线程共享（Tauri command 内部直接 lock）。
//!
//! **FTS5**：使用 managed 模式（无 `content='notes'`），便于在 `set_tags` 中
//! 直接 `UPDATE notes_fts` 维护 `tags` 列；标签 / 标题 / 正文共同参与全文搜索
//! （`tokenize = "unicode61 remove_diacritics 2"`）。

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

use crate::fs::NOTEGO_DIR;

/// Vault 内索引文件相对路径：`<vault>/.notego/index.sqlite`。
const INDEX_FILE: &str = "index.sqlite";

/// 单批 commit 的笔记数量（避免长事务占用锁）。
const BATCH_SIZE: usize = 1000;

/// 笔记索引器：内部持有 SQLite 连接，外部加锁串行访问。
#[derive(Debug)]
pub struct Index {
    conn: Mutex<Connection>,
}

/// 反向链接查询结果行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacklinkRow {
    /// 引用了当前笔记的源笔记相对路径
    pub from_path: String,
    /// 源笔记标题
    pub from_title: String,
    /// 命中行号
    pub line: i64,
    /// 命中行附近 1 行上下文（不含 `[[ ]]` 包裹）
    pub snippet: String,
}

/// 全文搜索结果行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    /// 命中笔记 ID
    pub id: i64,
    /// 命中笔记相对路径
    pub path: String,
    /// 命中笔记标题
    pub title: String,
    /// 含 FTS5 高亮标记（`\u{0001}` / `\u{0002}`）的命中片段
    pub snippet: String,
    /// FTS5 排序分（越小越相关）
    pub rank: f64,
}

/// 未解决的双向链接条目：`to_path` 不在 `notes.path` 集合内。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnresolvedLinkRow {
    /// 引用了不存在的目标笔记的源笔记相对路径
    pub from_path: String,
    /// 原始 `[[...]]` 文本
    pub to_text: String,
    /// 命中行号
    pub line: i64,
}

impl Index {
    /// 打开或创建索引文件 `<vault>/.notego/index.sqlite`，并执行迁移。
    ///
    /// 父目录 `.notego/` 不存在则会自动创建。
    pub fn open(vault_path: &Path) -> Result<Self> {
        let dir = vault_path.join(NOTEGO_DIR);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("无法创建索引目录: {}", dir.display()))?;
        let db_path = dir.join(INDEX_FILE);
        let conn = Connection::open(&db_path)
            .with_context(|| format!("打开索引数据库失败: {}", db_path.display()))?;
        let idx = Self {
            conn: Mutex::new(conn),
        };
        idx.migrate().context("索引迁移失败")?;
        Ok(idx)
    }

    /// 初始化 / 升级表结构（当前仅 v1，无版本号检查）。
    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().expect("index 锁中毒");
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS notes (
                id          INTEGER PRIMARY KEY,
                path        TEXT NOT NULL UNIQUE,
                title       TEXT NOT NULL,
                mtime       INTEGER NOT NULL,
                size        INTEGER NOT NULL,
                hash        TEXT NOT NULL,
                body        TEXT NOT NULL,
                indexed_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title);
            CREATE INDEX IF NOT EXISTS idx_notes_mtime ON notes(mtime DESC);

            CREATE TABLE IF NOT EXISTS tags (
                note_id  INTEGER NOT NULL,
                tag      TEXT NOT NULL,
                PRIMARY KEY (note_id, tag),
                FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

            CREATE TABLE IF NOT EXISTS links (
                from_id   INTEGER NOT NULL,
                to_path   TEXT NOT NULL,
                to_text   TEXT NOT NULL,
                line      INTEGER NOT NULL,
                PRIMARY KEY (from_id, to_path, line),
                FOREIGN KEY (from_id) REFERENCES notes(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_path);
            CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id);

            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- FTS5 全文搜索虚拟表（managed 模式，便于在 set_tags 中直接更新 tags 列）
            CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
                title,
                body,
                tags,
                tokenize = "unicode61 remove_diacritics 2"
            );

            -- 同步触发器：notes 行变化时同步维护 FTS 索引（tags 列留空，由 set_tags 回填）
            CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
                INSERT INTO notes_fts(rowid, title, body, tags)
                VALUES (new.id, new.title, new.body, '');
            END;
            CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
                DELETE FROM notes_fts WHERE rowid = old.id;
            END;
            CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
                DELETE FROM notes_fts WHERE rowid = old.id;
                INSERT INTO notes_fts(rowid, title, body, tags)
                VALUES (new.id, new.title, new.body, '');
            END;
            "#,
        )
        .context("建表 SQL 失败")?;
        Ok(())
    }

    /// 全量重建：清空 `notes` 及其衍生表后按给定文件列表重新插入。
    ///
    /// 性能：
    ///   - 分批事务：每 [`BATCH_SIZE`] 条 commit 一次，避免长事务占用锁
    ///   - 使用 `INSERT OR REPLACE` 简化 upsert
    ///
    /// 入参 `files` 元素：`(id, path, title, mtime, size, hash, body)`，其中
    /// `id` 与 `hash` 来自 `crate::fs::build_record`（内容 SHA-256 前 8 字节 -> i64）。
    #[allow(clippy::type_complexity)]
    pub fn rebuild(
        &self,
        files: &[(i64, String, String, i64, i64, String, String)],
    ) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut conn = self.conn.lock().expect("index 锁中毒");
        // 1. 清空（独立事务）
        {
            let tx = conn.transaction()?;
            tx.execute_batch(
                "DELETE FROM tags; DELETE FROM links; DELETE FROM notes;",
            )
            .context("清空旧索引失败")?;
            tx.commit()?;
        }
        // 2. 分批插入
        let total = files.len();
        let mut start = 0usize;
        while start < total {
            let end = (start + BATCH_SIZE).min(total);
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare(
                    "INSERT OR REPLACE INTO notes (id, path, title, mtime, size, hash, body, indexed_at)\
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )?;
                for (id, path, title, mtime, size, hash, body) in &files[start..end] {
                    stmt.execute(params![id, path, title, mtime, size, hash, body, now])?;
                }
            }
            tx.commit()
                .with_context(|| format!("提交索引批次 {start}..{end} 失败"))?;
            start = end;
        }
        Ok(())
    }

    /// 增量更新单篇笔记。已存在则覆盖（路径/ID 冲突时 REPLACE）。
    pub fn upsert_note(
        &self,
        id: i64,
        path: &str,
        title: &str,
        mtime: i64,
        size: i64,
        hash: &str,
        body: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("index 锁中毒");
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT OR REPLACE INTO notes (id, path, title, mtime, size, hash, body, indexed_at)\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, path, title, mtime, size, hash, body, now],
        )
        .with_context(|| format!("upsert_note 失败: {path}"))?;
        Ok(())
    }

    /// 按 ID 删除笔记（级联清理 `tags` / `links`）。
    pub fn remove_note(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().expect("index 锁中毒");
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
            .with_context(|| format!("remove_note 失败: {id}"))?;
        Ok(())
    }

    /// 按路径删除笔记（供未持有 ID 的场景使用）。
    pub fn remove_note_by_path(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().expect("index 锁中毒");
        conn.execute("DELETE FROM notes WHERE path = ?1", params![path])
            .with_context(|| format!("remove_note_by_path 失败: {path}"))?;
        Ok(())
    }

    /// 重命名 / 移动笔记。同步更新 `notes.path` 与指向该路径的所有 `links.to_path`。
    ///
    /// 注意：ID 来自文件内容 SHA-256，重命名不修改内容 → 主键保持不变。
    pub fn rename_note(&self, old_path: &str, new_path: &str) -> Result<()> {
        let mut conn = self.conn.lock().expect("index 锁中毒");
        let tx = conn.transaction()?;
        // 1. 若目标路径已存在另一条记录，先删掉（极小概率：用户将不同文件改名到同一目标）
        tx.execute("DELETE FROM notes WHERE path = ?1", params![new_path])?;
        // 2. 更新自身 path
        tx.execute(
            "UPDATE notes SET path = ?1, indexed_at = ?2 WHERE path = ?3",
            params![new_path, chrono::Utc::now().timestamp_millis(), old_path],
        )?;
        // 3. 同步更新其它笔记指向该路径的出链
        tx.execute(
            "UPDATE links SET to_path = ?1 WHERE to_path = ?2",
            params![new_path, old_path],
        )?;
        tx.commit().context("rename_note 提交失败")?;
        Ok(())
    }

    /// 设置某笔记的全部标签（先清空再批量插入，单事务）。
    pub fn set_tags(&self, note_id: i64, tags: &[String]) -> Result<()> {
        let mut conn = self.conn.lock().expect("index 锁中毒");
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM tags WHERE note_id = ?1", params![note_id])?;
        {
            let mut stmt =
                tx.prepare("INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?1, ?2)")?;
            for tag in tags {
                stmt.execute(params![note_id, tag])?;
            }
        }
        // FTS 的 tags 列：直接由入参拼接后 UPDATE。set_tags 在
        // upsert_note 之后调用，notes_fts 行已存在；这里就地改 tags 列。
        let joined: String = tags
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        tx.execute(
            "UPDATE notes_fts SET tags = ?1 WHERE rowid = ?2",
            params![joined, note_id],
        )?;
        tx.commit().context("set_tags 提交失败")?;
        Ok(())
    }

    /// 设置某笔记的全部出链（`(to_path, to_text, line)`）。
    pub fn set_links(&self, from_id: i64, links: &[(String, String, i64)]) -> Result<()> {
        let mut conn = self.conn.lock().expect("index 锁中毒");
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM links WHERE from_id = ?1", params![from_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO links (from_id, to_path, to_text, line)\
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (to_path, to_text, line) in links {
                stmt.execute(params![from_id, to_path, to_text, line])?;
            }
        }
        tx.commit().context("set_links 提交失败")?;
        Ok(())
    }

    /// 反向链接查询：返回所有"指向 `to_path`"的源笔记条目。
    pub fn get_backlinks(&self, to_path: &str) -> Result<Vec<BacklinkRow>> {
        let conn = self.conn.lock().expect("index 锁中毒");
        let mut stmt = conn.prepare(
            "SELECT n.path, n.title, l.line, n.body\
             FROM links l JOIN notes n ON n.id = l.from_id\
             WHERE l.to_path = ?1\
             ORDER BY n.path, l.line",
        )?;
        let mut rows = stmt.query(params![to_path])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let from_path: String = row.get(0)?;
            let from_title: String = row.get(1)?;
            let line: i64 = row.get(2)?;
            let body: String = row.get(3).unwrap_or_default();
            let snippet = extract_line_snippet(&body, line);
            out.push(BacklinkRow {
                from_path,
                from_title,
                line,
                snippet,
            });
        }
        Ok(out)
    }

    /// 重命名后批量更新所有 `links.to_path` 引用。
    ///
    /// 返回受影响的行数。
    pub fn resolve_link_targets(&self, old_path: &str, new_path: &str) -> Result<usize> {
        let conn = self.conn.lock().expect("index 锁中毒");
        let n = conn
            .execute(
                "UPDATE links SET to_path = ?1 WHERE to_path = ?2",
                params![new_path, old_path],
            )
            .with_context(|| format!("resolve_link_targets 失败: {old_path} -> {new_path}"))?;
        Ok(n)
    }

    /// FTS5 全文搜索。`query` 使用 FTS5 语法（支持 `AND` / `OR` / `NEAR` / 前缀 `*`）。
    ///
    /// **安全**：用户输入会被包裹为 FTS5 phrase（`"..."`），内部 `"` 转义为 `""`，
    /// 控制字符过滤。这样 FTS5 总是把 query 视为字面量，不会因 `*` `:` `(` 等
    /// 触发语法解析错误，也不会被注入 `MATCH` 子句。
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().expect("index 锁中毒");
        let phrase = safe_fts5_phrase(q);
        // snippet 列号 -1 = 命中列自适应；标记符 X'01' / X'02' 供前端 `<mark>` 渲染
        // 使用 FTS5 内置 `rank` 列（升序 = 相关性高），兼容 SQLite 3.41+ 旧版 FTS5；
        // 若升级到 3.45+ 可改用 `bm25(notes_fts)` 以获得更精准的 BM25 排序。
        let sql = format!(
            "SELECT n.id, n.path, n.title, snippet(notes_fts, -1, X'01', X'02', '…', 12) AS snip,\
                    rank AS score\
             FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid\
             WHERE notes_fts MATCH ?1\
             ORDER BY score LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params![phrase, limit as i64])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(SearchHit {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                snippet: row.get(3)?,
                rank: row.get(4)?,
            });
        }
        Ok(out)
    }

    /// 按 tag 过滤：`tag` 与 `tags.tag` 完全匹配。
    pub fn notes_with_tag(&self, tag: &str) -> Result<Vec<(i64, String, String)>> {
        let conn = self.conn.lock().expect("index 锁中毒");
        let mut stmt = conn.prepare(
            "SELECT n.id, n.path, n.title FROM tags t\
             JOIN notes n ON n.id = t.note_id\
             WHERE t.tag = ?1 ORDER BY n.mtime DESC",
        )?;
        let rows = stmt
            .query_map(params![tag], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 全部不重复标签及其计数（按计数倒序）。
    pub fn all_tags(&self) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().expect("index 锁中毒");
        let mut stmt = conn.prepare(
            "SELECT tag, COUNT(*) AS c FROM tags GROUP BY tag ORDER BY c DESC, tag ASC",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 解析双向链接文本 → 在索引中查找最匹配的笔记相对路径。
    ///
    /// 匹配优先级：
    ///   1. 精确匹配 `notes.title`
    ///   2. 大小写不敏感匹配 `notes.title`
    ///   3. 在 `notes.path` 中模糊包含（`LIKE '%target%'`）
    ///
    /// 返回首个命中；`text` 允许带 `[[ ]]` / `#heading` / `|alias` 外壳。
    pub fn resolve_link(&self, text: &str) -> Result<Option<String>> {
        // 先用 parser 抽取 target（支持 `[[xxx]]` / `[[xxx#h]]` / `[[xxx|alias]]`）
        let target = crate::parser::extract_link_target(text);
        if target.is_empty() {
            return Ok(None);
        }
        let conn = self.conn.lock().expect("index 锁中毒");
        // 1) 精确 title
        if let Some(p) = conn
            .query_row(
                "SELECT path FROM notes WHERE title = ?1 LIMIT 1",
                rusqlite::params![target],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(Some(p));
        }
        // 2) 忽略大小写 title
        if let Some(p) = conn
            .query_row(
                "SELECT path FROM notes WHERE LOWER(title) = LOWER(?1) LIMIT 1",
                rusqlite::params![target],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(Some(p));
        }
        // 3) path 包含（LIKE 模式已用 ESCAPE '\\' 转义 `%` `_` `\`）
        let pattern = format!("%{}%", like_escape(target));
        if let Some(p) = conn
            .query_row(
                "SELECT path FROM notes WHERE path LIKE ?1 ESCAPE '\\' LIMIT 1",
                rusqlite::params![pattern],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(Some(p));
        }
        Ok(None)
    }

    /// 查询所有"未解决"的双向链接：`links.to_path` 不在 `notes.path` 中。
    pub fn unresolved_links(&self) -> Result<Vec<UnresolvedLinkRow>> {
        let conn = self.conn.lock().expect("index 锁中毒");
        let mut stmt = conn.prepare(
            "SELECT n.path, l.to_text, l.line\
             FROM links l LEFT JOIN notes n2 ON n2.path = l.to_path\
             JOIN notes n ON n.id = l.from_id\
             WHERE n2.id IS NULL\
             ORDER BY n.path, l.line",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(UnresolvedLinkRow {
                    from_path: r.get(0)?,
                    to_text: r.get(1)?,
                    line: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 笔记总数。
    pub fn count_notes(&self) -> Result<i64> {
        let conn = self.conn.lock().expect("index 锁中毒");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .optional()?
            .unwrap_or(0);
        Ok(n)
    }
}

/// 从 `body` 中提取第 `line` 行（1-based）作为 snippet。
///
/// 若该行超过 200 字符则截断为 `…xxx…`。
fn extract_line_snippet(body: &str, line: i64) -> String {
    let target = if line <= 0 { 1 } else { line } as usize;
    let current = body.split('\n').nth(target.saturating_sub(1));
    match current {
        Some(s) => {
            let trimmed = s.trim();
            if trimmed.chars().count() > 200 {
                let chars: String = trimmed.chars().take(200).collect();
                format!("{chars}…")
            } else {
                trimmed.to_string()
            }
        }
        None => String::new(),
    }
}

/// FTS5 安全短语：用户输入包成 `"..."`（phrase 语法），内部 `"` 替换为 `""`。
///
/// FTS5 在遇到带引号的 token 时会**整段当作字面量**解析，不再尝试语法分析：
///   - 不再识别 `AND` / `OR` / `NOT` / `NEAR` / `*` 等操作符
///   - 不再把 `:` `(` `)` `^` 等解释为列前缀或权值
///   - `"` 字符通过 `""` 转义（SQLite FTS5 字符串字面量规则）
///
/// 同时过滤 ASCII / Unicode 控制字符，防止 0x00 / 换行污染 MATCH 解析。
fn safe_fts5_phrase(q: &str) -> String {
    let cleaned: String = q.chars().filter(|c| !c.is_control()).collect();
    format!("\"{}\"", cleaned.replace('"', "\"\""))
}

/// LIKE 模式转义：转义 `\`（ESCAPE 字符本身）、`%`、`_` 三个特殊字符。
///
/// 调用方 SQL 必须使用 `LIKE ? ESCAPE '\'`，否则转义会被忽略。
fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts5_phrase_wraps_and_escapes() {
        assert_eq!(safe_fts5_phrase("hello"), "\"hello\"");
        assert_eq!(safe_fts5_phrase("a\"b"), "\"a\"\"b\"");
        assert_eq!(safe_fts5_phrase("a*b"), "\"a*b\"");
        assert_eq!(safe_fts5_phrase("a OR b"), "\"a OR b\"");
        // 控制字符被过滤
        assert_eq!(safe_fts5_phrase("a\nb\tc"), "\"abc\"");
    }

    #[test]
    fn like_escape_handles_specials() {
        assert_eq!(like_escape("plain"), "plain");
        assert_eq!(like_escape("a%b"), "a\\%b");
        assert_eq!(like_escape("a_b"), "a\\_b");
        assert_eq!(like_escape("a\\b"), "a\\\\b");
        assert_eq!(like_escape("a%_\\b"), "a\\%\\_\\\\b");
    }
}
