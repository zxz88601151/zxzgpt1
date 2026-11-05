# 预览窗口 CSP 真机验证清单（队列 ⑥）

> 日期：2026-11-06 · 状态：**BLOCKED / NOT_TESTED**（本沙箱为 Ubuntu，无 Windows WebView2 宿主）
> 关联：宪章 §3.7「不改 `tauri.conf.json` 的 CSP/安全配置而不做真机验证；CSP 改动必须有宿主级证据」
> 关联技术债：D-23（预览窗口边界未纳入治理）、`README.md` §15.2 第 3 条
> 性质：**验证清单 + 判定标准**，不是验证结论。本文件不含任何 `PASS` 宣称。

---

## 0. 为什么本轮只能交付清单

`open_preview`（`src-tauri/src/lib.rs::preview_cmds`）用
`WebviewWindowBuilder::new(..., WebviewUrl::External(url))` 新建一个 WebView 窗口，
加载任意 http(s) 链接或任意存在的本地文件。需要回答的是**宿主级**问题：

- 主窗口在 `tauri.conf.json` 里配的 `csp` / `devCsp` 会不会作用到这个 External 窗口；
- 外部页面能否通过 `__TAURI_INTERNALS__` / IPC 触达文件系统与命令执行；
- `file://` 页面能否读到工程根之外的文件。

这些只能在 **Windows + WebView2 运行时**里用 DevTools 观察，Ubuntu 沙箱既没有
WebView2 也没有 GUI 宿主；`npm test` / `vite build` 都测不到注入后的 CSP。
按宪章 §3.8「不得伪造 PASS」，本项一律标 **`NOT_TESTED`**，并给出可复现的宿主步骤。

> **本轮没有改 `tauri.conf.json` 的任何 CSP 配置**，因此不需要为未做的改动补证据。

---

## 1. 环境与前置（执行人填写）

| 项 | 要求 | 实测值（待填） |
|---|---|---|
| OS | Windows 10/11，已装 WebView2 Runtime | |
| 工具链 | `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu`（宪章 §5.6） | |
| 构建方式 | `npm run tauri dev`（devCsp）**或** 打包版（生产 csp），两种都要测 | |
| 用户数据目录 | 隔离的临时 `user-data` 目录（宪章 §3.6，不碰真实用户数据） | |
| 版本 | 本次验证对应的 HEAD SHA | |
| 网络 | 允许访问一个受控 http(s) 测试页（用本地 mock 服务，避免外泄数据） | |

---

## 2. 待验证的行为（逐条给结论）

| # | 场景 | 操作 | 期望（安全侧） | 结论（待填） |
|---|---|---|---|---|
| V1 | http(s) 预览 | `/preview https://<本地受控服务>/probe.html` | 窗口能加载；页面内 `<script>` 按 CSP 被拦或放行需与 `tauri.conf.json` 一致 | |
| V2 | 本地 HTML 预览 | `/preview <隔离目录>/probe.html` | 同上，且 `file://` 页面不能读工程根之外的文件 | |
| V3 | CSP 是否注入 | DevTools → Elements 查 `<meta http-equiv="Content-Security-Policy">`，Network 查响应头 | 与所选构建（dev/prod）配置的 `csp` 一致；**若 External 窗口完全没有 CSP，记为 FAIL 并升级 D-23** | |
| V4 | 脚本执行 | probe.html 里放内联脚本与外链脚本 | 生产配置 `script-src 'self'` 下内联脚本应被拦（除非 Tauri 注入 nonce/hash） | |
| V5 | IPC 可达性 | probe.html 里探测 `window.__TAURI_INTERNALS__` / `window.__TAURI__` 并尝试 `invoke("fs_read", ...)` | **外部页面不得能调用任何文件/命令 IPC**；能调用即为高危 FAIL | |
| V6 | 跨域与导航 | 页面尝试 `window.open` / 跳转到另一个域 | 不允许借预览窗口扩大到任意域后仍持有宿主能力 | |
| V7 | 计划/探索模式 | 两种模式下由模型侧构造预览请求 | 模型没有工具能直达 `open_preview`（目前触发口只有用户 `/preview` 与文件回执按钮） | |

---

## 3. 可复现步骤（建议在隔离环境执行）

```powershell
# 1) 隔离 user-data 目录，避免碰真实用户数据
$env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\zxz-csp-probe"
$env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"

# 2) 起一个受控本地页面（probe.html 内容见 §4），不要用公网地址
node tools/mock-upstream.cjs        # 或任意静态服务器，仅本机可访问

# 3) 启动桌面宿主（dev 与打包版各跑一遍）
npm run tauri dev
# 或： npm run tauri build 后安装到隔离目录再运行

# 4) 在应用里分别执行
#    /preview http://127.0.0.1:<port>/probe.html
#    /preview <隔离目录>\probe.html

# 5) 预览窗口里按 F12 打开 DevTools，逐条记录 §2 的 V1~V7
```

`probe.html` 最小内容（只做探测，不做任何破坏性操作）：

```html
<!doctype html>
<meta charset="utf-8">
<title>csp probe</title>
<script>document.title = "inline-ran";</script>
<script src="./external.js"></script>
<pre id="out"></pre>
<script>
  const o = document.getElementById("out");
  o.textContent = JSON.stringify({
    hasInternals: !!window.__TAURI_INTERNALS__,
    hasTauri: !!window.__TAURI__,
    cspMeta: [...document.querySelectorAll("meta[http-equiv]")].map(m => m.content),
  }, null, 2);
</script>
```

DevTools Console 里额外确认：

```js
// 只做「能否解析到 invoke」的探测，不要真的执行写/命令类调用
typeof window.__TAURI_INTERNALS__?.invoke
document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content
```

---

## 4. 判定标准（写死，避免事后解释）

| 判定 | 条件 |
|---|---|
| **PASS** | V3 显示 CSP 与所选构建配置一致，V4 内联脚本按策略被拦，且 **V5 外部页面无法触达任何 IPC**；DevTools Console 无 CSP 报错（除预期被拦的报错） |
| **FAIL** | V3 显示 External 窗口完全没有 CSP，或 V5 能调用文件/命令 IPC |
| **PARTIAL** | 其余组合：例如 CSP 存在但 V4/V6 行为与配置不一致 |
| **NOT_TESTED** | 未在上述宿主环境实操，或证据（截图/日志）缺失 |

**升级规则**：出现 FAIL 时，D-23 从 P2 升 **P1**，并按宪章 §4 停止条件暂停预览相关改动，
先收敛 `open_preview` 的窗口能力（禁用不需要的 IPC / 限定可加载来源），再做第二轮验证。

---

## 5. 证据记录表（执行人填写，空 = 未验证）

| # | 证据类型 | 文件 / 截图路径 | 结论 | 执行人 | 时间 |
|---|---|---|---|---|---|
| V1~V7 | DevTools Console 截图 | | | | |
| V3 | CSP 响应头 / meta 原文 | | | | |
| V5 | IPC 探测输出 | | | | |
| — | 宿主版本与 HEAD SHA | | | | |

---

## 6. 本轮边界声明

- 本轮**未修改** `tauri.conf.json`、`lib.rs::open_preview` 或任何 CSP 相关配置；
- 本轮**未执行**上述宿主验证，未产生任何 `PASS` 结论；
- 队列 ⑥ 在本沙箱的状态是 **`BLOCKED`**，交付物是这份可复现清单；
- 后续若业主提供 Windows 宿主或授权真机环境，按 §3 执行并回填 §5，
  再由**非实施者**复核后才能在 `STATE.md` 把该项从 `NOT_TESTED` 改为 `PASS`
  （宪章 §1：开发结论不构成验收结论）。
