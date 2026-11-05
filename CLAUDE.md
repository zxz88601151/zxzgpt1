# zxz 项目记忆

一个只做外壳的本地 AI 对话桌面端：Tauri 2 + Rust 做网络与文件，React + TypeScript + Vite 做界面。
不绑定任何一家模型厂商，只接 OpenAI 兼容接口。

## 架构边界（改代码前先对齐这几条）

- 一次发送的轮循环在 `src/orchestration/session.ts` 的 `runRounds(deps)`，**该目录不 import react**
  （可在 Node 下单测）。`App.tsx` 只装配依赖：`chat` / `tools()` / `commitMessages` / `patchMessage` /
  `executeTool` / `writeFiles` / `readFiles` / `readRefs` / `runTest` / `currentWorkspace`。
  给循环加副作用时必须新增 deps 字段，并同步更新 `src/app.rounds.test.tsx` 的夹具——
  那里用假上游 + 假 IPC 驱动真实 `runRounds`，装配漏一个就会当场变红。
  `session.ts` 现在还含 `runToolBatch`（只读并发扇出 / 写与执行串行）与 `maybeCompact` 调用；
  新增 deps 已有 `summarize` / `patchConversation` / `maxRounds`。`App.tsx` 仍是 1550 行的装配中心，
  ADR 0001 的「< 500 行」未达成，**不要再把新能力的接线往 App 里堆**。

- 前端只做展示与编排，不直接碰磁盘：本机读写统一走 Tauri IPC，校验在 Rust 侧 `src-tauri/src/fsx.rs`；受控命令同理走 `run_allowed` IPC，校验在 `src-tauri/src/runx.rs`（两模块都不依赖 tauri，fs-harness 可直接单测）。
- `fsx.rs` 不依赖 tauri，这样 `tools/fs-harness` 可以在无窗口环境下单测路径校验与落盘。
- 模型与程序的协议：工具调用优先，文本约定作回退。
  - 工具调用开启时：`src/lib/registry.ts` 的 `TOOLS` 是**内置工具的唯一真值源，现为 11 个**：
    `read_file / list_dir / search_files / write_file / edit_file / apply_patch /
    run_command / web_search / todo_write / glob / explore`
    （原生 `tool_calls` 协议，下一轮展开成 assistant tool_calls + tool 消息）。
    `search_files` 支持 `regex=true`；`glob` 匹配相对路径；`explore` 派只读探索子代理
    （独立上下文、最多 4 轮、工具集 = 探索三件套 + `glob` + `web_search`）。
    **MCP 插件工具是另一套动态清单**（`src/lib/mcp.ts` 的 `mcpToolDefs`，`App.tsx` 拼到
    `TOOL_DEFS` 后面），**不在 `TOOLS` 注册表内**，计划/探索拦截由
    `executeMcpToolCall` 自己实现——详见下方安全红线，别把它当内置工具改注册表；
    `file:` / `@@read:` 只作不支持工具的兼容端回退，不要在工具可用时混用两套协议。
  - 补丁工具只改已存在的文件：`edit_file` 单处精确替换、`apply_patch` 多 hunk，
    old_text 必须逐字命中且恰好一次，不做模糊匹配；落盘复用 write_file 的
    备份/确认/回读校验。
  - 探索模式（`exploreMode`）：只读三件套 `read_file / list_dir / search_files`
    是硬编码名单，将来新增工具默认不认；发工具定义与执行层两道门拦截写与跑命令，
    `file:` 块也不落盘。
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
- **MCP 工具已纳入统一权限视图并默认 `Ask`**（2026-11-06，ADR 0004 / D-18 已修）：
  `lib/toolpolicy.ts` 把内置 / MCP 动态 / 未知三类解析成同一张策略表，动态工具是
  `access: exec` / `approval: ask` / `cost: expensive`；`mcp_call_tool` IPC 必带
  `session_id`，Rust 侧 `perms::guard_mcp` 是权威闸门，未授权回 `need_grant` →
  复用 `askExec` 弹框 → `perm_grant` 记账 → 重试，scope = `["mcp", server, tool]`。
  **审批通道缺失时 `executeMcpToolCall` 必须 fail-closed 直接拒绝**，改这条链路别把这个
  性质弄丢。缺省 `context-mode` 仍为 `enabled: false`；`mcp.json` 在应用配置目录
  （工程根之外）且有校验，「模型改配置 → 自动拉起任意命令」这条链本来就不成立。
- **子代理复用主链路取消信号**（D-17 已修）：`App.tsx` 把本轮 `controller.signal`
  存进 `mainSignalRef` 交给 `runSubagent`；`runRounds` 每轮前检查 `signal.aborted`，
  `runSubagent` 每轮请求前再查一次、停止后不返回残缺摘要。动停止链路或并行调度时
  别把这两个检查拆掉。**`runToolBatch` 的任何异常都必须补成 `error` 记录，
  `records` 不许留空洞**（D-20 已修）。
- 预览窗口 `open_preview` 接受任意 http(s) 或任意**存在的本地文件**（不限工程根、不限扩展名），
  用 `WebviewUrl::External` 新开 WebView。External URL 的 CSP 是否生效**没有真机证据**，
  改预览或 CSP 前先按上面那条要求做宿主 DevTools 验证（D-23）。

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

2026-11-05 独立审计实测基线（HEAD `2083011`，Ubuntu 沙箱）：`npm ci` PASS、
`npm test` **545 passed / 6 skipped（29 文件）**、`npm run build` PASS（365,04 kB）、
三处版本号均 0.3.0、CI 23 次运行最新 `passing`。
本环境**未跑**：Rust 测试、本地 e2e、真机 CSP、打包（均标 `NOT_TESTED`，别据此写 PASS）。
完整结论见 `docs/audit/HEAD_2083011_INDEPENDENT_AUDIT_20261105.md` 与
`docs/governance/STATE.md`（唯一权威状态板）。
