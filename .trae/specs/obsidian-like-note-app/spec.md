# 类 Obsidian 笔记管理软件 (NoteGo) Spec

## Why
打造一个跨平台、本地优先、基于 Markdown 的笔记软件，融合 Obsidian 的核心生产力特性（双向链接、知识图谱、插件扩展），并通过 S3 兼容协议实现多端同步，让用户的知识资产完全自主可控。

## What Changes
- 新建一个 Tauri (Rust + Web) 跨平台桌面应用项目，代号 NoteGo
- 实现 Markdown 文件本地管理 + 内存/磁盘索引
- 实现双向链接 (`[[wiki]]`)、标签 (`#tag`)、反向链接、知识图谱
- 实现编辑器、Markdown 增强渲染 (表格 / 代码高亮 / Mermaid / LaTeX)
- 实现 S3 兼容协议同步 (AWS S3 / 阿里云 OSS / MinIO 等)
- 实现可扩展插件系统 (前端 WebExtension 风格)
- 实现多平台打包 (Windows / macOS / Linux)，并预留移动端 / Web 端扩展点

## Impact
- Affected specs: 无 (全新项目)
- Affected code: 项目根目录下所有新增文件
  - `src-tauri/` Rust 后端 (核心服务、文件 IO、索引、同步、插件宿主)
  - `src/` Web 前端 (编辑器、视图、设置面板)
  - `docs/` 架构与开发文档

## 架构概览
```
┌─────────────────────────────────────────────────────────────┐
│  Web 前端 (React + TypeScript + Vite)                        │
│  ├─ Editor     (CodeMirror 6 / Monaco)                       │
│  ├─ GraphView  (Cytoscape.js / Sigma.js)                    │
│  ├─ FileTree   (文件夹 + 标签)                              │
│  ├─ Search     (全文 / 标题 / 反向链接)                      │
│  └─ Settings   (主题 / 插件 / 同步配置)                       │
└─────────────────────┬───────────────────────────────────────┘
                      │ Tauri IPC (invoke / event)
┌─────────────────────▼───────────────────────────────────────┐
│  Rust 后端 (Tauri 2.x)                                       │
│  ├─ fs:        文件系统监听 (notify-rs)                      │
│  ├─ index:     SQLite 索引 (rusqlite) — 元数据 / 链接 / 标签 │
│  ├─ parser:    Markdown 解析 (pulldown-cmark + 自定义扩展)   │
│  ├─ sync:      S3 客户端 (aws-sdk-s3 / rusoto)               │
│  ├─ plugin:    插件宿主 (WASM 沙箱 / JS 子进程)              │
│  └─ crypto:    本地加密 (AES-GCM，可选)                     │
└─────────────────────────────────────────────────────────────┘
```

## ADDED Requirements

### Requirement: 多平台桌面应用骨架
系统 SHALL 提供一个基于 Tauri 2.x 的跨平台桌面应用骨架，可在 Windows / macOS / Linux 上构建和运行，并通过同一套前端代码提供统一的用户界面。

#### Scenario: 首次启动
- **WHEN** 用户从官网下载并安装 NoteGo
- **THEN** 应用启动后展示欢迎页，引导用户选择/创建 Vault（笔记库目录）
- **AND** 自动初始化该目录的索引数据库

#### Scenario: 跨平台构建
- **WHEN** 开发者执行 `pnpm tauri build`
- **THEN** 系统根据当前操作系统生成对应安装包 (.msi / .dmg / .AppImage / .deb)

### Requirement: 本地 Markdown 笔记管理
系统 SHALL 将所有笔记以标准 Markdown (`.md`) 文件形式存储在用户选择的 Vault 目录中，并构建一个 SQLite 索引来加速元数据查询。

#### Scenario: 新建笔记
- **WHEN** 用户点击"新建笔记"按钮或使用快捷键 `Ctrl/Cmd + N`
- **THEN** 系统在当前目录创建 `.md` 文件，文件名按模板（标题 + 时间戳）生成
- **AND** 在索引中插入对应记录

#### Scenario: 实时监听外部修改
- **WHEN** 用户使用外部编辑器修改了 Vault 中的 `.md` 文件
- **THEN** 系统通过 `notify` 检测到变更
- **AND** 自动重新解析该文件并更新索引
- **AND** 通知前端刷新对应视图

#### Scenario: 删除/重命名/移动
- **WHEN** 用户在文件树中执行删除 / 重命名 / 拖拽移动操作
- **THEN** 系统同步修改底层文件
- **AND** 自动修复受影响的 `[[双向链接]]`，将失效链接重定向到新名称

### Requirement: 双向链接 (Wiki Link)
系统 SHALL 支持 Obsidian 风格的 `[[笔记标题]]` 与 `[[笔记标题|别名]]` 双向链接语法，并能解析 `[[目录/子笔记]]` 路径形式。

#### Scenario: 创建链接
- **WHEN** 用户在编辑器中输入 `[[`
- **THEN** 系统弹出自动补全面板，列出当前 Vault 匹配笔记
- **WHEN** 用户选中目标笔记
- **THEN** 插入 `[[目标笔记]]` 文本，并实时渲染为可点击链接

#### Scenario: 反向链接面板
- **WHEN** 用户打开任一笔记
- **THEN** 右侧"反向链接"面板显示所有引用了该笔记的其他笔记列表（按段落 / 行号聚合）
- **AND** 点击反向链接可跳转到来源位置

#### Scenario: 悬停预览
- **WHEN** 用户将鼠标悬停在 `[[双向链接]]` 上
- **THEN** 系统弹出小卡片，展示目标笔记的标题、前 500 字内容、标签

### Requirement: 标签系统
系统 SHALL 支持 `#标签` 内联标签与 YAML Front Matter 标签，并提供标签树视图与按标签过滤功能。

#### Scenario: 内联标签
- **WHEN** 用户在正文中输入 `#tagName` 且 `tagName` 不包含空格
- **THEN** 系统识别为标签并在索引中建立关联

#### Scenario: 标签面板
- **WHEN** 用户打开侧边栏"标签"视图
- **THEN** 系统以树形 / 嵌套形式展示所有标签及对应笔记数
- **AND** 支持点击标签查看包含该标签的所有笔记

### Requirement: Markdown 增强渲染
系统 SHALL 在阅读模式下渲染以下扩展语法：表格、任务列表、代码块语法高亮、Mermaid 图表、LaTeX 数学公式、脚注、Callout 块（`> [!note]`）。

#### Scenario: Mermaid 渲染
- **WHEN** 笔记中存在 ` ```mermaid ` 代码块
- **THEN** 阅读模式下渲染为对应的流程图 / 时序图 / 类图

#### Scenario: LaTeX 渲染
- **WHEN** 笔记中存在 `$inline$` 或 `$$block$$` 数学公式
- **THEN** 系统使用 KaTeX 渲染为可视化公式

### Requirement: 知识图谱视图
系统 SHALL 提供基于力导向算法的知识图谱视图，节点表示笔记，边表示双向链接。

#### Scenario: 打开图谱
- **WHEN** 用户点击工具栏"图谱"按钮
- **THEN** 系统渲染当前 Vault 的全局图谱，节点按笔记标题展示
- **AND** 节点大小与连接数（度数）正相关
- **AND** 支持缩放、平移、点击节点跳转

#### Scenario: 局部图谱
- **WHEN** 用户在笔记页面内打开"局部图谱"
- **THEN** 系统展示以当前笔记为中心、N 层邻居的子图

#### Scenario: 过滤图谱
- **WHEN** 用户在过滤框输入标签或关键字
- **THEN** 系统隐藏不匹配的节点与边

### Requirement: 全文搜索
系统 SHALL 提供基于 SQLite FTS5 的全文搜索能力，支持标题、正文、标签、YAML 字段的检索。

#### Scenario: 快速搜索
- **WHEN** 用户按 `Ctrl/Cmd + P` 打开命令面板
- **AND** 输入关键字
- **THEN** 系统实时返回匹配的笔记列表，按相关度排序
- **AND** 高亮显示命中片段

#### Scenario: 高级搜索
- **WHEN** 用户使用 `tag:#project author:kyle` 语法
- **THEN** 系统按字段组合过滤

### Requirement: S3 兼容同步
系统 SHALL 支持通过 S3 兼容协议（AWS S3 / 阿里云 OSS / 腾讯云 COS / MinIO / Cloudflare R2）将 Vault 同步到对象存储。

#### Scenario: 配置同步
- **WHEN** 用户在设置中输入 Endpoint、Bucket、Access Key、Secret Key、Region
- **AND** 点击"测试连接"
- **THEN** 系统通过 S3 ListBucket 验证凭据有效性

#### Scenario: 全量同步
- **WHEN** 用户点击"立即同步"
- **THEN** 系统按以下顺序执行：
  1. 拉取远端清单，与本地索引对比
  2. 上传本地新增 / 修改的文件
  3. 下载远端新增 / 修改的文件
  4. 删除双端都已删除的墓碑文件
  5. 解决冲突（默认保留较新版本 + 副本保留另一版本，命名 `冲突-时间戳.md`）

#### Scenario: 增量同步
- **WHEN** 本地文件被保存
- **THEN** 系统将变更加入防抖队列（默认 5 秒）
- **AND** 防抖结束后自动推送至 S3

#### Scenario: 离线容错
- **WHEN** 网络断开
- **THEN** 系统记录本地变更日志，恢复网络后自动重试

### Requirement: 插件系统
系统 SHALL 提供一个安全的插件扩展机制，允许第三方开发者扩展编辑器、侧边栏、命令、图谱节点样式等。

#### Scenario: 安装插件
- **WHEN** 用户从社区插件市场点击"安装"
- **THEN** 系统下载插件包（`.zip` / `.tar.gz`），校验签名
- **AND** 将插件放入 `<Vault>/.notego/plugins/<plugin-id>/`
- **AND** 加载并在沙箱中执行

#### Scenario: 插件 API
- **WHEN** 插件调用 `notego.api` 暴露的 API
- **THEN** 系统仅授予经过白名单的权限（读文件 / 注册命令 / 注册视图 / 监听事件）
- **AND** 拒绝任何尝试访问文件系统外的 API 调用

#### Scenario: 禁用/卸载
- **WHEN** 用户在设置中禁用插件
- **THEN** 系统立即卸载插件实例，保留文件以便恢复

### Requirement: 主题与外观
系统 SHALL 提供亮色 / 暗色两套内置主题，并允许用户通过 CSS 覆盖。

#### Scenario: 切换主题
- **WHEN** 用户在设置中选择"暗色"或系统自动跟随
- **THEN** 系统立即应用主题，所有视图同步刷新

#### Scenario: 自定义 CSS
- **WHEN** 用户在 `<Vault>/.notego/appearance.css` 写入自定义样式
- **THEN** 系统在主题加载后追加该 CSS，实现覆盖

### Requirement: 性能与可扩展性
系统 SHALL 保证在 10,000 篇笔记 / 50,000 个链接规模下仍能流畅运行。

#### Scenario: 索引构建
- **WHEN** 用户首次打开一个 10,000 笔记的 Vault
- **THEN** 系统在 30 秒内完成全量索引构建并进入可用状态

#### Scenario: 增量更新
- **WHEN** 用户修改单篇笔记
- **THEN** 系统在 200ms 内完成解析、索引更新、UI 刷新

## MODIFIED Requirements
无 (全新项目)。

## REMOVED Requirements
无 (全新项目)。

## 安全与隐私
- 所有笔记默认本地存储，绝不上传到 S3 以外的服务器
- S3 凭据使用操作系统级安全存储 (Windows DPAPI / macOS Keychain / Linux Secret Service)
- 插件运行在受限沙箱 (WASM 或受限 JS 上下文)
- 同步流量使用 HTTPS / TLS 1.2+
- 提供 Vault 级可选加密 (AES-256-GCM)

## 验收里程碑
1. **M1 骨架**：Tauri 项目可启动，"新建 / 打开 / 保存 .md" 闭环
2. **M2 索引**：双向链接、反向链接、标签、搜索可用
3. **M3 视图**：图谱、Markdown 增强渲染、主题
4. **M4 同步**：S3 同步、冲突解决、离线容错
5. **M5 插件**：插件市场、安装、API 沙箱
6. **M6 打包**：Windows / macOS / Linux 跨平台构建，签名与自动更新
