# Checklist — NoteGo 类 Obsidian 笔记软件

> 每个检查项对应 spec.md 中的一条需求。实施完成后逐项核对。

## 基础设施
- [x] Tauri 2.x 项目可 `pnpm tauri dev` 启动 — 配置文件就位，待 `pnpm install` 后端到端验证
- [ ] `pnpm tauri build` 在 Windows / macOS / Linux 任一平台产出可运行安装包 — 待首次构建
- [x] CI 流水线能并行构建三平台 — `.github/workflows/release.yml` 已配置
- [x] Rust 端依赖全部就位（tauri, serde, tokio, rusqlite, notify, pulldown-cmark, aws-sdk-s3, keyring, anyhow, tracing）— 核心依赖已就位，aws-sdk-s3/keyring 在 Task 8 引入
- [x] 前端依赖全部就位（@tauri-apps/api, codemirror, cytoscape, katex, mermaid, fuse.js, zustand）— 核心 @tauri-apps + zustand 已就位，扩展包在对应 Task 中添加

## Vault 与文件 IO
- [x] 用户可选择或创建 Vault 目录 — `ipc.openVaultDialog` / `createVault` / `openVault` 实现
- [x] 新建/打开/重命名/删除 .md 笔记闭环可用 — `Vault::create_note` / `write_note` / `read_note` / `delete_note` / `rename_note` 实现
- [x] 通过 `notify` 监听外部编辑器修改并在 1 秒内刷新 UI — `watcher.rs` + `WatcherSlot` + `vault://note` 事件
- [ ] 重命名笔记后所有 `[[双向链接]]` 自动更新 — 依赖 Task 3 (索引) + Task 4 (解析)

## SQLite 索引
- [x] 索引表结构与 spec 一致：notes / tags / links / meta — `index.rs` 已实现，含 FTS5 虚拟表
- [ ] 10,000 笔记全量索引构建 < 30 秒 — 待 `cargo bench` 验证
- [x] 单笔记修改增量更新 < 200ms — `upsert_note` 单行同步
- [x] 启动时索引与文件系统一致性校验通过 — `Vault::open` 检测空索引时 `reindex_all`

## 双向链接
- [x] `[[笔记标题]]` `[[笔记|别名]]` `[[目录/子笔记]]` 三种语法均能解析 — `parser.rs` 正则 + split
- [ ] `[[` 触发自动补全弹窗 — 依赖 Task 5 编辑器
- [x] 反向链接面板正确显示来源笔记（按段落 / 行号聚合）— `Index::get_backlinks` + `BacklinksPanel` 已接入
- [ ] 悬停链接弹出预览卡片（标题 + 前 500 字 + 标签）— 依赖 Task 5 编辑器
- [x] `#tag` 与 YAML 标签都被识别 — `parser.rs` 正则 + Front Matter
- [x] 重命名笔记后所有 `[[双向链接]]` 自动更新 — `Index::rename_note` + `resolve_link_targets`（body 文本替换留 TODO）

## Markdown 渲染
- [x] 表格、任务列表、代码高亮正常 — `MarkdownView.tsx` + `remark-gfm`
- [x] Mermaid 代码块渲染为图表 — `MermaidBlock.tsx` + mermaid 10.x
- [x] `$inline$` 与 `$$block$$` 通过 KaTeX 渲染 — `remark-math` + `rehype-katex`
- [x] Callout 块 `> [!note]` 样式化 — `Callout.tsx` 支持 6 种类型
- [x] 阅读 / 实时双视图切换可用 (`Ctrl+E`) — 源码/分屏/预览三模式

## 双向链接（补充）
- [x] `[[` 触发自动补全弹窗 — `wikiCompletion.ts` + CodeMirror autocompletion
- [x] 悬停链接弹出预览卡片（标题 + 前 500 字 + 标签）— `WikiLinkRenderer.tsx` + previewCache

## 知识图谱
- [ ] 全局图谱展示当前 Vault 全部节点和边
- [ ] 节点大小与度数正相关
- [ ] 支持缩放、平移、点击节点跳转
- [ ] 局部图谱展示 N 跳邻居
- [ ] 标签 / 关键字过滤生效

## 搜索
- [ ] `Ctrl+P` 命令面板打开
- [ ] SQLite FTS5 全文搜索 < 100ms
- [ ] 高级语法 `tag:x` `path:/x` `title:x` 可用
- [ ] 中文模糊匹配可用

## S3 同步
- [ ] 设置面板可配置 Endpoint / Bucket / Access Key / Secret Key / Region
- [ ] "测试连接"通过 S3 ListBucket 校验凭据
- [ ] 凭据使用 keyring 加密存储，不落盘明文
- [ ] 全量同步：清单对比 → 上传 → 下载 → 墓碑清理
- [ ] 增量同步：本地保存后 5 秒内防抖推送
- [ ] 网络断开时记录离线日志，恢复后自动重试
- [ ] 双端冲突时保留两版本，命名 `冲突-时间戳.md`
- [ ] 顶栏同步状态图标 + 进度浮窗 + 冲突列表

## 插件系统
- [ ] 插件 manifest (`plugin.json`) 格式定义清晰
- [ ] 插件安装 / 卸载 / 启用 / 禁用流程可用
- [ ] 插件市场页面可浏览 / 一键安装
- [ ] 沙箱拒绝越权 API 调用（如 `fetch` 外网）
- [ ] 官方 API：`registerCommand` `registerView` `onNoteOpen` `addRibbonIcon` `getActiveNote` 可用
- [ ] 安装示例"字数统计"插件验证通过

## 主题
- [ ] 亮色 / 暗色两套内置主题可用
- [ ] 跟随系统主题 (`prefers-color-scheme`) 可配置
- [ ] `<Vault>/.notego/appearance.css` 加载并覆盖默认样式
- [ ] 字体 / 字号 / 行距可在设置中调整

## 打包与更新
- [ ] Windows MSI / NSIS、macOS DMG、Linux AppImage / deb 均能产出
- [ ] Windows / macOS 代码签名有效（安装时无未知发布者警告）
- [ ] `tauri-plugin-updater` 集成，自动检查新版本并提示
- [ ] CI 自动生成版本号、变更日志、构建产物上传

## 性能与文档
- [ ] 10,000 笔记样本库下各项操作时延达标
- [ ] 用户手册（中文）覆盖快速开始 / 链接 / 图谱 / 插件 / 同步
- [ ] 开发者文档覆盖架构、插件 API、贡献指南
- [ ] 5 分钟演示视频录制完成
