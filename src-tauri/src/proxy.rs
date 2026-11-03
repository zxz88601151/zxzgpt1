// 本机回环 HTTP/SSE 代理：WebView ⇄ Rust ⇄ 远端模型 prompted API
//
// 之所以自己实现而不是让前端直接 fetch 远端：
// - Tauri 的 CSP/CORS 对跨源请求有限制，各家模型厂商对浏览器 Origin 的支持也不一致；
// - 由 Rust 统一转发后，任何 OpenAI 兼容端点都能接，且不用把 Key 暴露给 WebView 的网络栈之外的任何东西。
//
// 仅监听 127.0.0.1，并要求每次请求携带启动时生成的一次性令牌，避免本机其它进程误用；
// 另校验 Host 必须是回环名，挡住把外部域名解析到 127.0.0.1 的 DNS rebinding。

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::async_runtime;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::api;

/// 起始端口，被占用则顺延，最多尝试 64 个。
const BASE_PORT: u16 = 19527;
const MAX_TRIES: u16 = 64;
/// 单次请求头上限，防止恶意超长头打满内存。
const MAX_HEAD_BYTES: usize = 64 * 1024;
/// 单次请求体上限：对话消息里会夹带文件内容，给到 32MB 足够，
/// 再大就拒绝——否则本机任意进程可用一个超大 Content-Length 把内存打满。
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

pub struct ProxyInfo {
    pub port: u16,
    pub token: String,
}

/// 生成一个仅本次运行有效的访问令牌。
///
/// 只靠「时间 ^ pid」是可预测的：本机进程能看到进程启动的大致时刻与 pid，
/// 就能把令牌算出来。这里改用 `RandomState` 的哈希键——它由操作系统熵初始化
/// （不必引入 rand 依赖），再混入时钟与 pid 拉开不同实例，拼出 256 位令牌。
fn gen_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let mut out = String::with_capacity(64);
    for i in 0u64..4 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(nanos);
        h.write_u32(pid);
        h.write_u64(i);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// 探测一个可用端口（先同步 bind 试占用，成功后立即释放）。
fn pick_port() -> Option<u16> {
    for offset in 0..MAX_TRIES {
        let port = BASE_PORT + offset;
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

/// 启动代理服务，异步跑起来后立刻返回端口信息（不阻塞主线程）。
pub fn spawn() -> ProxyInfo {
    let port = pick_port().unwrap_or(BASE_PORT);
    let token = gen_token();

    let tok = token.clone();
    async_runtime::spawn(async move {
        if let Err(e) = serve(port, tok).await {
            eprintln!("[zxz] 代理服务异常：{}", e);
        }
    });

    ProxyInfo { port, token }
}

async fn serve(port: u16, token: String) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("绑定 127.0.0.1:{} 失败：{}", port, e))?;
    println!("[zxz] 本地代理已就绪：http://127.0.0.1:{}", port);

    let share: std::sync::Arc<String> = std::sync::Arc::new(token);
    loop {
        let (socket, _) = match listener.accept().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let tok = share.clone();
        async_runtime::spawn(async move {
            if let Err(e) = handle_conn(socket, tok).await {
                eprintln!("[zxz] 连接处理失败：{}", e);
            }
        });
    }
}

// ---------------------------------------------------------------- 请求/响应

/// 已经通过鉴权的请求。`headers` 不在这里——Host / token 在 `RequestHead` 阶段
/// 就校验完了，后面按路由分发只看 method / path / body，留着它只会变成死字段。
struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

/// `/models` 请求体：只带 base_url 与 api_key，走 body 不进 URL。
#[derive(serde::Deserialize)]
struct ModelsRequest {
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
}

/// 只接受指向本机回环的 Host：挡住 DNS rebinding——外部页面把某域名解析到
/// 127.0.0.1 后，浏览器仍会带上原站点的 Host，据此可拒。一次性 token 才是主门槛，
/// 这层是加固。
fn host_is_loopback(headers: &HashMap<String, String>) -> bool {
    let Some(host) = headers.get("host") else {
        return false;
    };
    let name = host.split(':').next().unwrap_or("").trim().to_ascii_lowercase();
    name == "127.0.0.1" || name == "localhost"
}

async fn handle_conn(mut socket: TcpStream, token: std::sync::Arc<String>) -> Result<(), String> {
    // 只先读头：鉴权要看的东西全在头里。把 body 留到鉴权之后读，
    // 否则一个没 token 的请求也能让代理先收下 32MB——校验再准也没意义了。
    let head = match read_head(&mut socket).await {
        Ok(Some(h)) => h,
        Ok(None) => return Ok(()),
        Err(e) => {
            write_json(&mut socket, 400, &serde_json::json!({ "error": e })).await?;
            return Ok(());
        }
    };

    // Host 校验先于预检与令牌：非回环 Host 一律不服务。
    if !host_is_loopback(&head.headers) {
        write_json(
            &mut socket,
            403,
            &serde_json::json!({ "error": "只接受本机回环 Host" }),
        )
        .await?;
        return Ok(());
    }

    // 预检请求：没有 body，直接回
    if head.method == "OPTIONS" {
        write_cors(&mut socket, 204, "text/plain", "").await?;
        return Ok(());
    }

    // 令牌校验（仍在读 body 之前）
    match head.headers.get("x-zxz-token") {
        Some(v) if v == token.as_str() => {}
        _ => {
            write_json(
                &mut socket,
                401,
                &serde_json::json!({ "error": "无效的本地访问令牌" }),
            )
            .await?;
            return Ok(());
        }
    }

    // 到这里才认这个请求，也才去读它的 body
    let RequestHead { method, path, headers, rest } = head;
    let body = match read_body(&mut socket, &headers, rest).await {
        Ok(b) => b,
        Err(e) => {
            write_json(&mut socket, 400, &serde_json::json!({ "error": e })).await?;
            return Ok(());
        }
    };
    let req = Request { method, path, body };

    let path = req.path.split('?').next().unwrap_or("/").to_string();

    match (req.method.as_str(), path.as_str()) {
        ("GET", "/health") => {
            write_json(
                &mut socket,
                200,
                &serde_json::json!({ "status": "ok", "service": "zxz" }),
            )
            .await?
        }

        ("POST", "/chat") => {
            let payload: api::ChatRequest = match serde_json::from_slice(&req.body) {
                Ok(v) => v,
                Err(e) => {
                    write_json(
                        &mut socket,
                        400,
                        &serde_json::json!({ "error": format!("请求体不是合法 JSON：{}", e) }),
                    )
                    .await?;
                    return Ok(());
                }
            };
            handle_chat(&mut socket, payload).await?;
        }

        ("POST", "/test") => {
            let payload: api::ChatRequest = match serde_json::from_slice(&req.body) {
                Ok(v) => v,
                Err(e) => {
                    write_json(
                        &mut socket,
                        400,
                        &serde_json::json!({ "error": format!("请求体不是合法 JSON：{}", e) }),
                    )
                    .await?;
                    return Ok(());
                }
            };
            let res = api::test_connection(payload).await;
            write_json(&mut socket, 200, &res).await?;
        }

        ("POST", "/models") => {
            // base_url / api_key 走请求体而不是 URL：一次性令牌请求行/访问日志里
            // 不该留明文 Key，本机其它进程若能读网络连接也不该看到它。
            let payload: ModelsRequest = match serde_json::from_slice(&req.body) {
                Ok(v) => v,
                Err(e) => {
                    write_json(
                        &mut socket,
                        400,
                        &serde_json::json!({ "error": format!("请求体不是合法 JSON：{}", e) }),
                    )
                    .await?;
                    return Ok(());
                }
            };
            let res = api::list_models(payload.base_url, payload.api_key).await;
            write_json(&mut socket, 200, &res).await?;
        }

        _ => {
            write_json(
                &mut socket,
                404,
                &serde_json::json!({ "error": format!("未知路由 {} {}", req.method, path) }),
            )
            .await?
        }
    }

    Ok(())
}

/// 流式对话：先把 SSE 响应头写出去，再一边读远端一边把分片推给前端。
async fn handle_chat(socket: &mut TcpStream, payload: api::ChatRequest) -> Result<(), String> {
    let head = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/event-stream; charset=utf-8\r\n",
        "Cache-Control: no-cache\r\n",
        "Connection: keep-alive\r\n",
        "X-Accel-Buffering: no\r\n",
        "Access-Control-Allow-Origin: *\r\n",
        "Access-Control-Allow-Headers: Content-Type, X-ZXZ-Token\r\n",
        "\r\n"
    );
    socket
        .write_all(head.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    socket.flush().await.map_err(|e| e.to_string())?;

    let (tx, mut rx) = mpsc::channel::<Option<String>>(64);

    // 读取远端流，转换成统一事件：{type: delta|reasoning|usage|error|done, ...}
    async_runtime::spawn(async move {
        if let Err(e) = api::stream_chat(payload, tx.clone()).await {
            let _ = tx
                .send(Some(
                    serde_json::json!({ "type": "error", "message": e }).to_string(),
                ))
                .await;
        }
        let _ = tx.send(Some(serde_json::json!({ "type": "done" }).to_string())).await;
        // 结束哨兵，让下面的读取循环退出
        let _ = tx.send(None).await;
    });

    while let Some(item) = rx.recv().await {
        match item {
            Some(json) => {
                socket
                    .write_all(format!("data: {}\n\n", json).as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                socket.flush().await.map_err(|e| e.to_string())?;
            }
            None => break,
        }
    }

    Ok(())
}

async fn write_json(socket: &mut TcpStream, status: u16, body: &serde_json::Value) -> Result<(), String> {
    let text = body.to_string();
    write_cors(socket, status, "application/json; charset=utf-8", &text).await
}

async fn write_cors(socket: &mut TcpStream, status: u16, content_type: &str, body: &str) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let len = body.as_bytes().len();
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, X-ZXZ-Token\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\n\r\n",
        status, reason, content_type, len
    );
    socket
        .write_all(head.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    if len > 0 {
        socket
            .write_all(body.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }
    socket.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- HTTP 解析

/// 读到的请求头（尚未读 body）。`rest` 是「头之后已经跟着读到的那部分字节」。
struct RequestHead {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    rest: Vec<u8>,
}

/// 读请求头，读到 `\r\n\r\n` 为止就返回——**不碰 body**。
///
/// 拆开这一步是为了让鉴权发生在读 body 之前：头里已经有 Host 和 token，
/// 没通过就不该让对端把 32MB 塞进来。合在一起读的话，校验再严也只是
/// "收完再拒"，内存已经被对方牵着走了。
async fn read_head(socket: &mut TcpStream) -> Result<Option<RequestHead>, String> {
    let mut buf = Vec::with_capacity(2048);

    let head_end = loop {
        let mut chunk = [0u8; 1024];
        let n = socket.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return if buf.is_empty() { Ok(None) } else { Err("连接被提前关闭".into()) };
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_head_end(&buf) {
            break pos;
        }
        if buf.len() > MAX_HEAD_BYTES {
            return Err("请求头过大".into());
        }
    };

    let head_text = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let rest = buf[head_end + 4..].to_vec();

    let mut lines = head_text.lines();
    let request_line = lines.next().unwrap_or("").to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let path = parts.next().unwrap_or("/").to_string();

    let mut headers: HashMap<String, String> = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_lowercase(), v.trim().to_string());
        }
    }

    Ok(Some(RequestHead { method, path, headers, rest }))
}

/// 按 Content-Length 读完 body。调用点必须在鉴权之后。
async fn read_body(
    socket: &mut TcpStream,
    headers: &HashMap<String, String>,
    rest: Vec<u8>,
) -> Result<Vec<u8>, String> {
    // 先把 Content-Length 卡在上限内：读 body 之前就拒绝，避免按一个超大
    // 声明长度预留/累积内存，把本机内存打满。
    if let Some(len) = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        if len > MAX_BODY_BYTES {
            return Err(format!("请求体 {} 字节超过上限 {}，已拒绝", len, MAX_BODY_BYTES));
        }
        let mut body = rest;
        while body.len() < len {
            let mut chunk = vec![0u8; 8192];
            let n = socket.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
            if body.len() > MAX_BODY_BYTES {
                return Err("请求体超过上限，已拒绝".into());
            }
        }
        body.truncate(len);
        return Ok(body);
    }
    Ok(rest)
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}
