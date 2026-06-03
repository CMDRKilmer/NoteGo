import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { ipc } from "../../lib/ipc";
import type { NoteRecord } from "../../types/note";

/**
 * 标签树面板
 *
 * - Props: `tags: Array<{ tag: string; count: number }>`
 * - 按 `/` 切分标签名构建嵌套树（例如 `daily/2024` → 根 daily → 子 2024）
 * - 叶子节点显示 count 徽标
 * - 点击叶子节点调 `ipc.notesWithTag(tag)`，把结果塞进 store（`setNotes`）
 *
 * 设计取舍：
 *   - 不引入额外 zustand slice，直接复用 `setNotes` —— 标签视图与文件树共享
 *     "当前笔记列表"这一槽位，避免拆分数据流
 *   - 默认全部展开；用户可在后续版本中持久化折叠状态
 */

export interface TagItem {
  /** 标签名（不含 `#`），可含 `/` 表示嵌套 */
  tag: string;
  /** 引用此标签的笔记数 */
  count: number;
}

export interface TagTreeProps {
  /** 标签列表（已去重 + 含 count） */
  tags: TagItem[];
  /** 选中标签时回调（用于通知 Sidebar 切换视图） */
  onSelect?: (tag: string, notes: NoteRecord[]) => void;
}

interface TreeNode {
  /** 节点名（路径的一段） */
  name: string;
  /** 完整路径前缀（含自身），如 `daily/2024` */
  fullPath: string;
  /** 子节点 */
  children: TreeNode[];
  /** 叶子节点上的 count；非叶为 0 */
  count: number;
  /** 是否叶子 */
  isLeaf: boolean;
}

export function TagTree({ tags, onSelect }: TagTreeProps): JSX.Element {
  const setActivePath = useAppStore((s) => s.setActivePath);
  const setNotes = useAppStore((s) => s.setNotes);
  const [loading, setLoading] = useState<string | null>(null);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  // 构建树
  const tree = useMemo(() => buildTagTree(tags), [tags]);

  // 初次进入默认全展开
  useEffect(() => {
    const initial: Record<string, boolean> = {};
    walk(tree, (n) => {
      initial[n.fullPath] = true;
    });
    setOpenMap((prev) => ({ ...initial, ...prev }));
  }, [tree]);

  const toggle = (path: string) => {
    setOpenMap((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const handleLeafClick = async (tag: string) => {
    if (loading) return;
    setLoading(tag);
    try {
      const list = await ipc.notesWithTag(tag);
      // 把标签命中的笔记注入 store，Sidebar 视图层会同时看到
      setNotes(list);
      if (list.length > 0) {
        setActivePath(list[0].path);
      }
      onSelect?.(tag, list);
    } catch (err) {
      console.error("[TagTree] notesWithTag failed:", err);
    } finally {
      setLoading(null);
    }
  };

  if (tags.length === 0) {
    return <p className="tag-tree__empty">暂无标签</p>;
  }

  return (
    <div className="tag-tree">
      {tree.map((node) => (
        <TagTreeNode
          key={node.fullPath}
          node={node}
          depth={0}
          openMap={openMap}
          onToggle={toggle}
          onLeafClick={handleLeafClick}
          loading={loading}
        />
      ))}
    </div>
  );
}

interface TagTreeNodeProps {
  node: TreeNode;
  depth: number;
  openMap: Record<string, boolean>;
  onToggle: (path: string) => void;
  onLeafClick: (tag: string) => Promise<void>;
  loading: string | null;
}

function TagTreeNode({
  node,
  depth,
  openMap,
  onToggle,
  onLeafClick,
  loading,
}: TagTreeNodeProps): JSX.Element {
  const indent = { paddingLeft: `${depth * 12 + 8}px` };
  const open = openMap[node.fullPath] ?? true;

  if (!node.isLeaf) {
    return (
      <div className="tag-tree__node tag-tree__node--dir">
        <div
          className="tag-tree__row"
          style={indent}
          onClick={() => onToggle(node.fullPath)}
        >
          <span className="tag-tree__caret">{open ? "▾" : "▸"}</span>
          <span className="tag-tree__icon">📂</span>
          <span className="tag-tree__name">{node.name}</span>
        </div>
        {open && (
          <div className="tag-tree__children">
            {node.children.map((c) => (
              <TagTreeNode
                key={c.fullPath}
                node={c}
                depth={depth + 1}
                openMap={openMap}
                onToggle={onToggle}
                onLeafClick={onLeafClick}
                loading={loading}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="tag-tree__node tag-tree__node--leaf">
      <div
        className="tag-tree__row"
        style={indent}
        onClick={() => void onLeafClick(node.fullPath)}
        title={`#${node.fullPath}`}
      >
        <span className="tag-tree__caret">·</span>
        <span className="tag-tree__icon">🏷️</span>
        <span className="tag-tree__name">{node.name}</span>
        <span className="tag-tree__count">
          {loading === node.fullPath ? "…" : node.count}
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  树构建                                   */
/* -------------------------------------------------------------------------- */

function buildTagTree(tags: TagItem[]): TreeNode[] {
  const root: TreeNode = {
    name: "",
    fullPath: "",
    children: [],
    count: 0,
    isLeaf: false,
  };
  for (const t of tags) {
    const segs = t.tag.split("/").filter((s) => s.length > 0);
    if (segs.length === 0) continue;
    let cur = root;
    let acc: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      acc.push(seg);
      const fullPath = acc.join("/");
      const isLast = i === segs.length - 1;
      let next = cur.children.find((c) => c.name === seg);
      if (!next) {
        next = {
          name: seg,
          fullPath,
          children: [],
          count: 0,
          isLeaf: isLast,
        };
        cur.children.push(next);
      } else if (isLast) {
        // 多源合并：即使该层已有子节点（其它标签延续到此），也保证是叶子
        next.isLeaf = true;
      }
      cur = next;
    }
    cur.count = t.count;
  }
  // 排序：目录在前，叶子在后
  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: TreeNode[]) {
  nodes.sort((a, b) => {
    if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  nodes.forEach((n) => sortTree(n.children));
}

function walk(nodes: TreeNode[], cb: (n: TreeNode) => void) {
  for (const n of nodes) {
    cb(n);
    if (n.children.length > 0) walk(n.children, cb);
  }
}
