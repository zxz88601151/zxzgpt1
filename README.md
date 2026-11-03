# zxz

一个**只做外壳**的本地 AI 对话桌面端：内嵌网页做界面，网络请求全部由 Rust 侧完成。
填上任意一家 OpenAI 兼容接口的 Base URL + API Key + 模型名即可开聊，不绑定任何一家厂商。

技术栈：**Tauri 2 + Rust（edition 2021）**，前端 **React 18 + TypeScript + Vite**（`src/`，构建产物落在 `dist/`）。
Markdown 渲染与代码高亮仍然自己实现，没有引入 marked / highlight.js 之类运行时依赖。

---

## 1. 目录结构

```
zxz/
├── index.html                  Vite 入口
├── package.json                React / Vite / Vitest 依赖
├── vite.config.ts              dev 固定 1420（Tauri devUrl），build → dist/
├── vitest.config.ts            纯逻辑单测（node 环境，串行执行）
├── src/                        ★ 前端源码
│   ├── main.tsx                挂载 React
│   ├── App.tsx                 状态编排：会话 / 发送 / 快捷键 / 主题
│   ├── types.ts                会话、消息、设置、事件类型
│   ├── presets.ts              8 家服务商预设 + 默认设置 + 欢迎卡片
│   ├── state.ts                存储读写、上下文窗口、会话过滤（纯函数，可单测）
│   ├── api.ts                  双通道传输层 + SSE 解析（代理 / 直连）
│   ├── styles.css              样式（深色 / 浅色双主题）
│   ├── orchestration/
│   │   └── round.ts            轮末判定（纯函数：停/继续、停止提示、自动测试门禁）+ 单测
│   ├── lib/
│   │   ├── md.ts               自实现 Markdown 渲染
│   │   ├── hl.ts               自实现代码高亮（5 类 token）
│   │   ├── text.ts             escape / clamp / uid / 复制 / 上下文切片
│   │   ├── files.ts            file: 块/@@read 解析、路径校验、读写提示词
│   │   ├── diff.ts             行级 LCS diff（前后缀裁剪 + 大文件退化）
│   │   ├── undo.ts             撤销栈：列快照 / 读某一版 / 恢复（恢复也可撤销）
│   │   ├── skill.ts            SKILL.md 解析、分类/阶段、技能提示词、触发词匹配、@@ref 协议
│   │   ├── skillstore.ts       外部技能库扫描（两种目录布局）+ 内建/本地合并
│   │   ├── project.ts          项目记忆（CLAUDE.md / AGENTS.md）+ 计划模式指令
│   │   ├── tools.ts            工具定义、白名单、tool_calls 合并、测试回路决策（纯逻辑）
│   │   ├── pending.ts          写入前确认：待批清单（纯逻辑，不碰 IPC）
│   │   ├── fsapi.ts            本机文件 IPC 封装（列目录 / 读 / 写 / 拼目录树）
│   │   └── *.test.ts           本目录 13 个单测文件（全仓 17 个 / 400 条，见 §9.6）
│   ├── skills/
│   │   ├── index.ts            内建技能装配（?raw 导入，与外部技能同一套解析）
│   │   ├── sources.ts          外部来源登记表（29 条）+ 分组汇总 + 审计清单生成
│   │   ├── sources.test.ts     来源表完整性、改名链接、清单导出
│   │   └── builtin/*.md        12 份编码规范（通用 / React / Node / Python / SQL / 测试 / 审查 / 安全 / 架构 / 调试）
│   └── components/
│       ├── Sidebar.tsx         会话列表 / 搜索 / 通道状态 / 导入导出
│       ├── TopBar.tsx          标题、模型徽标、重新生成、清空、主题
│       ├── MessageList.tsx     消息渲染、流式光标、代码块复制委托
│       ├── Composer.tsx        输入框（自增高 / Enter 发送 / Esc 停止）
│       ├── SettingsDrawer.tsx  设置抽屉（预设、测试连接、拉取模型）
│       ├── FolderPicker.tsx    本地工程：目录浏览弹层
│       ├── FileWrites.tsx      本地工程：自动落盘回执（路径 / 增删行数 / 新建或覆盖）
│       ├── DiffModal.tsx       只读红绿对比：磁盘原内容 vs 现在
│       ├── UndoPanel.tsx       写入历史：列快照、看差异、恢复某一版
│       ├── SkillChips.tsx      输入框上方：已启用技能的胶囊
│       ├── SkillPanel.tsx      技能库两页签：技能（分类分组）/ 来源清单（审计项 + 导出）
│       ├── PendingWrites.tsx   写入前确认面板：勾选文件、看差异、批了才写盘
│       ├── ConfirmExec.tsx     执行授权确认框：仅此一次 / 本工程目录都允许 / 拒绝
│       ├── Welcome.tsx         空会话引导（含人像 hero）
│       └── ui.tsx              图标 / 按钮 / Toast / 头像等通用件
├── dist/                       Vite 构建产物（Tauri 直接托管）
└── src-tauri/
    ├── Cargo.toml              edition 2021，依赖：tauri2 / tokio / reqwest(rustls) / serde
    ├── build.rs
    ├── tauri.conf.json         窗口、打包、beforeDevCommand / devUrl / frontendDist
    ├── capabilities/default.json
    ├── examples/smoke.rs       链路自检：不弹窗口，只拉起本地代理验证 SSE 转发
    ├── icons/                  32/128/256/512 图标 + icon.ico（Windows 资源必需）
    └── src/
        ├── main.rs             入口
        ├── lib.rs              应用装配 + IPC 命令 proxy_info
        ├── fsx.rs              本机文件读写（路径三道校验，不依赖 tauri，可单测）
        ├── runx.rs             受控命令执行（白名单、60 秒超时、输出上限，不依赖 tauri，可单测）
        ├── proxy.rs            本机回环 HTTP/SSE 代理（127.0.0.1 + 一次性 token）
        └── api.rs              OpenAI 兼容客户端：流式对话 / 连接测试 / 模型列表
```

## 2. 数据是怎么走的

```
网页 UI ──(fetch SSE)──> 127.0.0.1:<随机端口> ──(reqwest)──> 各家 /chat/completions
                              ↑ 由 Rust 起
```

- **为什么要绕一层本机代理**：浏览器有 CORS/CSP 限制，且各家对浏览器 Origin 的支持不一致。请求交给 Rust 发，就能接任何 OpenAI 兼容端点。
- **通道安全**：只监听 `127.0.0.1`，每次启动用 OS 熵生成 256 位一次性 token，前端通过 IPC 拿端口和 token，请求必须带 `x-zxz-token` 头，并校验 Host 是回环名（挡 DNS rebinding），本机其它进程无法调用。
  校验的**顺序**也是安全的一部分：先读头、鉴权通过之后才读 body（`read_head` / `read_body` 拆开）。
  合在一起读的话，一个没有 token 的请求也能让代理先收下 32MB——"拒得对"，但内存已经被人牵着走。
  这条有裸 socket 断言守着：声明 `Content-Length: 33554432` 却一个字节都不发，必须立刻拿到 401；
  若代理在等 body，这条只会超时。
- **端口策略**：从 `19527` 起向后探测空闲端口（最多 64 个），被占用自动顺延。
- **双通道降级**：没有 IPC 时（比如用静态服务器直接打开 `dist/`），前端自动切到"浏览器直连"模式，界面功能不变，区别只是请求由浏览器发出。左下角会显示当前通道。

## 3. 已实现的能力

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 流式输出 | PASS | SSE 增量渲染，逐字返回，可随时中止（Esc / 停止按钮） |
| 思维链 | PASS | `reasoning_content`（DeepSeek-reasoner、o 系列等）折叠展示 |
| 多会话 | PASS | 新建 / 重命名（双击）/ 删除 / 搜索，按最近更新排序 |
| 上下文轮数 | PASS | 默认携带最近 10 轮，可在设置里调整 0–100 |
| Markdown | PASS | 标题、列表（含嵌套）、表格、引用、分割线、链接、图片、删除线 |
| 代码高亮 | PASS | 自实现五类 token（注释 / 字符串 / 数字 / 关键字 / 函数调用），带一键复制 |
| 系统提示词 | PASS | 每条请求作为 system 消息发送 |
| token 用量 | PASS | 上游返回 usage 时显示 in / out |
| 服务商预设 | PASS | 8 家预设 + 自定义，可一键拉取远端模型列表 |
| 主题 | PASS | 深色 / 浅色，顶栏按钮即时切换 |
| 导入导出 | PASS | 全部会话导出为 JSON，支持重新导入 |
| 重新生成 | PASS | 顶栏按钮重发最后一条用户消息 |

## 4. 运行

### 4.1 前置依赖

**Rust**（需 1.77.2 及以上）：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**系统依赖 —— Linux**：

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev libsoup-3.0-dev javascriptcoregtk-4.1-dev build-essential pkg-config
```

**系统依赖 —— Windows**：安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) 与 MSVC 生成工具即可（`tauri.conf.json` 已把 `webviewInstallMode` 设为 `downloadBootstrapper`，打包时会自动引导安装）。

> 注意：Windows 上必须有 **MSVC 链接器**（`link.exe`）。只装了 rustup 而没装 Visual Studio 生成工具时，`cargo build` 会报 `link.exe 不是内部或外部命令`／`link: extra operand`（后者说明链接器被 Git 自带的 GNU `link` 顶掉了）。
> 不想装 MSVC 时，可改用 GNU 工具链：把 mingw-w64 的 `bin` 放进 PATH，然后 `cargo +stable-x86_64-pc-windows-gnu build`（本仓库的模拟测试就是这样跑通的）。

**mingw 下编桌面 exe 的三个坑（都实测过）**：

1. **必须临时去掉 `cdylib`。** `src-tauri/Cargo.toml` 里 `crate-type = ["staticlib", "cdylib", "rlib"]` 是为移动端准备的；mingw 链接
   `cdylib` 会直接失败 `error: export ordinal too large: 111144` —— 这是 PE 导出表序号只有 16 位的格式限制，
   **换 lld 也救不了**，`cargo build --bin zxz` 也躲不掉（bin 依赖 lib，lib 仍要出 dll）。编桌面版时改成
   `["rlib"]`，编完改回来（`git diff` 应为空）。
2. **`cargo build`（含 `--release`）不会内嵌前端，必须走 `tauri build`。** 前端资源是否内嵌取决于
   `tauri` CLI 注入的环境变量，拿 `cargo` 直接编出来的 exe 一律指向 `devUrl`，窗口里是 `localhost:1420 拒绝连接`
   —— **debug 和 release 都这样**，只是 release 不带调试信息、体积小（4.5M vs 253M），很容易误以为已经打好了。
   正确的构建命令（gnu 工具链、只出 exe 不打包安装器）：
   ```bash
   # 先把 Cargo.toml 的 crate-type 改成 ["rlib"]（见上面第 1 条）
   PATH="/e/Software/mingw64/bin:$PATH" \
   RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu \
   npx tauri build --no-bundle
   # → src-tauri/target/release/zxz.exe（约 4.8M，含 dist）
   ```
   `RUSTUP_TOOLCHAIN` 不能省：CLI 会检查「当前活动工具链的已安装 target」，默认是 msvc 那个，
   传 `--target x86_64-pc-windows-gnu` 会报 `Target ... is not installed`。
3. **想临时开调试端口，别改配置。** 用 `npx tauri build` 打好的包若要从 Playwright/CDP 连进去，
   在 `tauri.conf.json` 的窗口里加 `additionalBrowserArgs: "--remote-debugging-port=9223"` 再编一次即可；
   注意 WebView2 的 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量**对 Tauri 无效**（它自己设了参数，会覆盖）。
4. **发布版默认不带 devtools（右键"检查元素"）。** `src-tauri/Cargo.toml` 里 `tauri` 依赖不写
   `features = ["devtools"]`。tauri 与 tauri-runtime-wry 的门控都是
   `#[cfg(any(debug_assertions, feature = "devtools"))]`（`tauri-2.12.5/src/webview/mod.rs:2263`、
   `tauri-runtime-wry-2.12.3/src/lib.rs:3937`），所以：
   - `cargo build` / `npm run tauri dev` → 照常有 devtools（`debug_assertions` 对依赖同样为真）
   - `cargo build --release` / `tauri build` → 没有 devtools

   真要给某个发布版排障，用 `--features devtools` 显式打开，**不要**把它改回默认依赖特性——
   那等于给每个用户附赠一个调试接口。
   验证方式（不产出发布物即可确认）：`cargo tree -e features | grep -i devtools` 输出为空。

另外，mingw 链接大 exe 会打印 `warning: linker stderr: .rsrc merge failure: multiple non-default manifests`，
这是 mingw `ld` 合并资源段的已知告警，产物照常运行，不用管。

> 排查时如果 `cargo build` 长时间无输出、`rustc` 进程 CPU 几乎不涨，先看 `rustc --verbose --version` 能不能秒回。
> 本机踩过一次：rustup 在后台把工具链从 1.98.1 更到 1.99.1，更新期间 rustc 被锁住，连查询版本都会挂住，
> 表现和「链接卡死」一模一样。

**macOS**：`xcode-select --install` 即可。

### 4.2 启动

```bash
npm install          # 首次拉前端依赖
npm run tauri dev    # 开发模式（自动起 vite dev server + 弹窗）
npm run tauri build  # 产出安装包（先 npm run build 再打包）

npm run build        # 只构建前端 → dist/
npm run dev          # 只起前端 dev server（http://localhost:1420）
```

`tauri.conf.json` 已把 `beforeDevCommand` / `beforeBuildCommand` / `devUrl` / `frontendDist` 接好，不需要手动改。

> 首次编译会拉取并编译 tauri 依赖树，耗时较长（10 分钟量级），后续为增量。
> 只改前端时用 `npm run build` + 浏览器直连就能验证，不必等 Rust 编译。

## 5. 接入模型

打开左下角**设置**，选服务商预设，填 API Key，模型名可以用「拉取列表」自动获取，也可以手填。

| 服务商 | Base URL | 常见模型 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o`、`gpt-4o-mini`、`gpt-4.1` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat`、`deepseek-reasoner` |
| Moonshot 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-32k`、`moonshot-v1-128k` |
| 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash`、`glm-4-plus` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
| 阿里云百炼（兼容） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`、`qwen-max` |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-pro-32k` |
| Ollama 本地 | `http://localhost:11434/v1` | `qwen2.5:7b`（Key 随意填一个非空值即可） |

填完点「测试连接」，返回"连接正常，模型可用"就可以开始对话了。

## 6. 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Enter` | 发送 |
| `Shift + Enter` | 换行 |
| `Esc` | 停止当前生成 / 关闭设置面板 |
| `Ctrl / Cmd + K` | 新建对话 |
| `Ctrl / Cmd + ,` | 打开设置 |

### 6.1 头像

界面上有两处人像，都来自 `src/assets/`：

| 文件 | 用在哪 | 建议尺寸 |
| --- | --- | --- |
| `avatar.png` | 欢迎页主位（76px 圆角方块 + 右下角 z 角标） | 512×512 |
| `avatar-sm.png` | 每条用户消息左侧的小头像（26px） | 128×128 |

换成自己的照片时保持文件名不变、正方形、头肩居中即可。小图要单独裁紧一点（脸占比更大），否则 26px 下五官会糊。改完 `npm run build` 生效；桌面端的资源是编译进二进制的，必须重新 `cargo build` 才会变。

## 7. 数据存储与安全边界

| 项 | 位置 | 备注 |
| --- | --- | --- |
| 对话记录 | 浏览器 localStorage（键名 `zxz.state.v1`） | 桌面端位于 WebView 的用户数据目录，纯本地 |
| 设置 / API Key | 同上 | 明文存放，不外发；若机器多人使用请自行注意 |
| 请求上游 | Rust 进程发出 | 不经过任何第三方中转 |

## 8. 链路自检（不想打包也能验证）

`examples/smoke.rs` 不启动窗口，只拉起本地代理，用来验证「Rust ⇄ 上游」这一段是否通畅：

```bash
cd src-tauri
cargo run --example smoke
# 输出：
# PORT=19527
# TOKEN=<本次随机令牌>
```

另开一个终端（换成实际输出的 PORT / TOKEN）：

```bash
# 1 探活
curl -H "x-zxz-token: $TOKEN" http://127.0.0.1:$PORT/health
# → {"status":"ok","service":"zxz"}

# 2 拉模型列表（base_url / api_key 走请求体，不进 URL）
curl -X POST -H "Content-Type: application/json" -H "x-zxz-token: $TOKEN" \
  -d '{"base_url":"https://api.openai.com/v1","api_key":"'$KEY'"}' \
  http://127.0.0.1:$PORT/models

# 3 流式对话（真实返回 SSE）
curl -N -H "Content-Type: application/json" -H "x-zxz-token: $TOKEN" \
  -d '{"base_url":"https://api.openai.com/v1","api_key":"'$KEY'","model":"gpt-4o-mini",
       "messages":[{"role":"user","content":"说句 hello"}],"stream":true}' \
  http://127.0.0.1:$PORT/chat
# → data: {"type":"delta","text":"..."} ... data: {"type":"done"}
```

不带 token 的请求一律返回 `401`。

本地 CI 跑过一遍的结果是六个用例全 PASS：探活、模型列表、流式对话、非流式对话（含 usage 回传）、连接测试成功分支、上游 401 错误翻译。

## 9. 没有 API Key 也能跑（模拟测试）

`tools/` 下带一套零依赖的模拟环境，不消耗任何真实 token。

### 9.1 启动模拟上游

```bash
node tools/mock-upstream.cjs 19888
# → http://127.0.0.1:19888/v1
```

它实现 `/v1/models` 与 `/v1/chat/completions`（SSE 流式、非流式、`reasoning_content` 思维链、usage 收尾帧、`[DONE]`），并提供几个开关：

| 触发方式 | 行为 |
| --- | --- |
| `model = bad-key` | 401 `invalid_api_key` |
| `model = unknown-model` | 404 `model_not_found` |
| `model = reasoner-mock` | 先返回思维链再返回正文 |
| 消息含 `[[slow]]` | 每帧间隔 300ms，用于测「停止生成」 |
| 消息含 `[[long]]` | 返回 2000+ 字长文，用于测滚动与渲染 |

`GET /_last` 返回最近一次请求体，方便断言「实际发出去的上下文」。

### 9.2 浏览器直连模式（不需要编译 Rust）

```bash
npx vite --port 1420 --strictPort        # 开发服务器（默认端口就是 1420）
node tools/mock-upstream.cjs 19888       # 模拟上游，零真实 token

node tools/e2e.cjs                       # 24 项，2026-11-03 实测 24/24
# 默认就连 http://localhost:1420，不用再传 ZXZ_BASE（要连别处才传）
```

纯逻辑单测（Markdown / 高亮 / 上下文窗口 / 会话过滤）不需要浏览器：

```bash
npm test                  # vitest run，437 条（18 个文件），2026-11-03 实测
```

**两个本机踩过的坑，写下来省得再踩**：

- 需要覆盖 `ZXZ_BASE` 时用 `http://localhost:1420`，**不要用 `127.0.0.1`**。vite 默认只监听
  `localhost`（落到 `::1`），`127.0.0.1:1420` 会直接 `ECONNREFUSED`。脚本的默认值已经改成
  `localhost:1420`，所以平时不用传。
- 本机若设了 `http_proxy`，`curl` 会绕道代理并返回 502，看着像服务挂了。验证端口用
  `curl --noproxy '*'`。
- **浏览器不再写死 `msedge`。** 所有会启动浏览器的脚本都走 `tools/browser.cjs`，
  按 `ZXZ_BROWSER_CHANNEL` → `msedge` → `chrome` → playwright 自带 chromium 的顺序试。
  以前五个脚本各自写死 `channel: 'msedge'`，在没装 Edge 的机器/CI 上会直接
  `Chromium distribution 'msedge' is not found`——那个报错跟用例内容毫无关系，
  看着像测试坏了，其实是环境缺浏览器。全都不行时的报错会把每次的真实原因列出来。
- **`playwright` 目前不在 `package.json` 里**（只是在 `node_modules` 中），
  `npm ci` 之后会消失。这是 e2e 进不了 CI 的最后一个原因，属「新增第三方依赖」，
  需要业主批准后才能补进 `devDependencies`。

### 9.3 本机代理模式（走真实 Rust 转发）

装了 MSVC 生成工具的话，直接用示例程序：

```bash
cd src-tauri && cargo build --example smoke
cd .. && node tools/proxy-e2e.cjs           # 默认会去找 smoke.exe
```

没有 MSVC 时（mingw 下 tauri 的 `cdylib` 链接会报 `export ordinal too large`，且 `smoke.exe` 会被 MSVC 版 WebView2 导入库拖累），用只依赖 tokio/reqwest 的 harness —— 它通过 `#[path]` **逐字复用** `src-tauri/src/{api,proxy}.rs`，只把 `tauri::async_runtime::spawn` 换成 tokio 运行时（真实 tauri 内部也是 tokio）：

```bash
cd tools/proxy-harness && cargo build
cd ../.. && node tools/proxy-e2e.cjs
```

脚本会先直接对代理验 token 鉴权 / CORS 预检 / 未知路由 / 模型列表 / 非流式对话 / 上游 401 翻译，再把端口与 token 注入 `window.__TAURI_INTERNALS__`，让前端以「本地代理」通道跑一遍完整交互。2026-11-03 实测：接口 11/11 + 前端 24/24。

**两条前置，少一条就白跑**：

- ~~必须先 `ZXZ_BASE=...`~~ **已修**：子进程现在由脚本显式传入 `ZXZ_BASE`，
  默认 `http://localhost:1420`，与 `vite.config.ts` 的端口一致。以前不传会让子进程
  退回 `5173`，报 `waiting for locator('#btnNew') to be visible`，看着像前端挂了。
- **改了 `proxy.rs` 就要重编 harness**。这个坑当场吃过一次：`target-gnu` 里的
  `proxy-harness.exe` 是 11-01 09:34 的，`proxy.rs` 是 11-01 22:07 改的，
  拿旧二进制跑出两条 FAIL（`非回环 Host 被拒` 返回 200、`/models` 报「未知路由」），
  重编之后同样两条都是 PASS。**测试二进制比源码旧时，FAIL 结论无效**——
  先比时间戳再下判断。

### 9.4 本地写代码（工程模式）

前端链路（注入假 IPC，无需桌面端）：

```bash
node tools/workspace-e2e.cjs   # 39 项，实测 39/39（默认连 localhost:1420）
```

> 这份假 IPC 必须跟着真 IPC 的接口走。B4 把撤销备份改到 `undo_write` 专用通道之后，
> 这里没跟上的那段时间，`[[files]]` 落盘会一路失败、卡在等「已落盘」超时——
> 报错信息完全没提撤销，很容易误判成写盘坏了。现在补齐了
> `undo_write` / `undo_read` / `undo_list` / `perm_*`。

真机端到端（走真实 Rust IPC、真写磁盘）：

```bash
# 1) 临时把 --remote-debugging-port 写进 tauri.conf.json 的 windows[0].additionalBrowserArgs
# 2) 重编并启动 exe，3) 跑脚本，4) 记得把配置改回去再重编
node tools/desktop-workspace-e2e.cjs   # 静态 34 项，本轮未跑（见 9.6）
```

Rust 侧路径校验与真实写入（不依赖 tauri，`#[path]` 引用 `fsx.rs` 原文）：

```bash
cd tools/fs-harness && cargo test      # 82 条（另 1 条 60 秒超时用例默认 ignore，用 --ignored 跑）
```

> 必须带 GNU 工具链：`RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu`。
> 本机 msvc 默认工具链会在链接期被 Git for Windows 的 `link.exe` 抢占，
> 报 `link: extra operand`，**而且依然返回 exit 0**——成败只能读日志，不能看退出码。

真模型全流程（选文件夹 → 真读 → 写代码落盘；打的是你在界面里接的模型，不是模拟上游）：

```bash
# 同一个 CDP 前置（临时开 --remote-debugging-port=9223，跑完重编还原）
node tools/live-deepseek-e2e.cjs       # 静态 27 项，本轮未跑（需真 Key，见 9.6）
```

> 这个脚本不改你的 baseUrl / Key / 模型，只在开头读出来断言「确实是真 DeepSeek」，
> 跑完把 localStorage 与工程目录还原。断言落在磁盘：备份快照、回执字节数、`class Cart` 是否真写进去。
> 前置要一个临时工程目录（默认 `F:\zhuomian\zxz\.tmp-live`，脚本每次重建）。

### 9.5 技能库

前端链路（注入假 IPC + 虚拟技能目录，无需桌面端）：

```bash
node tools/skill-e2e.cjs   # 69 项，实测 69/69（默认连 localhost:1420）
```

真机端到端（真目录、真 SKILL.md、真附件读取、审计清单真写盘）：

```bash
node tools/desktop-skill-e2e.cjs    # 静态 21 项，本轮未跑（见 9.6，同样需要先开 CDP 端口编译）
```

### 9.6 覆盖范围（2026-11-03 重测，数字=实测）

**当日实跑，全绿**：

| 脚本 / 命令 | 项数 | 结果 |
|---|---|---|
| `tools/e2e.cjs`（浏览器直连 + 模拟上游） | 24 | **24 PASS / 0 FAIL** |
| `tools/workspace-e2e.cjs`（假 IPC 工程模式） | 39 | **39 PASS / 0 FAIL** |
| `tools/skill-e2e.cjs`（假 IPC 技能库） | 69 | **69 PASS / 0 FAIL** |
| `tools/proxy-e2e.cjs`（真实 Rust 代理，重编后） | 11 + 24 | **11/11 接口 + 24/24 前端** |
| `cargo test --manifest-path tools/fs-harness/Cargo.toml` | 82 + 1 ignored | **82 PASS** |
| `npx vitest run` | 400 / 17 文件 | **400 PASS** |

**当日没跑，只有静态计数**（下表数字是脚本里 `check(...)` 的调用点数量，
不是运行结果；未跑的原因逐个写在最后一列）：

| 脚本 | 静态项数 | 为什么没跑 |
|---|---|---|
| `tools/desktop-workspace-e2e.cjs` | 34 | 需要临时把 CDP 端口编进 exe 并重编——重编产物属业主保留权限 |
| `tools/desktop-skill-e2e.cjs` | 21 | 同上 |
| `tools/live-deepseek-e2e.cjs` | 27 | 需要真实 API Key + CDP 前置 |
| `tools/live-web-round.cjs` | 47 | 同上 |
| `tools/live-tools-e2e.cjs` | 20 | 同上 |
| `tools/live-tools-edge.cjs` | 29 | 同上（历史记录写的是 28/28，与静态计数差 1） |
| `tools/live-skill-e2e.cjs` | 35 | 同上 |

> **不要把静态计数当通过证据**。它只能说明脚本里写了多少条断言，
> 不能说明这些断言今天是不是都过。上表这七个脚本本轮的状态是 `NOT_TESTED`。

**上一版的数字为什么全错**：那些数字是历史记录，脚本后来一直在加断言，README 没跟着改，
于是同一个脚本在两处写成不同值（工程模式一处 18、一处 34；技能库 47、真机技能 17）。
这次全部按当天实跑输出重写，**以后改脚本必须同时改这张表**——
数字过期比没有数字更糟，因为它看起来像证据。

覆盖内容：通道探测、设置抽屉、拉取模型、测试连接、流式逐字输出、Markdown
（标题/列表/嵌套/表格/引用/行内代码/加粗/删除线/外链）、代码高亮与复制按钮、
长文本完整渲染、usage 回显、思维链折叠、停止生成、重新生成不重复追加用户消息、
上下文轮数窗口、多会话/搜索/主题、刷新后持久化、上游 401/404 错误提示、无 JS 运行时错误；
工程模式另含目录选择/新建/重名报错、路径越权拦截、自动落盘、回读校验、diff、撤销与回滚；
技能库另含 frontmatter 解析、分类分组、触发词自动匹配、3 个上限、外部目录扫描与坏技能报错、
29 条来源清单与审计清单导出（无工程时下载、有工程时写进 `.zxz/audit/`）。


## 10. 本地工程模式（让模型直接在你电脑上读写代码）

顶部点「选文件夹」，选一个本地目录后进入工程模式。没有合适的目录就在选择器里点「新建文件夹」——
只在**当前这一层**建一个（不做递归创建），建完直接进去，重名会明确报错而不是悄悄复用旧目录。
名字的合法性（分隔符、`..`、Windows 的 `<>:"|?*` 与 `CON`/`NUL` 这类保留名）全在 Rust 侧判，
前端只负责把错误显示出来。

这里不是"把代码显示给你看"，而是真的读写磁盘。默认仍是自动落盘，
但设置里多了两道人工门禁（见第 13 节）：计划模式先对齐方案再开写，
写入前确认先看差异再批——大改动建议先开其中一个，别直接自动写：

1. 目录树（深度 2，忽略 `node_modules` / `.git` / `target` / `dist` / `.zxz`）随每轮请求发给模型；
2. 模型用 ```` ```file:相对路径 ```` 输出文件 → 默认**程序立即写进磁盘**，不需要点按钮；
3. 对话里只留一段解释 + 一张「已写入 N 个文件」回执（路径、新建/覆盖、体积），
   代码正文不再堆在对话框；
4. 模型要看已有文件时输出一行 `@@read: 相对路径`，程序读真实内容回传后自动再来一轮
   （单次最多 6 轮、每轮最多 6 个文件、单文件回传上限 24000 字符），
   所以它是"先读后改"，不会凭猜测覆盖你的代码；
5. 每轮写完刷新目录树，下一轮模型能看到自己刚写的文件。

### 10.1 看差异

自动写入意味着没有"确认弹窗"这一层保护，所以给你两个事后视角：

1. **回执行右侧有增删行数**（`+12 −3`），一眼看出这次改了多大；
2. **点文件名看红绿对比**：左边是覆盖前磁盘上的内容（来自快照），右边是现在的真实内容——
   两边都是重新读盘，不是内存里的字符串。差异用自实现的 LCS 算，先裁公共前后缀，
   中间块超过 400 万格就退化成「整块替换」，避免大文件把内存吃爆。

### 10.2 回滚

覆盖前旧内容会存到 `<工程根>/.zxz/undo/<时间戳>/<相对路径>`（该目录不进目录树、不发给模型）。
顶栏的时钟图标打开「写入历史」：按时间列出每次快照、里面有哪些文件，可以看差异或恢复某一版。

恢复本身也可撤销——写回之前，当前内容会先存进一个新的时间戳目录，所以"退错了"还能再退回来。

### 10.3 安全边界

三道校验都在 Rust 侧（`src-tauri/src/fsx.rs`），前端只做参数转发：

1. 相对路径只允许普通段 —— 拒绝 `..`、绝对路径、盘符前缀；
2. 根目录必须是绝对路径且真实存在；
3. 真正落盘前对父目录做 `canonicalize`，确认没有借符号链接逃出根目录。

另外：读文件上限 4MB 且只接受 UTF-8 文本；工程目录被删或移动时，启动会自动退出该模式（不然每次写入都只会报「目录不可用」）。

WebView 侧配了 CSP（`tauri.conf.json` 的 `csp` / `devCsp`）：生产 `script-src 'self'`（Tauri 打包时会给自有脚本自动注入 nonce/hash），开发额外放 `unsafe-inline` 给 Vite 的 react-refresh 与 HMR。Markdown 渲染本身已 `escapeHtml` 并拒绝 `javascript:` / `data:` 链接，CSP 是第二层。注意 CSP 只在真实 `tauri dev`/打包运行时注入，headless 测不到——改完要在 DevTools 看有无 CSP 报错。

浏览器直开（`dist/` 静态托管）时没有磁盘访问：点「选文件夹」会提示需要桌面端运行，
此时模型给的 `file:` 块只作为普通代码块展示，不会落盘。

### 10.4 IPC 命令

| 命令 | 作用 |
| --- | --- |
| `fs_roots` | 列出可用盘符 |
| `fs_list` | 列一层目录（目录在前，最多 2000 条） |
| `fs_mkdir` | 在指定目录下新建一层文件夹（选择器里的「新建文件夹」） |
| `fs_read` | 读文本文件 |
| `fs_exists` | 写入前判断是否已存在 |
| `fs_write` | 写入，自动创建父目录 |

## 11. 技能库（可插拔的编码规范）

技能就是一份 `SKILL.md`：frontmatter 写 `name` / `description` / `triggers`，正文写规则。
启用后正文作为一条系统提示注入本次请求，模型按它写代码——这就是"规范的代码"的来源。

```
技能库目录/
└── my-lint/
    ├── SKILL.md        ← 必须有；frontmatter + 规则正文
    └── refs/detail.md  ← 可选；正文里用 @@ref: my-lint/refs/detail.md 按需取
```

### 11.1 怎么用

1. 输入框上方点「技能」打开面板；
2. 勾选要用的技能（最多 3 个），输入框上方会出现胶囊，点 × 单独关掉；
3. 想接自己的规范：把技能目录准备好，点「选目录」指向它，面板会立刻列出；
4. 勾上「按触发词自动加载」后，一句话里出现 `react`、`建表` 这类词就自动补上对应技能，
   只对本次请求生效，不改你的勾选。

### 11.2 内建 12 个技能（带分类与环节）

面板按 `category` 分组、组内按 `stage` 排序；这两个字段都由 frontmatter 给，第三方技能没写就各归「未分类 / other」，不猜。

| id | 分类 | 环节 | 什么时候用 | 核心约束 |
|---|---|---|---|---|
| `code-style` | 通用 | write | 任何语言，兜底 | 先读后改、错误分支必须有去向、不留魔法值 |
| `react-ts` | 前端 | write | 写组件 / Hooks | effect 只同步外部系统、依赖数组完整、必须有清理 |
| `node-api` | 后端 | write | 写接口 | 路由/服务/存储三层分开、入参校验、统一错误模型、超时 |
| `python-service` | 后端 | write | Python 脚本与服务 | 类型标注、不留可变默认参数、参数化 SQL、async 里不阻塞 |
| `sql-schema` | 数据 | write | 建表 / 加索引 / 迁移 | 主键与时间字段、金额用 DECIMAL、索引不套函数、迁移向后兼容 |
| `module-boundaries` | 架构 | write | 拆文件 / 定接口 | 接口窄实现深、依赖单向、变更不外溢、按变化原因切 |
| `test-cases` | 质量 | test | 补测试 | 一例一断言、边界表、确定性、测行为不测实现 |
| `debug-first` | 质量 | test | 报错 / 不工作 | 先定位再修，说不出文件:行与条件就不动手 |
| `code-review` | 质量 | review | 让我 review | 按 Blocking / Should fix / Nit 分级，每条给位置 + 后果 + 改法 |
| `verify-before-done` | 质量 | review | 说「做好了」之前 | 回读 diff、逐条对照、把「无法验证」明写出来 |
| `security-check` | 安全 | review | 登录 / 鉴权 / 上传 | 鉴权在服务端、参数化、输出转义、路径规范化、密钥不落库 |
| `dangerous-ops` | 安全 | review | 删除 / 迁移 / 部署 | 不可逆操作要么给可逆写法、要么同行标后果；密钥不进命令行参数 |

环节取值：`plan` / `write` / `test` / `review` / `ship` / `infra` / `release` / `other`，写中文（测试、发版）也能认。

后三条是从外部技能库里**摘编**的，不是原文照搬——原版假设 agent 有终端、能跑命令、能打断用户提问，
这三件事本工具都做不到，所以：

- `verify-before-done` 把「跑命令看输出」换成「回读自己刚写的文件 + 拿 diff 的 `+N −N` 当证据」，
  并强制把「本工具不能执行命令」写成 `⚠️ 无法验证`，而不是含糊成「应该没问题」；
- `debug-first` 保留「先根因后修复」的四阶段，去掉了所有依赖跑测试的步骤；
- `module-boundaries` 取自深模块与单向依赖那一套，落到本项目的文件切分与签名纪律上。

### 11.3 渐进式加载（省 token）

- **L0**：没启用技能时，一个技能相关的 token 都不发；
- **L1**：启用后只发这些技能的正文 + 一份目录清单（让模型知道还能 `@@ref` 取哪个）；
- **L2**：正文里写了参考附件时，模型用 `@@ref: <id>/<路径>` 请求，程序读出来作为隐藏消息回传，
  界面上看不到，也不会污染对话。

内建技能以 `?raw` 打进产物（markdown 原样参与构建），和外部技能走同一个解析器；
同名 id 时外部覆盖内建，方便你改一份自己的版本。

按一句话触发时有三条硬限制，写技能、写测试都要按这个口径：

- **数量上限**：一次最多 `MAX_ACTIVE_SKILLS`（默认 3，含自动匹配进来的），多余的截断，界面会 toast 告知；
- **自动匹配**：`MAX_AUTO_MATCH`（默认 2），按「命中触发词个数 → 声明顺序」排序取前两名，
  所以**调整 `src/skills/index.ts` 的 import 顺序就是调整谁胜出**，改触发词同理。
  （实测一例：「写个小项目 + 写完自己验证一遍」同时命中 4 个技能，最终只加载了
  命中 3 次的 `code-style`，以及同分 1 次里声明最靠前的 `react-ts`；`verify-before-done`、
  `module-boundaries` 被挤掉。想让它必中，就在面板里手动勾上。）

**测试不许写死技能名**：一旦测「这次应该加载哪几个技能」，就把值重复了一遍，
改一次触发词或 import 顺序就会假红。`tools/live-skill-e2e.cjs` 的做法是——
从 `src/skills/builtin/*.md` 与 `index.ts` 重建目录，用与 `src/lib/skill.ts` 同构的打分函数
（`hits()` 中文走包含、英文走词边界；`matchSkills()` 先命中数后声明顺序）算一遍期望值，
再去核对界面实际加载了谁。技能库怎么改都不会失真。

### 11.4 来源清单与审计（外部仓库怎么进来）

技能库面板的第二个页签不是"技能市场"，而是一张**审计底稿**：登记了 29 个真实仓库，
说清每个"是什么、能不能接入、装之前要查什么"。

- 每条只有事实与检查项，**不含任何第三方技能正文**——正文仍然只从你磁盘上的 `SKILL.md` 读；
- 按流水线环节分组：需求 → 写码 → 验证 → 审查 → 交付 → 基建 → 发版 → 其它；
- 三种接入方式一眼可分：`可接入技能库`（15 条，一个目录 + SKILL.md）、`需 MCP 宿主 / 需 CI 环境`（2 条，本项目当前离线，挂不上）、`仅参考`（12 条，独立应用或框架）；
- 会动远端、凭证、基础设施的标 `高风险`（4 条），装之前必须先读；
- 核实程度如实标注：`已核实` 是用 GitHub API 拿到的语言/星数/许可/最后推送；`仅确认存在` 是当时 API 被限流、只验了页面；
- 改过名的仓库直接指向新地址：`ruvnet/claude-flow` → `ruvnet/ruflo`（旧地址 301）。

点「导出审计清单」会生成一份可勾选的 Markdown：

- 有工程目录 → 写进 `<工程>/.zxz/audit/source-audit-<时间戳>.md`（`.zxz` 不进目录树、也不发给模型）；
- 没有工程目录 → 浏览器下载。

清单里每条都带审计项与统一检查项（frontmatter 是否齐全、有没有 `rm -rf` / `curl | bash` /
`git push` 这类命令、是否需要凭证、触发词是否冲突、许可是否允许再分发）。
其中「有没有危险命令」这一项已经从清单落成了真工具，见下一节。

#### 实测：4 条高风险仓库真拉下来扫过了

预判是看名字猜的，实测是拿 codeload 取 tarball 在本地 grep。两者不一致时，以实测为准，
并把「预判 → 实测」的变化留痕（卡片上那条被划掉的红色徽章）。**这条修正本身比结论更值钱**：

| 仓库 | 预判 | 实测 | 结论 | 关键证据 |
|---|---|---|---|---|
| `garrytan/gstack` | 高 | **高** | 不接入 | `docs/uninstall.md:30/37/43/46` 在卸载流程里 `rm -rf ~/.claude/skills/*`、`~/.gstack`；`gstack-upgrade/SKILL.md:218` clone 换装；硬依赖 bun |
| `vercel-labs/agent-skills` | 高 | **高** | 挑着接 | `vercel-cli-with-tokens/SKILL.md:20-48` 会 `printenv` / `grep .env` / 按 `vca_` 前缀猜变量名再 export |
| `hashicorp/agent-skills` | 高 | **高** | 挑着接 | `terraform-search-import/SKILL.md:89` 流程第 5 步就是 `terraform apply`；`aws-ami-builder/SKILL.md:133` 给了 export `AWS_SECRET_ACCESS_KEY` |
| `addyosmani/agent-skills` | 高 | **中** | 挑着接 | `rm -rf` 与 `curl \| bash` 均 0 命中，12 个脚本全在 `evals/fixtures`；25 份 description 质量最好——真问题是 15/25 超过 12000 字符加载上限 |

两条方法论上的收获：

1. **同一条 `rm -rf` 要分三种性质看**：写在卸载脚本里是风险，写在 `careful/SKILL.md` 的拦截表里是防护，
   写在 CHANGELOG 里只是记录。混为一谈会得出"gstack 满页 `rm -rf` 所以最危险"这种半对结论。
   gstack 25 个 `rm -rf` 命中里，真正会执行的只有 2 个文件。
2. **体积也是接入门槛**。本项目单份截断 12000 字符，addy 15/25、gstack 26/33 超限——
   截断后的技能比没有更糟，因为它看起来完整，实际规则被腰斩。

### 11.5 本地技能扫描（装之前先看它写了什么）

来源清单管的是"我登记过的 29 个仓库"；但你实际会从各处拉技能库进来，所以还有一个跑在
**你自己磁盘上**的扫描器：选中外部技能库目录后，每个技能卡片上直接出现徽章，点开看「第几行写了什么」。

10 条危险模式：递归删除、远程脚本直跑、覆盖远端历史、丢弃未提交改动、真改基础设施、删表、
放开权限、发到公共仓库、读写死凭证、动态求值。每条都带一句后果，不是等级。

**只给行号，不给危险分。** 同一条 `rm -rf` 写在卸载脚本里是风险，写在拦截规则表里是防护。
给个分数出来，用户会拿它当结论；分错一次要么删掉一个好技能，要么留下一个坏技能。

所以命中按语境分三档：

| 语境 | 判据 | 怎么看 |
|---|---|---|
| 代码块里 | 围栏代码块内，或行内反引号里 | 最可能被照着跑，先看这些 |
| 劝阻语境 | 本行或所在章节标题带 `never` / `不要` / `禁止` 这类词 | 多半是防护规则表，是好事 |
| 正文提到 | 其余 | 要人看原文 |

表格行永远不算代码块：表格是查阅用的，代码块才是抄来跑的。

最能说明这套判据有用的是一个反例：`mattpocock/skills` 里有个 `git-guardrails-claude-code`，
它整份内容就是「把这些命令拦住」，正文列了 `git push --force`、`git reset --hard`、`git clean -fd`。
三条命中全部判成 `guard`，一个都没被误报成危险技能。如果只按命令名匹配，这个专门做防护的技能
会被排在最危险的第一位。

边界：只扫 `SKILL.md` 正文，不扫 `refs/` 与仓库脚本——脚本不会自己跑，正文会进上下文。
内建那 12 条不扫：本项目自带、review 过，扫出来全是自己的示例，纯噪音。

#### 拿 6 个真仓库验过，排序和人工审计一致

| 仓库 | 技能数 | 干净 | 代码块有命令 | 命中 | 上一轮人工结论 |
|---|---|---|---|---|---|
| `garrytan/gstack` | 33 | 21 | 3 | **30** | 不接入（`gstack-upgrade` 一个技能占 13 处） |
| `vercel-labs/agent-skills` | 9 | 8 | 1 | 10 | 挑着接（全在 tokens 那条） |
| `hashicorp/agent-skills` | 20 | 17 | 3 | 6 | 挑着接（terraform apply + AWS 凭证） |
| `addyosmani/agent-skills` | 25 | 23 | 1 | 4 | 挑着接（问题是体积不是安全） |
| `obra/superpowers` | 15 | 12 | 3 | 3 | 可接入 |
| `mattpocock/skills` | 39 | 38 | 0 | 3 | 最干净 |

调规则时被真实数据纠正了四次，这四次都是同一个教训——**别只看命令名，要看它在什么位置**：

- `rm -f "$_D"` 被判递归删除：它删的是单个临时文件，日常操作。改成必须带 `r` 或 `--recursive`
- 浏览器的 `--eval` 参数被判成 shell `eval`
- 镜像构建里的 `sudo apt-get` 被判成提权，一抓一大把
- `careful` 那张拦截表整张变红：反引号里的命令按行内代码判了

点「导出扫描结果」会把结果写成 Markdown（只有「哪行写了什么」，不含正文，可以直接发人）。

导出的底稿是一份文件、两节：前半是「该查什么」（清单），后半是「查完是什么」（实测报告），
以免浏览器把同站点连续两次自动下载拦掉。

#### 审计结论怎么变成代码里的规则

审计出来的东西如果只停在报告里，等于没审。所以每条结论都要能落到一个产出上，
`audit.ts` 里的 `applied` 字段就是这条追溯线（测试会校验它引用的技能 id 真实存在）：

| 来源 | 拿走的 | 落到哪 |
|---|---|---|
| `gstack/careful/SKILL.md` | 危险操作分类表、「`node_modules`/`dist` 这类可放行」的豁免清单 | `dangerous-ops` |
| `vercel-labs/.../vercel-cli-with-tokens` | 「密钥走环境变量，不进命令行参数」（它自己第 57 行的劝告） | `dangerous-ops` |

但**没有照抄**：gstack 的形态是 hook 拦在执行前、弹窗问「确定吗」，
本工具根本不执行命令、也没有交互，所以 `dangerous-ops` 的落点改成了
「不可逆操作要么给可逆写法，要么在同一行标出后果」——因为最终跑脚本的人是用户，
注释是唯一能传达风险的位置。

## 12. 已知限制

- 首期只做**纯文本对话**：不支持图片输入、函数调用插件、联网搜索。
- "最大输出 tokens"留空时不发送该字段；部分推理模型（`o` 系列等）不接受 `max_tokens`，请留空。
- 浏览器直连模式受厂商跨域策略影响，个别端点可能失败 —— 这种情况下打包成桌面端即可解决。
- `strip = true` + `panic = "abort"` 的 release 配置追求体积，排查线上问题时请用 dev 构建。
- 前端不再是"零构建"：跑之前需要 `npm install`。但**运行时**仍只有 React/ReactDOM，Markdown 与高亮都是自己实现的。
- 本机代理按 `Content-Length` 读请求体，不解析 chunked（浏览器 `fetch` 固定带长度，非浏览器客户端需自行带上）。
- 升级到 React 版不影响已有数据：`localStorage` 仍是 `zxz.state.v1`，结构未变。

## 13. 计划模式 / 写入前确认 / 项目记忆（对照 Claude Code 的工程纪律）

这三件都是“让模型先对齐、再动手、动手后可验证”，不是多几个开关摆着看：

### 13.1 计划模式（设置 → 计划模式）

开着时，本轮只出方案：模型仍可用 `@@read` 看真实文件，但程序会跳过它输出的
所有 `file:` 块，一个字都不落盘；工具调用里的写文件和跑命令同样会被拦截，
只放行读、列目录、搜索。方案里必须写清改哪些文件、每处改什么、
改动顺序、风险点、哪些结论还无法验证；需要验证的步骤要写成给人执行的清单。
方案对齐后，关掉计划模式再发一次才会真正写（工具调用开启时还会自动跑测试，见第 14 节）。

### 13.2 写入前确认（设置 → 写入前确认）

开着时，模型给的每一批文件先弹面板：每行显示新建还是覆盖、`+N −M`，
点“看差异”看红绿对比；默认全勾选，只把不想写的去掉，点“写入勾选的”才落盘，
点“全部放弃”则本轮磁盘一个字都不动。消息列表里的“重新写入”同样走这个面板，
不会绕过确认。关着时保持老约定：自动落盘。

### 13.3 项目记忆（工程根目录的 CLAUDE.md / AGENTS.md）

接入工程时，程序会先读根目录的 `CLAUDE.md`，没有就退到 `AGENTS.md`，
读到就作为一条系统消息随每轮请求发给模型（上限 8000 字符，超了截断并明说）。
这是项目给模型的长期约定——架构、禁令、文件切分方式——不用每轮现口头复述。
本仓库自己的 `CLAUDE.md` 就是一份示范：改这个仓库时，先读它。

### 13.4 落盘后回读校验

不管开没开确认，写完都会回读一次：回读内容与模型给的内容逐字不一致，
回执里会标“回读不一致”，不能算“写好了”。这一步替代不了跑测试和构建，
只是保证“写进去的”就是“模型说的”。

**覆盖前的备份是硬前置**（2026-11-03 收紧）：目标是否存在必须先拿到确定答案，
`fs_exists` 报错（越界、会话失效、目标是指到工程外的链接）不再被当成“不存在”，
而是直接中止这一次写入并给出原因；备份写失败同样中止，不会“先覆盖了再说”。
此前的行为是把校验失败吞成 `false` → 当新建处理 → 静默跳过备份，
等于一次校验失败就换来一次不可撤销的覆盖。

另外：仓库根目录的 `CLAUDE.md` 是给未来接手这个仓库的 Agent 看的项目记忆；
`.github/workflows/ci.yml` 跑 `npm test` + `npm run build` + Rust 文件层单测
（`tools/fs-harness`），桌面全量构建因需要 WebView2 系统库不在 CI 里做。

## 14. 工具调用 / 受控执行 / 测试回路（0.3.0）

这是从“聊天壳”到“能自己验证的 Agent”的第一步，也是第一次改掉“不执行命令”
这条旧定位，所以范围收得很紧：

### 14.1 五个工具

模型在工程模式下可用：`read_file`（读文件）、`list_dir`（列一层目录）、
`search_files`（字面子串搜索，最多 100 个命中）、`write_file`（整文件写入，
覆盖前备份、落盘后回读校验、确认开关同样生效）、`run_command`（白名单命令）。
工具调用开启时模型优先用工具，`file:` / `@@read:` 只作不支持工具的兼容端回退；
关掉工具调用开关就回到纯文本协议，老行为不变。工具调用会以消息里的工具日志
折叠展示（工具名、结果或失败原因），下一轮发给上游时展开成原生 `tool_calls`
加 `tool` 消息，模型能把“调了什么、结果是什么”对上号。

**五份清单收成一份**（2026-11-03 补，B6）：工具名联合类型、发给模型的 JSON Schema、
参数校验的 if 链、提示词里的工具说明、按名字分发——原来是五处各写一遍，加一个工具要改五个
地方，漏一处就是“声明了但不校验”或者“校验了但分发不到”。现在这五份都由
`src/lib/registry.ts` 的 `TOOLS` 派生，加工具只改注册表。分发处的 `findTool` 是
**精确匹配**：`Run_Command`、`run_command ` 这类变形一律落到“未知工具”，
不做 trim、不做大小写归一——归一化等于给权限等级判断开了模糊匹配的侧门。
`registry.test.ts` 把这几条不变量锁住了（Schema 与注册表逐字段一致、
`planModeBlocks` 的集合等于 write+exec 的集合、九种变形别名全部被拒）。

### 14.2 白名单与硬边界

`run_command` 只允许：`npm test`、`npm run build`、`npm run lint`、
`npx vitest run`、`git status`、`git diff`、`git diff --stat`，以及 `--version` 查询。
安装、发布、推送、提交、删除、改写历史一律拒绝，不弹确认、直接报错。
命令以 argv 数组直接交给子进程，不走 shell，不拼字符串；工作目录只限工程根目录；
超时 60 秒（超时杀进程并注明）。输出有两道闸：Rust 侧每路最多**保留** 256 KB
（管道必须读空，否则子进程会堵死在缓冲区里；读空之后超出的部分丢掉并置 `truncated`），
前端再按 20000 字符截断给模型看，并且 `truncated` 时明确追加一句
“输出过长已截断，只保留了开头部分，不要把『没看到报错』当成测试通过”——
截断本身不能变成一次假的通过。
超时是**连进程树一起杀**：Windows 上 npm / npx 由 `cmd` 包一层，只 `kill()` 外面那层
的话，真正干活的 node 还活着，管道不关，调用方要一直等到它自己结束（实测会拖到 96 秒，
等于超时保护失效）。所以先 `taskkill /PID … /T /F` 收树再 `kill()` 兜底——顺序不能反，
父进程先死的话 Windows 的父子链就断了，`/T` 找不到后代。此外读完管道 EOF 另有 5 秒
宽限，兜住极少数攥着句柄不放的情况，不会把调用方挂在 `join()` 上。
白名单在前端 `src/lib/tools.ts` 和 Rust `src-tauri/src/runx.rs` 各有一份，
Rust 侧对每一次调用重新校验，绝不信任前端传进来的参数；两边改一边就要改另一边。
跑命令只在桌面端可用，浏览器直开时直接报错，不会悄悄降级成别的东西。

**Windows 上的命令名解析**（这件事在 Windows 上必踩，不是玄学）：Windows 的
`CreateProcessW` 只自动补 `.exe`，补不了 `.cmd`，而本机 npm / npx 正是批处理文件，
所以直接 `Command::new("npm")` 会报 `program not found`。`run_allowed` 会先按 PATH
把命令名解析到真实存在的文件（`npm.exe` / `npm.cmd` 都试，命中谁 spawn 谁）再执行。
命令名只认 PATH 上的裸名字，带路径或分隔符的一律拒绝。依然不额外启 shell：
argv 数组原样传给子进程。因为 `.cmd` 最终由 COMSPEC 执行，元字符黑名单比 unix 侧更严，
把 `% ^ ! " ' ( )` 和反斜杠一并挡掉（`has_shell_meta` 里可以看到完整清单）。

**只读 git 的三道不可关闭加固**（2026-11-03 补）：仓库自己也能决定 git 跑什么——
`.git/config` 的 `diff.<driver>.textconv` / `diff.external` 会在 `git diff` 时执行命令，
`core.fsmonitor` 会在 `git status` 时执行 hook。所以 `run_allowed` 在 spawn 前**强制**
插入用户参数里关不掉的东西：git 命令统一前置 `-c core.fsmonitor=false`，
`diff` 再追加 `--no-textconv --no-ext-diff`；同时注入
`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=<空设备>`、`GIT_CONFIG_SYSTEM=<空设备>`、
`GIT_TERMINAL_PROMPT=0`、`GIT_PAGER=cat`、`GIT_OPTIONAL_LOCKS=0`。
配套的写侧闸门：`fsx::write` **整目录拒绝** `.git/**`（config / hooks / info / attributes 全在内），
不做“只挡 config”这种半开口子。0.3.0 及之前这两条都缺，等于“能写 .git”+“git 会执行配置”
= 受控执行变成任意执行。

### 14.2.1 执行授权闸门

白名单解决的是“哪些命令允许跑”，没有解决“这一条是谁批准的”。所以白名单内部还有一道闸：
每次 `run_command` 先过 `perms::decide`，结论只有三种——

| 结论 | 触发条件 | 表现 |
| --- | --- | --- |
| `Deny` | 不在白名单 | 直接报错，**不弹确认框** |
| `Ask` | 在白名单，但本次会话没批准过这个 scope | 弹确认框：仅此一次 / 本工程目录都允许 / 拒绝 |
| `Allow` | 这个 scope 已经批准过 | 直接跑 |

scope 的粒度是“命令 + 子命令”：`git diff` 和 `git status` 是两个 scope，
批了一个不解锁另一个；`npm test` 与 `npm run build` 同理。白名单外的命令**不走 Ask 直接拒**，
因为“弹窗问一个本来就不该跑的命令”只会训练用户无脑点同意（单测
`non_allowlisted_is_denied_not_asked` 锁住这条）。授权只存内存不落盘：关工程时 Rust 侧清空，
切/新建/删除/清空对话时前端主动撤回。

**这里有一个必须说清楚的边界**：Rust 侧按工程目录记账，而同一目录重复 `ws_open` 会复用
同一个会话号——所以“本工程目录都允许”的真实生命周期是“直到关闭工程”，不是“直到切换对话”。
前端靠主动撤回把粒度收回对话级，这是**补偿，不是隔离**：一旦出现绕过前端的调用路径，
粒度会退回工程级。要真正按对话隔离，得让 Rust 侧带着 convId 记账，当前版本没做。

已知取舍：一次性授权在闸门处就被扣掉，如果随后进程启动失败（比如 PATH 里没有 npm），
这一次批准就白费了，用户要再批一次。修它需要把“扣额度”推迟到 spawn 成功之后，
等于在安全关键路径上引入两阶段提交；考虑到它的失败方向是**更严**而不是更松，本版保持现状。

### 14.3 测试回路

写完文件（工具写入或 `file:` 写入都算）且自动测试回路开启、且在桌面端时，
程序自动跑一次 `npm test`：通过就停在本轮；失败把报错原文当成隐藏消息回传，
模型下一轮再改，最多 3 轮；3 轮不过就停下并明确告诉人“测试仍未通过，
已停止自动修复”，不许模型在测试通过前宣称完成。单次对话的读写轮数上限仍是 6 轮，
测试轮数单独计，不互相顶掉。

**两个必须知道的约束**（承接 14.2，这里是最容易看漏的一层）：

- `autoTest` **默认关闭**，而且要显式写成 `true` 才生效。原因：`npm test` 真正执行的是
  工程 `package.json` 里写死的脚本，而 npm 会自己起 shell 去跑它——白名单审的是 argv[0]，
  审不到这一层。这个文件可能正是模型刚写的，默认开等于默认允许自动执行未经人审的命令。
- 就算开关打开了，程序也会先读工程的 `package.json`，只有当 `scripts.test` 是受信任的
  测试运行器（`vitest` / `jest` / `mocha` / `node --test` / `tsc`）时才真的跑；
  认不出来就只提示“未运行”，不动手。判据在 `src/lib/tools.ts` 的 `isSafeTestScript`。

**判据不只看首词**（2026-11-03 补）：只按 `&& || ;` 切段会漏掉 `vitest run | sh`、
`vitest run & curl x`、`vitest run $(curl x)`、反引号与换行续接——首词都是受信任运行器，
shell 却会再执行一条命令。所以先做构造级拒绝（`$`、反引号、`>`、`<`、换行、NUL），
再按 `&& || ; | &` 全部切段。Rust `runx.rs` 与前端 `tools.ts` 用的是同一套规则，
执行时以 Rust 为准。

**点「停止」要真的停下来**（2026-11-03 补，B13）：`AbortController` 只能中断
`fetch`，而 `npm test` 是 Rust 侧起的子进程，abort 对它没有任何作用——界面显示"已停止"、
命令还在跑，这是界面在说谎。现在停止按钮会额外调一次 `run_cancel(sessionId)`：
Rust 侧给这个会话的取消位置位，等待循环每 50ms 看一眼，置位就 `taskkill /T` 收树
并返回 `cancelled: true`。

三个细节都是刻意的：

- **取消位每次执行新建、用完注销**。复用同一个位的话，上一次点停止留下的 `true`
  会把下一次刚开始的命令直接杀掉——表现就是"点过一次停止，之后所有命令都起不来"。
- **没在跑的时候点停止什么也不做**（`cancel_running` 返回 `false`，不报错）。
  停止按钮随时可点，留下一个将来才生效的标记是最糟的行为。
- **`cancelled` 与 `timed_out` 分开报**。两者都是"进程被我们杀了"，但含义相反：
  超时是命令自己没跑完（该改代码），取消是人叫停的（别当失败再试一遍）。
  混成一个字段，测试回路会在用户点停止后回传"第 1/3 轮 npm test 未通过"——
  把人的操作写成代码的错，模型于是接着改根本没问题的代码。

端到端测试不看标志位只看**耗时**：起一条挂 60 秒的 `npm test`，2.5 秒后取消，
必须 15 秒内返回且 `cancelled=true`。只断言标志位是不够的——标志位可以置对而进程还活着，
那正是这条缺陷最初的样子。

**还要审 `pre` / `post` 钩子**（2026-11-03 补，实测可绕过）：`npm test` 实际会依次跑
`pretest` → `test` → `posttest`，只审 `scripts.test` 等于只看了三步里的中间那一步。
实测这套配置能过审并写出文件：

```json
{ "scripts": { "pretest": "node evil.js", "test": "node --test emit.js" } }
```

`test` 是受信任的 `node --test`，`pretest` 是任意脚本——只审 `test` 就放过了。
现在 `check_npm_script` / `checkNpmCommandScript` 对 `pre<name>`、`post<name>` 一并审，
任一条不过就整条命令拒绝。同类问题还有一个：**工程里的 `.npmrc` 会把 npm 的脚本 shell
换掉**（`script-shell=...`），这条实测生效——写一个不存在的路径，`npm run build` 直接报
`npm error syscall spawn C:/nonexistent/zzz-shell.exe`。所以 `.npmrc` / `.yarnrc` /
`.yarnrc.yml` / `.pnpmfile.cjs` 与 `.git/**` 同级，`fsx::write` 一律拒绝。

### 14.4 本版验证状态（先说清楚，再谈功能）

**当前状态（2026-11-03 实测，替换掉下面那段历史描述）**：

| 项目 | 结果 |
| --- | --- |
| `npx vitest run` | **400 passed / 17 files** |
| `npx tsc --noEmit` | **0 error** |
| `npm run build` | 成功 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | **通过，0 warning**（含 lib.rs 的 IPC 注册、api.rs 转发） |
| `cargo test --manifest-path tools/fs-harness/Cargo.toml` | **82 passed / 1 ignored**（GNU 工具链） |
| `run_allowed` 在本机真 spawn `npm --version` | 退出码 0，输出 10.9.7 |
| `node tools/e2e.cjs` / `workspace-e2e` / `skill-e2e` / `proxy-e2e` | 24/24、39/39、69/69、10+24 全过（见 9.6） |

**仍未验的**：桌面全量构建、安装包产出、真模型工具调用（需真 Key 与 CDP 前置）、
以及 9.6 表里那七个 `NOT_TESTED` 脚本。没验过的不要宣称已验。

<details>
<summary>历史描述（已被上表取代，保留以说明当时为什么这么写）</summary>

> 本机没有 cargo，`src-tauri` 本体（lib.rs 的 IPC 注册、api.rs 的工具转发）
> 在本机没有编译过，桌面全量构建与真模型工具调用仍需在 Windows 真机上验证
> 后才能算“跑通过”。

</details>

### 14.5 集成时的补充验证（本机 Windows 真机）

补丁作者上面那句“src-tauri 本体没有编译过”，已由本机补上：

| 项目 | 结果 |
| --- | --- |
| `cargo check`（含 runx.rs、lib.rs IPC 注册、api.rs 工具转发） | 通过，0 warning |
| fs-harness Rust 单测 | 通过（含 runx 白名单与真实 spawn） |
| vitest | 通过（条数以 14.4 的当日实测为准，本节不再单独记数） |
| `run_allowed` 在本机真 spawn `npm --version` | 退出码 0，输出 10.9.7 |

**集成过程中修掉的两个缺陷**（都是原补丁在 Windows 上的真问题）：

1. `npm` / `npx` 无法 spawn。原实现直接 `Command::new("npm")`，本机实测报
   `program not found`（Windows 不给 `.cmd` 补后缀）。修法：spawn 前先按 PATH 解析真实文件名，
   白名单同时认 `npm.cmd` 这类形态，并补严元字符黑名单（见 14.2）。修完实测才拿到 10.9.7。
   作者的 runx 单测只 spawn 过 `git`（真 .exe），所以这条当时漏网。
2. 自动测试回路会把白名单“绕过一层”。`is_allowed` 审的是 argv[0]，但 `npm test`
   执行的是 package.json 里的用户脚本。修法：`autoTest` 默认关 + 跑之前先验脚本内容
   （见 14.3）。

### 14.6 护栏的边界用例（真模型 + Rust 双侧）

> **口径（2026-11-03 重测时补）**：本节的 `28/28` 是当时的实跑记录，**本轮没有重跑**
> （`tools/live-tools-edge.cjs` 需要真模型 Key + CDP 前置，状态 `NOT_TESTED`）。
> 脚本现在静态有 29 个断言点。下面四项的结论按"当时实测"读，不当成今日证据。

前三节的 happy path 跑通不等于护栏有效——护栏只有被触达时才起作用。下面四项都用真模型
在桌面端实跑过（`tools/live-tools-edge.cjs`，28/28），四项都 PASS：

| 护栏 | 怎么验的 | 结果 |
| --- | --- | --- |
| 计划模式 | 开 `planMode`，要求模型 read → write → run 三步 | 只读正常读到真内容；`write_file` / `run_command` 都返回“计划模式已拦截”；**磁盘 3 个文件零改动** |
| 写入前确认 | 开 `confirmWrites`，要求模型用 `write_file` 新建文件 | 流程停在待批复面板、列了待写路径、**批复前磁盘零改动**；点“写入勾选的”后才落盘并继续跑完 |
| 目录逃逸 | 指名让模型用 `read_file` 读 `../.tmp-edge-outside.txt` | 工具返回 error，没有任何一条工具结果带出根目录外内容 |
| 项目记忆 | 明令“不许用工具、不许读文件”，问 CLAUDE.md 里的约定 | 答出了 `ZXZ-MEMO-7742`，且** 0 次工具调用**，证明确实是随请求注入而非临时去读 |

Rust 侧另补了边界用例（`tools/fs-harness`，当日 **82 条全过**，另有 1 条 `#[ignore]`）：

- **非零退出码必须透传**：自动测试回路靠它判断“过没过”，掉了就会把失败误判成通过。
- **超大输出不死锁**：两个流都必须读到 EOF（提前停读会把子进程堵死在管道缓冲区），
  但只保留 256 KB，超出部分丢掉并置 `truncated`。
- **环境是白名单不是宿主拷贝**：`env_clear()` 之后只加回 19 项；测试比的是
  「子进程报上来的键集合」。注意宿主的进程沙箱会在 env 之外注入 `LSBOX_*` 这类变量，
  写断言时要把它们和 npm 自己加的 `npm_*` 区分开，否则会误判成泄漏。
- **超时 + 进程树**（`#[ignore]`，要实打实等 60 秒，`cargo test -- --ignored` 才跑）：
  这条一开始是** FAIL **，把 14.2 记的那个真缺陷挖了出来，详见 14.2 与下一段。

当时这条用例的原话是“超时 60 秒”，实测 `run_allowed` 用了 **96 秒**才返回：父进程被杀后
孙进程还活着、攥着管道句柄，读线程的 `join()` 就一直挂着，调用方被硬拖到子进程自然结束。
修完同一条用例标称 OK：`60.2s` 返回、`timed_out=true`、孙进程已不在。
