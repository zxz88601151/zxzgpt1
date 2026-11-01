# ZXZGPT1 — 模块依赖与边界

> Phase 0 READ-ONLY 审计产出。基于 import 语句与源码人工核对，未运行依赖分析工具。
> 现状依赖图 → 问题 → 目标依赖图 → 边界规则。

---

## 1. 现状依赖图（前端 `src/`）

### 1.1 完整边表（人工核对）

| From | To | 说明 |
|---|---|---|
| `main.tsx` | `App.tsx` | 挂载 |
| `App.tsx` | `api.ts` | `chatStream` / `detectTransport` |
| `App.tsx` | `state.ts` | `loadState` / `persist` / `buildMessages` / `findActive` |
| `App.tsx` | `presets.ts` | —（间接经 state） |
| `App.tsx` | `types.ts` | 类型 |
| `App.tsx` | `lib/{text,diff,undo,files,tools,fsapi,skill,skillscan,project,pending,md?}` | 直接引用 |
| `App.tsx` | `skills/{index,sources,audit}` | `builtinSkills` / `SOURCES` / `buildAuditMarkdown` |
| `App.tsx` | `lib/skillstore` | `loadLocalSkills` / `mergeSkills` / `pickSkills` |
| `App.tsx` | `components/*`（14 个） | 渲染 |
| `api.ts` | `lib/text`（`safeJsonParse`）、`lib/tools`（`accumulateToolCallDeltas`）、`types` | |
| `state.ts` | `presets`、`lib/{files,project,tools,text}`、`types` | |
| `lib/tools.ts` | `lib/files`（`relPathError`） | **唯一一条 lib 内部边** |
| `lib/fsapi.ts` | `lib/files`（`shouldSkipDir`、`treeLine`） | **第二条 lib 内部边** |
| `skills/index.ts` | `lib/skill` | |
| `skills/sources.ts` | —（数据 + 纯函数） | |
| `components/*` | `lib/{md,files,text,diff,undo}`、`types`、`components/ui` | |
| `components/MessageList` | `lib/md`、`lib/files`、components/{ui,FileWrites} | |

### 1.2 图（简化）

```
                        main.tsx
                           │
                           ▼
        ┌──────────────────────────────────────────┐
        │              App.tsx (1340)              │  ← 扇入 0，扇出 20+
        └───┬────┬────┬────┬────┬────┬────┬───────┘
            │    │    │    │    │    │    │
            ▼    ▼    ▼    ▼    ▼    ▼    ▼
         api  state  lib/*  skills/*  components/*  presets  types
          │     │      │        │          │
          │     │      │        │          ▼
          │     │      │        │      lib/{md,files,text,diff,undo}, ui
          │     │      │        ▼
          │     │      │    lib/skill
          │     │      ▼
          │     │   tools → files
          │     │   fsapi → files
          │     ▼
          │  presets, lib/{files,project,tools,text}
          ▼
      lib/{text,tools}, types
```

### 1.3 循环依赖检查

**结论：未发现循环依赖。** `lib/` 内部是一个只有两条边的 DAG：
```
tools.ts ──▶ files.ts
fsapi.ts ──▶ files.ts
```
`files.ts` 不反向依赖任何 lib 模块（它是叶子）。`skills/` → `lib/skill` 单向。

> 【待验证】以上基于人工核对 import 语句，未使用 `madge`/`dependency-cruiser` 等工具验证。
> 建议在 P1 加入一条 CI 检查固化这一结论。

---

## 2. 现状依赖图的四个问题

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| 1 | **单点扇出**：`App.tsx` 扇入 0、扇出 20+ | `App.tsx:1-61` import 段 | 无法复用编排逻辑；无法单测；任何新能力只能加进来 |
| 2 | **UI 直连基础设施**：UI 层直接调 `fsapi`/`runAllowed` | `App.tsx:274-511` | 权限决策散落在 UI 代码里，无法集中审计 |
| 3 | **契约手工同步**：Rust 与 TS 各定义 `FsEntry`/`WriteResult`/`RunResult` | `fsx.rs:18-32` vs `fsapi.ts:8-19`；`runx.rs:31-38` vs `fsapi.ts:101-107` | 字段漂移编译期不可见 |
| 4 | **同一判定两份实现**：命令白名单 TS + Rust | `tools.ts:142` vs `runx.rs:210` | 见 TECHNICAL_DEBT D2 |

---

## 3. Rust 侧依赖图（现状）

```
main.rs ──▶ lib.rs
              ├─▶ api.rs      (reqwest, futures_util, serde_json, tokio)
              ├─▶ fsx.rs      (serde, std::fs)          ← 不依赖 tauri ✅
              ├─▶ runx.rs     (serde, std::process)     ← 不依赖 tauri ✅
              └─▶ proxy.rs    (tokio, tauri::async_runtime) ──▶ api.rs
```

- `fsx.rs` / `runx.rs` **不依赖 tauri**，可被 `tools/fs-harness` 用 `#[path]` 直接引用跑单测
  （`fsx.rs:8`、`runx.rs:14` 注释明示）—— **这是正确的依赖切分，目标架构必须保留**。
- `proxy.rs` 依赖 `tauri::async_runtime`，因此 harness 需要替换运行时
  （`tools/proxy-harness` 的做法，见 README §9.3）。

---

## 4. 目标依赖图

### 4.1 前端

```
components/*  ──▶  lib/*（渲染用纯函数）
     │
     ▼
  App.tsx ──▶ orchestration/ (AgentLoop)  ──▶ runtime/ (ContextBuilder, ToolRegistry, Compactor)
                     │                              │
                     │                              ▼
                     │                        transport/ (api.ts 重构：单入口 + 双通道)
                     ▼
              persistence/ (会话、设置、checkpoint)
                     │
                     ▼
               ipc/ (集中定义命令名与契约类型)  ──▶ Rust
```

### 4.2 Rust

```
lib.rs
  ├─▶ security/  (session, policy, audit, credentials)
  ├─▶ tools/     (registry, handlers) ──▶ fsx.rs, runx.rs
  ├─▶ provider/  (trait + openai_compatible) ──▶ api.rs
  ├─▶ persistence/ (sessions, settings, checkpoint, audit log)
  └─▶ proxy.rs ──▶ provider/
```

---

## 5. 边界规则（目标的硬约束）

| # | 规则 | 现状是否违反 |
|---|---|---|
| R1 | L1 UI 不得直接调用 IPC 或 Provider；只能经 L2 发命令 | **违反**（`App.tsx` 直接调 `fsRead`/`fsWrite`/`runAllowed`） |
| R2 | L2/L3 不得 import 任何 React | **违反**（逻辑写在组件里） |
| R3 | 工具执行的工作根只能来自 `WorkspaceSession`，不接受调用方传入的任意路径 | **违反**（`fs_read(root, rel)` 任意 root） |
| R4 | 每次工具执行必须经 `PermissionPolicy` 决策 | **违反**（仅 `write_file` 有可选确认） |
| R5 | 工具声明（schema）是校验与下发的**唯一**来源 | **违反**（`TOOL_DEFS` 与 `validateToolArgs` 双份） |
| R6 | 命令白名单与脚本审计的**唯一权威在 Rust** | **违反**（TS 有一份镜像） |
| R7 | 契约类型由一处定义或由工具生成 | **违反**（手工各写一份） |
| R8 | 不得在 UI 层拼接 HTML 后注入 DOM | **违反**（`MessageList.tsx:57,87`） |

---

## 6. 落地检查项（供后续阶段自检）

- [ ] `App.tsx` 行数 < 400，且不含 `await fsWrite` / `await runAllowed`
- [ ] 存在 `src/orchestration/agent-loop.ts` 且**不 import react**
- [ ] `src/orchestration/*.test.ts` 覆盖：轮次终止、中断、审批挂起、测试回路 3 轮上限
- [ ] `TOOL_DEFS` 由注册表生成，`validateToolArgs` 由 schema 驱动
- [ ] `fs_read`/`fs_write`/`run_allowed` 只接受 `sessionId`
- [ ] 契约测试：Rust fixture ↔ TS 类型对齐
- [ ] `components/` 中无 `dangerouslySetInnerHTML`（或已配 sanitizer + CSP）

---

*本文档为 Phase 0 审计产出，未修改任何业务代码。*
