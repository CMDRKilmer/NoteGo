import { useAppStore } from "../../store/appStore";
import { Sidebar } from "./Sidebar";
import { BacklinksPanel } from "./BacklinksPanel";
import { Editor } from "../Editor/Editor";

/**
 * 三栏主布局
 *
 *  ┌─────────────────────────────────────────────┐
 *  │                Toolbar (40px)                │
 *  ├──────────┬─────────────────────┬────────────┤
 *  │ Sidebar  │      Editor         │ Backlinks  │
 *  │  240px   │        1fr          │   280px    │
 *  └──────────┴─────────────────────┴────────────┘
 *  │              Statusbar (24px)                │
 *  └─────────────────────────────────────────────┘
 */
export function AppLayout(): JSX.Element {
  const vault = useAppStore((s) => s.vault);
  const activePath = useAppStore((s) => s.activePath);
  const notes = useAppStore((s) => s.notes);

  // 当前笔记的字数（用于 statusbar）
  const activeNote = activePath
    ? notes.find((n) => n.path === activePath)
    : undefined;
  // 真实字数按 Editor 内部文本统计；此处仅显示占位
  const count = activeNote ? activeNote.size : 0;

  if (!vault) {
    return <div className="app-layout app-layout--loading">加载中…</div>;
  }

  return (
    <div className="app-layout">
      <header className="toolbar">
        <span className="vault-name" title={vault.path}>
          📂 {vault.name}
        </span>
        <div className="toolbar__actions">
          <button className="toolbar__btn" disabled title="Task 6 实现">
            图谱
          </button>
          <button className="toolbar__btn" disabled title="Task 8 实现">
            同步
          </button>
          <button className="toolbar__btn" disabled title="Task 9 实现">
            设置
          </button>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar">
          <Sidebar />
        </aside>
        <main className="editor-pane">
          <Editor />
        </main>
        <aside className="backlinks">
          <BacklinksPanel />
        </aside>
      </div>

      <footer className="statusbar">
        {activePath ? (
          <>
            当前：<code>{activePath}</code> · 字节：<strong>{count}</strong>
          </>
        ) : (
          <>未选中任何笔记</>
        )}
      </footer>
    </div>
  );
}
