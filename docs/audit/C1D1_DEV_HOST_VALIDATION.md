# C1-D1｜隔离式开发宿主真实桌面验证 —— 审计报告

- 阶段：C1-D1（路线 A：开发宿主 + 既有 debug 桌面二进制）
- 执行时间：2026-11-02 13:05–13:41（本机时钟）
- 角色：独立测试工程师 / QA 审计 / 发布准入评估
- 仓库：`F:\zhuomian\zxz`　分支：`main`　HEAD：`b4a3ed2`
- 报告位置：仓库外（本文件）。**未提交、未 Push、未进入 Release 构建阶段。**
- 最终状态：**PASS_WITH_CONDITIONS**

---

## 0. 基线复核（动手前实测，未引用历史报告作为当前事实）

| 项 | 实测值 | 与预期一致 |
| --- | --- | --- |
| 工作目录 / 仓库身份 | `F:/zhuomian/zxz`，`git rev-parse --show-toplevel` 同路径 | 是 |
| 分支 / HEAD | `main` / `b4a3ed2` | 是 |
| HEAD 父提交 | `35b56c0`（C1） | 是 |
| R1 提交 | `b4a3ed2`（`fix(security): Markdown 链接与图片改用协议白名单…（R1）`） | 是 |
| 受跟踪文件改动 | `git diff --stat` = 0 行；`git status --porcelain` 仅 12 条未跟踪 | 是 |
| 远端状态 | github / origin 均落后，本轮未触碰 | 是（未 push） |
| 既有 EXE（debug） | `571AD599F7C2D809A7DDCEE8DC63940E67589DA29A2518B4E1D9A493C9690D6B`，265,620,205 B，07:51:41 | 是（本轮未重编） |
| 既有 EXE（release） | `7D17EB310F92B53A0A45F35619BA0CACA4136231FC5D673372896288C7ACCC33`，5,036,544 B，11-01 21:20:28 | 是（本轮未重编） |
| 原 `.tmp-ws` 指纹 | 6 文件，`find … -printf "%s %p" \| sort \| md5sum` = `a509349eaef0525f8afce71e1d078ec6` | 是（清理后复测同值） |

未执行 O1（重编 Release）。未修改 `tauri.conf.json`、任何源码、任何测试文件、任何依赖。

---

## 1. 宿主与隔离证明（强制安全前置，先证明才允许跑用例）

启动方式：`src-tauri\target\debug\zxz.exe`（PID 5804，13:10:16），环境变量
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223 --remote-allow-origins=*"`、
`WEBVIEW2_USER_DATA_FOLDER=%TEMP%\c1d\profile`。未改任何项目配置。

清理前逐进程复核（`logs/isolation-final.txt`，UTF-8）：

| 证据 | 实测 |
| --- | --- |
| WebView2 进程总数 | 6（浏览器 1 + crashpad/gpu/network/storage/renderer 5） |
| 带 `--user-data-dir=…\Temp\c1d\profile\EBWebView` 的进程 | **6 / 6** |
| 命令行含 `com.zxz.desktop`（真实 profile）的进程 | **0** |
| 隔离 profile 文件数 / 最新写入 | 410 文件，最新 13:36:53（本轮内） |
| 真实 profile `C:\Users\Administrator\AppData\Local\com.zxz.desktop\EBWebView` | 498 文件，**最新写入 07:52:34**；本轮窗口（≥13:00）内被写/新建文件数 = **0** |
| 进程归属 | 9 个 PID 全部记录 PID/PPID/启动时间/完整命令行；zxz 树 13:10:16、node（vite 8548 / mock 7156）13:05:39，父进程为本轮后台启动器 14164 |

> 更正记录：`isolation-final.ps1` 首版把真实 profile 猜成 `Local\Packages\com.zxz.desktop_*\…`，因而输出了「目录不存在」这一**无效断言**。已定位真实路径为 `Local\com.zxz.desktop\EBWebView` 并单独取证（`logs/real-profile-after.txt`）。上表以更正后的证据为准。

**判定：隔离成立，允许继续执行用例。**

---

## 2. 用例执行结果（V1–V11）

驱动：`%TEMP%\c1d\src\cases.cjs`（Playwright `connectOverCDP` → 真实 WebView2）。
第 1 次完整运行 56 PASS / 1 FAIL（驱动自身缺陷，见 §5-F3）；修正后第 2 次运行 **57 PASS / 0 FAIL / 2 INFO**（`logs/cases-run3.txt`、`logs/cases-results.json`）。

| 用例 | 前置条件 | 操作 | 预期 | 实际 | 原始证据 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| V1 桌面窗口启动 | 隔离 env + debug EXE | 启动 | 窗口/宿主存在 | `title=zxz`，`#root` 5 子节点，`#input` 存在 | run3 行 2 | PASS |
| V2 WebView2 加载 | 同上 | 读文档 | readyState complete | `complete`，`url=http://localhost:1420/`，UA Chromium 156 | run3 行 3 | PASS |
| V3 CDP 连接 | 9223 监听 | connectOverCDP | 连上 1 个 context | `pages=1` | run3 行 1 | PASS |
| V3a 走开发宿主 | — | 读 `script[src]` | `/src/*` 而非 dist 指纹 | `["/@vite/client","/src/main.tsx"]` | run3 行 4 | PASS |
| V3b 宿主桥 | — | 探测 `__TAURI_INTERNALS__` | 存在（浏览器直开不存在） | 存在 | run3 行 5 | PASS |
| V2a/b/c 运行时代码=HEAD | — | 抓取页面实际执行的模块 | 含 R1 白名单、无旧黑名单、含 C1 `reject_busy` | `md.ts` 含 `SAFE_SCHEMES`+`browserScheme`；旧黑名单形态未出现；`appcontrol.ts` 含 `reject_busy`/`nextInputAfterCommand` | run3 行 6–8 | PASS |
| V4 Rust IPC 往返 | mock/proxy 在跑 | `proxy_info` | 返回 port+token | `port=19527`，token 64 hex | run3 行 10 | PASS |
| V4 会话边界 | 临时 `c1d\ws` | `ws_open`→`fs_list_in:sub`→`fs_read`→`fs_write`→`ws_close` | 全部成功且路径落在临时目录 | 6 项全 PASS；写回 `\\?\C:\…\c1d\ws\sub\w.txt` | run3 行 11–15,20 | PASS |
| V4 越界拒绝 | 同上 | `rel="."` / `"../a.txt"` / 绝对路径 / `node -e` / 关闭后复用 | 全部被 Rust 拒 | `路径为空` / `路径里不允许出现 ..` / `不允许绝对路径` / `node 只允许 --version` / `列目录：会话已关闭，请重新接入工程目录` | run3 行 16–18,21 | PASS |
| V4 执行通道 | 同上 | `run_allowed node --version` | 白名单内放行 | `exit_code=0 stdout=v22.23.2` | run3 行 19 | PASS |
| V5 busy 拒绝命令 | `[[slow]]` 流式中 | 生成中键入 `/new` + Enter | 不执行、输入逐字保留、不多发请求 | 会话数 1→1；输入仍 `/new`；上游请求恰 1 次；生成结束后输入未被消耗 | run3 行 V5a–f | PASS |
| V6 解析失败保留原文 | 干净会话 | 键入 `/zzz` + Enter | 报错 toast + 逐字保留 + 零上游请求 + 零消息 | toast `未知命令 /zzz…`；input=`/zzz`；新增上游 0；conv=0 | run3 行 V6a–d | PASS |
| V7 重新生成不误判 | 已有 user+assistant | 输入框填 `/new`，点 `#btnRegen` | 走 reuse 而非命令 | 上游 1 次；conv=1；user=1；无「新建」toast；`/_last` 复核 messages=1 且 lastUser=原问题；助手消息替换为 1 条 | run3 行 V7a–d + V7c2 | PASS |
| V8a 普通消息发送 | 指向 mock | 键入非 `/` 开头句子 + Enter | 经 Rust 代理发出、原文一致、流式落地、输入清空 | `via=rust-proxy`、`base_url=…19888/v1`、带 `x-zxz-token`；`/_last` 原文逐字一致；回答含「模拟回答」；input=`""` | run3 行 V8a1–5 | PASS |
| V8b `/` 开头普通句子 | 同上 | 键入 `/etc/hosts 里的 127.0.0.1 是干嘛的` | 实测：被命令层拦截 | 上游 0 次；toast `未知命令 /etc/hosts…`；输入逐字保留；消息数不变 | run3 行 V8b-* + 截图 | PASS（并登记 F-C1-1） |
| V9 Markdown 真实渲染 | 注入含攻击面的助手消息后重载 | 读 live DOM | 危险协议不落地、合法协议放行、无内联事件 | `a` 数 7（=预期）；协议集合仅 `{https:, http:, mailto:, tel:}`；全页 `javascript:` 锚点 0；`da\tta:` 图未落地、合法图 `naturalWidth=32 complete=true`；内联事件属性 0；无 `<b>`/`<script>` 复活；无残留 `](`；rel/target 全为 `noreferrer noopener`/`_blank` | run3 行 V9–V9h、`logs/v9-dom.json`、`shots/c1d-07-markdown.png` | PASS |
| V10 控制台异常 | 全流程 | 采集 console/pageerror | 无新增无法解释异常 | 采集 9 条，**error 0、warning 0、pageerror 0**；全部为 vite debug / React DevTools info / `verbose:[DOM] Password field…` / 懒加载 info（均为应用既有特征） | `logs/cases-console.json` | PASS |
| V11 退出后释放 | 清理阶段 | 结束本轮进程树 | 端口释放、进程消失 | 9223/1420/19888/19527 全部无监听；`zxz.exe` 与 `msedgewebview2.exe` 进程数 0 | netstat/tasklist 输出 | PASS |

网络侧独立统计（`logs/cases-network.json`）：页面总请求 151，其中上游 `/chat` **恰好 3 次**（V8a、V7、V5），URL 全为 `http://127.0.0.1:19527/chat`，`base_url` 全为 `http://127.0.0.1:19888/v1`，3/3 带 `x-zxz-token` 头，`messages` 数序列 `[1,1,3]` —— 与 V7「旧回答被切掉后只带 1 条 user」互相印证。

---

## 3. 取证方法边界（不得冒充的部分）

| 手段 | 属于 | 说明 |
| --- | --- | --- |
| `page.keyboard.type/press`（CDP `Input` 域） | 真实 WebView2 输入管线 | 命令输入、发送、点击全部走这条路径，非 DOM 注入事件 |
| `page.evaluate` 写 `localStorage` 注入 settings/消息 | **状态注入** | 仅用于构造前置数据（V2d、V9 载荷），不得当作「用户输入」证据 |
| `page.evaluate` 调 `__TAURI_INTERNALS__.invoke` | **宿主 IPC 直调** | 证明 Rust 侧边界与命令面，与 App UI 是否这样调用无关（App 经 `src/lib/fsapi.ts` 同一通道） |
| 结论适用范围 | 前端逻辑 + Rust IPC | **开发宿主通过 ≠ 生产 Release 验证通过**（见 §4、§6） |

---

## 4. §6 构建来源对应关系（EXE ↔ 源码）

| 取证项 | 实测 |
| --- | --- |
| debug EXE SHA-256 | `571AD599…90D6B`（265,620,205 B，07:51:41） |
| 版本资源 | `FileVersion=0.3.0`、`ProductVersion=0.3.0`、`FileDescription=zxz`、`CompanyName=zxz`（`logs/verinfo.txt`） |
| 内嵌配置逐字节比对 | HEAD `tauri.conf.json` 的 **csp（297 B）命中 1 次、devCsp（317 B）命中 1 次**，`com.zxz.desktop` 1 次、`http://localhost:1420` 1 次（`logs/exe-csp-audit.json`，附命中上下文原文） |
| P0-1 模块存在性 | `wsx.rs`（仅存在于 a280051 之后）在二进制中出现 4 次；`ws_open` 3 次；`会话已关闭` 2 次 |
| 全部 HEAD Rust 模块名 | `api/fsx/lib/main/proxy/runx/wsx.rs` 均在二进制中出现（无缺失模块） |
| 行为级印证 | 运行中的宿主返回了 `列目录：会话已关闭，请重新接入工程目录`，该文案由 HEAD `wsx.rs:162` 字面量 + `fsx.rs` 运行时前缀拼成 |
| Release EXE | `ws_open=0`、`wsx.rs=0`、`会话已关闭=0` → **可证明不含 P0-1 会话边界**，早于 C1/R1，不能用于生产侧验证 |

**判定：UNKNOWN（严格字节级对应关系无法证明）**，理由与可用结论：

1. 项目未嵌入任何构建元数据（无 commit hash / 无 `vergen` 类产物），无法把二进制钉到某个 revision；**时间戳不作为构建来源证明**。
2. 两个构建输入 `src-tauri/Cargo.toml`(07:52:34)、`tauri.conf.json`(07:52:40) 的 mtime **晚于** EXE 的 07:51:41，因此「构建时配置内容」不可知（当前内容与 HEAD 一致，但那是事后状态）。
3. 可用的强证据是**内容级**的：内嵌 csp/devCsp/identifier/devUrl 与 HEAD 逐字节一致，且含 P0-1 才有的 `wsx.rs` 模块与错误文案 → 该 debug 二进制**至少**是 P0-1 之后、且配置为 HEAD 形态时构建的。
4. 但见 F-C1D1-2：该二进制内嵌配置里还含一个 HEAD 不存在的字符串 `--remote-debugging-port=9223`，说明它构建自**一个带临时 CDP 参数的工作树**，与 HEAD 的配置内容并非完全一致 → 严格对应关系只能记 UNKNOWN。

---

## 5. 发现清单

| 编号 | 内容 | 严重度 | 证据 |
| --- | --- | --- | --- |
| F-C1-1 | 任何 trim 后以 `/` 开头的输入都进入命令命名空间，未知命令只报错、不透传。开发者高频句子（`/etc/hosts 里的 127.0.0.1 是干嘛的`、`/src/App.tsx 里的 useEffect`）**永远发不出去**，用户必须改写（前置空格也不行，会被 trim）。单测 `appcontrol.test.ts:32`（`/rm -rf` 判未知命令）锁死了该机制，所以**实现没有偏离测试**；但它与本文件自己的设计约束「普通消息一个字都不拦截」（`appcontrol.ts:7-8`）相互矛盾 —— 以斜杠开头的正常句子正是普通消息。 | 中（可用性） | run3 V8b-*、截图 `c1d-04`/`c1d-04b`；已登记为技术债 **D16** |
| F-C1D1-2 | `src-tauri/target/debug/zxz.exe` 内嵌 `additionalBrowserArgs = --remote-debugging-port=9223`（HEAD 配置无此字段）。即：**该调试产物一启动就在 127.0.0.1 开放 CDP**，任何本机进程可接管该 WebView 并调用其 Rust IPC（含 `ws_open` 任意目录）。属构建产物卫生问题，非 HEAD 源码缺陷。 | 中（本地产物风险） | `logs/exe-csp-audit.json` 命中上下文原文 |
| F-C1D1-3 | 本轮 CDP 端口的**因果归属未定**：浏览器进程命令行只含 `--remote-debugging-port=9223`（与内嵌值一致），未见我经 env 追加的 `--remote-allow-origins=*`。profile 隔离确定来自 env（`Temp\c1d\profile` 非 HEAD 配置值），端口则更可能来自二进制内嵌。区分两者需以「不带 env 再启一次」验证，而那会写入真实用户 profile —— 超出授权，**未做**。 | 低（证据完备性） | `logs/isolation-final.txt` 行 7 |
| F-C1D1-4 | 截图帧不同步：`c1d-04-passthrough.png` 与 `c1d-04b-slash-sentence.png` **字节完全相同**（md5 `7bc85132…`），内容为 V8b 时刻。说明 Playwright-over-CDP 在 WebView2 上的截图可能与断言时刻不同帧，V8a 无独立截图。故本轮以 JSON/DOM 断言为主证，截图为旁证。 | 低（证据质量） | `md5sum shots/*` |
| F-C1D1-5 | 驱动缺陷两处（已修，第 1 次运行的 1 个 FAIL 是**假红**）：① `run_allowed node --version` 期望桶放错；② toast 观察器把上一条用例仍在前台的 toast（2600ms 生命周期）重扫进本条 → V8a2 假红，改为等 `#toastHost` 清空再复位。 | — | `logs/cases-run2.txt` vs `cases-run3.txt` |
| F-C1D1-6 | 工具异常披露：本轮一次 `Grep` 返回了仓库中**不存在**的内容（`isCommandLikeText`、多条 `/etc/hosts` 断言、`{kind:"none"}` 出现在 App.tsx）。已用 `Bash grep` + `Read` 复核并弃用该结果，本报告结论不依赖它。 | 中（审计可信度） | `grep -rn "etc/hosts" src/` 无匹配 |

---

## 6. 证据缺口 / 未测（不得推断通过）

| 项 | 状态 | 缺口 |
| --- | --- | --- |
| 生产 Release 宿主下的 V1–V11 | **NOT_TESTED** | Release EXE 可证明早于 P0-1（§4），必须先重编（O1，未授权） |
| 真实模型上游（非 mock） | NOT_TESTED | 本轮只用本地 mock，未触碰真实账号 |
| 工具调用链路（`toolCalls=true`：list/read/write/run_command + 写入确认面板） | NOT_TESTED | 测试状态里显式关闭，未覆盖 |
| 工程目录 UI（选文件夹、`.zxz` 记忆、目录树、技能加载、计划模式） | NOT_TESTED | 未走 UI，仅直调 IPC 验证边界 |
| 斜杠命令 `/help`、`/plan 开`、`/tools 关`、`/new` 的**桌面端**行为 | NOT_TESTED | 仅单测覆盖；本轮只测了 `/zzz`、`/new`(busy)、`/etc/hosts` |
| 窗口关闭/重启后会话失效、多窗口、DPI、真实鼠标/IME | NOT_TESTED | 本轮以 CDP `Input` 键入，未做真 OS 级鼠标与中文输入法组合 |
| EXE ↔ HEAD 严格对应 | **UNKNOWN** | 见 §4 |

---

## 7. §8 清理与完整性核对

| 核对项 | 结果 |
| --- | --- |
| 仅结束本轮启动的进程 | `taskkill /PID 5804 /T`（zxz + 6 个 webview2 子进程）、`7156`（mock）、`8548`（vite）；连带其子 PID 828/15412/4044/5624，均属本轮树 |
| 未终止无法确认归属的进程 | 是（PPID 5492/14164 未动） |
| 端口释放 | 9223 / 1420 / 19888 / 19527 清理后无监听 |
| 真实用户 profile | 未被写入（本轮窗口内 0 文件被写/新建，最新写痕仍是 07:52:34） |
| git 工作树 | HEAD 仍 `b4a3ed2`；受跟踪改动 0；未跟踪仍 12 条（本轮**未在仓库内新建任何文件**） |
| 既有 EXE 哈希 | debug `571AD599…`、release `7D17EB31…` 与清理前一致 |
| 原 `.tmp-ws` | 指纹 `a509349eaef0525f8afce71e1d078ec6` 前后一致，未删除未重建 |
| 仓库外证据保留 | `%TEMP%\c1d\{src,logs,shots,ws,profile}` 全部保留（本轮唯一写入区，归属明确） |

---

## 8. 必答问题

1. **C1/R1 前端逻辑是否通过真实桌面验证？** 是 —— 57/57 断言在真实 Windows WebView2 宿主通过；R1 的协议白名单在 live DOM 上落地为 `{https, http, mailto, tel}`，危险协议（含 `java\tscript:`、`da\tta:`、vbs/file/blob/chrome）全部降级为纯文本且无残留 `](`；C1 的 busy 拒绝、解析失败逐字保留、reuse 不误判、普通消息零拦截均实测成立。
2. **Rust IPC 是否通过？** 是 —— `proxy_info`/`ws_open`/`fs_list_in`/`fs_read`/`fs_write`/`run_allowed`/`ws_close` 全部往返成功，且绝对路径、`..`、`node -e`、关闭后复用四类越界全部由 Rust 侧拒绝；所有读写落在本轮临时目录。
3. **是否有控制台异常？** 无 —— error 0、warning 0、pageerror 0（9 条均为 vite/React 既有 info/debug）。
4. **是否有危险链接渲染？** 无 —— 全页 `javascript:` 锚点 0；截图可见危险行整行纯文本、合法行才是链接。
5. **是否有生产 Release 对应关系证据？** **没有** —— Release 二进制可证明不含 P0-1 会话边界；debug 二进制与 HEAD 的严格对应记 UNKNOWN（含 F-C1D1-2 的反证）。
6. **哪些仍未测？** 见 §6 表：生产 Release、真实上游、工具调用链、工程目录 UI、其余斜杠命令、真 OS 鼠标/IME、窗口生命周期。

**最终状态：PASS_WITH_CONDITIONS**

条件：① 生产 Release 侧验证仍为 0（需 O1 重编后另批）；② EXE↔HEAD 严格对应为 UNKNOWN；③ F-C1-1 与 F-C1D1-2 已登记为债务 **D16/D17**，是否立项修复待业主裁决；④ 本报告已按单独授权归档进 `docs/audit/`，仓库外原件（`%TEMP%\c1d\`）继续保留作为原始证据。

---

## 9. 归档时的更正与登记（本文件入库时追加）

1. **F-C1-1 定性更正**：驱动原始输出（`logs/cases-run3.txt` 的 INFO 行）写的是"属设计选择而非实现偏离"。归档复核后更正为：实现与单测一致，但**与 `appcontrol.ts:7-8` 的设计自述（"普通消息一个字都不拦截"）矛盾** —— 以 `/` 开头的正常句子就是普通消息。原始日志不改，以本节为准。
2. **F-C1D1-2 处置**：连同 F-C1-1 一并登记进 `docs/audit/TECHNICAL_DEBT.md`，编号 **D17**（P0）与 **D16**（P1），含建议解法。
3. **§1 的 profile 路径更正**已在原处标注（首版脚本猜错路径导致一条无效断言，已用 `Local\com.zxz.desktop\EBWebView` 重新取证）。
4. 本轮未在仓库内创建除本文件与债务台账之外的任何文件；未提交、未 Push。

---

## 附录 A：证据文件

```
%TEMP%\c1d\
  src\cases.cjs  smoke.cjs  exe-csp-audit.cjs  isolation-final.ps1  real-profile.ps1  verinfo.ps1  procs.ps1 …
  logs\cases-run.txt / cases-run2.txt / cases-run3.txt      三次运行逐条输出
  logs\cases-results.json (9.9K) / cases-console.json / cases-network.json (22K)
  logs\smoke-results.json / smoke-console.json
  logs\exe-csp-audit.json      内嵌配置命中数 + 上下文原文
  logs\isolation-final.txt     9 PID 全命令行 + user-data-dir 归属统计 + 端口
  logs\real-profile-after.txt  真实 profile 498 文件、本轮 0 写痕
  logs\verinfo.txt             EXE 版本资源
  shots\c1d-01…07 *.png        8 张（04 与 04b 同帧，见 F-C1D1-4）
  ws\ marker.txt sub\a.txt sub\w.txt   本轮唯一被 IPC 写过的目录
  profile\EBWebView            隔离 profile（410 文件）
```

## 附录 B：复现要点

1. `npm run dev`（1420）+ `node tools/mock-upstream.cjs 19888`；
2. 以 `WEBVIEW2_USER_DATA_FOLDER=%TEMP%\c1d\profile` 启动 `src-tauri\target\debug\zxz.exe`（9223 由该产物内嵌参数提供，另需 `--remote-allow-origins=*` 才能被 Playwright 连上）；
3. `node %TEMP%\c1d\src\cases.cjs`；
4. 断言读的是 live DOM（`a.protocol`）、mock 的 `GET /_last`、`localStorage` 快照与 CDP 网络事件，四路互相独立。
