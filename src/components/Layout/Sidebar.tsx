import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { ipc } from "../../lib/ipc";
import { vaultEvents } from "../../lib/events";
import type { NoteRecord, SearchHit } from "../../types/note";
import { TagTree, type TagItem } from "../Tags/TagTree";

/**
 * 左侧栏：Vault 名称 + 新建按钮 + 搜索 + 递归文件树 / 标签树
 *
 * - 搜索框防抖 200ms，调用 Rust 端 FTS5 全文搜索（标题 + 正文 + 标签）
 * - 搜索结果以下拉浮层展示，最多 20 条
 * - 文件树按路径段递归构建；目录节点可折叠
 * - 标签视图通过顶部的"标签"按钮切换，按 `/` 切分构建嵌套树
 * - 选中态高亮 + 监听 `vault://note` 实时刷新
 */
export function Sidebar(): JSX.Element {
  const vault = useAppStore((s) => s.vault);
  const notes = useAppStore((s) => s.notes);
  const activePath = useAppStore((s) => s.activePath);
  const setActivePath = useAppStore((s) => s.setActivePath);
  const setNotes = useAppStore((s) => s.setNotes);
  const removeNote = useAppStore((s) => s.removeNote);

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // 防抖后的搜索 query：空表示仅展示文件树
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // 搜索结果：FTS5 命中条目
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  // 视图模式：files（文件树）| tags（标签树）
  type View = "files" | "tags";
  const [view, setView] = useState<View>("files");
  // 标签列表（含 count）
  const [tagList, setTagList] = useState<TagItem[]>([]);
  // 标签抽屉是否展开（顶部小图标按钮触发）
  const [tagDrawerOpen, setTagDrawerOpen] = useState(false);

  // 防抖 200ms 触发搜索
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  // 搜索：调用 Rust 端 FTS5；命中时浮层
  useEffect(() => {
    if (!debouncedQuery) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    ipc
      .searchNotes(debouncedQuery)
      .then((hits) => {
        if (!cancelled) setSearchResults(hits.slice(0, 20));
      })
      .catch((err) => console.error("[Sidebar] search failed:", err))
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  // 初次进入时拉一次列表
  useEffect(() => {
    ipc.listNotes().then(setNotes).catch(console.error);
  }, [setNotes]);

  // 拉取标签列表（在 tags 视图激活时 + 抽屉打开时刷新）
  useEffect(() => {
    if (view !== "tags" && !tagDrawerOpen) return;
    let cancelled = false;
    ipc
      .listTags()
      .then((raw) => {
        if (cancelled) return;
        setTagList(raw.map((r) => ({ tag: r.name, count: r.count })));
      })
      .catch((err) => console.error("[Sidebar] listTags failed:", err));
    return () => {
      cancelled = true;
    };
  }, [view, tagDrawerOpen]);

  // 监听文件变化：created/modified/renamed → upsert；deleted → removeNote
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    vaultEvents
      .onNoteChanged((e) => {
        if (e.type === "deleted") {
          removeNote(e.path);
          return;
        }
        if (e.type === "created" || e.type === "modified") {
          // 单条拉取容易实现但要再调一次 list_notes；这里直接刷新
          ipc.listNotes().then(setNotes).catch(console.error);
        } else if (e.type === "renamed") {
          // 老路径直接移除，刷新整体获取新元数据
          removeNote(e.oldPath);
          ipc.listNotes().then(setNotes).catch(console.error);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, [setNotes, removeNote]);

  // 文件树：搜索激活时仅展示搜索结果前若干项的折叠列表，避免两套 UI 抢位置
  const filtered = useMemo<NoteRecord[]>(() => {
    if (!debouncedQuery) return notes;
    return notes;
  }, [notes, debouncedQuery]);

  // 构建文件树
  const tree = useMemo(() => buildTree(filtered), [filtered]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    const rel = name.endsWith(".md") ? name : `${name}.md`;
    try {
      const note = await ipc.createNote(rel, name.replace(/\.md$/, ""));
      setActivePath(note.path);
      const list = await ipc.listNotes();
      setNotes(list);
    } catch (err) {
      console.error("[Sidebar] createNote failed:", err);
      alert(`创建失败: ${err}`);
    } finally {
      setNewName("");
      setCreating(false);
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__vault" title={vault?.path}>
          {vault?.name ?? "Vault"}
        </span>
        {/* 标签入口图标按钮 */}
        <button
          className={
            "sidebar__action sidebar__action--tag" +
            (view === "tags" ? " sidebar__action--active" : "")
          }
          onClick={() => {
            setView(view === "tags" ? "files" : "tags");
            setTagDrawerOpen(true);
          }}
          title={view === "tags" ? "切换到文件树" : "查看标签"}
          aria-label="标签"
        >
          🏷️
        </button>
        <button
          className="sidebar__action"
          onClick={() => setCreating(true)}
          title="新建笔记"
          aria-label="新建笔记"
        >
          +
        </button>
      </div>

      {/* tab 切换条（仅在 tag 抽屉展开后常驻显示） */}
      {tagDrawerOpen && (
        <div className="sidebar__tabs">
          <button
            className={
              "sidebar__tab" + (view === "files" ? " sidebar__tab--active" : "")
            }
            onClick={() => setView("files")}
          >
            文件
          </button>
          <button
            className={
              "sidebar__tab" + (view === "tags" ? " sidebar__tab--active" : "")
            }
            onClick={() => setView("tags")}
          >
            标签
          </button>
          <button
            className="sidebar__tab sidebar__tab--close"
            onClick={() => setTagDrawerOpen(false)}
            title="关闭抽屉"
          >
            ×
          </button>
        </div>
      )}

      <div className="sidebar__search">
        <input
          type="search"
          className="sidebar__search-input"
          placeholder="搜索笔记…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* 搜索浮层：FTS5 命中 */}
        {debouncedQuery && (
          <div className="sidebar__search-results">
            {searching ? (
              <p className="sidebar__search-empty">搜索中…</p>
            ) : searchResults.length === 0 ? (
              <p className="sidebar__search-empty">无匹配结果</p>
            ) : (
              <ul className="sidebar__search-list">
                {searchResults.map((hit) => (
                  <li
                    key={hit.path}
                    className="sidebar__search-item"
                    onClick={() => {
                      setActivePath(hit.path);
                      setQuery("");
                    }}
                    title={hit.path}
                  >
                    <div className="sidebar__search-item-title">
                      {hit.title || hit.path}
                    </div>
                    {hit.snippet && (
                      <div
                        className="sidebar__search-item-snippet"
                        // FTS5 高亮标记 `\u0001` / `\u0002` 转为 <mark>
                        dangerouslySetInnerHTML={{
                          __html: highlightFtsSnippet(hit.snippet),
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {creating && (
        <div className="sidebar__create">
          <input
            autoFocus
            type="text"
            placeholder="文件名（可省 .md）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
              if (e.key === "Escape") {
                setCreating(false);
                setNewName("");
              }
            }}
          />
        </div>
      )}

      {/* 搜索激活时隐藏主体内容，避免视觉冗余 */}
      {!debouncedQuery && (
        <div className="sidebar__body">
          {view === "files" ? (
            <div className="sidebar__tree">
              {tree.length === 0 ? (
                <p className="sidebar__empty">暂无笔记，点击 + 创建</p>
              ) : (
                tree.map((node) => (
                  <TreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    activePath={activePath}
                    onSelect={setActivePath}
                  />
                ))
              )}
            </div>
          ) : (
            <div className="sidebar__tags">
              <TagTree tags={tagList} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 将 FTS5 snippet 中 `\u0001...\u0002` 高亮标记替换为 `<mark>` 标签。
 * 转义：`<` / `>` / `&` / `"` 需 HTML 转义以防 XSS（snippet 来自用户笔记正文）。
 */
function highlightFtsSnippet(s: string): string {
  const escape = (raw: string): string =>
    raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  // FTS5 `snippet()` 第三个参数为开始标记，第四个为结束标记。
  // Rust 端使用 `X'01'` / `X'02'` (即 U+0001 / U+0002) 作为标记。
  const START = String.fromCharCode(1);
  const END = String.fromCharCode(2);
  let out = "";
  let buf = "";
  for (const ch of s) {
    if (ch === START) {
      out += escape(buf);
      buf = "";
      out += "<mark>";
    } else if (ch === END) {
      out += escape(buf);
      buf = "";
      out += "</mark>";
    } else {
      buf += ch;
    }
  }
  out += escape(buf);
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                文件树节点                                  */
/* -------------------------------------------------------------------------- */

interface TreeNodeModel {
  /** 节点名（最后一段） */
  name: string;
  /** 完整路径；目录节点以 `/` 结尾 */
  path: string;
  /** true = 目录；false = 文件 */
  isDir: boolean;
  /** 笔记元数据（仅文件） */
  note?: NoteRecord;
  /** 子节点 */
  children: TreeNodeModel[];
}

function buildTree(notes: NoteRecord[]): TreeNodeModel[] {
  const root: TreeNodeModel = {
    name: "",
    path: "",
    isDir: true,
    children: [],
  };
  for (const n of notes) {
    const segments = n.path.split("/");
    let cur = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      let next = cur.children.find(
        (c) => c.name === seg && c.isDir === !isLast
      );
      if (!next) {
        next = {
          name: seg,
          path: segments.slice(0, i + 1).join("/"),
          isDir: !isLast,
          children: [],
          note: isLast ? n : undefined,
        };
        cur.children.push(next);
      }
      cur = next;
    }
  }
  // 排序：目录在前，文件在后，各自按字典序
  const sortRec = (nodes: TreeNodeModel[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(root.children);
  return root.children;
}

interface TreeNodeProps {
  node: TreeNodeModel;
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void;
}

function TreeNode({
  node,
  depth,
  activePath,
  onSelect,
}: TreeNodeProps): JSX.Element {
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  if (node.isDir) {
    return (
      <div className="tree-node tree-node--dir">
        <div
          className="tree-node__row"
          style={indent}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tree-node__caret">{open ? "▾" : "▸"}</span>
          <span className="tree-node__icon">📁</span>
          <span className="tree-node__name">{node.name}</span>
        </div>
        {open && (
          <div className="tree-node__children">
            {node.children.map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                activePath={activePath}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isActive = activePath === node.path;
  return (
    <div
      className={
        "tree-node tree-node--file" + (isActive ? " tree-node--active" : "")
      }
      style={indent}
      onClick={() => onSelect(node.path)}
    >
      <span className="tree-node__caret">·</span>
      <span className="tree-node__icon">📄</span>
      <span className="tree-node__name">{node.note?.title ?? node.name}</span>
    </div>
  );
}
