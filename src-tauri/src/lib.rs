// zxz 外壳：Tauri 2 后端
// 设计要点：
// 1) 前端是纯静态网页（dist/），由 Tauri WebView 直接托管，不引入任何 Node/前端构建产物。
// 2) 所有对远端模型的 HTTP 请求都由 Rust 侧发出，天然绕开浏览器 CORS，API Key 也不必交给 JS 沙箱以外的环境。
// 3) Rust 与前端之间用一条本机回环 HTTP/SSE 通道通讯，前端通过 IPC 拿到端口与一次性 token。

mod api;
mod fsx;
mod proxy;
mod runx;

use crate::proxy::ProxyInfo;
use std::sync::OnceLock;

/// 本机代理通道信息，进程内只初始化一次。
static PROXY: OnceLock<ProxyInfo> = OnceLock::new();

/// 前端启动时调用，拿到本机代理的端口与访问令牌。
#[tauri::command]
fn proxy_info() -> Result<serde_json::Value, String> {
    match PROXY.get() {
        Some(info) => Ok(serde_json::json!({
            "port": info.port,
            "token": info.token,
        })),
        None => Err("代理尚未启动".into()),
    }
}

/// 单独启动本地代理（供 examples/smoke.rs 做链路自检用）。
pub fn spawn_proxy() -> ProxyInfo {
    proxy::spawn()
}

/// 文件系统 IPC 壳：只做参数转发，纯逻辑在 `fsx`（不依赖 tauri，便于单测）。
mod fs_cmds {
    #[tauri::command]
    pub fn fs_roots() -> Vec<String> {
        crate::fsx::roots()
    }

    #[tauri::command]
    pub fn fs_list(path: String) -> Result<Vec<crate::fsx::FsEntry>, String> {
        crate::fsx::list(path)
    }

    /// 选择器里的「新建文件夹」：只建一层，名字与落点都在 fsx 里校验过
    #[tauri::command]
    pub fn fs_mkdir(dir: String, name: String) -> Result<String, String> {
        crate::fsx::mkdir(dir, name)
    }

    #[tauri::command]
    pub fn fs_read(root: String, rel: String) -> Result<String, String> {
        crate::fsx::read(root, rel)
    }

    #[tauri::command]
    pub fn fs_exists(root: String, rel: String) -> Result<bool, String> {
        crate::fsx::exists(root, rel)
    }

    #[tauri::command]
    pub fn fs_write(root: String, rel: String, content: String) -> Result<crate::fsx::WriteResult, String> {
        crate::fsx::write(root, rel, content)
    }
}

/// 受控命令执行 IPC 壳：白名单、超时、输出上限都在 runx 里，壳只做参数转发。
/// 前端在调用前也会先校验一次，但 Rust 侧必须重新校验，绝不信任前端 argv。
mod run_cmds {
    #[tauri::command]
    pub fn run_allowed(root: String, argv: Vec<String>) -> Result<crate::runx::RunResult, String> {
        crate::runx::run_allowed(&root, &argv)
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            proxy_info,
            fs_cmds::fs_roots,
            fs_cmds::fs_list,
            fs_cmds::fs_mkdir,
            fs_cmds::fs_read,
            fs_cmds::fs_exists,
            fs_cmds::fs_write,
            run_cmds::run_allowed
        ])
        .setup(|_app| {
            let _ = PROXY.set(proxy::spawn());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("zxz 启动失败");
}
