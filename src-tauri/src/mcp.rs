//! MCP 客户端（Rust 侧）：拉起本地 MCP 服务器子进程、走 JSON-RPC over stdio
//! 做 initialize / tools/list / tools/call，带超时；读写 mcp.json 配置文件。
//!
//! 分层（与前端 `src/lib/mcp.ts` 一一对应，职责不越界）：
//!   - 这里：子进程、stdio、握手、超时、杀进程、配置文件。前端永远不直接 spawn。
//!   - 前端：注册表类型与校验、工具名命名空间、参数校验、调用分发。
//!
//! 安全边界（读之前先看这三条，改代码时别顺手放宽）：
//!   1. 启动命令白名单就是注册表本身：`start_server` 只接受调用方传来的、
//!      用户在 mcp.json 里明确配置过的命令；`validate_server_config` 再查一遍
//!      ——裸命令名、不接受路径、不接受 shell 元字符。模型与对话内容没有任何
//!      通道能把启动命令传进来（没有任何模型工具能调到 `mcp_start`）。
//!   2. context-mode 自带沙箱、自己跑命令，这是一条独立于 ZXZGPT 受控执行
//!      白名单之外的命令通道：本文件不审 MCP 工具的语义，只保证「服务器
//!      是谁、工具名是不是它自己报出来的」；执行权限的约束在前端
//!      （计划/探索模式拦截、exec 级串行），见 `src/lib/mcp.ts`。
//!   3. 凭据不进 MCP 配置：`validate_server_config` 直接拒绝 KEY / TOKEN /
//!      SECRET / PASSWORD / AUTH / CREDENTIAL 这类环境变量名；context-mode
//!      本身不需要 API Key。
//!
//! 超时与失败隔离：每一次请求都在独立线程里做阻塞读，主线程
//! `recv_timeout` 等；超时就杀掉子进程、把服务器标成失败——一条 wedged
//! 的管道不能拖住之后所有调用。服务器挂了不影响主流程，也不丢已有会话。
//!
//! 注意：本文件目前**只写、未编译未跑**（本机无 cargo）。写得保守、简单，
//! 单元测试在下面，待用户在 Windows 真机上 `cargo test` / `cargo build` 验证。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

/// MCP 协议版本：initialize 时报给服务器。2024-11-05 是各家服务器都认的老版本，
/// 比新版更不容易遇到「服务器不认协议版本」的握手失败。
pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
/// 握手与 tools/list 的超时（毫秒）：initialize 是冷启动（npx 可能要现下载包），
/// 给 30 秒；超过就当服务器起不来。
pub const MCP_HANDSHAKE_TIMEOUT_MS: u64 = 30_000;
/// tools/call 的超时（毫秒）：ctx_execute 跑脚本可能慢，给 60 秒。
pub const MCP_TOOL_TIMEOUT_MS: u64 = 60_000;
/// MCP 工具结果回传给模型的字符上限（与前端 MAX_TOOL_OUTPUT_CHARS 同值）。
pub const MCP_MAX_RESULT_CHARS: usize = 20_000;
/// context-mode 要求的最低 Node 版本（它 package.json 的 engines 字段）。
pub const MCP_MIN_NODE: (u64, u64, u64) = (24, 15, 0);

/* ------------------------------------------------------------ 类型 */

/// 一台 MCP 服务器的注册信息：与前端 `McpServerConfig` 同构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub enabled: bool,
}

/// mcp.json 的文件结构：目前只有服务器列表，没有别的字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpConfigFile {
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}

/// 服务器返回的单个工具（tools/list 的原始形态）。
///
/// `rename_all = "camelCase"` 不能省：Rust 字段是 `input_schema`，前端
/// 读的是 `inputSchema`——不改名，工具的 inputSchema 到前端是 undefined，
/// 模型拿到的工具定义就没有 parameters，等于白列一遍工具。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_input_schema")]
    pub input_schema: serde_json::Value,
}

fn default_input_schema() -> serde_json::Value {
    serde_json::json!({"type": "object"})
}

/// 服务器运行状态（mcp_status 的返回形态）。
#[derive(Debug, Clone, Serialize)]
pub struct McpServerStatus {
    pub name: String,
    pub running: bool,
    /// 已缓存的工具数（未 list 时为 0）
    pub tools: usize,
    /// 失败原因：有值表示服务器已挂（超时/崩溃/握手失败），需要重新开启
    pub error: Option<String>,
}

/// mcp_config_read 的返回：配置文件实际路径 + 服务器列表。
/// 路径要回给前端——用户第一次启用 context-mode 时，得知道去哪里改文件。
#[derive(Debug, Clone, Serialize)]
pub struct McpConfigRead {
    pub path: String,
    pub servers: Vec<McpServerConfig>,
}

/* ------------------------------------------------------------ 校验 */

/// 与前端 `mcp.ts` 的 SHELL_META 同款字符集：启动命令与参数里一个都不能有。
/// 注意：参数里的 `-y` 这类正常 flag 不受影响，只有这些元字符被拦。
const SHELL_META: &[char] = &[
    ';', '|', '&', '$', '`', '\\', '\n', '\r', '<', '>', '^', '%', '!', '"', '\'', '(', ')',
];

fn has_control_chars(s: &str) -> bool {
    s.chars().any(|c| c == '\0' || c == '\n' || c == '\r')
}

/// 裸命令名：不含路径分隔符、不含 shell 元字符、不含控制字符。
/// 白名单只认 PATH 上的裸命令名——`npx` 可以，`/usr/bin/npx`、`./npx` 不行。
fn is_bare_command(cmd: &str) -> bool {
    !cmd.is_empty()
        && cmd.chars().count() <= 64
        && !cmd.contains('/')
        && !cmd.contains('\\')
        && !cmd.chars().any(|c| SHELL_META.contains(&c) || c.is_control())
}

/// 凭据类环境变量名：命中即拒绝，凭据不得写进 MCP 配置。
fn is_secret_env_key(key: &str) -> bool {
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "AUTH", "CREDENTIAL"]
        .iter()
        .any(|needle| key.contains(needle))
}

/**
 * 注册表项校验：与前端 `validateMcpServerConfig` 是同一套规则。
 * 前端提前拦截、Rust 执行时必然重查——前端校验永远不能代替 Rust 校验，
 * 改一边就要改另一边。
 */
pub fn validate_server_config(cfg: &McpServerConfig) -> Result<(), String> {
    if cfg.name.is_empty()
        || cfg.name.chars().count() > 32
        || !cfg
            .name
            .chars()
            .next()
            .map(|c| c.is_ascii_lowercase())
            .unwrap_or(false)
        || !cfg
            .name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(format!(
            "MCP 服务器名非法：{}（只允许小写字母、数字、-、_，首字符为小写字母，最长 32 字符）",
            cfg.name
        ));
    }
    if !is_bare_command(&cfg.command) {
        return Err(format!(
            "MCP 服务器 {} 的启动命令非法：{}（只允许 PATH 上的裸命令名，不接受路径与 shell 元字符）",
            cfg.name, cfg.command
        ));
    }
    if cfg.args.len() > 32 {
        return Err(format!("MCP 服务器 {} 的启动参数太多（上限 32 个）", cfg.name));
    }
    for a in &cfg.args {
        if a.chars().count() > 512 {
            return Err(format!("MCP 服务器 {} 的启动参数太长（上限 512 字符）", cfg.name));
        }
        if SHELL_META.iter().any(|m| a.contains(*m)) || has_control_chars(a) {
            return Err(format!(
                "MCP 服务器 {} 的启动参数含 shell 元字符或控制字符，已拒绝",
                cfg.name
            ));
        }
    }
    if cfg.env.len() > 16 {
        return Err(format!("MCP 服务器 {} 的环境变量太多（上限 16 个）", cfg.name));
    }
    for (k, v) in &cfg.env {
        if k.is_empty()
            || !k
                .chars()
                .next()
                .map(|c| c.is_ascii_uppercase())
                .unwrap_or(false)
            || !k
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            return Err(format!(
                "MCP 服务器 {} 的环境变量名非法：{}（只允许大写字母、数字、下划线）",
                cfg.name, k
            ));
        }
        if is_secret_env_key(k) {
            return Err(format!(
                "MCP 服务器 {} 的环境变量 {} 看起来像凭据（KEY/TOKEN/SECRET/PASSWORD 等），凭据不得写进 MCP 配置，context-mode 本身也不需要 API Key",
                cfg.name, k
            ));
        }
        if v.chars().count() > 1024 {
            return Err(format!(
                "MCP 服务器 {} 的环境变量 {} 太长（上限 1024 字符）",
                cfg.name, k
            ));
        }
        if has_control_chars(v) {
            return Err(format!(
                "MCP 服务器 {} 的环境变量 {} 含控制字符，已拒绝",
                cfg.name, k
            ));
        }
    }
    Ok(())
}

/// 整个配置文件的校验：服务器名唯一、总数上限 16。
pub fn validate_config_file(cfg: &McpConfigFile) -> Result<(), String> {
    if cfg.servers.len() > 16 {
        return Err("MCP 服务器太多（上限 16 个）".into());
    }
    let mut seen = HashSet::new();
    for s in &cfg.servers {
        if !seen.insert(s.name.clone()) {
            return Err(format!("MCP 服务器名重复：{}", s.name));
        }
        validate_server_config(s)?;
    }
    Ok(())
}

/* ------------------------------------------------------------ 配置文件 */

/// 缺省配置：只有 context-mode 一项，且默认关闭。
/// 与前端 `DEFAULT_MCP_CONFIG` 同构，两边改一边就要改另一边。
pub fn default_config() -> McpConfigFile {
    McpConfigFile {
        servers: vec![McpServerConfig {
            name: "context-mode".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "context-mode".into()],
            env: HashMap::new(),
            enabled: false,
        }],
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取不到应用配置目录：{e}"))?;
    Ok(dir.join("mcp.json"))
}

/// 读 mcp.json。文件不存在时写一份默认配置再返回（context-mode 默认关闭）。
/// 文件存在但解析失败或校验失败时直接报错、不静默回退默认配置：
/// 静默回退等于把用户手改的配置悄悄丢掉，下次启动还是一样错。
pub fn read_config(app: &tauri::AppHandle) -> Result<McpConfigRead, String> {
    let path = config_path(app)?;
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建 MCP 配置目录失败：{e}"))?;
        }
        let cfg = default_config();
        let text = serde_json::to_string_pretty(&cfg).map_err(|e| format!("序列化默认 MCP 配置失败：{e}"))?;
        std::fs::write(&path, text).map_err(|e| format!("写默认 MCP 配置失败：{e}"))?;
        return Ok(McpConfigRead {
            path: path.to_string_lossy().into_owned(),
            servers: cfg.servers,
        });
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("读 MCP 配置失败（{}）：{e}", path.display()))?;
    let cfg: McpConfigFile = serde_json::from_str(&text)
        .map_err(|e| format!("MCP 配置解析失败（{}）：{}，请按默认格式修好再启动", path.display(), e))?;
    validate_config_file(&cfg).map_err(|e| format!("MCP 配置校验失败：{e}"))?;
    Ok(McpConfigRead {
        path: path.to_string_lossy().into_owned(),
        servers: cfg.servers,
    })
}

/// 保存整份 mcp.json：先解析 + 校验，再原子写入（临时文件 + 改名），
/// 避免写一半的配置下次启动读到坏文件。
pub fn save_config(app: &tauri::AppHandle, content: &str) -> Result<(), String> {
    let cfg: McpConfigFile =
        serde_json::from_str(content).map_err(|e| format!("MCP 配置解析失败：{e}"))?;
    validate_config_file(&cfg)?;
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 MCP 配置目录失败：{e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| format!("序列化 MCP 配置失败：{e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("写 MCP 配置失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("写 MCP 配置失败：{e}"))?;
    Ok(())
}

/* ------------------------------------------------------------ Node 前置检查 */

/// 解析 `node --version` 的输出（`v24.15.0` → (24, 15, 0)）。
fn parse_node_version(out: &str) -> Option<(u64, u64, u64)> {
    let s = out.trim().strip_prefix('v').unwrap_or(out.trim());
    let mut it = s.split('.');
    let major: u64 = it.next()?.parse().ok()?;
    let minor: u64 = it.next().unwrap_or("0").parse().ok()?;
    let patch: u64 = it.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// context-mode 的前置检查：Node 24.15+。没装、读不到版本、版本过低，
/// 都直接报人话错误——不要等 npx 在握手里超时才让用户猜。
fn check_node_for_context_mode() -> Result<(), String> {
    let out = match Command::new("node").arg("--version").output() {
        Ok(o) if o.status.success() => o,
        _ => {
            return Err(
                "未检测到 Node.js：context-mode 需要 Node 24.15+，请先安装 Node.js（https://nodejs.org/）再开启 MCP 插件"
                    .into(),
            )
        }
    };
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let v = parse_node_version(&text).ok_or_else(|| {
        format!(
            "读不到 Node.js 版本号（输出：{}），请检查 Node 安装",
            text.trim()
        )
    })?;
    if v < MCP_MIN_NODE {
        return Err(format!(
            "Node.js 版本过低：当前 v{}.{}.{}，context-mode 要求 24.15+，请升级 Node.js 再开启",
            v.0, v.1, v.2
        ));
    }
    Ok(())
}

/* ------------------------------------------------------------ 服务器运行态 */

struct McpConn {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

struct McpServer {
    config: McpServerConfig,
    conn: Mutex<McpConn>,
    next_id: AtomicU64,
    /// 杀进程专用：与 conn 分开锁——超时处理要杀进程时，
    /// 读线程可能正拿着 conn 锁卡在 read_line 上，分开才不会死锁。
    child: Mutex<Child>,
    tools: Mutex<Option<Vec<McpTool>>>,
    failed: Mutex<Option<String>>,
}

static SERVERS: OnceLock<Mutex<HashMap<String, Arc<McpServer>>>> = OnceLock::new();

fn servers() -> &'static Mutex<HashMap<String, Arc<McpServer>>> {
    SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn status_of(server: &Arc<McpServer>) -> McpServerStatus {
    let failed = server
        .failed
        .lock()
        .ok()
        .and_then(|f| f.clone());
    let tools = server
        .tools
        .lock()
        .ok()
        .and_then(|t| t.as_ref().map(|v| v.len()))
        .unwrap_or(0);
    McpServerStatus {
        name: server.config.name.clone(),
        running: failed.is_none(),
        tools,
        error: failed,
    }
}

fn get_server(name: &str) -> Result<Arc<McpServer>, String> {
    servers()
        .lock()
        .map_err(|e| format!("MCP 注册表锁失败：{e}"))?
        .get(name)
        .cloned()
        .ok_or_else(|| format!("MCP 服务器未运行：{name}（请先在 mcp.json 里启用并打开工程）"))
}

/// 标记失败并杀掉子进程。杀进程后读线程会读到 EOF 而退出，
/// 不会留下一条 wedged 的管道拖住之后所有调用。
fn mark_failed(server: &Arc<McpServer>, reason: &str) {
    if let Ok(mut f) = server.failed.lock() {
        *f = Some(reason.to_string());
    }
    if let Ok(mut child) = server.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/**
 * 发一次 JSON-RPC 请求并等一行响应。
 *
 * 写 + 读都在独立线程里做（stdio 管道没有跨平台的读超时），主线程
 * `recv_timeout` 等；超时与读线程 panic 都按「服务器无响应」处理，
 * 杀进程、标失败——之后再调同一台服务器会直接返回失败原因，
 * 不会在一条死管道上反复等。
 */
fn request(
    server: &Arc<McpServer>,
    method: &str,
    params: serde_json::Value,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    let id = server.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let line = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string();
    let (tx, rx) = mpsc::channel::<Result<serde_json::Value, String>>();
    let srv = Arc::clone(server);
    std::thread::spawn(move || {
        let res = (|| -> Result<serde_json::Value, String> {
            let mut conn = srv
                .conn
                .lock()
                .map_err(|e| format!("MCP 连接锁失败：{e}"))?;
            conn.stdin
                .write_all(line.as_bytes())
                .map_err(|e| format!("向 MCP 服务器写请求失败：{e}"))?;
            conn.stdin
                .write_all(b"\n")
                .map_err(|e| format!("向 MCP 服务器写请求失败：{e}"))?;
            conn.stdin
                .flush()
                .map_err(|e| format!("向 MCP 服务器写请求失败：{e}"))?;
            let mut raw = String::new();
            let n = conn
                .stdout
                .read_line(&mut raw)
                .map_err(|e| format!("读 MCP 服务器响应失败：{e}"))?;
            if n == 0 {
                return Err("MCP 服务器已退出（读到 EOF）".into());
            }
            let msg: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|e| format!("MCP 服务器返回的不是合法 JSON：{e}"))?;
            if let Some(err) = msg.get("error") {
                let m = err
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知错误");
                return Err(format!("MCP 服务器返回错误：{m}"));
            }
            msg.get("result")
                .cloned()
                .ok_or_else(|| "MCP 服务器响应里没有 result".to_string())
        })();
        let _ = tx.send(res);
    });
    match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(r) => r,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let reason = format!("MCP 服务器无响应（{} 秒），已停止该服务器", timeout_ms / 1000);
            mark_failed(server, &reason);
            Err(format!(
                "MCP 服务器 {} 无响应（{} 秒），已停止该服务器；请检查服务器是否卡住，重新开启后再试",
                server.config.name,
                timeout_ms / 1000
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let reason = "MCP 请求线程异常退出".to_string();
            mark_failed(server, &reason);
            Err(format!("MCP 服务器 {} 请求失败：{reason}", server.config.name))
        }
    }
}

/**
 * 启动一台服务器并握手。已在跑时直接返回当前状态，不重复拉进程
 * （调用方换了配置要生效时，先调 mcp_stop 再启动）。
 *
 * 握手：initialize → notifications/initialized。握不上就杀掉进程、
 * 不注册、不留僵尸。`session_root` 是工程根目录（Rust 侧从 sessionId
 * 换出来，前端不传路径）：子进程的 cwd 跟着工程走，context-mode 的
 * ctx_* 工具才会在正确的工程目录里跑。
 */
pub fn start_server(
    config: McpServerConfig,
    session_root: Option<std::path::PathBuf>,
) -> Result<McpServerStatus, String> {
    validate_server_config(&config)?;
    {
        let map = servers()
            .lock()
            .map_err(|e| format!("MCP 注册表锁失败：{e}"))?;
        if let Some(existing) = map.get(&config.name) {
            return Ok(status_of(existing));
        }
    }
    if config.name == "context-mode" {
        check_node_for_context_mode()?;
    }
    let mut cmd = Command::new(&config.command);
    cmd.args(&config.args)
        .envs(&config.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // stderr 直接丢掉：服务器的日志不进本程序的输出；
        // 启动失败通过握手超时/错误报出来，不靠读 stderr 猜。
        .stderr(Stdio::null());
    if let Some(root) = &session_root {
        cmd.current_dir(root);
    }
    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "启动 MCP 服务器 {} 失败：{e}（命令 {} 不在 PATH 上或无权执行）",
            config.name, config.command
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "MCP 服务器没有 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "MCP 服务器没有 stdout".to_string())?;
    let server = Arc::new(McpServer {
        config: config.clone(),
        conn: Mutex::new(McpConn {
            stdin,
            stdout: BufReader::new(stdout),
        }),
        next_id: AtomicU64::new(0),
        child: Mutex::new(child),
        tools: Mutex::new(None),
        failed: Mutex::new(None),
    });
    let init = request(
        &server,
        "initialize",
        serde_json::json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "zxzgpt", "version": "0.3.0"},
        }),
        MCP_HANDSHAKE_TIMEOUT_MS,
    );
    match init {
        Ok(result) => {
            let proto = result
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if proto.is_empty() {
                let reason = "MCP 握手失败：服务器没有返回 protocolVersion";
                mark_failed(&server, reason);
                return Err(format!("MCP 服务器 {} 握手失败：{reason}", config.name));
            }
            // initialized 是通知（无 id），写不进去说明管道已断，
            // 后面的 tools/list 会自己报出来，这里不致命。
            if let Ok(mut conn) = server.conn.lock() {
                let note =
                    serde_json::json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
                        .to_string();
                let _ = conn.stdin.write_all(note.as_bytes());
                let _ = conn.stdin.write_all(b"\n");
                let _ = conn.stdin.flush();
            }
        }
        Err(e) => {
            mark_failed(&server, &e);
            return Err(format!("MCP 服务器 {} 握手失败：{e}", config.name));
        }
    }
    let status = status_of(&server);
    servers()
        .lock()
        .map_err(|e| format!("MCP 注册表锁失败：{e}"))?
        .insert(config.name.clone(), server);
    Ok(status)
}

/// 停掉一台服务器（没在跑也算成功，幂等）。
pub fn stop_server(name: &str) -> Result<(), String> {
    let removed = servers()
        .lock()
        .map_err(|e| format!("MCP 注册表锁失败：{e}"))?
        .remove(name);
    if let Some(server) = removed {
        if let Ok(mut child) = server.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

/// 停掉全部服务器（应用退出时调用，不留孤儿进程）。
pub fn stop_all() {
    let names: Vec<String> = servers()
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for name in names {
        let _ = stop_server(&name);
    }
}

/// 所有服务器的运行状态（含已挂的，带失败原因）。
pub fn list_status() -> Vec<McpServerStatus> {
    servers()
        .lock()
        .map(|m| m.values().map(|s| status_of(s)).collect())
        .unwrap_or_default()
}

/// 解析 tools/list 的返回：只要合法的工具，名字与 inputSchema 非法直接报错。
fn parse_tools_list(result: &serde_json::Value) -> Result<Vec<McpTool>, String> {
    let arr = result
        .get("tools")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "MCP 服务器 tools/list 没有返回 tools 数组".to_string())?;
    let mut out = Vec::new();
    for t in arr {
        let name = t
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty()
            || name.chars().count() > 128
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(format!("MCP 服务器返回了非法工具名：{name}"));
        }
        let description = t
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let input_schema = t
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({"type": "object"}));
        if !input_schema.is_object() {
            return Err(format!("MCP 工具 {name} 的 inputSchema 不是对象"));
        }
        out.push(McpTool {
            name,
            description,
            input_schema,
        });
    }
    Ok(out)
}

/// 列出工具（tools/list，成功后缓存，重复调用不重复发请求）。
pub fn list_tools(name: &str) -> Result<Vec<McpTool>, String> {
    let server = get_server(name)?;
    if let Some(f) = server
        .failed
        .lock()
        .map_err(|e| format!("MCP 状态锁失败：{e}"))?
        .clone()
    {
        return Err(f);
    }
    if let Some(cached) = server
        .tools
        .lock()
        .map_err(|e| format!("MCP 工具缓存锁失败：{e}"))?
        .clone()
    {
        return Ok(cached);
    }
    let result = request(&server, "tools/list", serde_json::json!({}), MCP_HANDSHAKE_TIMEOUT_MS)?;
    let tools = parse_tools_list(&result)?;
    *server
        .tools
        .lock()
        .map_err(|e| format!("MCP 工具缓存锁失败：{e}"))? = Some(tools.clone());
    Ok(tools)
}

/// 把 tools/call 的 content 拼成给模型看的文本：text 段原样接，非文本段只留一句说明。
fn join_call_content(result: &serde_json::Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(arr) = result.get("content").and_then(|v| v.as_array()) {
        for item in arr {
            if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                    parts.push(t.to_string());
                }
            } else {
                parts.push("[非文本内容已省略]".to_string());
            }
        }
    }
    if parts.is_empty() {
        "(空结果)".to_string()
    } else {
        parts.join("\n")
    }
}

/// 按字符截断，截断时注明（不是静默丢）。
fn truncate_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let mut s: String = text.chars().take(max).collect();
    s.push_str(&format!(
        "\n\n/* MCP 工具输出已截断：原文 {count} 字符，只取前 {max} 字符 */"
    ));
    s
}

/// 调一次工具（tools/call，60 秒超时）。
///
/// fail-closed：只认 tools/list 里出现过的工具名——模型拼出来的名字
/// 到不了服务器；参数必须是 JSON 对象。
pub fn call_tool(name: &str, tool: &str, arguments: serde_json::Value) -> Result<String, String> {
    let server = get_server(name)?;
    if let Some(f) = server
        .failed
        .lock()
        .map_err(|e| format!("MCP 状态锁失败：{e}"))?
        .clone()
    {
        return Err(f);
    }
    if !arguments.is_object() {
        return Err("MCP 工具参数必须是 JSON 对象".into());
    }
    let tools = list_tools(name)?;
    if !tools.iter().any(|t| t.name == tool) {
        return Err(format!("未知 MCP 工具：{tool}（服务器 {name} 没有提供它）"));
    }
    let result = request(
        &server,
        "tools/call",
        serde_json::json!({"name": tool, "arguments": arguments}),
        MCP_TOOL_TIMEOUT_MS,
    )?;
    let text = join_call_content(&result);
    if result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(format!("MCP 工具 {tool} 返回错误：{text}"));
    }
    Ok(truncate_chars(&text, MCP_MAX_RESULT_CHARS))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context_mode() -> McpServerConfig {
        McpServerConfig {
            name: "context-mode".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "context-mode".into()],
            env: HashMap::new(),
            enabled: false,
        }
    }

    #[test]
    fn default_config_is_context_mode_disabled() {
        let c = default_config();
        assert_eq!(c.servers.len(), 1);
        assert_eq!(c.servers[0].name, "context-mode");
        assert!(!c.servers[0].enabled);
        assert!(validate_config_file(&c).is_ok());
    }

    #[test]
    fn valid_server_config_passes() {
        assert!(validate_server_config(&context_mode()).is_ok());
        assert!(validate_server_config(&McpServerConfig {
            name: "my-server_1".into(),
            command: "uvx".into(),
            args: vec!["mcp-server".into()],
            env: HashMap::new(),
            enabled: true,
        })
        .is_ok());
    }

    #[test]
    fn bad_server_names_rejected() {
        let mut cases: Vec<String> = vec![
            "".into(),
            "Context-Mode".into(),
            "1abc".into(),
            "has space".into(),
        ];
        cases.push("a".repeat(33));
        for name in cases {
            let mut c = context_mode();
            c.name = name.clone();
            assert!(validate_server_config(&c).is_err(), "应拒绝服务器名：{name}");
        }
    }

    #[test]
    fn command_with_path_or_shell_meta_rejected() {
        for cmd in [
            "/usr/bin/npx",
            "./npx",
            "C:\\node\\npx",
            "npx;rm",
            "npx|sh",
            "npx$(id)",
            "npx`id`",
        ] {
            let mut c = context_mode();
            c.command = cmd.to_string();
            assert!(validate_server_config(&c).is_err(), "应拒绝启动命令：{cmd}");
        }
    }

    #[test]
    fn args_with_shell_meta_or_control_chars_rejected() {
        let mut c = context_mode();
        c.args = vec!["-y".into(), "x;curl y".into()];
        assert!(validate_server_config(&c).is_err());
        let mut c = context_mode();
        c.args = vec!["x\ny".into()];
        assert!(validate_server_config(&c).is_err());
    }

    #[test]
    fn secret_env_keys_rejected() {
        for key in ["API_KEY", "GITHUB_TOKEN", "MY_SECRET", "DB_PASSWORD", "AUTH_HEADER", "CREDENTIAL"] {
            let mut c = context_mode();
            c.env.insert(key.to_string(), "x".into());
            assert!(validate_server_config(&c).is_err(), "应拒绝环境变量：{key}");
        }
        let mut c = context_mode();
        c.env.insert("NODE_ENV".into(), "production".into());
        assert!(validate_server_config(&c).is_ok());
    }

    #[test]
    fn duplicate_server_names_rejected() {
        let c = McpConfigFile {
            servers: vec![context_mode(), context_mode()],
        };
        assert!(validate_config_file(&c).is_err());
    }

    #[test]
    fn parse_node_version_cases() {
        assert_eq!(parse_node_version("v24.15.0\n"), Some((24, 15, 0)));
        assert_eq!(parse_node_version("v22.1.0"), Some((22, 1, 0)));
        assert_eq!(parse_node_version("24.15"), Some((24, 15, 0)));
        assert_eq!(parse_node_version("garbage"), None);
        assert_eq!(parse_node_version(""), None);
        assert!((24, 15, 0) >= MCP_MIN_NODE);
        assert!((24, 14, 9) < MCP_MIN_NODE);
    }

    #[test]
    fn parse_tools_list_cases() {
        let ok = serde_json::json!({
            "tools": [
                {"name": "ctx_search", "description": "搜", "inputSchema": {"type": "object", "properties": {}}},
                {"name": "ctx_index", "description": "", "inputSchema": {"type": "object"}},
            ]
        });
        let tools = parse_tools_list(&ok).unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "ctx_search");
        assert_eq!(tools[0].input_schema["type"], "object");

        let no_tools = serde_json::json!({});
        assert!(parse_tools_list(&no_tools).is_err());

        let bad_name = serde_json::json!({"tools": [{"name": "bad name!", "inputSchema": {"type": "object"}}]});
        assert!(parse_tools_list(&bad_name).is_err());

        let bad_schema =
            serde_json::json!({"tools": [{"name": "x", "inputSchema": "not-an-object"}]});
        assert!(parse_tools_list(&bad_schema).is_err());
    }

    #[test]
    fn join_call_content_cases() {
        let r = serde_json::json!({"content": [
            {"type": "text", "text": "第一段"},
            {"type": "image", "data": "xxx"},
            {"type": "text", "text": "第二段"},
        ]});
        assert_eq!(
            join_call_content(&r),
            "第一段\n[非文本内容已省略]\n第二段"
        );
        assert_eq!(join_call_content(&serde_json::json!({})), "(空结果)");
        assert_eq!(
            join_call_content(&serde_json::json!({"content": []})),
            "(空结果)"
        );
    }

    #[test]
    fn truncate_chars_marks_truncation() {
        assert_eq!(truncate_chars("abc", 20), "abc");
        let long = "字".repeat(30);
        let out = truncate_chars(&long, 20);
        assert!(out.contains("工具输出已截断"));
        assert!(out.chars().count() < 30 + 40);
    }
}
