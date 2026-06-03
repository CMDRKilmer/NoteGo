import { useEffect, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { ipc } from "../../lib/ipc";
import { vaultEvents } from "../../lib/events";
import type { SearchHit } from "../../types/note";
import { TagTree, type TagItem } from "../Tags/TagTree";
import { SidebarHeader, type ViewMode } from "./SidebarHeader";
import { SidebarSearch } from "./SidebarSearch";
import { SidebarTree } from "./SidebarTree";

/**
 * 左侧栏容器：状态管理 + 子组件组合。
 *
 * 拆分为 4 个子文件后，本组件只负责：
 *   1. 持有跨子组件共享的 state（搜索 query、防抖、视图模式、标签列表）
 *   2. 副作用（拉取 notes、监听 vault://note 实时刷新）
 *   3. tabs 切换条
 *   4. 把数据下发给 SidebarHeader / SidebarSearch / SidebarTree
 *
 * 搜索：本地 200ms 防抖 → 调 Rust FTS5 → 浮层展示前 20 条
 * 文件树：直接基于 store.notes 渲染（M2.3 后增量事件也会刷新 store）
 * 标签树：tabs 切到 "tags" 或抽屉打开时才拉取一次
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
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState<ViewMode>("files");
  const [tagList, setTagList] = useState<TagItem[]>([]);
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

  // 拉取标签列表（tags 视图激活时 + 抽屉打开时刷新）
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

  // 监听文件变化：created/modified/renamed → 整列表刷新；deleted → removeNote
  // （M2.3 后事件 payload 已含 note 字段；此处为简化降级为整列表刷新，
  //  后续可改用 store.upsertNote(e.note) 增量更新。）
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    vaultEvents
      .onNoteChanged((e) => {
        if (e.type === "deleted") {
          removeNote(e.path);
          return;
        }
        if (e.type === "created" || e.type === "modified") {
          ipc.listNotes().then(setNotes).catch(console.error);
        } else if (e.type === "renamed") {
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
      <SidebarHeader
        vault={vault}
        view={view}
        onToggleTags={() => {
          setView(view === "tags" ? "files" : "tags");
          setTagDrawerOpen(true);
        }}
        onCreate={() => setCreating(true)}
      />

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

      <SidebarSearch
        query={query}
        onQueryChange={setQuery}
        debouncedQuery={debouncedQuery}
        searchResults={searchResults}
        searching={searching}
        onPick={(path) => {
          setActivePath(path);
          setQuery("");
        }}
      />

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

      {!debouncedQuery && (
        <div className="sidebar__body">
          {view === "files" ? (
            <SidebarTree
              notes={notes}
              activePath={activePath}
              onSelect={setActivePath}
            />
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
