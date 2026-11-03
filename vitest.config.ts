import { defineConfig } from "vitest/config";

// 与 vite.config.ts 分开：纯逻辑单测不需要 react 插件，
// 也避免把 build.outDir 之类的配置带进测试环境。
export default defineConfig({
  test: {
    environment: "node",
    // tsx 也要收：要渲染 App 的用例得用 JSX，而 .test.ts 写不了。
    // 环境仍是 node —— 需要 DOM 的文件用文件头的
    // `// @vitest-environment jsdom` 单独声明，不要把全局环境改成 jsdom。
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // 串行执行测试文件。本机宿主在多个 worker 同时写 vite 的模块缓存时会返回
    // EPERM，失败表现不是"报错"而是**某个测试文件被静默跳过**（总数变少、
    // 看起来像"用例没写"）。串行后 4 个文件全量收集。
    fileParallelism: false,
  },
});
