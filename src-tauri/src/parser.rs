//! Markdown 解析器
//!
//! 解析 `.md` 内容，提取：
//! - YAML Front Matter（title / tags / aliases / ...）
//! - 双向链接 `[[wiki]]` / `[[wiki|alias]]` / `[[path/]]` / `[[wiki#heading]]`
//! - 内联标签 `#tag` / `#nested/tag`
//! - 标题与正文纯文本
//!
//! 入口函数 [`parse`]，对整个 `.md` 文本做一次性解析，返回 [`ParsedNote`]。
//!
//! ## 设计
//! - **正则优先**：`[[...]]` 与 `#tag` 使用 `regex` crate 的 `OnceLock` 缓存
//! - **Front Matter**：首行 `---` 开始至下一个 `---` 结束；用 `serde_yaml` 解析
//! - **代码块跳过**：用 `pulldown-cmark` 的 `Event` 流识别 Code / CodeBlock 范围
//! - **行号 / 上下文**：所有 wikilink 记录命中行号 + 整行内容（截断 200 字符）

use anyhow::Result;
use pulldown_cmark::{Event, Options, Parser};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// 整篇解析的结果。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ParsedNote {
    /// YAML Front Matter 解析结果
    pub front_matter: FrontMatter,
    /// 合并 Front Matter 与正文后所有标签（去重，保持首次出现顺序）
    pub tags: Vec<String>,
    /// 双向链接列表
    pub links: Vec<WikiLink>,
    /// 纯文本正文（已剥离 Front Matter 与代码块）
    pub body: String,
}

/// YAML Front Matter 顶层字段。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct FrontMatter {
    /// `title: 笔记标题`
    pub title: Option<String>,
    /// `tags: [a, b]` 或 `tags:\n  - a\n  - b`
    #[serde(default)]
    pub tags: Vec<String>,
    /// `aliases: [x, y]`，等价于 Obsidian 的 `alias` / `aliases`
    #[serde(default, alias = "alias")]
    pub aliases: Vec<String>,
    /// 其余未识别字段原样保留（YAML 树）
    #[serde(default)]
    pub extra: serde_yaml::Value,
}

/// 一条双向链接。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiLink {
    /// 原始 `[[...]]` 文本（含括号）
    pub raw: String,
    /// 解析后的目标（标题或路径）
    pub target: String,
    /// `|alias` 部分
    pub alias: Option<String>,
    /// `#heading` 锚点
    pub heading: Option<String>,
    /// 出现行号（1-based）
    pub line: usize,
    /// 所在行内容（snippet）
    pub context: String,
}

/// wiki 链接正则：`[[...]]`，内容里允许除 `[` `]` 换行外的所有字符；非贪婪。
fn wiki_re() -> &'static Regex {
    static WIKI_RE: OnceLock<Regex> = OnceLock::new();
    WIKI_RE.get_or_init(|| Regex::new(r"\[\[([^\[\]\n]+?)\]\]").unwrap())
}

/// 内联标签正则：
/// - 前导：行首 / 空白 / 非 `\w/` 字符
/// - 内容：字母 / 数字 / 下划线 / `-` / `/`
/// - 不匹配 URL 锚点、Markdown 标题开头的 `#`
fn tag_re() -> &'static Regex {
    static TAG_RE: OnceLock<Regex> = OnceLock::new();
    TAG_RE.get_or_init(|| Regex::new(r"(?:^|[\s(>])#([A-Za-z_][\w/\-]*)").unwrap())
}

/// 上下文 snippet 最大长度。
const CONTEXT_MAX: usize = 200;

/// 解析单篇 Markdown 文本。
///
/// 流程：
/// 1. 切分 Front Matter（首段 `---` 块）
/// 2. 用 `serde_yaml` 解析 Front Matter；解析失败时返回原始 `String` 到 `extra`
/// 3. 在剩余正文中：
///    - 用 `pulldown-cmark` 走 Event 流，识别代码块范围用于跳过后续正则匹配
///    - 全文正则扫描 `[[...]]`，按行号记录
///    - 全文正则扫描 `#tag`，跳过代码块、跳过 URL 锚点、跳过 Markdown 标题开头
/// 4. 合并 Front Matter 的 `tags` 与正文 `tags`，按首次出现去重
pub fn parse(content: &str) -> Result<ParsedNote> {
    // 1) 切分 Front Matter
    let (fm_raw, body) = split_front_matter(content);

    // 2) 解析 Front Matter
    let front_matter = parse_front_matter(fm_raw);

    // 3) 计算代码块行号集合（用于跳过后续标签匹配）
    let code_block_lines = collect_code_block_lines(body);

    // 4) 提取 wikilink（行号 + 上下文）
    let links = extract_wiki_links(body);

    // 5) 提取内联标签
    let inline_tags = extract_tags(body, &code_block_lines);

    // 6) 合并 tags（Front Matter 优先，再接正文）
    let mut tags: Vec<String> = Vec::new();
    for t in &front_matter.tags {
        push_unique(&mut tags, t);
    }
    for t in &inline_tags {
        push_unique(&mut tags, t);
    }

    // 7) 提取纯文本正文（用 pulldown-cmark 把 Markdown 渲染为 Event 序列，收集 Text）
    let body_text = extract_text(body);

    Ok(ParsedNote {
        front_matter,
        tags,
        links,
        body: body_text,
    })
}

/// 切分 YAML Front Matter。
///
/// 规则：首行严格是 `---`（允许尾部空白），后续到下一个独立 `---` 行结束。
/// 若无 Front Matter 则整段都视为正文。
fn split_front_matter(content: &str) -> Option<(&str, &str)> {
    let mut lines = content.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let mut start = first.len();
    let mut idx = start;
    for line in lines {
        if line.trim_end() == "---" {
            // 结束位置：取到 `---` 行末尾（不含 `---` 后的内容）
            let end = idx + line.len();
            let fm = &content[start..idx];
            let body = &content[end..];
            return Some((fm, body));
        }
        idx += line.len();
    }
    // 没有匹配到结束 `---`：当作无 Front Matter
    None
}

/// 解析 YAML 块为 [`FrontMatter`]。解析失败时返回 `default()`，原文存入 `extra`。
fn parse_front_matter(raw: &str) -> FrontMatter {
    if raw.trim().is_empty() {
        return FrontMatter::default();
    }
    // 优先尝试带结构化字段的解析
    #[derive(Deserialize, Default)]
    struct Raw {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default, alias = "alias")]
        aliases: Vec<String>,
    }
    match serde_yaml::from_str::<Raw>(raw) {
        Ok(r) => {
            // extra：把原文再序列化回去（仅当存在未知字段时才有意义）
            let extra: serde_yaml::Value =
                serde_yaml::from_str(raw).unwrap_or(serde_yaml::Value::Null);
            FrontMatter {
                title: r.title,
                tags: r.tags,
                aliases: r.aliases,
                extra,
            }
        }
        Err(_) => {
            // 解析失败：把原文塞进 extra 以便后续排错
            FrontMatter {
                title: None,
                tags: Vec::new(),
                aliases: Vec::new(),
                extra: serde_yaml::Value::String(raw.to_string()),
            }
        }
    }
}

/// 提取双向链接。
///
/// 对每行独立扫描 `[[...]]` 正则；嵌套 `#heading` / `|alias` 解析在内部完成。
fn extract_wiki_links(content: &str) -> Vec<WikiLink> {
    let re = wiki_re();
    let mut out = Vec::new();
    for (i, line) in content.split('\n').enumerate() {
        for cap in re.captures_iter(line) {
            let raw = cap.get(0).map(|m| m.as_str()).unwrap_or("").to_string();
            let inner = cap.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
            let (target, heading, alias) = split_link_target(&inner);
            out.push(WikiLink {
                raw,
                target: target.to_string(),
                alias: alias.map(|s| s.to_string()),
                heading: heading.map(|s| s.to_string()),
                line: i + 1,
                context: truncate_context(line),
            });
        }
    }
    out
}

/// 解析 `inner`：`heading` 优先于 `|alias`。
///
/// - `note#section|alias` → target="note", heading="section", alias="alias"
/// - `note#section` → target="note", heading="section", alias=None
/// - `note|alias` → target="note", heading=None, alias="alias"
/// - `note` → target="note", heading=None, alias=None
fn split_link_target(inner: &str) -> (&str, Option<&str>, Option<&str>) {
    // 1) 切 `#heading`（先做）
    let (head, rest) = match inner.split_once('#') {
        Some((a, b)) => (a, b),
        None => (inner, ""),
    };
    // heading 不能含 `|`（如有则视为别名的一部分）
    let (heading, after_hash) = match rest.split_once('|') {
        Some((h, a)) => (Some(h), a),
        None => (if rest.is_empty() { None } else { Some(rest) }, ""),
    };
    // 2) 切 `|alias`
    let (target, alias) = match after_hash.split_once('|') {
        Some((t, a)) => (t, Some(a)),
        None => (head, None),
    };
    (target.trim(), heading.map(|s| s.trim()), alias.map(|s| s.trim()))
}

/// 提取内联标签。
///
/// 跳过：
///   - 代码块（按 `code_block_lines` 集合行号）
///   - 标题行开头的 `#`（Markdown H1~H6）
///   - URL 锚点（如 `https://x.com#frag`，由正则前导非 `:` 简单判断）
fn extract_tags(content: &str, code_block_lines: &[usize]) -> Vec<String> {
    let re = tag_re();
    let mut out = Vec::new();
    for (i, line) in content.split('\n').enumerate() {
        let line_no = i + 1;
        if code_block_lines.contains(&line_no) {
            continue;
        }
        // 标题行：`#` 紧跟空白或文本开头
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            // 紧跟 `#` 的是空白 / 行尾 / 普通字符（不是字母 / `_`），则视为标题
            let rest = trimmed[1..].chars().next();
            if rest.map(|c| !c.is_alphanumeric() && c != '_').unwrap_or(true) {
                continue;
            }
        }
        for cap in re.captures_iter(line) {
            if let Some(m) = cap.get(1) {
                let tag = m.as_str();
                // 简单 URL 过滤：含 `://` 的整行不当作正文
                if line.contains("://") {
                    // 进一步：仅当 `#` 出现在 `://` 之后才视为锚点
                    if let Some(pos) = line.find("://") {
                        if let Some(hash_pos) = line[pos..].find('#') {
                            // 全局位置
                            let hp = pos + hash_pos;
                            if let Some(m_start) = cap.get(0).map(|mm| mm.start()) {
                                if m_start >= hp {
                                    continue;
                                }
                            }
                        }
                    }
                }
                push_unique(&mut out, tag);
            }
        }
    }
    out
}

/// 用行扫描识别"fenced 代码块"内的行号（1-based）。
///
/// 实现：逐行读取，遇到以 ```` ``` ````（或 ~~~）开头的行切换 `in_fence` 状态。
/// 不依赖 `pulldown-cmark` 的 Event 流——后者不带字节偏移，逐行扫描更直观。
/// 缩进式代码块（4 空格）暂不识别，留待后续增强。
fn collect_code_block_lines(content: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut in_fence = false;
    let mut fence_marker: Option<char> = None;
    for (i, line) in content.split('\n').enumerate() {
        let line_no = i + 1;
        let trimmed = line.trim_start();
        // 简单判定：行首是 ``` 或 ~~~，且字符连续 ≥ 3
        let marker_char = trimmed.chars().next();
        let marker_run = marker_char
            .map(|c| trimmed.chars().take_while(|&x| x == c).count())
            .unwrap_or(0);
        if !in_fence {
            if marker_run >= 3 && (marker_char == Some('`') || marker_char == Some('~')) {
                in_fence = true;
                fence_marker = marker_char;
                out.push(line_no);
            }
        } else {
            out.push(line_no);
            // 结束围栏：相同字符且 ≥ 3
            if marker_run >= 3 && Some(marker_char.unwrap()) == fence_marker {
                in_fence = false;
                fence_marker = None;
            }
        }
    }
    out
}

/// 提取纯文本正文（剥离 Front Matter 后用 `pulldown-cmark` 走 Event 流）。
///
/// 拼接 `Event::Text` / `Event::Code` 文本；其它事件插入换行以保留段落边界。
fn extract_text(content: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = Parser::new_ext(content, options);
    let mut out = String::new();
    for ev in parser {
        match ev {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak | Event::HardBreak => out.push('\n'),
            Event::Start(_) | Event::End(_) => {}
            Event::Rule => out.push('\n'),
            Event::Html(_) | Event::FootnoteReference(_) | Event::TaskListMarker(_) => {}
        }
    }
    out
}

/// 去重追加：保持首次出现顺序。
fn push_unique(v: &mut Vec<String>, s: &str) {
    let s = s.to_string();
    if !v.iter().any(|x| x == &s) {
        v.push(s);
    }
}

/// 截断 context 至 `CONTEXT_MAX` 字符。
fn truncate_context(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() > CONTEXT_MAX {
        let cut: String = trimmed.chars().take(CONTEXT_MAX).collect();
        format!("{cut}…")
    } else {
        trimmed.to_string()
    }
}

/// 公开 helper：从一段 wikilink 文本中抽取 target。
///
/// 支持的输入形式：
///   - `[[note]]`
///   - `note`（裸字符串）
///   - `[[note#heading]]` / `[[note|alias]]` / `[[note#heading|alias]]`
///
/// 用于 [`crate::index::Index::resolve_link`] 等场景。
pub fn extract_link_target(text: &str) -> String {
    let s = text.trim();
    // 去除可能的 `[[` `]]` 包裹
    let s = s
        .strip_prefix("[[")
        .and_then(|x| x.strip_suffix("]]"))
        .unwrap_or(s);
    let (target, _heading, _alias) = split_link_target(s);
    target.trim().to_string()
}

// ---------------------------------------------------------------------------
//                                  单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_wiki_link() {
        let p = parse("hello [[note]] world").unwrap();
        assert_eq!(p.links.len(), 1);
        let l = &p.links[0];
        assert_eq!(l.target, "note");
        assert_eq!(l.alias, None);
        assert_eq!(l.heading, None);
        assert_eq!(l.line, 1);
        assert!(l.raw.contains("[[note]]"));
    }

    #[test]
    fn test_wiki_with_alias() {
        let p = parse("see [[note|display name]] here").unwrap();
        assert_eq!(p.links.len(), 1);
        let l = &p.links[0];
        assert_eq!(l.target, "note");
        assert_eq!(l.alias, Some("display name".to_string()));
        assert_eq!(l.heading, None);
    }

    #[test]
    fn test_wiki_with_heading() {
        let p = parse("jump to [[note#section]] now").unwrap();
        assert_eq!(p.links.len(), 1);
        let l = &p.links[0];
        assert_eq!(l.target, "note");
        assert_eq!(l.heading, Some("section".to_string()));
        assert_eq!(l.alias, None);
    }

    #[test]
    fn test_wiki_with_heading_and_alias() {
        let p = parse("see [[note#section|click]]").unwrap();
        assert_eq!(p.links.len(), 1);
        let l = &p.links[0];
        assert_eq!(l.target, "note");
        assert_eq!(l.heading, Some("section".to_string()));
        assert_eq!(l.alias, Some("click".to_string()));
    }

    #[test]
    fn test_yaml_front_matter() {
        let md = "---\ntitle: Hello\ntags: [a, b]\naliases: [x, y]\n---\n\n# body\n";
        let p = parse(md).unwrap();
        assert_eq!(p.front_matter.title.as_deref(), Some("Hello"));
        assert_eq!(p.front_matter.tags, vec!["a", "b"]);
        assert_eq!(p.front_matter.aliases, vec!["x", "y"]);
        // body 应当不含 yaml 内容
        assert!(p.body.contains("body"));
    }

    #[test]
    fn test_inline_tags_and_skip_code_block() {
        let md = "\
# 标题

正文 #foo 和 #bar 还有 #parent/child。

```
let x = 1; // #not_a_tag
#also_skipped
```

#another_tag at end
";
        let p = parse(md).unwrap();
        // 应当识别：foo, bar, parent/child, another_tag
        // 应当跳过：not_a_tag, also_skipped（都在代码块内）
        assert!(p.tags.contains(&"foo".to_string()));
        assert!(p.tags.contains(&"bar".to_string()));
        assert!(p.tags.contains(&"parent/child".to_string()));
        assert!(p.tags.contains(&"another_tag".to_string()));
        assert!(!p.tags.contains(&"not_a_tag".to_string()));
        assert!(!p.tags.contains(&"also_skipped".to_string()));
    }

    #[test]
    fn test_front_matter_tags_merged_with_inline() {
        let md = "---\ntags: [yaml_tag]\n---\n# heading\n\nbody #inline_tag\n";
        let p = parse(md).unwrap();
        assert!(p.tags.contains(&"yaml_tag".to_string()));
        assert!(p.tags.contains(&"inline_tag".to_string()));
    }

    #[test]
    fn test_skip_markdown_heading_sharp() {
        // 标题开头的 `#` 不应被识别为标签
        let p = parse("## Sub Heading\n\nbody #real\n").unwrap();
        assert!(p.tags.contains(&"real".to_string()));
        // Sub / Heading 都不应被误判
        assert!(!p.tags.contains(&"Sub".to_string()));
        assert!(!p.tags.contains(&"Heading".to_string()));
    }

    #[test]
    fn test_multiple_links_on_one_line() {
        let p = parse("first [[a]] and [[b|see]] and [[c#h]]").unwrap();
        assert_eq!(p.links.len(), 3);
        assert_eq!(p.links[0].target, "a");
        assert_eq!(p.links[1].target, "b");
        assert_eq!(p.links[1].alias.as_deref(), Some("see"));
        assert_eq!(p.links[2].target, "c");
        assert_eq!(p.links[2].heading.as_deref(), Some("h"));
    }
}
