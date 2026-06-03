import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { MermaidBlock } from './MermaidBlock';
import { Callout } from './Callout';
import { WikiLink } from './WikiLinkRenderer';
import 'katex/dist/katex.min.css';

interface Props {
  content: string;
}

/**
 * Markdown 预览组件
 *
 * - 启用 GFM（表格 / 任务列表 / 删除线）
 * - 启用 KaTeX 数学公式
 * - 启用原始 HTML（rehype-raw，谨慎使用）
 * - 自定义 `code`：```mermaid`` 走 MermaidBlock
 * - 自定义 `blockquote`：识别 `[!note]` / `[!warning]` 等 Callout 语法
 * - 自定义 `a`：识别 `notego://wiki/*` 走 WikiLink 渲染
 * - 在传给 react-markdown 之前把 `[[wiki]]` 转换为 `notego://wiki/...` 链接
 */
export function MarkdownView({ content }: Props): JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeRaw]}
        components={{
          code(props) {
            const { className, children, ...rest } = props as {
              className?: string;
              children?: React.ReactNode;
              inline?: boolean;
            };
            const match = /language-(\w+)/.exec(className || '');
            if (match && match[1] === 'mermaid') {
              return (
                <MermaidBlock
                  code={String(children ?? '').replace(/\n$/, '')}
                />
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          blockquote(props) {
            return <Callout>{props.children}</Callout>;
          },
          a: WikiLink as React.ComponentType<{
            href?: string;
            children?: React.ReactNode;
          }>,
        }}
      >
        {transformWikiLinks(content)}
      </ReactMarkdown>
    </div>
  );
}

/**
 * 把 `[[wiki]]` / `[[wiki|alias]]` 转换为 markdown 链接
 * 形如 `[alias](notego://wiki/<encoded>)`，由 react-markdown 配合 WikiLink 渲染器处理。
 */
function transformWikiLinks(content: string): string {
  return content.replace(/\[\[([^\]\n]+?)\]\]/g, (_match, raw: string) => {
    const pipeIdx = raw.indexOf('|');
    const target =
      pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw;
    const alias = pipeIdx >= 0 ? raw.slice(pipeIdx + 1) : undefined;
    const text = alias ?? target;
    const t = target.trim();
    return `[${text}](notego://wiki/${encodeURIComponent(t)})`;
  });
}
