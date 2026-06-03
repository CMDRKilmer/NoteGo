import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

interface Props {
  code: string;
}

let mermaidId = 0;

/**
 * Mermaid 图表渲染
 * - 使用 mermaid 10.x 的 API（render 返回 svg 字符串）
 * - 每次重新生成唯一 id，避免冲突
 */
export function MermaidBlock({ code }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'loose',
    });
    const id = `mermaid-${++mermaidId}`;
    mermaid
      .render(id, code)
      .then(({ svg: rendered }) => setSvg(rendered))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      });
  }, [code]);

  if (error) {
    return (
      <div className="mermaid-error">Mermaid 渲染失败: {error}</div>
    );
  }
  return (
    <div
      className="mermaid-block"
      ref={ref}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
