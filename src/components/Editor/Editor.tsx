import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { ipc } from "../../lib/ipc";
import { vaultEvents } from "../../lib/events";

/**
 * 编辑器（Task 2 简化版）
 *
 * - `activePath` 变化时通过 `readNote` 拉取内容
 * - textarea 防抖 500ms 自动 `writeNote`
 * - 监听 `vault://note` 的 `modified` 事件，若文件哈希变化则重新拉取
 *
 * Task 5 将替换为 CodeMirror 6 + Markdown 扩展。
 */
export function Editor(): JSX.Element {
  const activePath = useAppStore((s) => s.activePath);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // 当前文件 path（避免闭包问题）
  const activePathRef = useRef<string | null>(activePath);
  activePathRef.current = activePath;

  // 拉取笔记内容
  useEffect(() => {
    if (!activePath) {
      setContent("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const text = await ipc.readNote(activePath);
        if (!cancelled) setContent(text);
      } catch (err) {
        console.error("[Editor] readNote failed:", err);
        if (!cancelled) setContent(`# 错误\n\n无法读取：${String(err)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // 防抖保存 500ms
  useEffect(() => {
    if (!activePath) return;
    // 初次加载（loading）时不触发保存
    if (loading) return;
    const t = setTimeout(() => {
      (async () => {
        try {
          await ipc.writeNote(activePath, content);
          setSavedAt(Date.now());
        } catch (err) {
          console.error("[Editor] writeNote failed:", err);
        }
      })();
    }, 500);
    return () => clearTimeout(t);
  }, [content, activePath, loading]);

  // 监听 modified 事件：被外部修改时刷新（简单做法：直接重新拉一次）
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    vaultEvents
      .onNoteChanged((e) => {
        if (
          (e.type === "modified" || e.type === "renamed") &&
          activePathRef.current
        ) {
          const target =
            e.type === "renamed" ? e.newPath : e.path;
          if (target === activePathRef.current) {
            ipc
              .readNote(target)
              .then(setContent)
              .catch(console.error);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  if (!activePath) {
    return (
      <div className="editor editor--empty">
        <p>请在左侧选择一个笔记</p>
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="editor__toolbar">
        <span className="editor__path" title={activePath}>
          {activePath}
        </span>
        <span className="editor__status">
          {loading
            ? "加载中…"
            : savedAt
              ? `已自动保存 · ${new Date(savedAt).toLocaleTimeString()}`
              : "编辑中…"}
        </span>
      </div>
      <textarea
        className="editor__textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}
