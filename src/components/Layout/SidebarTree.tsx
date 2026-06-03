import { useMemo, useState } from "react";
import type { NoteRecord } from "../../types/note";

/**
 * 递归文件树渲染组件。
 *
 * 数据结构：把扁平 `NoteRecord[]` 按路径段构建成嵌套 `TreeNodeModel`：
 *   - 中间段 → 目录节点（`isDir = true`）
 *   - 末段 → 文件节点（携带 `NoteRecord`）
 * 排序：目录在前，文件在后，各自按字典序；递归处理。
 *
 * 选中态：`activePath === node.path` 高亮。
 * 折叠态：每个目录节点维护本地 `open` state，初始全展开。
 *
 * 设计要点：
 *   - 缩进 = `depth * 12 + 8` px（每深一级 +12px，基线 8px）
 *   - caret：目录用 `▾` / `▸`；文件用 `·`（占位）
 *   - 图标 emoji：📁 / 📄（避免引入 icon 库）
 */

interface TreeNodeModel {
  name: string;
  path: string;
  isDir: boolean;
  note?: NoteRecord;
  children: TreeNodeModel[];
}

export interface SidebarTreeProps {
  notes: NoteRecord[];
  activePath: string | null;
  onSelect: (path: string) => void;
}

export function SidebarTree({
  notes,
  activePath,
  onSelect,
}: SidebarTreeProps): JSX.Element {
  const tree = useMemo(() => buildTree(notes), [notes]);

  if (tree.length === 0) {
    return <p className="sidebar__empty">暂无笔记，点击 + 创建</p>;
  }

  return (
    <div className="sidebar__tree">
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
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
      let next = cur.children.find((c) => c.name === seg && c.isDir === !isLast);
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
