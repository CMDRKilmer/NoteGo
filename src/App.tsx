import { useEffect } from "react";
import { useAppStore } from "./store/appStore";
import { ipc } from "./lib/ipc";
import { vaultEvents } from "./lib/events";
import { WelcomeScreen } from "./components/Welcome/WelcomeScreen";
import { AppLayout } from "./components/Layout/AppLayout";

/**
 * 主应用入口
 *
 * - 启动时尝试读取已保存的 Vault
 * - 未选择 Vault → 渲染欢迎页
 * - 已选择 Vault → 渲染三栏主布局
 * - 全局监听 `vault://note` 事件，自动同步 `notes` 列表
 */
function App(): JSX.Element {
  const vault = useAppStore((s) => s.vault);
  const setVault = useAppStore((s) => s.setVault);
  const setNotes = useAppStore((s) => s.setNotes);
  const removeNote = useAppStore((s) => s.removeNote);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    // 1) 拉取当前 Vault
    ipc
      .getCurrentVault()
      .then((v) => {
        if (cancelled) return;
        if (v) {
          setVault(v);
          return ipc.listNotes().then(setNotes);
        }
        return undefined;
      })
      .catch((err) => {
        console.error("[App] failed to read current vault:", err);
      });

    // 2) 全局监听笔记变更
    vaultEvents
      .onNoteChanged((e) => {
        if (e.type === "deleted") {
          removeNote(e.path);
        } else {
          // created / modified / renamed 都做一次 list 简化处理
          ipc.listNotes().then(setNotes).catch(console.error);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [setVault, setNotes, removeNote]);

  if (!vault) return <WelcomeScreen />;
  return <AppLayout />;
}

export default App;
