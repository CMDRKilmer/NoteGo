import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite 启动配置 - 固定端口 1420 与 Tauri 一致
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 1421,
    },
    watch: {
      // 忽略 Rust 编译输出目录，避免不必要的重启
      ignored: ["**/src-tauri/**"],
    },
  },

  // Tauri 在生产环境会读取 dist/
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  optimizeDeps: {
    // Mermaid 体积较大且自身包含复杂依赖图，交给 Vite 直接预构建可能
    // 触发重复依赖 / ESM 兼容问题。排除后由 Vite 在首次访问时按需加载。
    exclude: ["mermaid"],
  },
}));
