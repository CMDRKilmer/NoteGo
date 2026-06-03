import type { Vault } from "../../types/note";

/**
 * Sidebar 头部：Vault 名称 + 标签入口 + 新建笔记按钮。
 *
 * 设计要点：
 *   - vault 名过长时 `text-overflow: ellipsis` 截断，悬停 title 提示完整路径
 *   - 标签按钮激活态以 `sidebar__action--active` 高亮（与新建按钮区分）
 *   - 图标 + `aria-label` 双重无障碍提示
 */

export type ViewMode = "files" | "tags";

export interface SidebarHeaderProps {
  vault: Vault | null;
  view: ViewMode;
  onToggleTags: () => void;
  onCreate: () => void;
}

export function SidebarHeader({
  vault,
  view,
  onToggleTags,
  onCreate,
}: SidebarHeaderProps): JSX.Element {
  return (
    <div className="sidebar__header">
      <span className="sidebar__vault" title={vault?.path}>
        {vault?.name ?? "Vault"}
      </span>
      <button
        className={
          "sidebar__action sidebar__action--tag" +
          (view === "tags" ? " sidebar__action--active" : "")
        }
        onClick={onToggleTags}
        title={view === "tags" ? "切换到文件树" : "查看标签"}
        aria-label="标签"
      >
        🏷️
      </button>
      <button
        className="sidebar__action"
        onClick={onCreate}
        title="新建笔记"
        aria-label="新建笔记"
      >
        +
      </button>
    </div>
  );
}
