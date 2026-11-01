// 本机代理自检 harness
//
// 目的：在没有 MSVC 工具链、也不方便拉起窗口的环境里，验证
// `src-tauri/src/proxy.rs`（手写 HTTP/SSE 转发）与 `api.rs`（OpenAI 兼容客户端）
// 的真实行为。两份源码通过 #[path] 逐字引用，没有副本、没有改逻辑。
//
// 唯一的替身是 `tauri::async_runtime::spawn` —— 这里用 tokio 运行时实现，
// 与 tauri 内部行为一致（tauri 的 async_runtime 本身就是一个 tokio 运行时）。
//
// 输出与 examples/smoke.rs 一致：
//   PORT=19527
//   TOKEN=<随机令牌>

#[path = "../../../src-tauri/src/api.rs"]
mod api;
#[path = "../../../src-tauri/src/proxy.rs"]
mod proxy;

fn main() {
    let info = proxy::spawn();
    println!("PORT={}", info.port);
    println!("TOKEN={}", info.token);
    println!("代理已就绪，按 Ctrl+C 退出");
    std::thread::park();
}
