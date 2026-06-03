# NoteGo

> 本地优先的 Markdown 知识库 — 类 Obsidian 笔记软件，支持双向链接、知识图谱与 S3 同步。

## 技术栈

- **后端**：Rust + Tauri 2.x
- **前端**：React 18 + TypeScript + Vite 5
- **存储**：本地 Markdown 文件 + SQLite 索引（`rusqlite` bundled）
- **包管理**：pnpm（推荐）

## 目录结构

```
NoteGo/
├── src/                    # 前端 React 源码
│   ├── components/         # UI 组件
│   ├── lib/                # IPC 封装、工具
│   ├── styles/             # 全局样式
│   ├── types/              # TypeScript 类型
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/              # Rust 后端
│   ├── src/                # fs / index / parser / sync / commands
│   ├── capabilities/       # Tauri 权限配置
│   ├── icons/              # 应用图标（待补充）
│   ├── Cargo.toml
│   └── tauri.conf.json
├── .github/workflows/      # CI：三平台构建
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## 快速开始

> 需要预先安装：Node.js ≥ 18、Rust（stable）、`pnpm`（可选）。

```bash
# 1. 安装依赖
pnpm install          # 推荐
# 或 npm install

# 2. 启动开发模式（前端 + Tauri 主进程）
pnpm tauri:dev

# 3. 构建生产安装包（三平台）
pnpm tauri:build
```

## 当前状态

这是 **Task 1：项目骨架** 阶段，仅搭建目录与最小可运行结构。后续 Task 将依次实现：

- Task 2：Vault / 文件 CRUD
- Task 3：SQLite 索引与文件监听
- Task 4：Markdown 解析、双向链接
- Task 5：CodeMirror 6 编辑器
- Task 6：知识图谱
- Task 7：标签与搜索
- Task 8：S3 同步
- Task 9：自动更新
- Task 10：发布流水线

## 许可

MIT
