// 链路自检：不启动窗口，只拉起本地代理，配合 examples/README 的 curl 命令验证
// Rust ⇄ 上游模型的 SSE 转发是否正常。
//
//   cargo run --example smoke
//
// 输出形如：PORT=19527 TOKEN=xxxxxxxx
// 随后另开终端：
//   curl -H "x-zxz-token: $TOKEN" http://127.0.0.1:$PORT/health
//   curl -N -H "Content-Type: application/json" -H "x-zxz-token: $TOKEN" \
//        -d '{"base_url":"http://127.0.0.1:19888/v1","api_key":"mock-key","model":"mock-gpt",
//             "messages":[{"role":"user","content":"hi"}],"stream":true}' \
//        http://127.0.0.1:$PORT/chat

fn main() {
    let info = zxz_lib::spawn_proxy();
    println!("PORT={}", info.port);
    println!("TOKEN={}", info.token);
    println!("代理已就绪，按 Ctrl+C 退出");
    std::thread::park();
}
