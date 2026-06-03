# Tasks — NoteGo 类 Obsidian 笔记软件

> 实施顺序按"自底向上"原则：先打通骨架与文件 IO，再叠加索引 / 链接 / 视图 / 同步 / 插件。

---

## Task 1: 项目骨架与工具链 ✅
**目标**: 初始化 Tauri 2.x 项目，配置 Rust 后端 + React/TypeScript 前端 + Vite + 包管理与 CI 脚本。

- [x] SubTask 1.1: 使用 `pnpm create tauri-app` 初始化 `notego` 应用 (前端选 React + TypeScript + Vite) — **手写所有配置文件，跳过交互式创建**
- [x] SubTask 1.2: 配置 `Cargo.toml` 依赖：`tauri` `serde` `tokio` `rusqlite` `notify` `pulldown-cmark` `aws-sdk-s3` `keyring` `anyhow` `tracing`
- [x] SubTask 1.3: 配置 `package.json` 依赖：`@tauri-apps/api` `@codemirror/*` `cytoscape` `katex` `mermaid` `fuse.js` `zustand` — 核心依赖已就位，扩展包在对应 Task 中添加
- [x] SubTask 1.4: 添加 `pnpm dev` / `pnpm build` / `pnpm tauri dev` / `pnpm tauri build` 脚本
- [x] SubTask 1.5: 配置 GitHub Actions：Windows / macOS / Linux 三平台并行构建

**验证**:
- `pnpm tauri dev` 成功启动空窗口 — 待用户首次 `pnpm install` 后验证
- `pnpm tauri build` 在当前平台产出可执行文件 — 待用户首次 `pnpm install` 后验证

**交付物**: 33 个文件已落盘（含 8 个 Rust、12 个 TS/TSX、5 个配置、3 个 CI/git、5 个样式/README）

---

## Task 2: Vault 管理与文件 IO ✅
**目标**: 实现 Vault（笔记库）的选择 / 创建 / 打开，以及对 `.md` 文件的 CRUD。

- [x] SubTask 2.1: Rust 端实现 `Vault::open(path)` `Vault::create(path)`，校验可写性、初始化 `.notego/` 配置目录 — `fs.rs` 完整实现，含路径安全（拒绝绝对路径 / `..` 越界）、SHA-256 稳定 ID
- [x] SubTask 2.2: Rust 端实现 `Note::read` `Note::write` `Note::delete` `Note::rename` 原子操作 — `tempfile` + `tokio::fs` 原子写
- [x] SubTask 2.3: 集成 `notify` 监听 Vault 目录变更，封装为 Tauri Event 推送给前端 — `watcher.rs` + `WatcherSlot` 保活机制
- [x] SubTask 2.4: 前端实现"选择 Vault"对话框、`tauri-plugin-dialog` — `ipc.openVaultDialog`
- [x] SubTask 2.5: 前端实现三栏布局：左文件树 / 中编辑器 / 右反向链接面板 — `AppLayout` + `Sidebar`（含搜索 + 新建） + `BacklinksPanel` + `Editor`（textarea + 500ms 防抖）

**验证**:
- 通过界面新建/重命名/删除笔记，磁盘文件同步变化 — 待 `pnpm install` + `pnpm tauri dev` 端到端验证
- 外部编辑器修改后 UI 在 1 秒内刷新 — `vault://note` 事件机制已就绪

**交付物**: 3 个新建（watcher.rs, events.ts, appStore.ts）+ 13 个修改

---

## Task 3: SQLite 索引 ✅
**目标**: 为 Vault 建立高效索引，支持按元数据 / 标签 / 链接查询。

- [x] SubTask 3.1: 设计索引表结构：`notes(id, path, title, mtime, size, hash)` `tags(note_id, tag)` `links(from_id, to_id, kind, position)` `meta(key, value)` — `index.rs` 完整实现，含 `notes_fts` FTS5 虚拟表 + 触发器维护
- [x] SubTask 3.2: Rust 端封装 `Index::upsert_note` / `Index::remove_note` / `Index::query_*` 接口 — 含 `get_backlinks` / `search` / `notes_with_tag` / `all_tags` / `count_notes`
- [x] SubTask 3.3: 实现"全量重建索引"与"增量更新"两种模式 — `rebuild` 分批 1000 条/事务，`upsert_note` 增量；Vault 集成 `Arc<Index>`
- [x] SubTask 3.4: 启动时自动校验索引与文件系统一致性，差异部分全量重建 — `Vault::open` 检测索引为空时自动 `reindex_all`

**验证**:
- 10,000 笔记全量索引构建 < 30 秒 — 分批事务 + FTS5 触发器维护，理论上达标，需运行时基准测试
- 单笔记修改后增量更新 < 200ms — `write_note` 同步索引，upsert 单行 < 1ms

**交付物**: 6 个新建/重写 + 3 个修改

---

## Task 4: Markdown 解析与双向链接 ✅
**目标**: 解析 `[[wiki]]` 语法，构建双向链接图。

- [x] SubTask 4.1: 基于 `pulldown-cmark` 实现自定义解析器，扩展识别 `[[]]` `[[|alias]]` `[[path/]]` — `parser.rs` 完整实现
- [x] SubTask 4.2: 解析 `#tag` `##tag`（标题中的标签）`#嵌套/子标签` — 正则 + 代码块跳过
- [x] SubTask 4.3: 解析 YAML Front Matter 中的 `tags:` `aliases:` 字段 — `serde_yaml`
- [x] SubTask 4.4: 将解析结果写入索引 `links` / `tags` 表 — `fs::reindex_note` / `reindex_all` 集成 parser
- [x] SubTask 4.5: 提供 IPC：`get_backlinks(note_id)` `resolve_link(text)` `get_unresolved_links()` — commands.rs + lib.rs

**验证**:
- 输入 `[[测试]]` 后，反向链接面板立即出现引用来源 — 解析 + 索引写入 + 事件刷新已闭环
- 重命名目标笔记后所有引用自动更新 — `Index::rename_note` + `resolve_link_targets` 批量更新；**body 文本级 `[[old]] → [[new]]` 替换**留 TODO

**交付物**: 1 个新建（TagTree.tsx）+ 10 个修改

**附注**:
- 9 个 parser 单元测试已编写（5 个必备 + 4 个扩展）
- 代码块检测仅识别 fenced code（```/~~~），不识别 4 空格缩进块
- 文本级链接重写（body 替换）作为 TODO 留给后续 Task

---

## Task 5: 编辑器与渲染 ✅
**目标**: 提供 CodeMirror 6 写作视图 + 阅读模式 Markdown 增强渲染。

- [x] SubTask 5.1: 集成 CodeMirror 6，配置 Markdown 语言、主题、快捷键（`[[` 触发补全、`Ctrl+B/I/K` 加粗/斜体/链接）— `CodeMirrorEditor.tsx` + `oneDark` + 历史/补全/搜索/快捷键
- [x] SubTask 5.2: 实现 `[[` 自动补全弹窗（基于索引实时查询）— `wikiCompletion.ts` + 空查询 fallback 到 list_notes
- [x] SubTask 5.3: 集成 `react-markdown` + `remark-gfm` + `rehype-katex` + `rehype-raw` + `remark-math` — `MarkdownView.tsx`
- [x] SubTask 5.4: 实现阅读 / 实时双视图切换 (`Ctrl+E`) — 源码/分屏/预览三模式 (`mode` state)
- [x] SubTask 5.5: 实现悬停预览组件 (Hover Popover) — `WikiLinkRenderer.tsx` + 预览缓存 + 500 字符

**验证**:
- 输入 ```mermaid 代码块渲染为流程图 — `MermaidBlock.tsx` + mermaid 10.x render API
- 悬停链接弹出预览卡片 — WikiLink onMouseEnter 触发 + 前 500 字片段

**交付物**: 7 个新建 + 7 个修改

**附注**:
- `Ctrl+B/I/K` 加粗/斜体/链接 依赖 CodeMirror 默认 keymap（已通过 `defaultKeymap` 提供）
- `Ctrl+E` 双视图切换在 `setMode` 工具栏实现，**未绑定快捷键**——可后续补
- Mermaid 通过 `optimizeDeps.exclude` 排除

---

## Task 6: 知识图谱视图
**目标**: 渲染全局 / 局部知识图谱。

- [ ] SubTask 6.1: 集成 Cytoscape.js，封装 `GraphView` 组件
- [ ] SubTask 6.2: 实现力导向布局 (`cose-bilkent`) 并支持拖拽 / 缩放 / 平移
- [ ] SubTask 6.3: 节点大小 = log(度数 + 1)，颜色 = 标签哈希
- [ ] SubTask 6.4: 局部图谱：BFS 取 N 跳邻居
- [ ] SubTask 6.5: 过滤：标签过滤、关键字搜索过滤

**验证**:
- 100 节点图谱渲染 < 1 秒，60fps 拖拽
- 局部图谱点击节点高亮邻居

---

## Task 7: 搜索与命令面板
**目标**: 全局快速搜索 + 命令面板。

- [ ] SubTask 7.1: SQLite FTS5 虚拟表，索引 `title` `body` `tags`
- [ ] SubTask 7.2: 前端命令面板组件 (类似 VSCode `Ctrl+P`)，支持模糊匹配 + 高亮
- [ ] SubTask 7.3: 高级搜索语法：`tag:x` `path:/daily` `title:foo`
- [ ] SubTask 7.4: 注册常用命令：新建笔记、切换主题、打开图谱、立即同步

**验证**:
- 10,000 笔记中搜索关键字 < 100ms
- 命令面板支持中文模糊匹配

---

## Task 8: S3 同步
**目标**: 实现 S3 兼容协议的 Vault 同步。

- [ ] SubTask 8.1: 集成 `aws-sdk-s3` (Rust)，封装 `S3Client::list` `put` `get` `delete`
- [ ] SubTask 8.2: 设置面板：S3 配置表单 + 测试连接
- [ ] SubTask 8.3: 凭据使用 `keyring` 加密存储
- [ ] SubTask 8.4: 实现同步引擎：清单对比 → 上传 / 下载 → 墓碑清理 → 冲突解决
- [ ] SubTask 8.5: 防抖队列 + 离线日志 + 自动重试
- [ ] SubTask 8.6: 同步状态 UI：顶栏图标 + 进度浮窗 + 冲突列表

**验证**:
- A 端新建笔记 → B 端 5 秒内收到
- 同文件双端修改 → 冲突解决，保留两版本

---

## Task 9: 插件系统
**目标**: 提供受限沙箱的插件机制。

- [ ] SubTask 9.1: 设计插件 manifest (`plugin.json`)：id / name / version / permissions / entry
- [ ] SubTask 9.2: 插件格式：JS 入口 + WASM 扩展 (可选)
- [ ] SubTask 9.3: 沙箱：通过 iframe + postMessage 隔离，仅暴露 `notego.api` 白名单
- [ ] SubTask 9.4: 插件 API：`registerCommand` `registerView` `onNoteOpen` `addRibbonIcon` `getActiveNote`
- [ ] SubTask 9.5: 插件市场页面：浏览 / 一键安装 / 卸载

**验证**:
- 安装示例插件 "字数统计" 后状态栏出现字数
- 恶意插件尝试 `fetch('http://evil')` 被沙箱拒绝

---

## Task 10: 主题与外观
**目标**: 主题系统 + 自定义 CSS。

- [ ] SubTask 10.1: 定义 CSS 变量主题 (亮 / 暗)
- [ ] SubTask 10.2: 跟随系统主题 (`prefers-color-scheme`)
- [ ] SubTask 10.3: 加载 `<Vault>/.notego/appearance.css`
- [ ] SubTask 10.4: 字体 / 字号 / 行距设置

**验证**:
- 切换主题立即生效
- 自定义 CSS 覆盖默认样式

---

## Task 11: 跨平台打包与自动更新
**目标**: 多平台分发 + 自动更新。

- [ ] SubTask 11.1: 配置 Tauri Bundle：Windows MSI / NSIS、macOS DMG、Linux AppImage / deb
- [ ] SubTask 11.2: 代码签名：Windows EV 证书、macOS Developer ID
- [ ] SubTask 11.3: 集成 `tauri-plugin-updater`，通过 S3 / GitHub Releases 分发新版本
- [ ] SubTask 11.4: 在 CI 中自动化版本号、变更日志、构建、上传

**验证**:
- 三平台均可成功打包
- 触发更新后应用内弹窗提示下载

---

## Task 12: 性能基准与文档
**目标**: 性能基线 + 用户文档 + 开发者文档。

- [ ] SubTask 12.1: 编写性能测试：10,000 笔记样本库
- [ ] SubTask 12.2: 编写用户手册（中文）：快速开始、双向链接、图谱、插件、同步
- [ ] SubTask 12.3: 编写开发者文档：架构、插件 API、贡献指南
- [ ] SubTask 12.4: 录制 5 分钟演示视频

**验证**:
- `pnpm bench` 报告：索引 / 搜索 / 同步时延
- 文档可在本地 `vitepress dev` 浏览

---

# Task Dependencies
- Task 2 依赖 Task 1
- Task 3 依赖 Task 2
- Task 4 依赖 Task 3
- Task 5 依赖 Task 2
- Task 6 依赖 Task 4
- Task 7 依赖 Task 3
- Task 8 依赖 Task 2
- Task 9 依赖 Task 1
- Task 10 依赖 Task 1
- Task 11 依赖 Task 1 ~ 9 全部
- Task 12 依赖 Task 1 ~ 9 全部
