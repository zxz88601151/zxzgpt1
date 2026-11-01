#!/usr/bin/env node
/* 用真实 Rust 本机代理跑前端 E2E
 *
 * 做两件事：
 *   1) 直接对代理打接口，校验 token 鉴权 / 预检 / 未知路由；
 *   2) 拉起 smoke 示例，把端口与 token 注入 __TAURI_INTERNALS__，
 *      让前端走「本地代理」通道，跑完整交互用例。
 *
 *   node tools/proxy-e2e.js [smoke 可执行文件路径]
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

/** 依次尝试：命令行入参 → tauri 版 smoke 示例 → 免 tauri 的 harness */
function resolveSmoke() {
  if (process.argv[2]) return process.argv[2];
  const root = path.join(__dirname, '..');
  const candidates = [
    path.join(root, 'tools', 'proxy-harness', 'target-gnu', 'debug', 'proxy-harness.exe'),
    path.join(root, 'tools', 'proxy-harness', 'target', 'debug', 'proxy-harness.exe'),
    path.join(root, 'src-tauri', 'target-gnu', 'debug', 'examples', 'smoke.exe'),
    path.join(root, 'src-tauri', 'target', 'debug', 'examples', 'smoke.exe'),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    console.error('找不到代理可执行文件，请先执行：\n  cd tools/proxy-harness && cargo build\n或\n  cd src-tauri && cargo build --example smoke');
    process.exit(2);
  }
  return hit;
}

const SMOKE = resolveSmoke();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function req(port, method, p, headers = {}, body) {
  const h = { ...headers };
  // 代理按 Content-Length 读 body（不解析 chunked），这里必须显式给出长度
  if (body) h['Content-Length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  console.log('启动 Rust 本机代理：' + SMOKE);
  const child = spawn(SMOKE, [], { stdio: ['ignore', 'pipe', 'pipe'] });

  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('代理启动超时：' + buf)), 20000);
    child.stdout.on('data', (c) => {
      buf += c.toString();
      const port = /PORT=(\d+)/.exec(buf);
      const token = /TOKEN=(\w+)/.exec(buf);
      if (port && token) {
        clearTimeout(timer);
        resolve({ port: Number(port[1]), token: token[1] });
      }
    });
    child.stderr.on('data', (c) => process.stderr.write('[smoke] ' + c.toString()));
    child.on('exit', (code) => reject(new Error('代理进程提前退出 code=' + code + '\n' + buf)));
  });
  console.log(`代理已就绪：127.0.0.1:${info.port}，token=${info.token.slice(0, 6)}…`);

  // 1 探活
  const health = await req(info.port, 'GET', '/health', { 'x-zxz-token': info.token });
  check('代理 /health', health.status === 200 && health.body.includes('"ok"'), health.body.trim());

  // 2 无 token 必须 401
  const noTok = await req(info.port, 'GET', '/health');
  check('无 token 请求被拒（401）', noTok.status === 401, noTok.body.trim());

  // 3 错误 token 同样 401
  const badTok = await req(info.port, 'GET', '/health', { 'x-zxz-token': 'deadbeef' });
  check('错误 token 被拒（401）', badTok.status === 401);

  // 4 CORS 预检
  const pre = await req(info.port, 'OPTIONS', '/chat', {
    Origin: 'http://127.0.0.1:5173',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-zxz-token',
  });
  check(
    'CORS 预检（204 + Allow-Origin）',
    pre.status === 204 && pre.headers['access-control-allow-origin'] === '*',
    `status=${pre.status}`
  );

  // 5 未知路由
  const notFound = await req(info.port, 'GET', '/nope', { 'x-zxz-token': info.token });
  check('未知路由返回 404', notFound.status === 404);

  // 5b 非回环 Host 被拒（DNS rebinding 加固）
  const badHost = await req(info.port, 'GET', '/health', { 'x-zxz-token': info.token, Host: 'evil.example.com' });
  check('非回环 Host 被拒（403）', badHost.status === 403, `status=${badHost.status}`);

  // 6 模型列表转发（base_url / api_key 走请求体，不再进 URL）
  const modelsBody = JSON.stringify({
    base_url: 'http://127.0.0.1:19888/v1',
    api_key: 'mock-key',
  });
  const models = await req(
    info.port,
    'POST',
    '/models',
    { 'Content-Type': 'application/json', 'x-zxz-token': info.token },
    modelsBody
  );
  const modelJson = JSON.parse(models.body || '{}');
  check('代理转发 /models', modelJson.ok === true && (modelJson.models || []).length === 4, models.body.slice(0, 80));

  // 6b 超大请求体在读 body 前就被 Content-Length 上限拒绝（400）
  // 故意声明一个远超 32MB 的长度但不真发数据：代理应在解析头阶段直接拒绝。
  const huge = await req(info.port, 'POST', '/chat', {
    'Content-Type': 'application/json',
    'x-zxz-token': info.token,
    'Content-Length': String(64 * 1024 * 1024),
  }, undefined);
  check('超大请求体被拒（400）', huge.status === 400, `status=${huge.status}`);

  // 7 非流式对话转发（含 usage）
  const chatBody = JSON.stringify({
    base_url: 'http://127.0.0.1:19888/v1',
    api_key: 'mock-key',
    model: 'mock-gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  });
  const chat = await req(info.port, 'POST', '/chat', { 'Content-Type': 'application/json', 'x-zxz-token': info.token }, chatBody);
  check(
    '代理非流式对话（delta + usage + done）',
    chat.body.includes('"type":"delta"') && chat.body.includes('"type":"usage"') && chat.body.includes('"type":"done"')
  );

  // 8 上游 401 被翻译成 error 事件
  const errBody = JSON.stringify({
    base_url: 'http://127.0.0.1:19888/v1',
    api_key: 'mock-key',
    model: 'bad-key',
    messages: [{ role: 'user', content: 'x' }],
    stream: true,
  });
  const errChat = await req(info.port, 'POST', '/chat', { 'Content-Type': 'application/json', 'x-zxz-token': info.token }, errBody);
  check('上游 401 翻译为 error 事件', /"type":"error"/.test(errChat.body) && /401/.test(errChat.body), errChat.body.slice(0, 90));

  // 9 前端走代理通道跑完整用例
  const e2e = spawn(process.execPath, [path.join(__dirname, 'e2e.cjs')], {
    env: { ...process.env, MODE: 'proxy', PROXY_PORT: String(info.port), PROXY_TOKEN: info.token },
    stdio: 'inherit',
  });
  const e2eCode = await new Promise((r) => e2e.on('exit', r));

  child.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n代理接口 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}；前端 E2E 退出码 ${e2eCode}`);
  process.exit(failed || e2eCode ? 1 : 0);
})().catch((e) => {
  console.error('代理 E2E 失败：', e.message);
  process.exit(2);
});
