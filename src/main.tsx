import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import { setupNoteEventBridge } from "./lib/noteEvents";

/**
 * 应用入口
 * - 在生产构建中以 Tauri 形式嵌入 WebView
 * - 端口 1420 与 Tauri `devUrl` 保持一致
 */

// 注册全局笔记事件桥接（[[wiki]] 跳转 → store.openNote）
setupNoteEventBridge();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
