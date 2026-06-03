import { type ReactNode } from 'react';

/**
 * Obsidian 风格 Callout 块
 *
 * 语法：`> [!note] 标题` / `> [!warning]` / `> [!tip]` / `> [!important]`
 * 等价于一个带颜色与图标的引用块。
 */

const CALLOUT_TYPES: Record<string, { icon: string; color: string }> = {
  note: { icon: '📝', color: '#448aff' },
  tip: { icon: '💡', color: '#00bfa5' },
  info: { icon: 'ℹ️', color: '#00b8d4' },
  warning: { icon: '⚠️', color: '#ff9100' },
  danger: { icon: '🔴', color: '#ff1744' },
  important: { icon: '❗', color: '#d500f9' },
};

/** 从 react-markdown 的 children 树中提取首段纯文本。 */
function extractFirstText(node: unknown): string {
  let cur: unknown = node;
  let depth = 0;
  while (cur && depth < 10) {
    if (typeof cur === 'string') return cur;
    if (Array.isArray(cur)) {
      cur = cur[0];
      depth++;
      continue;
    }
    if (
      typeof cur === 'object' &&
      cur !== null &&
      'props' in (cur as Record<string, unknown>)
    ) {
      cur = (cur as { props: { children: unknown } }).props.children;
      depth++;
      continue;
    }
    break;
  }
  return '';
}

export function Callout({ children }: { children: ReactNode }): JSX.Element {
  const text = extractFirstText(children);
  const match = text.match(/^\s*\[!(\w+)\]\s*(.*)/);
  if (!match) {
    return <blockquote className="callout callout--default">{children}</blockquote>;
  }

  const [, type, title] = match;
  const config = CALLOUT_TYPES[type] ?? CALLOUT_TYPES.note;

  // 移除首行的 [!type] 标记（react-markdown 会保留换行）
  let cleanChildren: ReactNode = children;
  if (typeof children === 'string') {
    cleanChildren = (children as string).replace(/^\s*\[!\w+\][^\n]*\n?/, '');
  }

  return (
    <div className="callout" style={{ borderLeftColor: config.color }}>
      <div className="callout__header" style={{ color: config.color }}>
        <span className="callout__icon">{config.icon}</span>
        <span className="callout__title">{title || type}</span>
      </div>
      <div className="callout__body">{cleanChildren}</div>
    </div>
  );
}
