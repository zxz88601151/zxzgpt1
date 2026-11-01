// OpenAI 兼容接口客户端：流式推理 + 连接测试 + 模型列表
//
// 统一的内部事件格式（发给前端的每一个 SSE data）：
//   {"type":"delta",     "text":"..."}          正文增量
//   {"type":"reasoning", "text":"..."}          思维链增量（DeepSeek-reasoner / o 系列等）
//   {"type":"usage",     "usage":{...}}         token 用量（厂商返回时才有）
//   {"type":"error",     "message":"..."}       错误
//   {"type":"done"}                             正常结束

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::mpsc::Sender;

#[derive(Debug, Clone, Deserialize)]
pub struct ChatRequest {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    // 注意：这里故意用 Value 而不是 ChatMessage。工具调用轮次的消息里有
    // assistant 的 tool_calls 数组和 role=tool 的消息，写死成 {role, content}
    // 会把它们丢掉，下一轮模型就对不上“调了什么、结果是什么”。
    pub messages: Vec<Value>,
    #[serde(default)]
    pub tools: Option<Value>,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default = "default_true")]
    pub stream: bool,
}

fn default_temperature() -> f64 {
    0.7
}
fn default_true() -> bool {
    true
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // 不设置整体超时：长推理模型可能数分钟才有首个 token
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{}", e))
}

/// 去掉 base_url 尾部多余的斜杠。
fn normalize_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        "https://api.openai.com/v1".to_string()
    } else {
        trimmed
    }
}

fn request_builder(client: &reqwest::Client, url: &str, api_key: &str) -> reqwest::RequestBuilder {
    let mut rb = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");
    let key = api_key.trim();
    if !key.is_empty() {
        rb = rb.bearer_auth(key);
    }
    rb
}

/// 把上游错误体整理成人话返回。
fn describe_upstream(status: reqwest::StatusCode, text: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(text).ok();
    let detail = parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .and_then(|e| {
            e.get("message")
                .or_else(|| e.get("msg"))
                .or_else(|| e.get("code"))
        })
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    match detail {
        Some(d) => format!("上游返回 {}：{}", status.as_u16(), truncate(&d, 500)),
        None => format!(
            "上游返回 {}：{}",
            status.as_u16(),
            truncate(text, 500)
        ),
    }
}

fn truncate(s: &str, max: usize) -> &str {
    if s.chars().count() <= max {
        s
    } else {
        let end = s.char_indices().nth(max).map(|(i, _)| i).unwrap_or(s.len());
        &s[..end]
    }
}

// ------------------------------------------------------------------ 流式对话

/// 读取远端 SSE，逐条转成内部事件推给 tx。调用方负责在结束后补 done。
pub async fn stream_chat(req: ChatRequest, tx: Sender<Option<String>>) -> Result<(), String> {
    if !req.stream {
        return chat_once(req, tx).await;
    }

    let client = http_client()?;
    let url = format!("{}/chat/completions", normalize_base(&req.base_url));

    let mut body = json!({
        "model": req.model,
        "messages": req.messages,
        "temperature": req.temperature,
        "stream": true,
    });
    if let Some(mt) = req.max_tokens {
        body["max_tokens"] = json!(mt);
    }
    if let Some(tools) = req.tools {
        body["tools"] = tools;
        body["tool_choice"] = json!("auto");
    }

    let resp = request_builder(&client, &url, &req.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连接失败：{}", friendly_reqwest_error(&e)))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(describe_upstream(status, &text));
    }

    let mut stream = resp.bytes_stream();
    let mut raw = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => return Err(format!("读取响应中断：{}", e)),
        };
        raw.push_str(&String::from_utf8_lossy(&bytes));

        // 逐行消费，保留未完成的行
        while let Some(pos) = raw.find('\n') {
            let mut line = raw[..pos].to_string();
            raw = raw[pos + 1..].to_string();
            if line.ends_with('\r') {
                line.pop();
            }
            for evt in parse_sse_line(&line) {
                if tx.send(Some(evt)).await.is_err() {
                    return Ok(());
                }
            }
        }
    }

    // 部分实现不以换行结尾，收尾处理一次
    if !raw.trim().is_empty() {
        for evt in parse_sse_line(raw.trim()) {
            let _ = tx.send(Some(evt)).await;
        }
    }

    Ok(())
}

/// 非流式：一次性返回整段内容。
async fn chat_once(req: ChatRequest, tx: Sender<Option<String>>) -> Result<(), String> {
    let client = http_client()?;
    let url = format!("{}/chat/completions", normalize_base(&req.base_url));

    let mut body = json!({
        "model": req.model,
        "messages": req.messages,
        "temperature": req.temperature,
        "stream": false,
    });
    if let Some(mt) = req.max_tokens {
        body["max_tokens"] = json!(mt);
    }
    if let Some(tools) = req.tools {
        body["tools"] = tools;
        body["tool_choice"] = json!("auto");
    }

    let resp = request_builder(&client, &url, &req.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连接失败：{}", friendly_reqwest_error(&e)))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(describe_upstream(status, &text));
    }

    let value: Value = serde_json::from_str(&text)
        .map_err(|e| format!("响应解析失败：{}（原文前 200 字：{}）", e, truncate(&text, 200)))?;

    if let Some(err) = value.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("未知上游错误");
        return Err(msg.to_string());
    }

    let choice = value
        .get("choices")
        .and_then(|c| c.get(0))
        .ok_or_else(|| "上游返回中没有 choices".to_string())?;

    if let Some(r) = choice
        .get("message")
        .and_then(|m| m.get("reasoning_content"))
        .and_then(|r| r.as_str())
        .filter(|s| !s.is_empty())
    {
        let _ = tx
            .send(Some(json!({ "type": "reasoning", "text": r }).to_string()))
            .await;
    }

    let content = choice
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string();

    let _ = tx
        .send(Some(json!({ "type": "delta", "text": content }).to_string()))
        .await;

    // 非流式工具调用：一次性把完整调用列表发给前端，前端按 id 执行后回传。
    if let Some(calls) = choice
        .get("message")
        .and_then(|m| m.get("tool_calls"))
        .and_then(|c| c.as_array())
    {
        let out: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let id = c
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("call_{i}"));
                json!({
                    "id": id,
                    "name": c.get("function").and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
                    "arguments": c.get("function").and_then(|f| f.get("arguments")).and_then(|v| v.as_str()).unwrap_or(""),
                })
            })
            .collect();
        if !out.is_empty() {
            let _ = tx
                .send(Some(json!({ "type": "tool_calls", "calls": out }).to_string()))
                .await;
        }
    }

    if let Some(usage) = value.get("usage") {
        let _ = tx
            .send(Some(json!({ "type": "usage", "usage": usage }).to_string()))
            .await;
    }

    Ok(())
}

/// 解析 SSE 的一行 data，产出统一事件（可能多个：正文 + 工具调用增量）。
/// 以前只返回一个事件，同一行里同时有 content 和 tool_calls 时工具调用会被丢掉；
/// 现在返回 Vec，调用方逐个转发。tool_call_delta 只带原始增量片，前端按 index
/// 累计 arguments，流结束时再合成完整调用——Rust 侧不拼 JSON，避免半截参数。
fn parse_sse_line(line: &str) -> Vec<String> {
    let rest = match line.split_once(':') {
        Some((field, rest)) if field == "data" => rest.trim(),
        _ => return Vec::new(),
    };
    if rest.is_empty() || rest == "[DONE]" {
        return Vec::new();
    }

    let value: Value = match serde_json::from_str(rest) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    if let Some(err) = value.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("上游返回错误")
            .to_string();
        return vec![json!({ "type": "error", "message": msg }).to_string()];
    }

    let mut out: Vec<String> = Vec::new();
    if let Some(usage) = value.get("usage") {
        if usage.is_object() {
            out.push(json!({ "type": "usage", "usage": usage }).to_string());
        }
    }

    let delta = value
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"))
        .cloned();

    if let Some(delta) = delta {
        if let Some(r) = delta.get("reasoning_content").and_then(|r| r.as_str()) {
            if !r.is_empty() {
                out.push(json!({ "type": "reasoning", "text": r }).to_string());
            }
        }
        if let Some(c) = delta.get("content").and_then(|c| c.as_str()) {
            if !c.is_empty() {
                out.push(json!({ "type": "delta", "text": c }).to_string());
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
            for (i, tc) in calls.iter().enumerate() {
                let mut evt = json!({ "type": "tool_call_delta", "index": i });
                if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                    evt["id"] = json!(id);
                }
                if let Some(name) = tc.get("function").and_then(|f| f.get("name")).and_then(|v| v.as_str()) {
                    evt["name"] = json!(name);
                }
                if let Some(args) = tc.get("function").and_then(|f| f.get("arguments")).and_then(|v| v.as_str()) {
                    evt["arguments"] = json!(args);
                }
                // 流式里 index 字段优先于数组位置：上游给 index 时用它，否则用位置。
                if let Some(idx) = tc.get("index").and_then(|v| v.as_u64()) {
                    evt["index"] = json!(idx);
                }
                out.push(evt.to_string());
            }
        }
    }

    out
}

// ------------------------------------------------------------------ 辅助接口

/// 连接测试：发一条极短请求验证 base_url / key / model 三件套是否可用。
pub async fn test_connection(req: ChatRequest) -> Value {
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "message": e }),
    };
    let url = format!("{}/chat/completions", normalize_base(&req.base_url));
    let body = json!({
        "model": req.model,
        "messages": [
            { "role": "user", "content": "hi" }
        ],
        "max_tokens": 1,
        "stream": false,
    });

    let mut rb = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(30));
    if !req.api_key.trim().is_empty() {
        rb = rb.bearer_auth(req.api_key.trim());
    }

    match rb.send().await {
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if status.is_success() {
                json!({ "ok": true, "message": "连接正常，模型可用" })
            } else {
                json!({ "ok": false, "message": describe_upstream(status, &text) })
            }
        }
        Err(e) => json!({
            "ok": false,
            "message": format!("连接失败：{}", friendly_reqwest_error(&e))
        }),
    }
}

/// 拉取模型列表（可选能力，失败不影响对话）。
pub async fn list_models(base_url: String, api_key: String) -> Value {
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "message": e, "models": [] }),
    };
    let url = format!("{}/models", normalize_base(&base_url));
    let mut rb = client.get(&url);
    if !api_key.trim().is_empty() {
        rb = rb.bearer_auth(api_key.trim());
    }

    match rb.timeout(Duration::from_secs(30)).send().await {
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return json!({
                    "ok": false,
                    "message": describe_upstream(status, &text),
                    "models": []
                });
            }
            let ids: Vec<String> = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("data").cloned())
                .and_then(|d| d.as_array().cloned())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            json!({ "ok": true, "models": ids })
        }
        Err(e) => json!({
            "ok": false,
            "message": format!("连接失败：{}", friendly_reqwest_error(&e)),
            "models": []
        }),
    }
}

/// 把 reqwest 的底层错误翻译成能看懂的中文提示。
fn friendly_reqwest_error(e: &reqwest::Error) -> String {
    if e.is_connect() {
        format!("无法建立连接（{}）—— 请检查 Base URL、网络或代理设置", e)
    } else if e.is_timeout() {
        "请求超时，请稍后重试".to_string()
    } else if e.is_body() || e.is_decode() {
        format!("响应体解析失败：{}", e)
    } else if e.is_request() {
        format!("请求构造失败：{}", e)
    } else {
        e.to_string()
    }
}
