import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 的 beforeDevCommand 会起这个 dev server，devUrl 固定 1420 端口，
// 所以 strictPort 必须开：端口被占时宁可失败，也不要悄悄换端口让窗口白屏。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: true,
  },
});
