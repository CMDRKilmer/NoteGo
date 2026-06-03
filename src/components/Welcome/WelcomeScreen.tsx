import { useState } from "react";
import { ipc } from "../../lib/ipc";
import { useAppStore } from "../../store/appStore";

/**
 * 欢迎页：未选择 Vault 时显示
 * - 中央 logo + 标题 + 副标题
 * - 主按钮 "打开 Vault"：调用 `open_vault_dialog` 选目录并构造 Vault
 */
export function WelcomeScreen(): JSX.Element {
  const setVault = useAppStore((s) => s.setVault);
  const setNotes = useAppStore((s) => s.setNotes);
  const [opening, setOpening] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpen = async () => {
    setError(null);
    setOpening(true);
    try {
      const vault = await ipc.openVaultDialog();
      if (!vault) return; // 用户取消
      // 再调一次 open_vault 以在 Rust 端启动文件监听
      await ipc.openVault(vault.path);
      setVault(vault);
      const list = await ipc.listNotes();
      setNotes(list);
    } catch (err) {
      console.error("[WelcomeScreen] open vault failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome__card">
        <div className="welcome__logo" aria-hidden>
          📝
        </div>
        <h1 className="welcome__title">NoteGo</h1>
        <p className="welcome__subtitle">本地优先的 Markdown 知识库</p>
        <p className="welcome__desc">
          双向链接 · 知识图谱 · S3 同步 · 全文搜索
        </p>
        <button
          className="welcome__primary-btn"
          onClick={handleOpen}
          disabled={opening}
        >
          {opening ? "正在打开…" : "打开 / 创建 Vault"}
        </button>
        {error && <p className="welcome__error">{error}</p>}
        <p className="welcome__footer">v0.1.0 · Task 2</p>
      </div>
    </div>
  );
}
