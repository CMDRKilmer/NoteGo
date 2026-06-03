import { useEffect, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { ipc } from "../../lib/ipc";
import { vaultEvents } from "../../lib/events";
import type { BacklinkRow } from "../../types/note";

/**
 * 右侧栏：反向链接面板
 *
 * - 根据 `activePath` 调用 `ipc.getBacklinks` 拉取所有指向该笔记的源条目
 * - 列表项显示 `fromTitle` + 行号 + 上下文 snippet
 * - 点击条目调用 `setActivePath(fromPath)` 切换编辑器
 * - 监听 `vault://note` 事件：当索引重建（重新打开 Vault）或笔记变化时刷新
 */
export function BacklinksPanel(): JSX.Element {
  const activePath = useAppStore((s) => s.activePath);
  const setActivePath = useAppStore((s) => s.setActivePath);
  const [backlinks, setBacklinks] = useState<BacklinkRow[]>([]);
  const [loading, setLoading] = useState(false);

  // activePath 变化时重新拉取
  useEffect(() => {
    if (!activePath) {
      setBacklinks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await ipc.getBacklinks(activePath);
        if (!cancelled) setBacklinks(list);
      } catch (err) {
        console.error("[BacklinksPanel] getBacklinks failed:", err);
        if (!cancelled) setBacklinks([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // 监听文件变化：modified/renamed/deleted 都可能影响反向链接结果，简单刷新
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    vaultEvents
      .onNoteChanged(() => {
        if (!activePath) return;
        ipc
          .getBacklinks(activePath)
          .then(setBacklinks)
          .catch((err) => console.error("[BacklinksPanel] refresh failed:", err));
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, [activePath]);

  return (
    <div className="backlinks">
      <div className="backlinks__header">
        <span>反向链接</span>
        {activePath && (
          <span className="backlinks__active" title={activePath}>
            {activePath}
          </span>
        )}
      </div>
      <div className="backlinks__body">
        {!activePath ? (
          <p className="backlinks__empty">尚未选中任何笔记</p>
        ) : loading ? (
          <p className="backlinks__empty">加载中…</p>
        ) : backlinks.length === 0 ? (
          <p className="backlinks__empty">暂无反向链接</p>
        ) : (
          <ul className="backlinks__list">
            {backlinks.map((b, idx) => (
              <li
                key={`${b.fromPath}:${b.line}:${idx}`}
                className="backlinks__item"
                onClick={() => setActivePath(b.fromPath)}
                title={b.fromPath}
              >
                <div className="backlinks__item-title">
                  <span className="backlinks__item-icon">↩</span>
                  <span className="backlinks__item-name">{b.fromTitle}</span>
                  <span className="backlinks__item-line">L{b.line}</span>
                </div>
                {b.snippet && (
                  <div className="backlinks__item-snippet">{b.snippet}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
