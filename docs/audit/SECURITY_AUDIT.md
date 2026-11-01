# ZXZGPT1 — Phase 0 安全审计

> 阶段性质：**READ-ONLY / AUDIT-ONLY**。本文档只记录证据与建议，**未修复任何问题、未修改任何业务代码**。
> 每条问题包含：① 风险描述 ② 源码路径 ③ 触发条件 ④ 潜在影响 ⑤ 建议修复 ⑥ 优先级。
> ## ⚠️ 审计期间的外部并发变更（必读）
>
> 本审计只读不写。但在审计窗口内（**22:07–22:10**）有多个文件被**外部进程/协作者**并发修改，非本审计所为：
>
> | 文件 | 变更（并发方所改） | 影响本报告的哪条 |
> |---|---|---|
> | `src-tauri/tauri.conf.json` | `"csp": null` → 完整 CSP（`script-src 'self'`，生产无 `unsafe-inline`）+ `devCsp` | **S1 影响缓解、S10 已修复** |
> | `src-tauri/src/proxy.rs` | 新增 Host 回环校验（挡 DNS rebinding）；`gen_token` 改用 `RandomState` 拼 256 位 | **S6 已修复** |
> | `README.md` | 单测条数 150 → 246（§9.6 已改；**§1 目录树下的"150 条单测"仍未改**） | D11 部分修复 |
> | `src-tauri/Cargo.toml` / `Cargo.lock` | `version 0.1.0` → `0.3.0`（版本号对齐） | 无（顺带修了 P6 记录的不一致） |
> | `CLAUDE.md` | 内容有更新，但第 46-47 行"OS 熵 256 位 + Host 校验"的要求**仍在** | 现已与代码一致 ✅ |
>
> **取证时点说明**：S1/S6/S10 的取证发生在 22:06–22:07，当时 `csp` 确为 `null`、
> `gen_token` 确为「时间 ^ pid + xorshift」、确无 Host 校验 —— **结论在取证时点成立**。
> 现在这三条已被并发方修复/缓解：
> - **S1**：CSP 会拦截 `onerror=` 等内联事件处理器，可利用性从 Critical 降为 **High**；
>   但 `escapeHtml` 不转义引号这一**根本缺陷仍在**，必须修（见 S1 ⑤）。
>   另：新 CSP 的 `connect-src` 含 `http: https:`、`img-src` 含 `http: https:`，偏宽，建议收紧。
> - **S6 / S10**：**已由并发方修复**，本报告的对应条目保留为**取证记录**，实施时先复核当前 HEAD。
>
> **未受影响的条目**：S2（root 不受约束）、S3（git 白名单绕过，已实测）、S4（悬空符号链接）、
> S7（无命令审批）、S8、S9、S11、S12、S14 —— 截至本报告完成时**均未修复**。
>
> **P0-1 落地后的状态更新（工程会话化）**：S2 与 S4 的**核心部分已修复** ——
> 文件/命令 IPC 改为只收 `sessionId`，工程根目录由 `src-tauri/src/wsx.rs` 登记并 canonicalize；
> 路径解析改为逐段 `symlink_metadata` + `canonicalize`（悬空链接一律拒绝），
> 包含判定用组件级 `Path::starts_with` 而非字符串前缀（详见 `docs/roadmap/` 后续记录与 Rust 单测）。
> **仍未处理**：S3（git 加固）、S7（命令审批，归 P0-4）、以及 `ws_open` 本身可被任意调用方
> 传入任意目录（需 P0-4 权限系统按「用户手势 / 白名单」约束，见下文 S2 条目）。
>
> 优先级口径：**P0** = 可被链式利用导致任意代码执行或全盘数据泄露，应在 P0 开发阶段前修复；
> **P1** = 高危但利用条件更苛刻或影响面较小；**P2** = 应在 P1-P2 阶段处理；**P3** = 产品化阶段。

---

## 0. 风险总表

| ID | 标题 | 严重度 | 优先级 | 证据强度 |
|---|---|---|---|---|
| **S1** | Markdown 属性注入 → XSS → 借 IPC 全盘读写 | Critical（CSP 已配后降为 High） | **P0** | 源码确认（取证时 `csp: null`，见顶部说明） |
| **S2** | 文件/命令 IPC 的 `root` 参数不受约束 = 全盘读写原语 | Critical | **P0** | 源码确认 |
| **S3** | `git diff` 可被工程内 `.git/config` 劫持执行任意命令 | High | **P0** | **已实测确认** |
| **S4** | 悬空符号链接写入逃出工程根 | High | **P0** | 源码分析（Windows 行为待实测） |
| **S5** | API Key 明文持久化在 localStorage | High | **P1** | 源码确认 + 文档自认 |
| **S6** | 代理 token 非密码学随机 + 无 Host 校验 | High（**22:09 已被并发方修复**） | P1 | 源码确认（取证时未修复，见顶部说明） |
| **S7** | `run_command` 无逐次审批；写+跑组合 = 任意代码执行 | High | **P0** | 源码确认 |
| **S8** | 子进程继承完整环境变量 | Medium | P2 | 源码确认 |
| **S9** | 工程内敏感文件（.env/密钥）无拒绝清单，可随上下文外发 | Medium | P2 | 源码确认 |
| **S10** | CSP 为 null（**22:09 已配**）+ 代理 `Access-Control-Allow-Origin: *`（**仍未改**） | Medium | P1 | 源码确认（CSP 已修，ACAO 未修） |
| **S11** | Unix 侧子进程超时不杀进程组 | Medium | P2 | 源码自认 |
| **S12** | 无工具调用审计日志 | Medium | P2 | 源码确认 |
| **S13** | MCP 尚未引入，但无权限边界设计（前瞻约束） | — | P4 前置 | 现状不适用 |
| **S14** | undo 快照在工程内明文长期保存旧内容 | Low | P3 | 源码确认 |

---

## S1 · Markdown 属性注入 → XSS → 借 IPC 全盘读写 【Critical / P0】

### ① 风险描述
`escapeHtml` 只转义 `&`、`<`、`>`，**不转义 `"` 与 `'`**。而 Markdown 渲染在拼接 `<a href="…">`、`<img src="…" alt="…">` 时，
把已经"转义过"的 URL / label **直接放进 HTML 属性**，并且只黑名单了 `javascript:` / `data:` 两种协议。
属性引号从未被转义 ⇒ 可以闭合属性并注入任意事件处理器 ⇒ **存储型 XSS**。

### ② 源码路径
- `src/lib/text.ts:7-9` —— 转义函数缺引号：
  ```ts
  export function escapeHtml(s: unknown): string {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  ```
- `src/lib/md.ts:40-46` —— URL 与 label 拼进属性，只挡两种协议：
  ```ts
  text = text.replace(/!?\[([^\]]*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (m, label, rawUrl) => {
    const clean = String(rawUrl).replace(/&amp;/g, "&").split(/\s+&quot;/)[0];
    if (/^\s*javascript:/i.test(clean) || /^\s*data:/i.test(clean)) return label;
    return m.startsWith("!")
      ? keep(`<img src="${clean}" alt="${label}" loading="lazy" />`)
      : keep(`<a href="${clean}" target="_blank" rel="noreferrer noopener">${label}</a>`);
  });
  ```
  注意：`.replace(/&amp;/g, "&")` 还会把 `&` 还原 —— 即 `&#x22;`（经 escapeHtml 变 `&amp;#x22;`）
  会被还原成 `&#x22;`，浏览器解析属性时再解码为 `"`，**同样能闭合属性**。
- `src/components/MessageList.tsx:57, 87` —— `dangerouslySetInnerHTML` 消费这段 HTML。
- `src-tauri/tauri.conf.json:28` —— `"csp": null`，**没有 CSP 兜底**。

### ③ 触发条件
只要有一段进入消息体的 Markdown 含有形如 `![x](y" onerror="PAYLOAD)` 的链接即可。
内容来源至少有三条路径：
1. 模型输出（上游被劫持、或中间人改响应体）；
2. **被代理读进上下文的项目文件** —— `CLAUDE.md`、任意源码文件都可以通过 prompt injection 诱导模型输出该串；
3. 导入的会话 JSON（`App.tsx:1092` 只校验是数组，内容原样渲染）。

### ④ 潜在影响
WebView 内任意 JS 执行 ⇒ 直接调用 `window.__TAURI_INTERNALS__.invoke` ⇒ 与 **S2** 叠加后：
**任意路径文件读写 + 白名单命令执行 + 读取 localStorage 中的 API Key**。
这是本项目单条最严重的漏洞，因为它把"模型/仓库内容"直接升级成"用户本机权限"。

### ⑤ 建议修复
1. `escapeHtml` 补齐 `"` → `&quot;` 与 `'` → `&#39;`；**属性插值必须走属性转义，不能复用文本转义**；
2. 链接 URL 改为**协议白名单**（只允许 `http` / `https`），且用 `encodeURI` 归一化后再入属性；
3. 移除 `.replace(/&amp;/g, "&")` 的还原逻辑（它是绕过转义的后门）；
4. `tauri.conf.json` 配置 CSP（至少 `default-src 'self'`、禁 `unsafe-inline` 的 script）；
5. 中期：把 `dangerouslySetInnerHTML` 换成 React 元素树渲染或经 sanitizer 白名单过滤。

### ⑥ 优先级
**P0** —— 必须在任何"让代理读不可信仓库"的场景上线前修复。

---

## S2 · 文件/命令 IPC 的 `root` 参数不受约束 = 全盘读写原语 【Critical / P0】

### ① 风险描述
`fs_read` / `fs_write` / `fs_exists` / `run_allowed` 都接受一个 `root` 参数，
Rust 侧对它**唯一的约束是"绝对路径且 canonicalize 成功"**。
"工程根目录"这个概念**只存在于前端调用方的自律**（`App.tsx` 传 `ws.root`），不在 IPC 契约里。
因此这组 IPC 本身就是一个**不受限的全盘读写 + 命令执行原语**。

### ② 源码路径
- `src-tauri/src/fsx.rs:55-61`：
  ```rust
  fn canon_root(root: &str) -> Result<PathBuf, String> {
      let p = Path::new(root);
      if !p.is_absolute() { return Err("工程目录必须是绝对路径".into()); }
      fs::canonicalize(p).map_err(|e| format!("工程目录不可用（{root}）：{e}"))
  }
  ```
- `src-tauri/src/lib.rs:60, 65, 70, 79` —— `fs_read(root, rel)` / `fs_exists` / `fs_write` / `run_allowed(root, argv)`。
- `src/lib/fsapi.ts:81-99, 114-120` —— 前端封装**不校验 `root === workspace.root`**。
- `src-tauri/src/fsx.rs:83-110` —— `fs_list(path)` 同样接受任意绝对路径（这是文件夹选择器所需，但对攻击者同样开放）。

### ③ 触发条件
任何能发起 IPC 调用的代码路径：
- **S1 的 XSS**（最直接）；
- 前端 bundle 被替换/注入（无 CSP + 无完整性校验）；
- 未来新增的任意调用点不小心传错 root（人为失误也会直接变成越权）。

示例（攻击者视角，拿到 JS 执行权后）：
```
invoke("fs_read",  { root: "C:\\Users\\me\\.ssh", rel: "id_rsa" })
invoke("fs_list",  { path: "C:\\" })
invoke("fs_write", { root: "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
                     rel: "x.bat", content: "..." })
```

### ④ 潜在影响
- 读取本机任意文本文件（SSH 私钥、其他工程源码、浏览器凭据文件）；
- 写入任意路径（启动项、其他工程、`C:\Windows\` 以外几乎任何可写位置）；
- 配合 `run_allowed` 的 `root` 自由度，在攻击者自建目录里执行白名单命令（见 S7）。

### ⑤ 建议修复
1. **引入"工程会话（WorkspaceSession）"**：用户选目录时由 Rust 侧登记 root 并返回一个 `sessionId`；
   后续 `fs_*` / `run_allowed` 只接受 `sessionId`（或校验 `root ∈ 已登记集合`），不再接受任意 root；
2. `fs_list` 保留给选择器，但应标记 `internal`，且**禁止与工程会话在同一能力集内被模型侧路径触达**；
3. `Capabilities` 层面拆分：给 WebView 的最小权限只含工程会话通道；
4. 短期缓解：在 `fsapi.ts` 层断言 `root === settings.workspace?.root`，不匹配直接抛错（**这只是缓解，不是边界**）。

### ⑥ 优先级
**P0** —— 这是安全边界错位的根因，S1 的危害正是由它放大的。

---

## S3 · `git diff` 可被工程内 `.git/config` 劫持执行任意命令 【High / P0，**已实测确认**】

### ① 风险描述
白名单放行了 `git diff` / `git diff --stat`。但 git 会读取**仓库内**的 `.gitattributes` 与 `.git/config`，
其中 `diff.<driver>.textconv` 指定的命令会在 `git diff` 执行时被调用 ⇒ **argv 白名单被完全绕过**。
而代理的 `write_file` 工具**可以写 `.git/config`**（`fsx.rs` 没有 `.git` 拒绝清单）。

### ② 源码路径
- `src-tauri/src/runx.rs:264-269` —— 放行 `git diff` 与 `git diff --stat`；
- `src-tauri/src/runx.rs:305-315` —— 只设置了 `GIT_CEILING_DIRECTORIES`，**未设置 `GIT_CONFIG_NOSYSTEM` / 未隔离 config**；
- `src-tauri/src/fsx.rs:247-276` —— `write()` 未拒绝 `.git/**`；
- `src/lib/tools.ts:202-208` —— `write_file` 的 `relPathError` 只拒绝 `..` 与盘符，`.git/config` 合法。

### ③ 触发条件（攻击链，全部在白名单内完成）
1. 代理被诱导（或用户 clone 的恶意仓库自带）执行 `write_file({path: ".gitattributes", content: "d.bin diff=p"})`；
2. `write_file({path: ".git/config", content: "[diff \"p\"]\n\ttextconv = <任意命令>"})`；
3. 代理（或用户）执行 `run_command({argv: ["git", "diff"]})`；
4. git 执行 `textconv` 指定的命令 ⇒ 任意代码执行。

### ④ 实测证据
在临时目录构造最小复现（**未触碰本项目任何文件**）：

```
$ git init -q . && printf 'v1\n' > d.bin
$ echo 'd.bin diff=p' > .gitattributes
$ printf '[diff "p"]\n\ttextconv = touch /tmp/gp3/EXECUTED\n' >> .git/config
$ git add -A && git commit -qm i && printf 'v2\n' > d.bin && git add d.bin
$ git diff --cached >/dev/null
=== A) 普通 git diff --cached ===
执行了外部命令（白名单被绕过）
=== B) 加 --no-textconv --no-ext-diff ===
已阻断
```

结论：**`git diff` 确实会执行仓库内配置指定的外部命令；`--no-textconv --no-ext-diff` 可关闭该路径。**

### ⑤ 建议修复
1. 白名单内所有 git 命令**强制追加** `--no-textconv --no-ext-diff`（Rust 侧在 spawn 前注入，前端不可控）；
2. spawn 时设置 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`，并显式传 `-c core.fsmonitor=false -c core.pager=cat`；
3. `fsx::write` 增加路径拒绝清单：`.git/**`（至少覆盖 `.git/config`、`.git/hooks/**`、`.git/info/**`）；
4. 中期：git 操作改走 `libgit2`/`git2` crate，彻底摆脱外部 git 进程与仓库配置。

### ⑥ 优先级
**P0** —— 已实测可利用，且完全落在当前白名单之内。

---

## S4 · 悬空符号链接写入逃出工程根 【High / P0】

### ① 风险描述
`fsx::write` 的符号链接检查被包在 `if target.exists()` 里。
对于**悬空符号链接**（指向工程外、且目标尚不存在），`Path::exists()` 返回 `false`，
整段检查被跳过，随后 `fs::write(&target, …)` 会**跟随链接在工程外创建文件**。

### ② 源码路径
`src-tauri/src/fsx.rs:260-270`：
```rust
// 目标若已存在且是符号链接，要确认它指向的仍在工程内
if target.exists() {
    if let Ok(real) = fs::canonicalize(&target) {
        if !real.starts_with(&rootc) {
            return Err(format!("{rel} 指向工程目录之外，拒绝写入"));
        }
    }
}
let created = !target.exists();
fs::write(&target, content.as_bytes())   // ← 悬空链接时，这里跟到了工程外
```
对比：`read` 侧（`fsx.rs:230-236`）虽也是 `if let Ok(...)`，但读取悬空链接必然失败，因此**不构成泄露**；
真正的缺口在 write。

### ③ 触发条件
工程目录内存在一个指向工程外的悬空符号链接（**Git 可以携带符号链接**，clone 一个恶意/被投毒的仓库即可获得），
随后代理（或用户）通过 `write_file` 命中该相对路径。
攻击者可据此在 `~/.ssh/authorized_keys`、启动目录、其他工程等位置创建或覆盖文件。

### ④ 潜在影响
任意路径文件创建/覆盖 ⇒ 与 S3/S7 同级的任意代码执行后果。

### ⑤ 建议修复
1. **无条件**做符号链接检查，不依赖 `exists()`：
   - 用 `fs::symlink_metadata(&target)` 判断 `is_symlink()`，**是则直接拒绝**（写入不允许穿越链接）；
   - 或用 `OpenOptions::new().write(true).create(true).custom_flags(O_NOFOLLOW)` 打开；
2. 把父目录的 canonicalize 检查（`fsx.rs:252-258`）扩展到**每一级**路径分量；
3. 补一条 harness 单测：在 temp 目录建悬空链接 → `write` 必须返回错误。
   现有单测（`fsx.rs:312-338`、`373-403`）只覆盖了 **junction（目录链接）**，未覆盖**文件符号链接/悬空链接**这一形态。

### ⑥ 优先级
**P0**。
> 【待验证】Windows 上创建文件符号链接通常需要管理员权限或开发者模式，而 junction 不需要。
> 因此实际可利用性取决于符号链接如何进入工程目录（clone 自 Linux 构建的仓库是最现实的途径）。
> 判定为 P0 是因为修复成本极低（几行），而不修的后果是工程根边界失效。

---

## S5 · API Key 明文持久化在 localStorage 【High / P1】

### ① 风险描述
`Settings.apiKey` 与整个 `AppState` 一起被 `JSON.stringify` 后写入 localStorage，
落盘在 WebView 的用户数据目录中，**未加密**。

### ② 源码路径
- `src/state.ts:31-33`：`localStorage.setItem(STORE_KEY, JSON.stringify(state))`；
- `src/state.ts:14`：`STORE_KEY = "zxz.state.v1"`；
- `src/App.tsx:118-127`：250ms 防抖后整体持久化；
- `README.md §7`：文档自认"明文存放，不外发；若机器多人使用请自行注意"；
- `CLAUDE.md:43-44` 要求"不要把它写进任何导出的审计清单"，但**导出会话**（`App.tsx:1069-1085`）只导出 conversations，不含 Key —— 这一条是符合的。

### ③ 触发条件
- 同一台机器的其他用户/进程读取 WebView 用户数据目录；
- 用户数据目录被同步/备份到云端；
- **与 S1/S2 叠加**：XSS 可直接 `localStorage.getItem("zxz.state.v1")` 取走 Key。

### ④ 潜在影响
上游模型凭据泄露 ⇒ 额度被盗用；若该 Key 另有权限（部分厂商一个 Key 通吃），影响面更大。

### ⑤ 建议修复
1. Key 移出 localStorage：Rust 侧用 OS 凭据库（`keyring` crate；Windows 凭据管理器 / macOS Keychain / libsecret）保存；
2. 前端 `Settings.apiKey` 退化为"是否已配置"的占位显示，真实 Key 由 Rust 在发请求时注入；
3. 过渡期：至少对 Key 字段做 DPAPI/加密存储，并在导出/日志中强制脱敏。

### ⑥ 优先级
**P1**（P0 阶段应先做 S1/S2/S3/S4，随后立即处理）。

---

## S6 · 代理 token 非密码学随机 + 无 Host 校验 【High / P1】

### ① 风险描述
本地代理的唯一鉴权是 `x-zxz-token`。该 token 由**纳秒时间 ^ pid 的 xorshift** 生成（可预测），
且请求处理**不校验 Host 头**（无法挡 DNS rebinding）。
而 `CLAUDE.md` 明确写了"应当"用 OS 熵生成 256 位并校验 Host —— **项目记忆与实现不一致**。

### ② 源码路径
- `src-tauri/src/proxy.rs:34-46`：
  ```rust
  fn gen_token() -> String {
      let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
      let pid = std::process::id() as u128;
      let mut x = nanos ^ (pid.wrapping_mul(0x9E37_79B9_7F4A_7C15));
      ...xorshift...
      format!("{:016x}", x)
  }
  ```
- `src-tauri/src/proxy.rs:129-141`：只比对 `x-zxz-token`，**不校验 Host / Origin**；
- `src-tauri/src/proxy.rs:20`：`BASE_PORT = 19527`，探测范围仅 64 个端口（端口可枚举）；
- **`CLAUDE.md:45-47` 的反证**：
  > "令牌用 OS 熵初始化的 `RandomState` 生成 256 位，别退回「时间 ^ pid」那种可预测写法；
  > 进入后还要校验 Host 是回环名（`127.0.0.1`/`localhost`），挡 DNS rebinding。"
  两条要求**代码均未实现**。

### ③ 触发条件
- 本机恶意进程：枚举 19527-19590 端口 → 用"启动时间 + pid"缩小 token 空间 → 爆破；
- 恶意网页 + DNS rebinding：把某域名解析到 `127.0.0.1`，让浏览器带着 `x-zxz-token` 跨站请求
  （需先以某种方式获得 token；**与 S10 的 `ACAO: *` 叠加会放大**）。

### ④ 潜在影响
本机任意进程可驱动代理：用**用户的 Key**向任意 `base_url` 发请求、拉取模型列表、消耗额度；
若把 `base_url` 指向攻击者服务器，还能把整个会话上下文（含工程代码）转发过去。

### ⑤ 建议修复
1. token 改用 OS 熵：`getrandom` / `rand::rngs::OsRng`，长度 ≥ 256 位；
2. 校验 `Host` ∈ `{127.0.0.1, localhost, [::1]}`（含端口变体），不匹配直接 403；
3. 非 `/health` 路由校验 `Origin`/`Sec-Fetch-Site`；
4. 同步修正 `CLAUDE.md`（或按计划实现它，使文档与代码一致）。

### ⑥ 优先级
**P1**

---

## S7 · `run_command` 无逐次人工审批；写 + 跑组合 = 任意代码执行 【High / P0】

### ① 风险描述
`run_command` 的**唯一**闸门是 argv 白名单 + npm 脚本首词审计，**没有任何"人批了才跑"的环节**。
而 `write_file` 可以写任意工程内文件（含测试文件）⇒ 代理可以"写一个恶意测试文件 → `npm test` 跑它"，
从而执行任意代码，**全程不违反任何一条白名单规则**。

### ② 源码路径
- `src/App.tsx:496-515` —— `run_command` 分支：过白名单后直接 `runAllowed`，无审批；
- `src/presets.ts:82` —— `toolCalls: true`（工具调用默认开启）；
- `src/presets.ts:85` —— `autoTest: false`（自动测试回路默认关，**这一条是对的**）；
- `src-tauri/src/runx.rs:144-157` —— 脚本审计只审**每段首词**是否在
  `{vitest, jest, mocha, node --test, tsc, vite, eslint}` 内，**不审脚本内容**；
  `node --test` 会执行目录内任意 `.js` 测试文件。

### ③ 触发条件
代理被诱导（prompt injection / 恶意仓库 CLAUDE.md）执行：
1. `write_file({path: "evil.test.js", content: "require('child_process').execSync('<任意命令>')"})`；
2. `write_file({path: "package.json", content: "{\"scripts\":{\"test\":\"node --test\"}}"})` —— **能通过脚本首词审计**；
3. `run_command({argv: ["npm", "test"]})` ⇒ 任意代码以当前用户权限执行。

### ④ 潜在影响
任意代码执行。这是 Coding Agent 产品的**固有风险**（Claude Code 同样如此），
区别只在于是否把它置于**显式、可审计、可逐次授权**的机制之下。当前没有。

### ⑤ 建议修复（与 ADR-0002 对齐）
1. 建立工具级权限策略：`read`（自动放行）/ `write`（可配置为"总是/每次询问/拒绝"）/ `run`（**默认每次询问**）；
2. 审批面板复用现有 `PendingWrites` 的形态（显示命令、工作目录、风险说明）；
3. 审批记录进审计日志（S12）；
4. 会话级"本会话总是允许"开关，但**重启后失效**；
5. 白名单外的命令不是"报错"而是"转审批"（当前是硬拒绝，见 `runx.rs:275`）。

### ⑥ 优先级
**P0**（权限模型是 P0 阶段必须交付的基础设施，S1/S2 是边界，S7 是闸门）。

---

## S8 · 子进程继承完整环境变量 【Medium / P2】

### ① 风险描述
`run_allowed` spawn 时只追加了 `GIT_CEILING_DIRECTORIES`，**其余环境全部继承**。
被执行的测试/构建脚本因此可以读取父进程的全部环境变量。

### ② 源码路径
`src-tauri/src/runx.rs:305-315`：`Command::new(&spawn_name).args(...).current_dir(dir).env("GIT_CEILING_DIRECTORIES", ...)`。
无 `env_clear()`。

### ③ 触发条件
用户机器上存在敏感环境变量（`OPENAI_API_KEY`、`GITHUB_TOKEN`、CI 凭据、代理配置等），
且被执行的测试脚本（可能由代理生成）读取并外发 `process.env`。

### ④ 潜在影响
凭据泄露到第三方（若脚本联网）。

### ⑤ 建议修复
`env_clear()` 后按最小白名单重建：`PATH`、`SystemRoot`/`HOME`/`TMP`、必要的 `HTTP(S)_PROXY`、
`NODE_OPTIONS` 之外的少量变量；敏感变量默认剔除。

### ⑥ 优先级
**P2**

---

## S9 · 工程内敏感文件无拒绝清单，可随上下文外发 【Medium / P2】

### ① 风险描述
`search_files` 会遍历工程内文本文件并逐行子串匹配；`read_file` 可读取工程内任意文本文件。
**没有 `.env` / `*credentials*` / `id_rsa` / `*.pem` 这类敏感文件的拒绝清单**，
命中的内容会被拼进消息体发给第三方模型端点。

### ② 源码路径
- `src/App.tsx:449-485` —— `search_files` 遍历（深度 3、最多 100 文件、100 命中），无文件名过滤；
- `src/App.tsx:437-440` —— `read_file` 直接返回内容，仅按 20000 字符截断；
- `src-tauri/src/fsx.rs:220-238` —— 只限制 4MB + UTF-8。

### ③ 触发条件
用户让代理"看一下配置""搜索 token 在哪定义"，或代理自主探索时命中 `.env`。

### ④ 潜在影响
数据库密码、云密钥、私钥随上下文发往第三方模型服务商并留存。

### ⑤ 建议修复
1. 敏感文件名/后缀拒绝清单（`.env*`、`*.pem`、`*.key`、`id_rsa*`、`credentials*.json`、`**/secrets/**`）；
2. 内容级 secret 模式检测（高熵串、`sk-` 前缀、`AKIA` 等）并在回传前脱敏 + 提示用户；
3. 读取敏感文件时默认需审批（复用 S7 的权限模型）。

### ⑥ 优先级
**P2**

---

## S10 · CSP 为 null + 代理 `Access-Control-Allow-Origin: *` 【Medium / P1】

### ① 风险描述
两条"兜底"同时缺失：**没有 CSP**，且本地代理对所有响应返回 ACAO `*`，
并声明允许 `X-ZXZ-Token` 作为跨域请求头 ⇒ 外部站点对该回环端口具备跨站读取能力（只要拿到 token）。

### ② 源码路径
- `src-tauri/tauri.conf.json:27-29`：`"security": { "csp": null }`；
- `src-tauri/src/proxy.rs:228-229`（SSE 响应头）与 `proxy.rs:287`（通用响应头）：
  `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Headers: Content-Type, X-ZXZ-Token`；
- `proxy.rs:124-127`：OPTIONS 预检一律 204 放行。

### ③ 触发条件
与 S6 组合：先获得/爆破 token，或借 DNS rebinding 让浏览器把请求打到 `127.0.0.1:19527`。

### ④ 潜在影响
放大 S1 与 S6 的后果；缺少 CSP 意味着任何一处 XSS 都能直接执行且无限制。

### ⑤ 建议修复
1. 配置 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' http://127.0.0.1:* https:`；
2. 代理改为校验 `Origin`：仅当 `Origin` 为 `tauri://localhost` / `http://tauri.localhost` / `null` 时回显，否则不返回 ACAO；
3. OPTIONS 预检同样做 Origin 校验。

### ⑥ 优先级
**P1**

---

## S11 · Unix 侧子进程超时不杀进程组 【Medium / P2】

### ① 风险描述
超时后 Windows 用 `taskkill /T /F` 收进程树；**Unix 侧没有任何进程组处理**，
只 `child.kill()` —— 孙进程会存活并继续占用资源/持有管道。

### ② 源码路径
`src-tauri/src/runx.rs:420-425`，代码注释自认：
```rust
// Unix 侧目前没有进程组的处理：白名单里的命令都是短命的测试/构建命令，
// 真要长期 *nix 支持，这里要换成 setpgid + kill(-pgid)。
```

### ③ 触发条件
在 Linux/macOS 上执行会 fork 长命子进程（`npm test` 起的 node worker 等）并触发 60 秒超时。

### ④ 潜在影响
超时保护部分失效；孤儿进程持续运行（可能与 5 秒管道宽限叠加导致调用方挂起）。

### ⑤ 建议修复
spawn 时 `pre_exec` 调 `setpgid(0,0)`，超时时 `kill(-pgid, SIGKILL)`；补一条跨平台 harness 用例。

### ⑥ 优先级
**P2**（Windows 是当前主路径，已缓解）

---

## S12 · 无工具调用审计日志 【Medium / P2】

### ① 风险描述
工具调用只在 UI 上以折叠日志呈现（`MessageList.tsx:63-79`，且截断显示 500 字符），
**没有任何落盘的结构化审计记录**。事后无法回答"代理做了什么、依据什么决策、被谁批准"。

### ② 源码路径
- `src/App.tsx:419-522` —— `executeTool` 只构造 `ToolCallRecord` 挂在消息上；
- 无日志模块；`CLAUDE.md` 也无相关要求。

### ③ 触发条件
安全事件复盘、误删文件追溯、合规审计。

### ④ 潜在影响
不可追溯；S7 的审批机制即便建了也缺少留痕。

### ⑤ 建议修复
Rust 侧落盘 JSONL 审计日志（时间戳、工具名、参数摘要、结果摘要、审批决策、决策来源 `user|policy|auto`），
路径独立于工程目录（避免被代理自己改写）。

### ⑥ 优先级
**P2**

---

## S13 · MCP 权限边界（前瞻约束，现状不适用）

【事实】当前**未实现 MCP**，因此无运行时风险。
但按路线图 P4 引入 MCP 时，若没有先建立 **S2 的会话化边界**与 **S7 的工具权限模型**，
MCP 提供的工具会天然绕过现有白名单（`runx.rs`）与工程根约定。
**约束**：MCP 的接入顺序必须排在 ADR-0002（工具权限）之后。

---

## S14 · undo 快照在工程内明文长期保存旧内容 【Low / P3】

### ① 风险描述
覆盖前旧内容备份到 `<工程>/.zxz/undo/<时间戳>/<rel>`（`files.ts:165-169`）。
该目录被排除在目录树外、不发给模型（设计正确），但**明文长期留在工程目录内**，
若被覆盖文件含密钥，密钥会以明文形式残留在磁盘上，并可能随仓库（若未 gitignore）外泄。

### ② 源码路径
`src/lib/files.ts:165-169`；`src/App.tsx:274-283`；`.gitignore` 已忽略 `.zxz/`。

### ③ 触发条件
代理覆盖 `.env`、配置含密钥的文件 → 旧内容进入 undo 目录。

### ④ 潜在影响
密钥残留；磁盘占用无上限（无清理策略）。

### ⑤ 建议修复
undo 快照：① 排除敏感文件；② 提供清理入口与保留条数上限；③ 可选加密。

### ⑥ 优先级
**P3**

---

## 4. 三条最容易被误判为"已解决"的点（澄清）

1. **"三道校验"是真的，但只覆盖 `rel`，不覆盖 `root`。**
   `fsx.rs` 的路径校验（`safe_rel` + `canon_root` + canonicalize 父目录）质量很高，
   但它防的是"模型给的 rel 越界"，**不防"调用方给的 root 不是工程根"**。见 S2。

2. **"白名单很严"是真的，但 git 是例外。**
   白名单 + npm 脚本内容审计挡住了最常见的利用链，
   但 git 子命令把 git 自己的配置系统带进了信任边界。见 S3（已实测）。

3. **"符号链接检查"写了，但被 `exists()` 包住了。**
   现有单测覆盖 junction（目录链接），因此测试全绿；
   文件符号链接/悬空链接这一形态**未覆盖**。见 S4。

---

## 5. 建议的修复顺序（进入 P0 开发后）

```
第一批（边界）       S2 工程会话化 root  →  S1 补引号转义（CSP 已配）→  S3 git 加固
第二批（闸门）       S7 工具权限模型（ADR-0002） →  S4 符号链接无条件检查
第三批（凭据与网络） S5 Key 入 OS 凭据库 → S10 收紧 ACAO/Origin（S6 + CSP 已由并发方修复，先复核再收尾）
第四批（纵深）       S8 env 净化 → S9 敏感文件清单 → S11 进程组 → S12 审计日志
第五批               S14 undo 清理
```

每一批完成后都应补对应单测（fs-harness 侧 + vitest 侧），并在 `docs/audit/SECURITY_AUDIT.md` 更新状态。

---

*本文档为 Phase 0 审计产出。除 S3 已通过临时目录最小复现实测确认外，其余均为源码静态分析结论；
S4 的 Windows 实际可利用性标注为【待验证】。所有修复建议均未实施，业务代码零改动。*
