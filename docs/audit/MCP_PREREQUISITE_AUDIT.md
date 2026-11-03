# 独立审计：加载这些外部能力，是否必须先加入 MCP？

> 日期：2026-11-02 · 性质：**AUDIT-ONLY**（未改业务代码；用过的临时测试探针已删除，`npm test` 复跑 319 全过）
> 承接：`docs/audit/EXTERNAL_REPO_HOTPLUG_ASSESSMENT.md`（10 个仓库拉取与热插拔评估）

---

## 0. 结论

**不需要。MCP 不是加载这些外部资产的前置条件。**

真正的拆分是三条**互相独立**的链路，只有其中一条需要 MCP：

| 链路 | 覆盖哪些资产 | 是否需要 MCP | 现在能不能用 |
|---|---|---|---|
| **① 加载**（读 `SKILL.md` + `@@ref` 取附件） | `ui-ux-pro-max`、`taste-skill`（规则段）、`addyosmani`、`agent-framework` | **否，零依赖** | **能**（需先去重/重排/瘦身，见前一份报告 §4.3） |
| **② 脚本执行**（`node scripts/*.mjs`、`python search.py`） | `taste-skill` 的 draw/assets/inspect/lint/scenes、`ui-ux` 的查表脚本 | **否**（是命令白名单问题，不是协议问题） | **不能**，实测全被拒 |
| **③ 外部 server 工具** | `modelcontextprotocol/servers`（filesystem/git/memory/…）、`playwright-mcp`（72 个 `browser_*`） | **是** | **不能**，无 MCP 客户端 |

**关键澄清**：MCP 与"脚本执行"是两条独立通道，**加 MCP 不会解锁 ②**，反而在权限模型落地之前先引入一条新的写盘通道。按 `FEATURE_GAP_MATRIX.md`，MCP 的前置是 **P0-4 权限模型**，不是反过来。

---

## 1. 链路①：加载 —— 零 MCP 依赖（PASS）

调用链全部走本地文件读取，与 MCP 无任何耦合：

```
loadLocalSkills(root)            skillstore.ts:26
  ├─ sessionFor(root)            skillstore.ts:34   → fsapi.ts:97（ws_open IPC）
  ├─ fsListIn(sessionId, "")     skillstore.ts:39   → Rust fsx
  └─ fsRead(sessionId, rel)      skillstore.ts:65   → Rust fsx
readSkillRefs(all, refs)         App.tsx:395
  └─ fsRead(await sessionFor(sk.dir), r.rel)   App.tsx:413
```

**证据一：全项目不存在 MCP 客户端实现。** `src/` 与 `src-tauri/src/` 内 `mcp` 命中 16 处，全部落在：

- `src/skills/sources.ts`（来源登记表的 `kind: "mcp"` / `hook: "mcp"` 分类与统计，如 `:15` `:52` `:191-198` `:531`）
- `src/skills/audit.ts:283` 的判定文案
- `src/skills/sources.test.ts:32-33` 的分类断言

**没有一处是 MCP 客户端、transport 或工具纳管代码。** 加载路径上更没有任何一处引用它。

**证据二：项目自身已有同口径认知。** `sources.ts:198` 对 `github-mcp-server` 的备注原文："本项目没有 MCP 客户端，挂不上；要用得先加 MCP 宿主层" —— 这条备注针对的是**外部 MCP server 类资产**，不适用于技能文件。

> 注：`readSkillRefs` 每次取附件都会 `sessionFor(sk.dir)`（`App.tsx:413`），即**技能目录自身被登记为一个工程根会话**，附件读取受同一套 `fsx` 边界约束（普通段 + canonicalize）。这是好设计：附件不会越出技能库。

---

## 2. 链路②：脚本执行 —— 与 MCP 无关，但当前不可用（FAIL）

`taste-skill` 正文第 3 步起就是 `node <skill>/scripts/draw.mjs …`，`ui-ux` 也有查表脚本。**这些步骤的成败与 MCP 无关**：它们要走的是 `run_command` → `runAllowed` IPC → Rust `runx.rs`，而 MCP 是另一条完全独立的通道。

### 实测（临时探针 `src/lib/zz_audit_probe.test.ts`，跑完已删除）

| 命令 | 前端 `isAllowedCommand` | 判定 |
|---|---|---|
| `node scripts/draw.mjs` | 返回错误串 | **拒绝** |
| `node scripts/inspect.mjs` | 返回错误串 | **拒绝** |
| `node scripts/assets.mjs` | 返回错误串 | **拒绝** |
| `python search.py --domain colors` | 返回错误串 | **拒绝** |

Rust 侧权威实现一致且更明确：

- `runx.rs:249-253` — `node` 在 argv 层**只放行 `--version`**；
- `runx.rs:146-149` — `node` 只在 **npm 脚本段内**才认 `--test`，注释原文："`node -e` / `node evil.js` 都是任意执行"；
- `runx.rs:151` — npm 脚本受信任运行器清单仅 6 个：`vitest / jest / mocha / tsc / vite / eslint`。

### 一处自我修正

探针里我设了对照组 `node --test` 并预期放行，**实测被拒**（前端返回 `node 只允许 --version`）。我一度以为前后端白名单不一致，核对后确认：**前后端一致，是我的对照组设错了**——`node --test` 只在 `npm run <script>` 的**脚本内容层**被允许（`runx.rs:146-149`），在 argv 层不放行。此处如实更正，不构成产品缺陷。

### 结论

要启用 ②，需要的是**命令白名单扩张（或独立的脚本执行通道）+ 审批**，属 `FEATURE_GAP_MATRIX.md` §9「脚本执行：无 → 新增，必须经权限模型」。**即便 MCP 做完了，这条也不会自动解锁。**

---

## 3. 链路③：外部 server —— 这一类才必须 MCP（BLOCKED）

| 资产 | 为什么必须 MCP |
|---|---|
| `modelcontextprotocol/servers`（filesystem / git / memory / sequentialthinking / time / fetch / everything） | 它们是 **MCP server 进程**，只能经 MCP 协议挂载 |
| `playwright-mcp`（72 个 `browser_*`） | 同上 |

**但"浏览器能力"本身不必然需要 MCP**：项目已有 `tools/e2e.cjs` 等 Playwright 脚本做 live e2e，走的是本地进程而非 MCP。所以"浏览器验证"有两条路：

- 确定性步骤 → 本地 Playwright 脚本（需 ② 的白名单支持）；
- 模型自由探索 → `browser_*` 工具（需 ③ MCP）。

---

## 4. 建议顺序（MCP 排在后面，不是前面）

| 顺序 | 动作 | 前置 |
|---|---|---|
| 1 | 外部技能去重 / 重排 / 瘦身并加载（链路①） | 无（现在可做） |
| 2 | **P0-4 权限模型** | — |
| 3 | 脚本执行通道 + 审批（链路②，按需） | 2 |
| 4 | MCP 客户端 + 工具纳管（链路③） | **2** |
| 5 | 子代理权限收敛 | 2、4 |

理由：**MCP 是权限面的扩张，不是能力的解锁**。filesystem 类 server 自带 root 概念，若在没有 `ToolRegistry` 统一拦截与写入确认之前接入，就是绕过 `fsx` 工程根与 `confirmWrites` 的第二条写盘通道（前一份报告 §4.4）。先做 MCP 等于先把闸门拆了再装门。

---

## 5. 状态汇总

| 项 | 状态 |
|---|---|
| 链路① 加载不依赖 MCP | **PASS**（调用链 + 全项目 0 处 MCP 实现） |
| 链路② 脚本命令当前可执行 | **FAIL**（4 条实测全拒，前后端一致） |
| 链路③ 外部 server 可用 | **BLOCKED**（无 MCP 客户端） |
| 浏览器能力必须经 MCP | **否**（本地 Playwright 脚本是另一条路） |
| `tauri` / `playwright` 仓库内容 | **NOT PRESENT**（沿用前一份：未拉到，不推断） |

---

*本轮 AUDIT-ONLY：除临时探针外未新增/修改任何源文件，探针已删除；`npm test` 复跑 15 文件 / 319 用例全通过。*
