import type { SearchHit } from "../../types/note";

/**
 * Sidebar 搜索区：搜索输入 + 防抖触发后的 FTS5 结果浮层。
 *
 * 数据流：
 *   - `query` 是受控输入（每次按键即更新）
 *   - `debouncedQuery` 是父组件 200ms 防抖后的值，仅在非空时显示浮层
 *   - `searching` / `searchResults` 来自父组件 IPC 结果
 *
 * FTS5 高亮：snippet 中嵌入 `\u0001` / `\u0002` 标记，由 `highlightFtsSnippet`
 * 转换为 `<mark>` 标签。在拼接前对片段做 HTML 转义，**防 XSS**。
 */

export interface SidebarSearchProps {
  query: string;
  onQueryChange: (q: string) => void;
  debouncedQuery: string;
  searchResults: SearchHit[];
  searching: boolean;
  onPick: (path: string) => void;
}

export function SidebarSearch({
  query,
  onQueryChange,
  debouncedQuery,
  searchResults,
  searching,
  onPick,
}: SidebarSearchProps): JSX.Element {
  return (
    <div className="sidebar__search">
      <input
        type="search"
        className="sidebar__search-input"
        placeholder="搜索笔记…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      {debouncedQuery && (
        <div className="sidebar__search-results">
          {searching ? (
            <p className="sidebar__search-empty">搜索中…</p>
          ) : searchResults.length === 0 ? (
            <p className="sidebar__search-empty">无匹配结果</p>
          ) : (
            <ul className="sidebar__search-list">
              {searchResults.map((hit) => (
                <li
                  key={hit.path}
                  className="sidebar__search-item"
                  onClick={() => onPick(hit.path)}
                  title={hit.path}
                >
                  <div className="sidebar__search-item-title">
                    {hit.title || hit.path}
                  </div>
                  {hit.snippet && (
                    <div
                      className="sidebar__search-item-snippet"
                      // FTS5 高亮标记 `\u0001` / `\u0002` 转为 `<mark>`
                      dangerouslySetInnerHTML={{
                        __html: highlightFtsSnippet(hit.snippet),
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 将 FTS5 snippet 中 `\u0001...\u0002` 高亮标记替换为 `<mark>` 标签。
 *
 * 安全：`<` / `>` / `&` / `"` 先做 HTML 转义以防 XSS
 * （snippet 来自用户笔记正文，未受信任）。
 */
function highlightFtsSnippet(s: string): string {
  const escape = (raw: string): string =>
    raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  // FTS5 `snippet()` 第三参数为开始标记，第四为结束标记。
  // Rust 端使用 `X'01'` / `X'02'` (U+0001 / U+0002)。
  const START = String.fromCharCode(1);
  const END = String.fromCharCode(2);
  let out = "";
  let buf = "";
  for (const ch of s) {
    if (ch === START) {
      out += escape(buf);
      buf = "";
      out += "<mark>";
    } else if (ch === END) {
      out += escape(buf);
      buf = "";
      out += "</mark>";
    } else {
      buf += ch;
    }
  }
  out += escape(buf);
  return out;
}
