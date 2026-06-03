/**
 * Note / Vault / Tag 数据模型
 *
 * 与 Rust 端 `src-tauri/src/fs.rs` 中序列化的结构保持一致。
 *
 * 注意：Rust 端笔记元数据使用 `id / path / title / mtime / size / hash`
 *      （不含正文），因此本文件不再维护 `content` / `tags` / `links` 字段；
 *      编辑器按需通过 `readNote` 拉取原始 Markdown。
 */

/** 笔记元数据（与 Rust `NoteRecord` 镜像） */
export interface NoteRecord {
  /** 稳定 ID：取自文件路径 SHA-256 前 8 字节 */
  id: number;
  /** 相对 Vault 根的 POSIX 路径，例如 "daily/2024-01-01.md" */
  path: string;
  /** 笔记标题（默认 = 文件名去后缀） */
  title: string;
  /** 最后修改时间（Unix 毫秒） */
  mtime: number;
  /** 字节数 */
  size: number;
  /** 内容 SHA-256（hex），用于脏检查 */
  hash: string;
}

/** Vault（笔记库） */
export interface Vault {
  /** Vault 根目录的绝对路径 */
  path: string;
  /** Vault 显示名（默认取目录名） */
  name: string;
}

/**
 * 标签信息：标签名 + 引用此标签的笔记数。
 *
 * 与 Rust 端 `Index::all_tags` 返回的 `(String, i64)` 对应。
 */
export interface TagInfo {
  /** 标签名（不含 `#`） */
  name: string;
  /** 引用此标签的笔记数 */
  count: number;
}

/**
 * 反向链接条目：指向当前笔记的源笔记元数据 + 行号 + 上下文片段。
 *
 * 与 Rust 端 `index::BacklinkRow` 镜像。
 */
export interface BacklinkRow {
  /** 引用了当前笔记的源笔记相对路径 */
  fromPath: string;
  /** 源笔记标题 */
  fromTitle: string;
  /** 命中行号（1-based） */
  line: number;
  /** 命中行附近上下文（不含 `[[ ]]` 包裹） */
  snippet: string;
}

/**
 * 全文搜索结果。
 *
 * 与 Rust 端 `index::SearchHit` 镜像。
 * `snippet` 含 FTS5 高亮标记：`\u0001` 开始、`\u0002` 结束，
 * 前端应将其替换为 `<mark>` 标签或自行渲染。
 */
export interface SearchHit {
  /** 命中笔记 ID */
  id: number;
  /** 命中笔记相对路径 */
  path: string;
  /** 命中笔记标题 */
  title: string;
  /** 含 FTS5 高亮标记（`\u0001` / `\u0002`）的命中片段 */
  snippet: string;
  /** FTS5 排序分（越小越相关） */
  rank: number;
}

/** 反向链接（前端 UI 友好类型，保留兼容旧组件） */
export interface Backlink {
  /** 引用了当前笔记的源笔记 */
  source: NoteRecord;
  /** 命中行号（1-based） */
  line: number;
  /** 匹配到的上下文片段（前后若干字符） */
  context: string;
}

/**
 * 双向链接条目（解析自 `[[xxx]]` / `[[xxx#h]]` / `[[xxx|alias]]`）。
 *
 * 与 Rust 端 `parser::WikiLink` 镜像；本任务暂未在 IPC 中批量返回，
 * 留待编辑器扩展（CodeMirror decoration）时使用。
 */
export interface WikiLink {
  /** 原始 `[[...]]` 文本（含括号） */
  raw: string;
  /** 解析后的目标（标题或路径） */
  target: string;
  /** `|alias` 部分 */
  alias: string | null;
  /** `#heading` 锚点 */
  heading: string | null;
  /** 出现行号（1-based） */
  line: number;
  /** 所在行内容（snippet） */
  context: string;
}

/**
 * 未解决的双向链接：`to_path` 在索引 `notes.path` 中找不到。
 *
 * 与 Rust 端 `index::UnresolvedLinkRow` 镜像。
 */
export interface UnresolvedLink {
  /** 引用了不存在目标的源笔记相对路径 */
  fromPath: string;
  /** 原始 `[[...]]` 文本 */
  toText: string;
  /** 命中行号 */
  line: number;
}
