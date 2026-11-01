# ZXZGPT1 — 当前架构（As-Is）

> Phase 0 READ-ONLY 审计产出。描述**代码里真实存在的架构**，不是 README 声称的架构。
> 所有断言附源码位置。

---

## 1. 全景

```
┌──────────────────────────────────────────────────────────────────────────┐
│  WebView（Tauri 2 / WebView2）                                            │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ src/App.tsx  (1340 行)   ← 唯一的编排中心                          │  │
│  │                                                                    │  │
│  │  ┌── 20+ useState / 6 useRef（手工双写 stateRef）──────────────┐   │  │
│  │  │                                                             │   │  │
│  │  │  send()  ── for (round < 6) ────────────────────────┐       │   │  │
│  │  │    App.tsx:601                                      │       │   │  │
│  │  │      ├─ buildMessages()      state.ts:57     上下文装配│       │   │  │
│  │  │      ├─ chatStream()         api.ts:64     模型调用   │       │   │  │
│  │  │      ├─ executeTool()        App.tsx:419   工具执行   │       │   │  │
│  │  │      ├─ requestApplyFiles()  App.tsx:328   写盘+审批  │       │   │  │
│  │  │      └─ 测试回路 / @@read 回传 → 下一轮 ─────────────┘       │   │  │
│  │  └─────────────────────────────────────────────────────┘       │   │  │
│  │                                                                    │  │
│  │  components/*（14 个，纯展示）  lib/*（纯函数，可单测）          │  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│         │ fetch SSE（proxy 通道）        │ Tauri IPC invoke               │
└─────────┼───────────────────────────────┼────────────────────────────────┘
          ▼                               ▼
┌───────────────────────────┐   ┌────────────────────────────────────────┐
│ src-tauri/src/proxy.rs    │   │ src-tauri/src/lib.rs  (9 条 IPC 命令)  │
│  127.0.0.1:19527+         │   │   proxy_info                           │
│  一次性 token             │   │   fs_roots / fs_list / fs_list_in      │
│  /health /chat /test /models│ │   fs_mkdir / fs_read / fs_exists       │
│      │                    │   │   fs_write                             │
│      ▼                    │   │   run_allowed                          │
│ src-tauri/src/api.rs      │   │      │                                 │
│  reqwest → 上游           │   │      ▼                                 │
│  SSE 解析 → 统一事件      │   │   fsx.rs（文件，三道校验）             │
└───────────────────────────┘   │   runx.rs（命令，白名单+超时）         │
                                └────────────────────────────────────────┘
                                             │
                                             ▼
                                    本机磁盘 / 子进程 / 上游 API
```

---

## 2. 分层与职责（现状）

| 层 | 实际载体 | 职责 | 边界是否清晰 |
|---|---|---|---|
| UI 展示 | `src/components/*.tsx`（14 个） | 渲染会话、面板、输入 | 清晰（但 `MessageList` 用 `dangerouslySetInnerHTML`） |
| **编排 + 状态** | **`src/App.tsx`（1340 行）** | 会话、发送循环、工具执行、工程模式、技能库、导入导出、快捷键 | **不清晰，全部混在一起** |
| 纯逻辑 | `src/lib/*.ts`（13 个） | Markdown/Diff/路径/工具定义/技能解析/IPC 封装 | 清晰，可单测 |
| 传输 | `src/api.ts`（302 行） | 双通道、SSE 解析 | 中（双份实现） |
| 存储 | `src/state.ts`（132 行） | localStorage 读写、上下文窗口 | 弱（无版本、无校验） |
| IPC 壳 | `src-tauri/src/lib.rs`（103 行） | 命令注册、参数转发 | 清晰 |
| 文件 | `src-tauri/src/fsx.rs`（481 行） | 路径三道校验、读写 | 清晰（**但 root 不受约束**） |
| 命令 | `src-tauri/src/runx.rs`（552 行） | 白名单、执行、超时、进程树 | 清晰（**但 git 可被配置劫持**） |
| 网络 | `src-tauri/src/{proxy,api}.rs` | 回环代理 + OpenAI 兼容客户端 | 清晰（但无 Provider 抽象） |

**结论**：Rust 侧的分层是健康的、边界清晰的；**TS 侧只有"纯 lib"与"App.tsx"两层**，
中间缺失"编排层 / Runtime 层 / 权限层"。

---

## 3. 关键数据流

### 3.1 一次带工具调用的发送（真实控制流）

```
用户点发送
  │
  ▼
App.tsx:526 send()
  ├─ 快照 settings（App.tsx:534）、算技能（App.tsx:554-566）
  ├─ 追加 userMsg → baseMessages（App.tsx:569-586）
  └─ for round in 0..6                      ← App.tsx:601
        ├─ 插入空 assistant 占位（App.tsx:602-617）
        ├─ buildMessages(...)               ← state.ts:57
        │     system: 人设 → 工程目录树 → 工具说明 → 项目记忆 → 技能 → 计划指令
        │     历史: sliceContext(最近 N 轮)
        │     assistant+toolCalls → assistant.tool_calls + tool 消息
        ├─ chatStream(...)                  ← api.ts:64
        │     proxy: fetch 127.0.0.1/chat → Rust api.rs:109 流式 → SSE
        │     onEvent: delta / reasoning / usage / error / tool_calls
        │     tool_call_delta 由 api.ts:182 累计，流末合成 tool_calls
        ├─ 解析 file: 块 → requestApplyFiles（App.tsx:679-682）
        │     confirmWrites ? 弹面板等批复 : 直接 applyFiles 落盘 + 备份 + 回读校验
        ├─ for call of roundToolCalls → executeTool（App.tsx:688-692）
        │     validateToolArgs → 计划模式拦截 → 分派到 fsRead/fsListIn/runAllowed
        ├─ 测试回路（autoTest===true 时）→ runAllowed(ws.root, ["npm","test"])
        │     失败 → 追加 hidden user 消息 → 下一轮
        └─ 终止判据（App.tsx:764）: 无工具调用 && 无 read && 无 ref → break
```

### 3.2 请求/响应链路（两种通道）

| | proxy 通道（桌面端） | direct 通道（浏览器直开） |
|---|---|---|
| 发起 | `fetch http://127.0.0.1:<port>/chat` + `x-zxz-token` | `fetch <baseUrl>/chat/completions` + `Authorization` |
| 出网 | Rust `reqwest` | 浏览器 |
| SSE 解析 | Rust `api.rs:290` → 统一事件 → TS 直接消费 | TS `api.ts:202` 自己解析 delta |
| 工具调用 | Rust `api.rs:126` 转发 `tools`+`tool_choice` | TS `api.ts:71` 直接带 |
| Key 存放 | 请求体 `api_key` 字段（`api.ts:84`） | 请求头 `Authorization`（`api.ts:94`） |

---

## 4. 依赖方向（现状）

```
                    App.tsx  （扇入 0，扇出 20+）
                   ╱   │    │    ╲      ╲
            api.ts   state.ts  lib/*  components/*  skills/*
               │         │       │          │           │
          lib/{text,  lib/{files, tools→files   lib/*    lib/skill
            tools}    project,             fsapi→files
                      tools,text}
                          │
                       presets.ts
```

- **无循环依赖**（人工核对 import 语句确认）；
- `lib/` 内部仅两条边：`tools → files`、`fsapi → files`；`skills/ → lib/skill` 单向；
- 风险不在环路，而在**单点扇出**：`App.tsx` 是唯一编排者，任何新能力都只能加进来。

---

## 5. 现状架构的三个结构性判断

1. **Rust 侧已经是"正确的后端形状"**：核心逻辑不依赖 tauri、可被 harness 单测、
   错误与边界集中在 `fsx.rs`/`runx.rs`。目标架构应**保留并强化**，不要重写。
2. **TS 侧缺一层**：`App.tsx` 同时承担了 UI 状态、编排、工具执行、权限决策四类职责。
   这是当前所有能力天花板（不可测、不可恢复、无并行、无子代理）的共同根因。
3. **安全边界错位**：工程根边界由"前端传对 root"维持，而不是由 IPC 契约维持。
   一旦前端不可信（XSS / 未来新调用点），边界即失效。

---

*本文档为 Phase 0 审计产出，未修改任何业务代码。*
