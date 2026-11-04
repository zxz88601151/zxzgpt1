# D-16 · 「用户点停止」不再被代理记成「连接处理失败」

- 日期：2026-11-04
- 登记处：`TECH_DEBT_REGISTER_20261103.md` 第 51 行（P3）
- 改动文件：`src-tauri/src/proxy.rs`（唯一）
- 结论：**PASS**（有对照实验，不是只看绿灯）

---

## 1. 缺陷复述

`serve()` 里对 `handle_conn` 的错误处理是一句话：

```rust
if let Err(e) = handle_conn(socket, tok).await {
    eprintln!("[zxz] 连接处理失败：{}", e);
}
```

而 `handle_conn` 的 `Err` 只有一个 `String`，没有种类信息。于是**任何**写失败都变成同一句红字，
包括最常见的一种：用户点了「停止生成」、切走页面、关窗口，前端直接断 TCP，
代理正在写 SSE 分片 → `BrokenPipe` / `ConnectionReset`（Windows 上实测 `os error 10053`）。

后果不是功能坏，而是日志失去信号：平时每停一次就打一行错误，真出故障那天没人会多看一眼。

## 2. 修法

1. 新增 `enum ConnError { PeerGone, Fatal(String) }`，并实现 `From<std::io::Error>`：
   `BrokenPipe` / `ConnectionReset` / `ConnectionAborted` → `PeerGone`，其余 → `Fatal`。
2. 写路径（`write_cors` / `write_json` / `handle_chat` 的 `write_all` 与 `flush`）的
   `map_err(|e| e.to_string())` 改为 `map_err(ConnError::from)`，让 `io::ErrorKind` 不再在
   转字符串时丢掉。
3. `serve()` 按种类分派：`PeerGone` 静默（这是正常路径），`Fatal` 才打日志。

**刻意没做的事情**：没有动读路径。`read_head` / `read_body` 返回的 `String` 错误
（请求头过大、连接被提前关闭、body 超上限）仍然是 `Fatal`——那些是畸形请求，
不是"人走了"，吞掉它们只会让真问题消失。

## 3. 判据

### 3.1 分类表（长期判据，`cargo test` 可跑）

`proxy.rs` 末尾新增 `#[cfg(test)] mod tests`，3 条：

| 用例 | 断言 |
|---|---|
| `peer_disconnects_are_not_fatal` | `BrokenPipe` / `ConnectionReset` / `ConnectionAborted` → `PeerGone` |
| `other_io_errors_stay_fatal` | `PermissionDenied` / `TimedOut` / `AddrInUse` → `Fatal` |
| `protocol_errors_on_the_read_path_stay_fatal` | `"连接被提前关闭"`（读路径字符串）→ `Fatal` |

跑法（本机 msvc 链不可用，必须指定 GNU）：

```sh
RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu \
  cargo test --manifest-path tools/proxy-harness/Cargo.toml
# 3 passed
```

变异检验：把 `BrokenPipe` 从 `PeerGone` 那一臂删掉 → `peer_disconnects_are_not_fatal` 精确变红
（`panicked at proxy.rs:497: BrokenPipe`），另两条仍绿。

### 3.2 端到端对照实验（一次性，2026-11-04 实跑）

脚本做的事：起一个每 150ms 发一片的假上游 → 起 `proxy-harness.exe` → 打 `/chat`
→ 读到第一个 SSE 分片后**主动 destroy socket**（模拟点停止）→ 800ms 后看 harness 的 stderr。

| 版本 | stderr | 判定 |
|---|---|---|
| 修复前（把 `PeerGone` 臂改回 `Fatal` 重编） | `[zxz] 连接处理失败：你的主机中的软件中止了一个已建立的连接。 (os error 10053)` | **FAIL** |
| 修复后 | `(空)` | **PASS** |

这条对照是这次修复唯一能证明"改对了"的证据：单测只钉分类表，
不证明 `serve()` 真的按分类走了。既然对照实验能稳定复现两种结果，就不是"运气好没触发"。

脚本没有入库（一次性验证，需要先编 harness exe）。要复现按上面四步自己写 30 行即可；
真正防回归的是 §3.1 那 3 条单测。

## 4. 未覆盖

- 中断发生在**读请求阶段**（头/体还没读完就断）时，仍会打 `连接处理失败`。这是有意的：
  那一档同时装着"畸形请求"，无法只凭 `io::ErrorKind` 区分"人走了"和"请求坏了"，
  在拿到更细的信号之前不做猜测。
- 没有验证 Windows 之外的错误映射（本机只有 Windows）。`ErrorKind` 的映射是跨平台的，
  但 10053 这类具体码没有在 Linux 上复核。
