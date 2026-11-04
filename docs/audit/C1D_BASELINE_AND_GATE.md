# C1-D｜真实桌面端 CDP 独立验证：基线重建、方案与授权门禁

角色：独立测试工程师 / 质量审计员 / 发布准入评估员
执行范围：Phase 0（基线重建）+ Phase 1（方案设计）+ Phase 2（授权门禁清单）
执行时间：2026-11-02 11:53–12:0x
本阶段动作：**全程只读**。未启动任何 EXE、未启动任何服务、未修改任何项目文件、未创建/删除任何目录、未执行 git add/commit/push。
最终状态：**`BLOCKED`**（停止条件第 1 条命中，详见 §4）

---

## 1. Phase 0：独立基线重建（全部本轮实测，不引用历史报告）

### 1.1 仓库身份与提交链

| 项 | 命令 | 实测值 |
| --- | --- | --- |
| 工作目录 | `pwd` / `git rev-parse --show-toplevel` | `/f/zhuomian/zxz` → `F:/zhuomian/zxz` |
| 远端 origin | `git config --get remote.origin.url` | `http://<内网地址>/<user>/zxzgpt.git`（内网 Gitea；公开推送前已做占位处理） |
| 远端 github | `git config --get remote.github.url` | `git@github.com:zxz88601151/zxzgpt1.git` |
| 分支 | `git rev-parse --abbrev-ref HEAD` | `main` |
| HEAD | `git rev-parse --short HEAD` | `b4a3ed2`（R1，2026-11-02T11:52:54+08:00） |
| 父提交 | `git rev-parse --short HEAD^` | `35b56c0`（C1，2026-11-02T09:52:18+08:00） |
| C1 在当前历史 | `git merge-base --is-ancestor 35b56c0 HEAD` | YES |
| R1 在当前历史 | `git merge-base --is-ancestor b4a3ed2 HEAD` | YES |
| 工作区 | `git status --porcelain` | 已跟踪文件 0 处修改、暂存区空；未跟踪 = `.tmp-skills/` + 7 份 `docs/audit/*.md` |
| stash | `git stash list` | 空 |
| 远端引用 | `git for-each-ref refs/remotes` | `github/main = origin/main = bd8c37a` → 本地领先 6 个提交，`NOT_PUSHED` 属实 |

**与任务书基线一致性：完全一致。**（R1 `b4a3ed2`、父 `35b56c0`、C1/R1 均已提交、远端未推送。）

### 1.2 提交内容边界（决定「前端层可否复用现有 Rust 二进制」）

| 提交 | 涉及文件（`git show --stat`） | 结论 |
| --- | --- | --- |
| `35b56c0` C1 | `src/App.tsx` +41、`src/lib/appcontrol.ts` +154、`src/lib/appcontrol.test.ts` +172、`src/presets.ts` +2、`src/types.ts` +3、4 份 docs | 纯前端 + 文档，**不含 `src-tauri/**`** |
| `b4a3ed2` R1 | `src/lib/md.ts` +23/-3、`src/lib/md.test.ts` +114/-1 | 纯前端，**不含 `src-tauri/**`** |
| `src-tauri` 最后一次改动 | `git log -1 -- src-tauri` | `a280051`（P0-1 工程会话化），提交于今日 07:54:45；`src-tauri/src/lib.rs` 文件 mtime 为 11-01 22:47:13 |

### 1.3 当前 EXE 清单（路径 / 大小 / SHA-256 / 时间戳）

| EXE | 大小（字节） | mtime | SHA-256 |
| --- | --- | --- | --- |
| `src-tauri/target/debug/zxz.exe` | 265,620,205 | 2026-11-02 07:51:41 | `571ad599f7c2d809a7ddcee8dc63940e67589da29a2518b4e1d9a493c9690d6b` |
| `src-tauri/target/release/zxz.exe` | 5,036,544 | 2026-11-01 21:20:28 | `7d17eb310f92b53a0a45f35619ba0caca4136231fc5d673372896288c7accc33` |
| `src-tauri/target-gnu/debug/zxz.exe` | 265,304,517 | 2026-11-01 13:08:45 | `f955df375fbc959c48439217fa98a52b569012ade2bce0f0af94527934994f8a` |

无 `bundle/` 目录（未生成 msi/nsis 安装包），仓库根无散落的 exe。

参考：当前 `dist/`（HEAD 前端构建产物，`npm run build` 于 11:49:54）= `index-CZKDyGdJ.js`、`index-BJpXV7Et.css`、两张头像 png。

### 1.4 EXE ↔ 源代码可信对应关系：**不成立（决定性证据）**

方法：Vite 的资源文件名带内容哈希（`index-<hash>.js`），Tauri 把 `frontendDist` 内嵌进二进制，文件名键串在 exe 中可被明文搜到 —— 因此可用「内嵌资源名」反推该 exe 内嵌的是哪一次前端构建。

```
grep -a -o -E "index-[A-Za-z0-9_-]{8}\.(js|css)" src-tauri/target/release/zxz.exe
  → index-B3Obu3Sr.js      index-BJpXV7Et.css
grep -a -o -E "index-[A-Za-z0-9_-]{8}\.(js|css)" src-tauri/target/debug/zxz.exe
  → （无任何命中）
```

| EXE | 实测 | 判定 |
| --- | --- | --- |
| release（`7d17eb31…`） | 内嵌 `index-B3Obu3Sr.js`，**与 HEAD 构建的 `index-CZKDyGdJ.js` 不是同一个内容哈希**；CSS 哈希一致（样式自 11-01 起未变，符合预期） | 内嵌的是 11-01 21:20 那一刻的前端，**不含 C1（09:39 编辑）、不含 R1（09:55 编辑）、甚至不含 P0-2 之后的前端改动**。用它验证 C1 = 验证另一个程序 |
| debug（`571ad599…`） | 二进制内搜不到任何内嵌资源名 → 未内嵌前端，运行时必须连 `devUrl = http://localhost:1420` | 它不是交付形态：跑起来加载的是「Vite dev server 当场提供的磁盘源码」，且使用 `devCsp`（含 `unsafe-inline` + `ws:`）而非生产 `csp`，origin 也不同（`localhost:1420` vs `tauri.localhost`） |
| target-gnu/debug | 同类 dev 构建，mtime 11-01 13:08，更早 | 同样不可用于 C1 |

补充时间线取证（说明为何不能复用今日早晨那批真机证据）：

```
tools/shots/desktop-*.png  → 全部 mtime 2026-11-02 07:52（共 36 张图，最早的 11-01 09:25）
src-tauri/target/debug/zxz.exe → 07:51:41
src-tauri/tauri.conf.json      → 07:52:40（内容经 git 核对与 HEAD 完全一致，说明是「改后还原」，mtime 只证明被碰过）
src/App.tsx / src/lib/appcontrol.ts → 09:39（C1-F 整改）
src/lib/md.ts → 09:55（R1）
```

结论：**今晨 07:52 那批桌面端截图属于 P0-1/P0-2 时代的构建，早于 C1-F 与 R1 一小时以上，不能作为 C1-D 的证据复用。**

按任务书 §六 第 1 条，「EXE 与源代码无法建立可信对应关系」→ 立即停止，不进入 Phase 3。

### 1.5 CDP 调试能力与运行环境（当前事实）

| 条件 | 实测 | 状态 |
| --- | --- | --- |
| 应用是否在跑 | `tasklist`（236 进程）中无 `zxz.exe`、无 `msedgewebview2.exe`、无 `msedge.exe` | 干净，启动不会干扰既有实例 |
| CDP 端口 9223 / dev 端口 1420 / 模拟上游 19888 | `netstat -ano` 无监听 | 三端口全空闲 |
| 配置文件里的 CDP 开关 | 读 `src-tauri/tauri.conf.json`：`windows[0]` 只有 label/title/尺寸/decorations/dragDropEnabled，**无 `additionalBrowserArgs`** | 当前构建不含编译期 CDP 参数 |
| WebView2 运行时 | `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\156.0.4314.58` | 具备（Chromium 156） |
| Edge 本体 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | 具备 |
| Playwright | `node_modules/playwright` = 1.64.1；`connectOverCDP` 走已有实例，无需下载浏览器内核 | 具备，**无需任何安装/下载** |
| Tauri CLI / Rust | `@tauri-apps/cli` 2.12.4；`cargo 1.98.1`，`rustc 1.98.1`，默认工具链 `stable-x86_64-pc-windows-msvc`（另有 gnu） | 具备重编条件 |
| 磁盘 | F: 剩余 33 GB | 具备 |
| 真实用户数据 | `C:\Users\Administrator\AppData\Local\com.zxz.desktop\EBWebView`（89 MB，含 `Default` profile，内有真实会话与设置） | **存在被写入的风险，必须隔离** |
| 既有桌面端 harness | `tools/desktop-workspace-e2e.cjs`、`tools/desktop-skill-e2e.cjs`、`tools/live-*.cjs` 共 6 个，均假定「exe 已用 `additionalBrowserArgs: --remote-debugging-port=9223` 编译并启动」+ 19888 模拟上游 | **无一覆盖 C1 斜杠命令/输入保留/协议过滤**，需要新用例脚本 |

## 2. Phase 1：验证方案设计

### 2.1 目标与判据边界

本阶段唯一目标是补上 C1 的证据缺口：**C1 的行为是否真的在桌面 WebView 里生效**（斜杠命令分发、busy 拒绝、解析失败保留输入、`/help`/`/new`/开关、重生成 reuse 路径不误判），以及 R1 的协议白名单在真实 DOM 里的落地。

必须区分三类结论，不得混用：

| 层级 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| 浏览器注入式 E2E（Playwright 直接开 msedge 打 dist） | 前端逻辑在 Chromium 里正确 | **不能**算桌面端实测（无 Rust IPC、无 CSP 注入、无 WebView2 宿主）——任务书明令禁止冒充 |
| debug exe + Vite dev server + CDP | 真实 WebView2 窗口 + 真实 Rust IPC + 当前 HEAD 源码 | 不是交付形态：走 `devCsp`、origin 为 `localhost:1420`、前端由 dev server 现服 |
| release exe + CDP | 交付形态的完整证据（生产 `csp`、内嵌 dist、真实 IPC） | —— |

结论上限：方案 B 最高只能给 `PASS_WITH_CONDITIONS`；只有方案 A 能给出 `PASS` 级的桌面端证据。

### 2.2 两条可行路径

**方案 A（推荐，证据等级最高）：重编 release exe 后用环境变量开 CDP**

1. 不修改 `tauri.conf.json`（本阶段禁止改配置）。用 WebView2 运行时支持的环境变量注入：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 --remote-allow-origins=* --user-data-dir=<仓库外的临时目录>`。
2. `npm run tauri build`（其 `beforeBuildCommand` 会自动 `npm run build`，产出与 HEAD 对应的新 dist 并内嵌）。
3. 新 exe 的对应性可当场验证：内嵌资源名应变成 `index-<新hash>.js`，与构建出的 dist 一致 → 形成可复核的 exe↔源码对应链。
4. 启动 exe（隔离 profile），Playwright `connectOverCDP('http://127.0.0.1:9223')` 驱动真实窗口。
5. 跑 C1/R1 用例（§2.3），截图与 JSON 结果落在**仓库外**的临时证据目录。
6. 清理：结束进程树、删除临时 user-data 与证据目录（保留哈希与日志在报告里）、`9223` 端口随之释放。

代价与风险：会**覆盖现有 `target/release/zxz.exe`**（哈希已记录 `7d17eb31…`，但覆盖后原文件不可恢复）；release 编译预计 5–15 分钟；若 cargo 需要联网补 crates（当前 target 缓存存在，概率低但非零）→ 命中停止条件「需要安装或下载新依赖」，届时立即停止并报告。

**方案 B（无需重编、无需改任何文件，证据等级次之）**

1. 启动 `npm run dev`（Vite，1420）与 `node tools/mock-upstream.cjs 19888`。
2. 以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 --remote-allow-origins=* --user-data-dir=<临时目录>` 启动现有 `target/debug/zxz.exe`（07:51 构建）。
3. 该 exe 的 Rust 层是否等于 HEAD 的 Rust 层：**只能由时间戳推断**（`lib.rs` mtime 11-01 22:47 < exe 07:51，且 C1/R1 未动 Rust），不构成密码学级证明 → 报告里会标为 `PASS_WITH_CONDITIONS` 的条件之一。
4. 前端 = Vite 当场提供的 HEAD 源码 → C1/R1 逻辑确实是待验代码。

**方案 C（明确不作为桌面端证据）**：msedge 直接打 `dist/index.html` 的浏览器 E2E。只作为「DOM 层协议过滤」的辅助观察，不进入准入判据。

### 2.3 用例设计（C1 为主，R1 顺带；均需断言真实 DOM 与真实 console）

| # | 用例 | 断言方式（真机） |
| --- | --- | --- |
| V1 | 启动与首屏 | 窗口存在、`document.readyState`、渲染出的根节点、`console` 无 error、无 CSP violation |
| V2 | `/help` | 会话内新增一条助手消息且内容 = `appCommandHelp()` 文本；输入框被清空；**不发出网络请求**（监听 19888 侧无新请求） |
| V3 | `/new` | 会话列表 +1、标题「新对话」、toast 文本、输入框清空（由 `createConv()` 内部完成） |
| V4 | `/explore on` / `/explore off` | `localStorage` 里 settings 字段真变化 + toast 标签文案 |
| V5 | 无法解析的命令 `/zzz`、`/` 后空、缺参数 | 不发送消息、**输入框保留原始字符串逐字符相等**（这是 F1 的真机闭环） |
| V6 | busy 期间输入 `/new` | `reject_busy`：无新会话、无请求、输入保留、提示文案正确 |
| V7 | 重生成（reuse）路径 | 点击「重新生成」不被当命令处理；用户消息不重复追加（O1/O2 观察项的真机复测） |
| V8 | 普通消息含 `/` 开头但不是命令（如 `/etc/hosts 里的`） | 走 `passthrough` 正常发送 |
| V9 | Markdown 协议过滤（R1）：模型回包插入 `[点我](java<TAB>script:alert(1))`、`![x](da<TAB>ta:text/html,x)`、`[ok](https://x/a?u=javascript:alert(1))`、`[rel](./a.md)` | 在真实 DOM 里断言：`a[href^="javascript"] == 0`、`img[src^="data"] == 0`、合法链接 `target=_blank`、相对链接 href 解析落在 base origin |
| V10 | 真机 CSP 观察（仅方案 A 有意义） | `console` 有无 `Refused to ...`；`javascript:` href 即便漏网也会被 CSP 兜住（记录纵深防御实况） |
| V11 | 异常退出与资源释放 | kill 进程树后 9223/1420/19888 无残留监听；隔离 user-data 目录可安全删除；真实 profile（89 MB）未被写入（比对目录 mtime/哈希） |

隔离方案：独立 `--user-data-dir`（仓库外）→ 不动用户真实 `com.zxz.desktop\EBWebView`；证据目录默认 `F:/zhuomian/zxz/tools/shots`（已 gitignore）改为仓库外临时目录，避免任何仓库内写入；mock 上游固定 19888，模型配置写在隔离 profile 的 localStorage 内。

### 2.4 已具备 vs 尚不具备

| 已具备 | 尚不具备（需授权） |
| --- | --- |
| WebView2 156 运行时、Edge、Playwright 1.64.1、cargo/msvc、33 GB 磁盘、三个端口全空、无既有实例、隔离用 user-data-dir 方案、mock 上游脚本、CDP harness 范式 | ① 与 HEAD 对应的 EXE（需重编，覆盖现有 release exe）② 启动 dev server / mock 上游 / EXE 三项副作用 ③ 一个新用例脚本（写在哪：仓库外临时目录） ④ 真机执行本身的授权 |

## 3. Phase 2：授权门禁清单

下表每一项都是**尚未执行**的动作。默认全部拒绝；勾选授权后才会发生。

| 操作 | 具体命令/动作 | 副作用 | 风险 | 影响范围 | 清理方式 | 是否需要授权 |
| --- | --- | --- | --- | --- | --- | --- |
| O1 重编 release exe（方案 A 第 2 步） | `npm run tauri build` | 覆盖 `src-tauri/target/release/zxz.exe`；重写 `dist/`；占用 target 缓存与新中间产物 | 现有 release exe 不可恢复（哈希 `7d17eb31…` 已留档，无法据此还原文件）；5–15 分钟 CPU；若需下载 crates 则联网 | 仅 `target/`、`dist/`（均 gitignored，非交付源） | 无需清理；构建产物本就可重建 | **需要** |
| O2 起 Vite dev server（方案 B 第 1 步） | `npm run dev`（1420） | 本地监听 1420；node 进程 | 与用户已开的 dev 实例冲突（当前无监听） | 端口 + 一个后台进程 | 结束时 kill 进程树，确认 1420 释放 | **需要** |
| O3 起模拟上游 | `node tools/mock-upstream.cjs 19888` | 本地监听 19888；读写仅内存，不写盘（脚本内无 fs.write） | 若用户配置指向真实上游则不涉及——测试只在隔离 profile 里指向 mock | 端口 + 一个后台进程 | kill 进程，确认端口释放 | **需要** |
| O4 启动 EXE | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=… zxz.exe` | 起 GUI 窗口 + 一串 `msedgewebview2.exe` 进程 + 监听 9223；在隔离 user-data 目录写缓存/LocalStorage | **若漏配 `--user-data-dir` 会写进用户真实 profile（89 MB，含真实会话）** | 桌面窗口（用户可见）、临时目录 | kill 进程树；删除临时 user-data | **需要** |
| O5 新建用例脚本于仓库外 | 写入 `%TEMP%/c1d/verify-c1.cjs` 等 | 无仓库内写入 | 低 | 仅仓库外临时目录 | `rm -r %TEMP%/c1d` | **需要**（虽在仓库外，仍是新增文件） |
| O6 在仓库内 `tools/` 新增 harness | 新建 `tools/c1d-verify.cjs` | **修改项目文件** | 中（与「不授权修改源码/测试文件」冲突） | 仓库工作区 | git 未跟踪，可移走 | **本任务明确不授权，我不会做** |
| O7 改写 `.tmp-ws`（既有 harness 会 `fs.rmSync` 重建） | 由 O3/O4 附带 | 删除现有 `.tmp-ws/.zxz`（今日 07:52 的测试工作区状态） | 丢临时测试数据（非用户数据，但属既有产物，任务书禁止删除） | `.tmp-ws/`（gitignored） | 不还原 | **需要**；建议改用新目录 `.tmp-ws-c1d/` 规避 |
| O8 截图与结果落盘 | 写入仓库外证据目录 | 新增文件（数十 MB） | 低 | 临时目录 | 报告内引用哈希后删除，或申请保留 | **需要** |
| O9 关闭应用与清理 | kill 进程树 + 删临时目录 | 无 | 低 | 临时目录 | —— | 随 O4/O8 一并授权 |
| 不授权清单 | `git add`/`commit`/`push`、修改 `src/**`、修改 `tauri.conf.json`、安装/升级依赖、删除 `tools/shots`、数据库迁移、发布/部署 | —— | —— | —— | —— | **一律不做**（任务书 §三） |

最小可执行组合（我的建议）：**O2 + O3 + O4 + O5 + O8 + O9**（方案 B，不重编、不改配置、不删 `.tmp-ws`，改指新目录）→ 可拿到 C1/R1 前端逻辑在真实 WebView2 + 真实 Rust IPC 下的行为证据，状态上限 `PASS_WITH_CONDITIONS`。
若要 `PASS` 级交付形态证据：追加 **O1**（方案 A），并接受现有 release exe 被覆盖。

## 4. Phase 3 未执行说明与逐项判据

| 判据 | 状态 | 依据 |
| --- | --- | --- |
| 真实桌面端启动方式 | `NOT_TESTED` | 未获授权启动，仅完成方案设计 |
| CDP 连接证据 | `NOT_TESTED` | 端口空闲、Playwright 就绪、连接参数已设计；**尚无任何一次成功连接** |
| EXE 与源码对应关系 | **`FAIL`** | release exe 内嵌 `index-B3Obu3Sr.js` ≠ HEAD 的 `index-CZKDyGdJ.js`；debug exe 无内嵌前端 → 无可信对应 |
| 页面加载与渲染 / 控制台错误 / 关键交互路径 / Markdown 渲染入口 / 外部链接协议过滤 / 异常退出与资源释放 | `NOT_TESTED` | 前置条件（对应可信的 exe）不成立，未启动即未测 |
| 是否需要模拟上游 | 设计为需要（19888），实测端口空闲 | 未执行 |
| 是否涉及真实账号或用户数据 | 设计上**不涉及**（隔离 `--user-data-dir`）；真实 profile 位置与体量已实测 89 MB | 未执行 |
| 环境条件（WebView2 156 / Playwright 1.64.1 / cargo-msvc / 磁盘） | `PASS`（可复核：§1.5 命令与输出） | 无需安装或下载 |
| 是否需要安装或下载新依赖 | `PASS`（不需要） | 若重编时 crates 缺失则降级为 `BLOCKED`，届时立即停止 |
| 阶段边界合规（只读、未提交、未推送、未改配置） | `PASS` | 见 §5 |

停止条件命中记录：

> §六 第 1 条「EXE 与源代码无法建立可信对应关系」→ **已命中**（证据见 §1.4）。
> §六 第 3 条「需要修改项目文件」→ 尚未命中，但**方案 A 若改用编译期 `additionalBrowserArgs` 就会命中**，因此设计中刻意走环境变量注入以避开它。

## 5. 证据索引与合规声明

本阶段使用的全部命令（只读）：

```
git rev-parse / merge-base --is-ancestor / status --porcelain / show --stat / log / reflog / stash list / for-each-ref
ls / stat / find / sha256sum / du
grep -a -o -E "index-[A-Za-z0-9_-]{8}\.(js|css)" <exe>      # 内嵌资源名取证
tasklist / netstat -ano
node -p require('./node_modules/playwright/package.json').version
读取（未修改）：src-tauri/tauri.conf.json、tools/desktop-workspace-e2e.cjs、tools/mock-upstream.cjs
```

关键哈希留档：debug exe `571ad599f7c2d809a7ddcee8dc63940e67589da29a2518b4e1d9a493c9690d6b`；release exe `7d17eb310f92b53a0a45f35619ba0caca4136231fc5d673372896288c7accc33`；gnu debug exe `f955df375fbc959c48439217fa98a52b569012ade2bce0f0af94527934994f8a`；`src/lib/md.ts` `03f3c79071094f04b4d5b978ae8e494e`；`src/lib/md.test.ts` `39f7ddd71ab873039ff43144a8c76794`；`src/lib/text.ts` `03518d7e02d58431c673b990eea43722`（末三者证明工作区与我提交的 R1 状态逐字节相同）。

报告完成后的工作区核对：

```
git status --porcelain  → 已跟踪文件 0 处修改
未跟踪新增：docs/audit/C1D_BASELINE_AND_GATE.md（本文件，审计产出，不入提交）
```

未做：启动任何进程、修改任何配置或源码、`git add`、`git commit`、`git push`、删除任何既有产物或日志。远端仍为 `NOT_PUSHED`（本地领先 6）。

## 6. 发布准入建议

**`BLOCKED`** —— 真实桌面端 CDP 验证在本任务授权范围内无法完成，根因是「仓库内不存在与 HEAD 源码可建立可信对应关系的 EXE」，而这既不是代码缺陷也不是测试缺陷，是构建产物的时效性问题。

解除阻塞只需一件事：**授权 O1（重编）或 O2+O3+O4+O5+O8+O9（dev 宿主方案，不重编）**。

发布准入意见（与验证状态分开陈述，避免推断通过）：

- C1/R1 的代码级证据：完整（无头 319 条 + 变异测试 + 3159 例模糊测试 + 边界探针，均已独立复审）。
- 桌面端真机证据：**缺失**，不得由无头结果外推。
- 生产 `csp` 在真实 WebView2 下的实际行为：**缺失**（连 devCsp 都不同）。
- 因此现在把 `b4a3ed2` 推上远端或出安装包属于**证据不完备下的发布**，不建议；等真机结论出来再决定 push。
