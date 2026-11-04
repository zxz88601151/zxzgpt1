# zxz 项目记忆

一个只做外壳的本地 AI 对话桌面端：Tauri 2 + Rust 做网络与文件，React + TypeScript + Vite 做界面。
不绑定任何一家模型厂商，只接 OpenAI 兼容接口。

## 架构边界（改代码前先对齐这几条）

- 一次发送的轮循环在 `src/orchestration/session.ts` 的 `runRounds(deps)`，**该目录不 import react**
  （可在 Node 下单测）。`App.tsx` 只装配依赖：`chat` / `tools()` / `commitMessages` / `patchMessage` /
  `executeTool` / `writeFiles` / `readFiles` / `readRefs` / `runTest` / `currentWorkspace`。
  给循环加副作用时必须新增 deps 字段，并同步更新 `src/app.rounds.test.tsx` 的夹具——
  那里用假上游 + 假 IPC 驱动真实 `runRounds`，装配漏一个就会当场变红。

- 前端只做展示与编排，不直接碰磁盘：本机读写统一走 Tauri IPC，校验在 Rust 侧 `src-tauri/src/fsx.rs`；受控命令同理走 `run_allowed` IPC，校验在 `src-tauri/src/runx.rs`（两模块都不依赖 tauri，fs-harness 可直接单测）。
- `fsx.rs` 不依赖 tauri，这样 `tools/fs-harness` 可以在无窗口环境下单测路径校验与落盘。
- 模型与程序的协议：工具调用优先，文本约定作回退。
  - 工具调用开启时：`read_file / list_dir / search_files / write_file / run_command`
    五个工具（定义在 `src/lib/tools.ts`，原生 `tool_calls` 协议，下一轮展开成
    assistant tool_calls + tool 消息）；`file:` / `@@read:` 只作不支持工具的
    兼容端回退，不要在工具可用时混用两套协议。
  - 文本回退：`` ```file:相对路径 `` → 程序写入磁盘（整文件覆盖）；
  - 单独一行 `@@read: 相对路径` → 程序回传真实文件内容，继续下一轮；
  - 普通代码块只展示，永远不落盘。
- 受控执行（0.3.0 起，第一次改掉“不执行命令”的旧定位）：`run_command` 只允许
  测试、构建、只读 Git，白名单在 `src/lib/tools.ts` 与 `src-tauri/src/runx.rs`
  各有一份且必须一致；argv 白名单之外还有第二层：npm/npx 真正执行的
  package.json 脚本必须逐段落在受信任运行器清单里（vitest / jest / mocha /
  node --test / tsc / vite / eslint），审计在 Rust `runx::check_npm_script`
  权威执行，前端 `checkNpmCommandScript` 只是提前拦截。不走 shell，工作目录
  只限工程根，超时 60 秒，输出各截断 20000 字符；Rust 侧每次重新校验，绝不信任
  前端 argv。写完文件后自动跑 `npm test`，失败回传报错再改，最多 3 轮，3 轮不过
  停下报人。
- 列目录有两条通道，不许混用：`fs_list`（任意绝对路径）只服务文件夹选择器；
  模型工具 `list_dir` / `search_files` 必须走 `fs_list_in`（root+rel，canonicalize
  后仍在工程根内，符号链接借道也算越界）。
- 写入默认自动落盘，但有两道人工门禁：设置里的“计划模式”（只出方案不落盘）、
  “写入前确认”（先看差异再批）。不要把默认改回“悄悄写”而不更新 README 第 10 节。
- 覆盖已有文件前，旧内容必须先备份到工程内 `.zxz/undo/<时间戳>/`；落盘后要回读校验，
  回读不一致不能算“写好了”。
- 听写 V1（按住说话）：只接浏览器语音识别（Web Speech API，需联网、音频发给浏览器厂商转录，**不是离线识别**）；转录只填进输入框，绝不自动发送、不触发工具/写入/命令；失败只 toast，输入框原文字不动。离线 Whisper 是后续 V1b，单独一题。
- 技能是 `SKILL.md`：frontmatter 写 `name / description / triggers`，正文写规则。
  启用后正文进系统提示；渐进加载：没启用不花 token，启用只发正文 + 目录清单，
  附件靠 `@@ref:` 按需取。内建技能在 `src/skills/builtin/`，与外部技能走同一套解析器。

## 安全红线

- 相对路径只允许普通段：拒绝 `..`、绝对路径、盘符；落盘前对父目录做 `canonicalize`，
  确认没有借符号链接逃出工程根；目标若已是符号链接，要确认指向仍在工程内。
- 读文件上限 4MB、只接受 UTF-8 文本；目录树深度 2，忽略 `node_modules / .git / target / dist / .zxz`。
- API Key 只存本机 `localStorage`（键 `zxz.state.v1`），明文存放、不外发；不要把它写进
  任何导出的审计清单、扫描结果或日志里。
- 本机代理 `src-tauri/src/proxy.rs` 只监听 127.0.0.1、每次请求要带一次性 token
  （令牌用 OS 熵初始化的 `RandomState` 生成 256 位，别退回「时间 ^ pid」那种可预测写法）；
  进入后还要校验 Host 是回环名（`127.0.0.1`/`localhost`），挡 DNS rebinding。
  `/models` 的 `base_url`/`api_key` 走 POST 请求体，不再拼进 URL（Key 不进请求行/日志）；
  `read_request` 在读 body 前用 `MAX_BODY_BYTES`（32MB）卡 Content-Length，超大直接 400，
  防本机进程用超大长度把内存打满。跑代理契约用 `node tools/proxy-e2e.cjs <harness exe>`（需先起 mock）。
- WebView CSP 在 `tauri.conf.json` 的 `csp`（生产，`script-src 'self'`，Tauri 会给自有脚本注入
  nonce/hash）与 `devCsp`（开发，额外放 `unsafe-inline` 给 Vite react-refresh/HMR）。CSP 只在真实
  `tauri dev`/打包运行时注入，headless 测不到——改了 CSP 必须在真机 DevTools 看有无 CSP 报错再算完成。
- 扫描技能时只给行号与语境（代码块 / 劝阻 / 正文），不给危险分：同一条命令写在
  拦截规则表里是防护，写在卸载脚本里才是风险。

## 改动纪律

- 纯逻辑优先抽成可单测的函数，放 `src/lib/`，测试放同名 `.test.ts`，跑 `npm test`。
- 不要在改动里顺带重构无关文件；不要把构建产物（`dist/`、`target/`）入库。
- 改了行为就同步改 README 对应章节；README 里的数字（单测条数、e2e 项数、技能数）
  必须与实际跑出来的结果一致，不能凭印象写。
- 本仓库的模拟测试不消耗真实 token：`tools/mock-upstream.cjs` + `tools/e2e.cjs`；
  真模型端到端脚本（`live-deepseek-e2e.cjs`）只在人工确认后跑，跑完要还原工程与 localStorage。

## 常用命令

```sh
npm install
npm test            # vitest 纯逻辑单测
npm run build       # tsc + vite build
cargo test --manifest-path tools/fs-harness/Cargo.toml  # Rust 文件层单测
```
