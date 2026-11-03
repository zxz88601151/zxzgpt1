// zxz 外壳：Tauri 2 后端
// 设计要点：
// 1) 前端是纯静态网页（dist/），由 Tauri WebView 直接托管，不引入任何 Node/前端构建产物。
// 2) 所有对远端模型的 HTTP 请求都由 Rust 侧发出，天然绕开浏览器 CORS，API Key 也不必交给 JS 沙箱以外的环境。
// 3) Rust 与前端之间用一条本机回环 HTTP/SSE 通道通讯，前端通过 IPC 拿到端口与一次性 token。

mod api;
mod fsx;
mod perms;
mod proxy;
mod runx;
mod wsx;

use crate::proxy::ProxyInfo;
use std::path::PathBuf;
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

/// 工程根目录的唯一入口：所有文件与命令操作都先经过这里把 sessionId 换成 root。
fn root_for(session_id: &str, op: &str) -> Result<PathBuf, String> {
    wsx::root_of(session_id).map_err(|e| format!("{op}：{e}"))
}

/// exec 闸门：`run_allowed` 的真正入口。
///
/// 这个函数存在的唯一目的，是让「有没有被批准」由 Rust 判定，而不是由前端。
/// 前端能做的是弹框问用户，那是体验；没有用户批准就起不了子进程，才是安全属性。
/// 判定在 IPC 后面，所以 devtools、前端 bug、将来接进来的第三方脚本都跳不过去。
///
/// 错误用 JSON 字符串回传，让前端能区分「需要授权」与「白名单拒绝」：
/// 前者该弹框，后者该直接告诉模型换个写法。
fn gate_exec(session_id: &str, argv: &[String]) -> Result<(), String> {
    perms::guard(session_id, argv).map_err(|denied| denied.to_json())
}

/// 工作区会话：工程目录只在这里登记一次，之后前端只认 sessionId。
mod ws_cmds {
    /// 登记工程目录（root 唯一一次出现在 IPC 里），返回会话信息
    #[tauri::command]
    pub fn ws_open(root: String) -> Result<crate::wsx::SessionInfo, String> {
        crate::wsx::open(&root)
    }

    #[tauri::command]
    pub fn ws_close(session_id: String) -> Result<(), String> {
        // 授权跟着会话走：会话一关，先前批过的执行许可全部作废。
        // 顺序上先清授权再关会话——反过来的话 close 失败会留下孤儿授权。
        crate::perms::clear_session(&session_id);
        crate::wsx::close(&session_id)
    }

    /// 查询会话是否还活着，顺带拿展示用的根目录与目录名
    #[tauri::command]
    pub fn ws_info(session_id: String) -> Result<crate::wsx::SessionInfo, String> {
        crate::wsx::info(&session_id)
    }
}

/// 文件系统 IPC 壳：只做参数转发，纯逻辑在 `fsx`（不依赖 tauri，便于单测）。
///
/// `fs_roots` / `fs_list` / `fs_mkdir` 是文件夹选择器通道：它天生要能浏览任意
/// 绝对路径（用户得先能走到工程目录），所以仍收绝对路径，但**只服务界面**——
/// 模型侧一律走下面的会话通道，拿不到第二个 root。
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

    /// 工程内列目录：模型工具专用，绝对路径与越界相对路径都在 Rust 侧拒绝
    #[tauri::command]
    pub fn fs_list_in(session_id: String, rel: String) -> Result<Vec<crate::fsx::FsEntry>, String> {
        let root = crate::root_for(&session_id, "列目录")?;
        crate::fsx::list_in(&root, &rel)
    }

    #[tauri::command]
    pub fn fs_read(session_id: String, rel: String) -> Result<String, String> {
        let root = crate::root_for(&session_id, "读文件")?;
        crate::fsx::read(&root, &rel)
    }

    #[tauri::command]
    pub fn fs_exists(session_id: String, rel: String) -> Result<bool, String> {
        let root = crate::root_for(&session_id, "查询文件")?;
        crate::fsx::exists(&root, &rel)
    }

    #[tauri::command]
    pub fn fs_write(session_id: String, rel: String, content: String) -> Result<crate::fsx::WriteResult, String> {
        let root = crate::root_for(&session_id, "写文件")?;
        crate::fsx::write(&root, &rel, content)
    }

    /// 撤销快照专用写入：只落 `.zxz/undo/<stamp>/<rel>`。
    ///
    /// 这是一条**不对外暴露给模型**的内部通道：模型手上的写工具走的是上面的
    /// `fs_write`，而 `fs_write` 整目录拒绝 `.zxz/undo`。撤销快照是覆盖写失败时
    /// 唯一的退路，它的写入路径因此必须和普通写路径分开。
    #[tauri::command]
    pub fn undo_write(
        session_id: String,
        stamp: String,
        rel: String,
        content: String,
    ) -> Result<crate::fsx::WriteResult, String> {
        let root = crate::root_for(&session_id, "写撤销快照")?;
        crate::fsx::undo_write(&root, &stamp, &rel, content)
    }

    /// 撤销快照的读取通道：`fs_read` / `fs_list_in` 对 `.zxz/undo` 已关闭，
    /// 撤销面板改走这两条。`stamp` 为 null 时列出快照目录列表。
    #[tauri::command]
    pub fn undo_list(
        session_id: String,
        stamp: Option<String>,
        rel: String,
    ) -> Result<Vec<crate::fsx::FsEntry>, String> {
        let root = crate::root_for(&session_id, "列撤销快照")?;
        crate::fsx::undo_list(&root, stamp.as_deref(), &rel)
    }

    #[tauri::command]
    pub fn undo_read(session_id: String, stamp: String, rel: String) -> Result<String, String> {
        let root = crate::root_for(&session_id, "读撤销快照")?;
        crate::fsx::undo_read(&root, &stamp, &rel)
    }
}

/// 受控命令执行 IPC 壳：白名单、超时、输出上限都在 runx 里，壳只做参数转发。
/// 前端在调用前也会先校验一次，但 Rust 侧必须重新校验，绝不信任前端 argv。
///
/// 工作目录只来自会话登记的根目录：这里不收、也不认任何 cwd 参数。
mod run_cmds {
    /// 执行一条已经获批的白名单命令。
    ///
    /// 注意执行顺序：先确认会话（root 拿得到），再过授权闸门，最后才 spawn。
    /// `gate_exec` 不能省、也不能挪到前端——它是「没有用户批准就起不了进程」
    /// 这句话的唯一实现。
    #[tauri::command]
    pub fn run_allowed(session_id: String, argv: Vec<String>) -> Result<crate::runx::RunResult, String> {
        let root = crate::root_for(&session_id, "执行命令")?;
        crate::gate_exec(&session_id, &argv)?;
        crate::runx::run_allowed(&root, &argv)
    }
}

/// 执行许可 IPC：查询、授予、撤销、列举。
///
/// `perm_grant` 是唯一能创建授权的入口，它只被前端界面调用——工具清单里没有它，
/// 模型无法通过工具调用触达。也不存在「先跑起来再自己授权」这条路：
/// 模型写的代码要跑起来，本身就得先过 `run_cmds::run_allowed` 的闸门。
mod perm_cmds {
    /// `uses` 为 null 表示本会话内不限次，为数字表示还能用几次
    #[tauri::command]
    pub fn perm_grant(
        session_id: String,
        scope: Vec<String>,
        uses: Option<u32>,
        label: String,
    ) -> Result<Vec<crate::perms::Grant>, String> {
        crate::root_for(&session_id, "授予执行许可")?;
        Ok(crate::perms::grant(&session_id, &scope, uses, label))
    }

    #[tauri::command]
    pub fn perm_revoke(session_id: String, scope: Option<Vec<String>>) -> Result<Vec<crate::perms::Grant>, String> {
        crate::root_for(&session_id, "撤销执行许可")?;
        Ok(crate::perms::revoke(&session_id, scope.as_deref()))
    }

    #[tauri::command]
    pub fn perm_list(session_id: String) -> Result<Vec<crate::perms::Grant>, String> {
        crate::root_for(&session_id, "查看执行许可")?;
        Ok(crate::perms::list(&session_id))
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            proxy_info,
            ws_cmds::ws_open,
            ws_cmds::ws_close,
            ws_cmds::ws_info,
            fs_cmds::fs_roots,
            fs_cmds::fs_list,
            fs_cmds::fs_list_in,
            fs_cmds::fs_mkdir,
            fs_cmds::fs_read,
            fs_cmds::fs_exists,
            fs_cmds::fs_write,
            fs_cmds::undo_write,
            fs_cmds::undo_list,
            fs_cmds::undo_read,
            run_cmds::run_allowed,
            perm_cmds::perm_grant,
            perm_cmds::perm_revoke,
            perm_cmds::perm_list
        ])
        .setup(|_app| {
            let _ = PROXY.set(proxy::spawn());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("zxz 启动失败");
}
