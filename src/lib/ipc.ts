import { invoke } from '@tauri-apps/api/core';
import type { BacklinkRow, NoteRecord, SearchHit, TagInfo, UnresolvedLink, Vault } from '../types/note';

/**
 * Tauri IPC 封装层
 *
 * 所有前端 → Rust 的命令调用都通过本文件统一出口，命令名与
 * `src-tauri/src/commands.rs` 中 `#[tauri::command]` 函数名保持一致。
 *
 * Rust 端使用 snake_case 命令名 + snake_case 字段名；本文件提供 camelCase 别名。
 */

/** Rust 端 `(String, i64)` 元组序列化为 `[name, count]` 形式的元组。 */
type RustTagTuple = [string, number];

export const ipc = {
  /** 弹窗选择 / 创建 Vault 目录。取消返回 `null`。 */
  openVaultDialog: (): Promise<Vault | null> =>
    invoke<Vault | null>('open_vault_dialog'),

  /** 打开一个已存在的 Vault 目录。 */
  openVault: (path: string): Promise<Vault> =>
    invoke<Vault>('open_vault', { path }),

  /** 创建一个新的 Vault 目录（不存在则递归创建）。 */
  createVault: (path: string): Promise<Vault> =>
    invoke<Vault>('create_vault', { path }),

  /** 取当前已打开的 Vault；未设置返回 `null`。 */
  getCurrentVault: (): Promise<Vault | null> =>
    invoke<Vault | null>('get_current_vault'),

  /** 列出 Vault 内所有笔记元数据。 */
  listNotes: (): Promise<NoteRecord[]> =>
    invoke<NoteRecord[]>('list_notes'),

  /** 读取单个笔记的原始 Markdown 内容。 */
  readNote: (relPath: string): Promise<string> =>
    invoke<string>('read_note', { relPath }),

  /** 写入（覆盖）一个笔记。 */
  writeNote: (relPath: string, content: string): Promise<void> =>
    invoke<void>('write_note', { relPath, content }),

  /** 创建一个新笔记，返回新建后的元数据。 */
  createNote: (relPath: string, title?: string): Promise<NoteRecord> =>
    invoke<NoteRecord>('create_note', { relPath, title }),

  /** 删除一个笔记。 */
  deleteNote: (relPath: string): Promise<void> =>
    invoke<void>('delete_note', { relPath }),

  /** 重命名 / 移动一个笔记。 */
  renameNote: (oldRel: string, newRel: string): Promise<void> =>
    invoke<void>('rename_note', { oldRel, newRel }),

  /**
   * 获取某笔记（按相对路径）的反向链接列表。
   * @param relPath 目标笔记的相对路径，例如 "daily/2024-01-01.md"
   */
  getBacklinks: (relPath: string): Promise<BacklinkRow[]> =>
    invoke<BacklinkRow[]>('get_backlinks', { relPath }),

  /**
   * FTS5 全文搜索。最多返回 50 条结果，按相关性排序。
   * 支持 FTS5 语法：`AND` / `OR` / `NEAR` / 前缀 `*` 等。
   *
   * 若传入空字符串或纯空白，则 fallback 为 list_notes 并取前 50 条
   * （用于 CodeMirror `[[wiki]]` 补全源的初始候选）。
   */
  searchNotes: async (query: string): Promise<SearchHit[]> => {
    if (!query.trim()) {
      const notes = await invoke<NoteRecord[]>('list_notes');
      return notes.slice(0, 50).map((n) => ({
        id: n.id,
        path: n.path,
        title: n.title,
        snippet: '',
        rank: 0,
      }));
    }
    return invoke<SearchHit[]>('search_notes', { query });
  },

  /**
   * 全量重建索引。返回重建后的笔记总数。
   *
   * 典型使用场景：用户手动触发"重建索引"按钮 / 索引损坏修复。
   */
  rebuildIndex: (): Promise<number> =>
    invoke<number>('rebuild_index'),

  /**
   * 取所有不重复标签及其计数（按 count 倒序）。
   * Rust 端返回 `[name, count]` 元组数组，前端映射为 `TagInfo`。
   */
  listTags: async (): Promise<TagInfo[]> => {
    const raw = await invoke<RustTagTuple[]>('list_tags');
    return raw.map(([name, count]) => ({ name, count }));
  },

  /**
   * 按标签过滤：返回所有挂载该 tag 的笔记元数据。
   */
  notesWithTag: (tag: string): Promise<NoteRecord[]> =>
    invoke<NoteRecord[]>('notes_with_tag', { tag }),

  /**
   * 解析一段双向链接文本（可带 `[[ ]]` / `#heading` / `|alias`），在索引中
   * 查找最匹配的笔记相对路径。无匹配返回 `null`。
   *
   * 匹配优先级：精确 title → 忽略大小写 title → path 模糊包含。
   */
  resolveLink: (text: string): Promise<string | null> =>
    invoke<string | null>('resolve_link', { text }),

  /**
   * 查询所有"未解决"的双向链接：源笔记引用了不存在的目标。
   * 可用于"修复链接 / 列出断链"等 UI。
   */
  getUnresolvedLinks: (): Promise<UnresolvedLink[]> =>
    invoke<UnresolvedLink[]>('get_unresolved_links'),
};
