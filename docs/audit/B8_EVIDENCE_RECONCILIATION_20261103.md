# B8 · E2E 证据对账（D-DOC-1）

日期：2026-11-03　｜　执行：QA + Senior Developer（Agent）
结论：**PASS**（数字已按实测重写；7 个脚本状态标为 `NOT_TESTED`，未冒称通过）

---

## 1. 上一版的问题

README 里的 e2e 项数是历史记录，脚本一直在加断言，文档没跟着改。结果是**同一个脚本
在两个地方写成不同数字**：

| 脚本 | README 一处 | README 另一处 | 实测 |
|---|---|---|---|
| `workspace-e2e.cjs` | 18 项 | 34 项 | **39** |
| `skill-e2e.cjs` | 47 项 | 47 项 | **69** |
| `desktop-workspace-e2e.cjs` | 13 项 | 25 项 | 未跑（静态 34） |
| `desktop-skill-e2e.cjs` | 17 项 | 17 项 | 未跑（静态 21） |

数字过期比没有数字更糟：它看起来像证据。所以这轮不再"估算"，全部按当天跑出来的
`合计 N 项` 重写。

## 2. 当日实跑结果

运行方式（本机复现的最小步骤）：

```bash
node tools/mock-upstream.cjs 19888                 # 模拟上游
npx vite --port 1420 --strictPort                  # 开发服务器
cd tools/proxy-harness && RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu cargo build --target-dir target-gnu
```

| 命令 | 结果 |
|---|---|
| `ZXZ_BASE=http://localhost:1420 node tools/e2e.cjs` | **24/24 PASS** |
| `ZXZ_BASE=http://localhost:1420 node tools/workspace-e2e.cjs` | **39/39 PASS** |
| `ZXZ_BASE=http://localhost:1420 node tools/skill-e2e.cjs` | **69/69 PASS** |
| `ZXZ_BASE=http://localhost:1420 node tools/proxy-e2e.cjs` | **接口 10/10 + 前端 24/24** |
| `cargo test --manifest-path tools/fs-harness/Cargo.toml` | **79 passed / 1 ignored** |
| `npx vitest run` | **396 passed / 17 files** |

## 3. 实跑暴露的两个真问题（都已修）

### 3.1 假 IPC 落后于真 IPC（`tools/workspace-e2e.cjs`）

第一次跑就卡在 `waitForFunction(#faStatus 含"已落盘")` 超时。原因不是写盘坏了，是
harness 的假 `__TAURI_INTERNALS__` 只实现了 B4 之前的命令集合——B4 把撤销备份改到
`undo_write` 专用通道后，写盘流程变成 `fs_exists → fs_read → undo_write → fs_write`，
第三步抛 `unknown cmd: undo_write`，于是"已落盘"永远不会出现。

这条值得记：**报错信息完全没提撤销**，第一眼极容易误判成写盘功能坏掉。
修法是给假 IPC 补齐 `undo_write` / `undo_read` / `undo_list` / `perm_*`。
补完 39/39。

教训：harness 的假实现必须跟着真 IPC 的接口走。假 IPC 越方便，越容易在
"新增了一条 IPC"时被忘掉，而它失效的方式是**误导性超时**，不是报错。

### 3.2 断言把 system 消息算进了轮数（`tools/e2e.cjs`）

`上下文轮数=1 只带最近一轮` 报 `4 条：system,user,assistant,user`。

先怀疑是窗口裁剪坏了，查下来不是：`sliceContext` 给的正是
`[user1, assistant1, user2]`（1 轮历史 + 本次提问），多出来的那一条 `system` 是
技能提示词。断言写死了 `ctx.length === 3`，而技能提示词是后加的功能——
**断言比功能旧**，功能一变就假红。

修法不是把 3 改成 4（那下次再加一条 system 又会红），而是只数对话消息：
`ctx.filter(m => m.role !== "system")`，并在详情里把 system 条数单独打出来。
真正要守的性质（窗口大小、角色顺序）一个字没放松。

## 4. 一次"看着像漏洞、其实是陈旧产物"的经历

`proxy-e2e.cjs` 第一次跑出两条 FAIL：

```
FAIL  非回环 Host 被拒（403）  — status=200
FAIL  代理转发 /models  — {"error":"未知路由 POST /models"}
```

`非回环 Host 被拒` 直接对应 DNS rebinding 加固，报 200 是要当安全缺陷处理的。
先把代码看了一遍：`proxy.rs` 的 `host_only_loopback` 确实在预检与令牌之前调用，
逻辑没问题。接着比时间戳：

```
proxy-harness.exe   2026-11-01 09:34
proxy.rs            2026-11-01 22:07
```

**二进制比源码旧 12 小时**。重编之后同样两条都是 PASS，接口 10/10。

这条不是"虚惊一场"就完了——它说明**用一个可控的产物做验证时，产物本身的有效期
是结论有效期的上限**。以后跑 Rust 侧 harness 之前先看时间戳，比看完 FAIL 再回头
查代码便宜得多。

另一个同类的坑：`proxy-e2e.cjs` 拉起 `e2e.cjs` 时不传 `ZXZ_BASE`，子进程会退回
默认的 `5173`。那里没有服务，报的是 `waiting for locator('#btnNew')`——
看着像前端崩了，其实是端口不对。所以脚本本身没写错，是**调用方式**有隐含前提，
已写进 README 9.3。

## 5. 未跑清单（不冒称通过）

| 脚本 | 静态 `check(` 调用点 | 理由 |
|---|---|---|
| `desktop-workspace-e2e.cjs` | 34 | 需临时把 CDP 端口编进 exe 并重编；重编产物属业主保留权限 |
| `desktop-skill-e2e.cjs` | 21 | 同上 |
| `live-deepseek-e2e.cjs` | 27 | 需真实 API Key |
| `live-web-round.cjs` | 47 | 同上 |
| `live-tools-e2e.cjs` | 20 | 同上 |
| `live-tools-edge.cjs` | 29 | 同上 |
| `live-skill-e2e.cjs` | 35 | 同上 |

静态计数只说明"脚本里写了多少条断言"，不说明"今天这些断言都过"。
这七项本轮状态是 `NOT_TESTED`。

## 6. 本批未做

- 未重编 release exe、未打安装包（业主保留权限）。
- 未推送远端。
- 未补 CI：e2e 仍进不了 CI（playwright 不在 `package.json`，`npm ci` 后就没有；
  `channel:"msedge"` 硬编码；默认端口 5173 与 vite 的 1420 冲突）。这三条是 R3，
  需要单独一批处理，不是"顺手改个数字"能解决的。
