// 本机回环 HTTP/SSE 代理：WebView ⇄ Rust ⇄ 远端模型 prompted API
//
// 之所以自己实现而不是让前端直接 fetch 远端：
// - Tauri 的 CSP/CORS 对跨源请求有限制，各家模型厂商对浏览器 Origin 的支持也不一致；
// - 由 Rust 统一转发后，任何 OpenAI 兼容端点都能接，且不用把 Key 暴露给 WebView 的网络栈之外的任何东西。
//
// 仅监听 127.0.0.1，并要求每次请求携带启动时生成的一次性 token，避免本机其它进程误用。

use std::collections::HashMap;
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

pub struct ProxyInfo {
    pub port: u16,
    pub token: String,
}

/// 生成一个仅本次运行有效的访问令牌（时间 + pid 混合哈希，不引入 rand 依赖）。
fn gen_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mut x = nanos ^ (pid.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    // xorshift 打散，避免低位的规律性
    x ^= x >> 33;
    x = x.wrapping_mul(0xFF51_AF7B);
    x ^= x >> 33;
    format!("{:016x}", x)
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

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn handle_conn(mut socket: TcpStream, token: std::sync::Arc<String>) -> Result<(), String> {
    let req = match read_request(&mut socket).await {
        Ok(Some(r)) => r,
        Ok(None) => return Ok(()),
        Err(e) => {
            write_json(&mut socket, 400, &serde_json::json!({ "error": e })).await?;
            return Ok(());
        }
    };

    // 预检请求
    if req.method == "OPTIONS" {
        write_cors(&mut socket, 204, "text/plain", "").await?;
        return Ok(());
    }

    // 令牌校验
    match req.headers.get("x-zxz-token") {
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

    let path = req.path.split('?').next().unwrap_or("/").to_string();
    let query = parse_query(&req.path);

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

        ("GET", "/models") => {
            let base_url = query.get("base_url").cloned().unwrap_or_default();
            let api_key = query.get("api_key").cloned().unwrap_or_default();
            let res = api::list_models(base_url, api_key).await;
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

/// 读取一个完整的 HTTP 请求（头 + Content-Length 指定的 body）。
async fn read_request(socket: &mut TcpStream) -> Result<Option<Request>, String> {
    let mut buf = Vec::with_capacity(2048);

    // 读到头部结束标记
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

    let mut body = rest;
    if let Some(len) = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        while body.len() < len {
            let mut chunk = vec![0u8; 8192];
            let n = socket.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
        body.truncate(len);
    }

    Ok(Some(Request {
        method,
        path,
        headers,
        body,
    }))
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_query(path: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some((_, q)) = path.split_once('?') {
        for pair in q.split('&') {
            if pair.is_empty() {
                continue;
            }
            if let Some((k, v)) = pair.split_once('=') {
                map.insert(k.to_string(), url_decode(v));
            } else {
                map.insert(pair.to_string(), String::new());
            }
        }
    }
    map
}

/// 极简 percent-decoding，够用于 base_url / api_key 这类参数。
fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                    out.push(h * 16 + l);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}
