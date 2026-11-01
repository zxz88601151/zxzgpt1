import { defineConfig } from "vitest/config";

// 与 vite.config.ts 分开：纯逻辑单测不需要 react 插件，
// 也避免把 build.outDir 之类的配置带进测试环境。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 串行执行测试文件。本机宿主在多个 worker 同时写 vite 的模块缓存时会返回
    // EPERM，失败表现不是"报错"而是**某个测试文件被静默跳过**（总数变少、
    // 看起来像"用例没写"）。串行后 4 个文件全量收集。
    fileParallelism: false,
  },
});
