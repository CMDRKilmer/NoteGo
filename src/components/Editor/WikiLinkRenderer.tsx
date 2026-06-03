import { useEffect, useState, type ReactNode, type MouseEvent } from 'react';
import { ipc } from '../../lib/ipc';

interface Props {
  href?: string;
  children: ReactNode;
}

const previewCache = new Map<string, string>();
const MAX_CACHE = 50;  // 简单 LRU 上限

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'notego:']);

function isSafeHref(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const u = new URL(href, location.origin);
    return ALLOWED_PROTOCOLS.has(u.protocol);
  } catch {
    return false;
  }
}

function evictIfFull() {
  if (previewCache.size > MAX_CACHE) {
    const firstKey = previewCache.keys().next().value;
    if (firstKey !== undefined) previewCache.delete(firstKey);
  }
}

/**
 * Wiki 链接渲染器（react-markdown `a` 组件）
 *
 * - 解析 `notego://wiki/<encoded>` 为目标标题
 * - 点击调用 ipc.resolveLink，命中后通过 `notego:open-note` 自定义事件切换笔记
 * - 悬停时拉取笔记前 500 字符作为预览（带本地缓存）
 * - URL 协议白名单（http/https/mailto/notego），其他协议降级为纯文本
 * - `target="_blank"` 外链使用 `rel="noopener noreferrer"` 防止 reverse tabnabbing
 */
export function WikiLink({ href, children }: Props): JSX.Element {
  const [preview, setPreview] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const isWiki = href?.startsWith('notego://wiki/');
  const target =
    isWiki && href
      ? decodeURIComponent(href.slice('notego://wiki/'.length))
      : null;

  // 非白名单协议：降级为纯文本
  if (href && !isSafeHref(href)) {
    return <span className="wiki-link wiki-link--unsafe">{children}</span>;
  }

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
    if (cached !== undefined) {
      setPreview(cached);
      return;
    }
    let cancelled = false;
    ipc
      .resolveLink(target)
      .then((resolved) => {
        if (cancelled || !resolved) return;
        return ipc.readNote(resolved).then((body) => {
          if (cancelled) return;
          const snippet = body.slice(0, 500);
          previewCache.set(target, snippet);
          evictIfFull();
          setPreview(snippet);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[WikiLink] preview failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [target, showPreview]);

  if (!target) {
    // 普通外链，target=_blank + noopener noreferrer
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  return (
    <span className="wiki-link-wrapper">
      <a
        href="#"
        className="wiki-link"
        role="link"
        aria-label={`打开笔记: ${target}`}
        onClick={handleClick}
        onMouseEnter={() => setShowPreview(true)}
        onMouseLeave={() => setShowPreview(false)}
        onFocus={() => setShowPreview(true)}
        onBlur={() => setShowPreview(false)}
      >
        {children}
      </a>
      {showPreview && preview && (
        <div className="wiki-preview" role="tooltip">
          <div className="wiki-preview__title">{target}</div>
          <div className="wiki-preview__body">{preview}</div>
        </div>
      )}
    </span>
  );
}
