import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";

/**
 * 应用入口
 * - 在生产构建中以 Tauri 形式嵌入 WebView
 * - 端口 1420 与 Tauri `devUrl` 保持一致
 */
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
