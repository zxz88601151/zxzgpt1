# P0-1-F · 独立复审与 P0-2/P0-3 实施准入评估

- 复审人角色：独立技术审计员 / 系统架构复审员
- 复审基线：`main @ 7ea1eb3`（P0-1 会话化 = `a280051`）
- 复审性质：严格只读（唯一写操作 = 本报告文件）
- 报告日期：2026-11-02

---

## 1. Git 基线核实结果（Phase F1）

| 核实项 | 结果 | 证据 |
|---|---|---|
| 当前分支 / HEAD | `main` @ `7ea1eb3` | `git branch --show-current`、`git log --graph` |
| 三提交父子关系 | 线性链：`bd8c37a → e87bc17 → a280051 → 7ea1eb3`，无分叉无合并 | `git show --format=%P`：e87bc17 父=bd8c37a；a280051 父=e87bc17；7ea1eb3 父=a280051 |
| e87bc17 文件清单 | 11 文件：proxy.rs、Cargo.toml/lock、tauri.conf.json、api.ts、tools.ts、tools.test.ts、proxy-e2e.cjs、live-tools-e2e.cjs、README、CLAUDE.md（+246/−107） | `git show --stat` |
| a280051 文件清单 | 19 文件：wsx.rs(新增)、fsx/lib/runx.rs、App.tsx、fsapi.ts(+.test.ts 新增)、undo/skillstore/types/project.test.ts、FileWrites/UndoPanel、fs-harness×3、3 个 e2e 脚本（+1488/−198） | `git show --stat` |
| 7ea1eb3 文件清单 | docs/ 12 份审计/架构/路线图/ADR 文档（+3216） | `git show --stat` |
| 未提交修改 | **无**（`git status --porcelain` 仅 1 条未跟踪） | 实测 |
| `.tmp-skills/` 归属 | 4 目录（broken/ext-skill/notaskill/risky-skill）+ 5 文件，全部 mtime=11-02 07:52，即今晨 desktop-skill-e2e 测试运行时生成；属测试产物 | `ls -la`、`find` 实测 |
| 临时 Cargo 配置还原 | **精确还原**：`git diff HEAD -- src-tauri/Cargo.toml` 为空；第 10 行 `crate-type = ["staticlib", "cdylib", "rlib"]` 与 `git show HEAD:` 的 blob 完全一致 | 逐字符比对 |
| tauri.conf.json 临时改动 | 已还原（工作区相对 HEAD 无差异，CDP 参数未入提交） | `git status` 实测 |

附加发现：`.gitignore` 忽略 `.tmp-ws/`（第 16 行）但**未忽略** `.tmp-skills/`，所以该目录以未跟踪状态可见（F-4）。

## 2. P0-1 架构审查结果（Phase F2）

### 2.1 代码证明的事实

| # | 事实 | 证据 |
|---|---|---|
| A1 | 全部 5 个文件 IPC（list_in/read/exists/write/list 之外的工程内四件）与命令 IPC 只收 `session_id`，root 由 `root_for()` 统一从 `wsx::root_of` 解析 | `src-tauri/src/lib.rs:90-123` |
| A2 | `ws_open` 是**唯一**接受 root 的 IPC | `lib.rs:50` |
| A3 | `run_allowed(root: &Path, argv)` 无任何前端可控的目录参数；cwd 只能来自会话 | `runx.rs:292-295`、`lib.rs:120-123` |
| A4 | 已关闭会话在所有 fs/run 操作上被拒（`root_of` 统一检查 `closed`） | `wsx.rs:158-165` |
| A5 | 路径收敛：`safe_rel` 拒绝 `..`/绝对路径/盘符前缀/UNC；`resolve` 逐段 canonicalize + 组件级 `Path::starts_with` 包含判定；junction 用文件属性位 0x400 识别；悬空链接直接拒绝；`write` 在 `create_dir_all` 后复核父目录落点 | `fsx.rs:40-58, 62-64, 68-77, 87-116, 303-316` |
| A6 | 并发会话无权限串扰：每个会话持有独立 `root: PathBuf`，登记表 `Mutex` 串行化，无共享可变状态 | `wsx.rs:40-61` |
| A7 | 会话异常退出无残留权限：登记表是进程内存 `OnceLock`，进程退出即全部失效；前端启动时按展示路径重新登记（登记不上自动退出工程模式） | `wsx.rs:53`、`App.tsx:839-857` |
| A8 | P0-4 权限接入点已预留：`root_for(session_id, op)` 单点，调用点无需再改 | `lib.rs:42-44` |
| A9 | 同目录幂等复用会话，活体上限 64 | `wsx.rs:104-113` |

### 2.2 仅有测试覆盖的行为（代码路径存在，本机未实跑）

- T10：Linux 分支符号链接处理（`is_reparse` 非 Windows 恒 false，走 `is_symlink()`+canonicalize 分支）——本机仅执行 Windows/junction 用例；Linux 行为依赖 CI/代码审查，**未实测**。
- T11：文件符号链接（非 junction）逃逸——本机无权限创建，用例统一用 `mklink /J`（测试注释与 `assert!(mk_junction(...))` 防空跑已核实，见 `fsx.rs:484-485`、`wsx.rs:307-308`）。

### 2.3 尚未验证的安全假设

- U1：P0-1 之前报告中"Windows 上创建文件符号链接需管理员权限"的假设本身未在本机复核（不需要，因为 resolve 对两类链接同路径拦截）。

### 2.4 发现的问题

| 编号 | 严重度 | 分类 | 问题 | 证据 | 影响范围 | 建议处理 |
|---|---|---|---|---|---|---|
| F-1 | **中** | 事实 | `ws_open` 本身不校验调用来源：任何能调 invoke 的前端代码（含 P0-2 之前的 XSS 面）可登记任意 root | `lib.rs:50`、`wsx.rs:98-102` | 工程边界（S2 残余面） | P0-4 权限系统按用户手势/白名单约束登记；P0-2 修复前属已知残余 |
| F-2 | 低 | 事实 | 已关闭会话的条目永不清理：`close()` 只置位，登记表随 open/close 循环缓慢增长；`MAX_SESSIONS` 只数活体 | `wsx.rs:110-113, 135-144` | 内存；无安全影响（关闭仍被拒） | 顺手加惰性清理即可，不阻塞任何阶段 |
| F-3 | 低 | 事实 | TOCTOU 残留：`resolve` 与最终 `fs::write` 之间最后一段可被并发替换（父目录已复核，末段未覆盖） | `fsx.rs:304-319` | 需要工程内并发写入者，攻击面窄 | 记入 P0-6 加固清单 |
| F-4 | 低 | 事实 | `.gitignore` 缺 `.tmp-skills/`（有 `.tmp-ws/`）→ 测试残留显形为未跟踪目录 | `.gitignore:16` | 仓库整洁 | 与 `.tmp-skills/` 清理一并处理 |
| F-5 | 中 | 事实 | **本机完整 `cargo build` 失败**：GNU 工具链链接 cdylib 报 `export ordinal too large: 111489`（mingw ld 限制）；MSVC Build Tools 本机未装（`E:\Software\vs-buildtools` 仅有安装说明文档） | 今晨构建实测 | 桌面构建/CI 流程 | 需业主决策：收窄 crate-type（桌面无用 cdylib/staticlib）或安装 MSVC；P0-3 的 Rust 测试走 fs-harness 不受影响 |
| F-6 | 信息 | 事实 | `fs_list`/`fs_mkdir` 仍是「任意绝对路径」通道（设计使然，仅界面使用）——任意前端代码可调，不只选择器 UI | `lib.rs:72-86`、`fsapi.ts:122-146` | 若未来暴露给工具层则破界 | 保持模型侧永不触达；P0-4 时可加调用方标记 |

## 3. Rust 安全边界审查结论

Rust 是工作区边界唯一可信来源：**成立**（A1-A8 全部代码证明）。前端无法为文件/命令操作指定第二个 root；唯一例外是登记入口 `ws_open`（F-1，P0-4 收口）与选择器通道（F-6，设计例外）。

## 4. 四组 E2E 测试可信度评估（Phase F3）

| 套件 | 断言数口径 | 后端 | 可信度评估 |
|---|---|---|---|
| workspace-e2e（39/39） | 40 行含 1 行 `check` 定义 → 39 次调用，与报告一致 | **假 IPC**（注入 `__TAURI_INTERNALS__`，脚本内虚拟文件系统） | 只验前端链路与新协议参数形状；**不验** Rust 强制。越权拦截断言由假 IPC 模拟，安全结论不能取自本套件 |
| skill-e2e（69/69） | 70−1=69，一致 | 同上，假 IPC | 同上 |
| desktop-workspace（34/34） | 35−1=34，一致 | **真机**：`connectOverCDP` 连真实 exe，真实 Rust IPC + 真实落盘；伪造/已关闭会话断言（296-304 行）直接经真 IPC 断言拒绝 | 安全核心结论应取自本套件 + Rust 单测 |
| desktop-skill（18/18） | 22−1=21 次调用，**仅 18 次执行**：清理段 `fs.rmSync` 抛异常（回收站 shim 拦截），末尾 2 条清理断言 + 汇总行未执行 | 同上，真机 | "18/18" 对**已执行**断言准确；脚本实际以非零/异常退出（被 shell 管道遮蔽）；测试结论不受影响（未执行的仅清理自检） |

其他审查结论：
- mock 掩盖风险：浏览器两套件如实声明（脚本头注释），且安全行为另有真机套件 + Rust 54 单测兜底，**不存在结论性掩盖**。
- 测试通过但未执行目标操作：未发现"空跑通过"——junction 用例均有 `assert!(mk_junction(...))` 防跳过分支（`fsx.rs:485,508`、`wsx.rs:308`），证据属实。
- **缺口（如实记录）**：无任何并发/重复请求测试；不存在异常输入 fuzz；测试数量 ≠ 安全覆盖率。

## 5. 已知遗留问题（复核后状态）

| 遗留 | 复核结论 |
|---|---|
| `.tmp-skills/` 未删除 | 属实（F-4 补充：.gitignore 未覆盖）；环境回收站 shim fail-closed 所致，属环境问题非代码问题 |
| bin 编译 1 条警告未确认 | 属实，本次只读阶段不触发编译，内容仍未知；lib 侧 0 警告有既有证据 |
| MSVC 未装 / GNU cdylib 链接失败 | 属实且影响确认（F-5） |
| crate-type 临时调整已还原 | 属实，逐字符比对通过（F1 表） |

## 6. 新发现的问题

F-2（会话条目不清理）、F-4（gitignore 缺项）、F-5（工具链构建失败需决策）、F-6（选择器通道可被任意前端代码调用）。均不阻塞 P0-2。

## 7. P0-2 / P0-3 依赖关系（Phase F4）

定义来源：仅取 `docs/roadmap/DEVELOPMENT_ROADMAP.md:55-115`，未自行补全。

### P0-2 · Markdown 转义与 CSP（目标：关闭 S1/S10）

| 维度 | 评估 |
|---|---|
| 目标与边界 | escapeHtml 补引号转义 + 新增 `escapeAttr` + 移除 `md.ts` 的 `&amp;` 还原后门 + URL 协议白名单 + CSP（roadmap:55-76） |
| 现有基础 | **未实现**：`escapeHtml` 仍只转义 `&<>`（`text.ts:7-9` 实测）；`md.ts:41` `.replace(/&amp;/g,"&")` 后门仍在（实测）；CSP 已由 e87bc17 配置（该项**已完成**）；`md.test.ts` 存在（init 提交即有）但**缺** P0-2 要求的 4 类回归用例 |
| 上下游依赖 | 无（roadmap 明示可与 P0-1 并行） |
| 安全风险 | 改动渲染管线，可能影响含引号链接标题的显示（roadmap 已列） |
| 测试缺口 | 4 类 XSS 回归用例待新增；渲染快照用例待补 |
| 实施前置条件 | 无 |
| 兼容性影响 | 纯前端渲染层；不改变 IPC 协议 |

### P0-3 · 受控执行加固（目标：封堵 S3/S4/S8）

| 维度 | 评估 |
|---|---|
| 目标与边界 | git 强制注入 `--no-textconv --no-ext-diff` + `GIT_CONFIG_NOSYSTEM` 等；`fsx` 拒绝写 `.git/**`；符号链接检查移出 `if exists`；`runx` `env_clear()` + 最小环境白名单（roadmap:78-115） |
| 现有基础 | **未实现**（runx/fsx grep 无命中）。**但**：roadmap 中符号链接两项（"移出 if target.exists"、"每级 canonicalize"）**已被 P0-1 的 `resolve()` 超额覆盖**（`fsx.rs:87-116`，且悬空 junction 用例已在 a280051 落地）——实施范围需在启动时按当前代码重新确认，避免重复劳动 |
| 上下游依赖 | roadmap 声明依赖 P0-1 → **已满足**（a280051 落地 + 本次复审 A1-A8 佐证） |
| 安全风险 | env_clear 影响 npm/npx 找 PATH；`.git` 拒绝影响合理配置修改需求；textconv 改变二进制 diff 输出（roadmap 均已列） |
| 测试缺口 | 3 类 harness 用例（git 副作用 marker / 悬空 symlink / env 白名单）待新增 |
| 实施前置条件 | F-5 工具链决策（桌面构建路径）；harness 测试本身不受影响 |
| 兼容性影响 | 改 Rust 执行层语义（env 收缩、git 参数注入），需回归 `run_allowed` 现有用例 |

## 8. 下一阶段实施准入建议

| 结论项 | 判定 |
|---|---|
| P0-1 独立复审 | **PASS**（A1-A9 全部代码证明；四组测试结论可信；F-1 为已知残余、P0-4 收口） |
| P0-2 准入 | **READY_FOR_PHASE_P0-2_AUTHORIZATION**：无前置依赖，范围独立，验收标准明确 |
| P0-3 准入 | **READY_FOR_PHASE_P0-2_AUTHORIZATION**（可紧随 P0-2 申请）：P0-1 依赖已满足；启动时需先按当前代码重确认 fsx 符号链接两项的剩余范围；建议与 F-5 工具链决策并行处理 |
| 不阻塞条件 | F-4（gitignore/.tmp-skills 清理）、F-5（工具链决策）、bin 警告确认——均属工程卫生项 |

## 9. 最终状态

**`READY_FOR_PHASE_P0-2_AUTHORIZATION`**

本报告不构成 P0-2 / P0-3 的实施授权。复审到此停止，等待业主决定。
