import { useEffect, useState, type ReactNode, type MouseEvent } from 'react';
import { ipc } from '../../lib/ipc';

interface Props {
  href?: string;
  children: ReactNode;
}

/**
 * Wiki 链接渲染器（react-markdown `a` 组件）
 *
 * - 解析 `notego://wiki/<encoded>` 为目标标题
 * - 点击调用 ipc.resolveLink，命中后通过 `notego:open-note` 自定义事件切换笔记
 * - 悬停时拉取笔记前 500 字符作为预览（带本地缓存）
 */
const previewCache = new Map<string, string>();

export function WikiLink({ href, children }: Props): JSX.Element {
  const [preview, setPreview] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const target =
    href && href.startsWith('notego://wiki/')
      ? decodeURIComponent(href.slice('notego://wiki/'.length))
      : null;

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (!target) return;
    ipc
      .resolveLink(target)
      .then((resolved) => {
        if (resolved) {
          window.dispatchEvent(
            new CustomEvent('notego:open-note', { detail: { path: resolved } }),
          );
        } else {
          window.alert(`未找到笔记: ${target}`);
        }
      })
      .catch((err) => {
        console.error('[WikiLink] resolveLink failed:', err);
      });
  };

  useEffect(() => {
    if (!target || !showPreview) return;
    const cached = previewCache.get(target);
    if (cached) {
      setPreview(cached);
      return;
    }
    let cancelled = false;
    ipc
      .resolveLink(target)
      .then((resolved) => {
        if (!resolved || cancelled) return;
        return ipc.readNote(resolved).then((body) => {
          if (cancelled) return;
          const snippet = body.slice(0, 500);
          previewCache.set(target, snippet);
          setPreview(snippet);
        });
      })
      .catch((err) => {
        console.error('[WikiLink] preview failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [target, showPreview]);

  if (!target) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }

  return (
    <span className="wiki-link-wrapper">
      <a
        href="#"
        className="wiki-link"
        onClick={handleClick}
        onMouseEnter={() => setShowPreview(true)}
        onMouseLeave={() => setShowPreview(false)}
      >
        {children}
      </a>
      {showPreview && preview && (
        <div className="wiki-preview">
          <div className="wiki-preview__title">{target}</div>
          <div className="wiki-preview__body">{preview}</div>
        </div>
      )}
    </span>
  );
}
