#!/usr/bin/env node
/* zxz 模拟上游：一个最小 OpenAI 兼容服务，用于在没有 API Key 的情况下跑通全链路。
 *
 * 覆盖的行为：
 *   GET  /v1/models              模型列表
 *   GET  /_last                  最近一次请求体（供测试断言实际发出去的上下文）
 *   POST /v1/chat/completions    流式 SSE / 非流式 JSON / 思维链 / usage / 各类错误
 *
 * 触发开关（写在 model 或消息里）：
 *   model = bad-key         → 401 invalid_api_key
 *   model = unknown-model   → 404 model_not_found
 *   model = reasoner-mock   → 先返回 reasoning_content，再返回正文
 *   消息含 [[slow]]          → 每个分片间隔 300ms，便于测中断
 *   消息含 [[long]]          → 返回长文本（12 段），便于测滚动
 *   消息含 [[files]]         → 返回 4 个 file: 代码块（本地工程模式自动落盘）
 *   消息含 [[badpath]]       → 返回 2 个越权路径 + 1 个合法路径
 *   消息含 [[read]]          → 先回 @@read: src/old.js；收到程序回传的 <<<FILE 后再给改写后的文件
 *   消息含 [[ref]]           → 先回 @@ref: ext-skill/refs/detail.md；收到回传后再给最终回答
 *
 *   node tools/mock-upstream.cjs [端口，默认 19888]
 */
'use strict';

const http = require('http');

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 19888);
const MODELS = ['mock-gpt-4o', 'mock-gpt-4o-mini', 'reasoner-mock', 'unknown-model'];

const REASONING = [
  '先确认用户想要什么：他想要一份能验证渲染能力的回答。\n',
  '于是准备一段包含标题、列表、表格、代码块、引用和链接的 Markdown。\n',
  '最后检查一下分片边界不要切断多字节字符。\n',
];

const ANSWER = `# 模拟回答

这是 **zxz** 在本地模拟上游下的回复，用来验证渲染链路，**不消耗任何真实 token**。行内代码 \`npm run dev\`，链接 [Tauri](https://tauri.app)。

## 要点

- 第一层要点
  - 嵌套的子要点
  - 另一个子要点
- 第二条要点，带 ~~删除线~~ 与 *斜体*

1. 有序一
2. 有序二

> 引用块：所有请求都由你配置的端点返回，zxz 只是外壳。

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 流式输出 | PASS | SSE 增量渲染 |
| 思维链 | PASS | reasoning_content 折叠 |
| Markdown | PASS | 表格 / 列表 / 代码 |

\`\`\`js
// 代码高亮自检
const answer = 42;
function greet(name) {
  return \`hello \${name}\`; // 模板字符串
}
\`\`\`
`;

/** 长文本：结构与 ANSWER 一致，再加 12 段，用于验证滚动与分段渲染 */
const LONG =
  ANSWER +
  '\n' +
  Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return `### 补充段落 ${n}

第 ${n} 段说明。这里放一些足够长的句子，让一屏放不下，用来验证滚动时是否跟到底部，以及渲染长文本时不会把上一条消息冲掉。`;
  }).join('\n\n') +
  '\n';

/** 本地工程模式：4 个文件的完整内容，程序会自动写进所选目录 */
const FILES = `这是一个最小可运行的静态页面工程，四个文件都写好了。

\`\`\`file:index.html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>本地工程</title>
    <link rel="stylesheet" href="src/style.css" />
  </head>
  <body>
    <h1>你好，本地工程</h1>
    <p>这个文件由 zxz 直接写进你选的目录。</p>
    <script type="module" src="src/main.js"></script>
  </body>
</html>
\`\`\`

\`\`\`file:src/style.css
:root {
  color-scheme: dark;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #0d0e11;
  color: #e8e9ec;
}

h1 {
  font-size: 32px;
  letter-spacing: 0.5px;
}
\`\`\`

\`\`\`file:src/main.js
const heading = document.querySelector("h1");

export function boot() {
  if (!heading) return;
  heading.addEventListener("click", () => {
    heading.textContent = "又被点了一下";
  });
}

boot();
\`\`\`

\`\`\`file:README.md
# 本地工程示例

由 zxz 生成的静态页面，直接用浏览器打开 \`index.html\` 即可。

- 无构建步骤
- 无外部依赖
\`\`\`
`;

/** 含非法路径的回复：越权与盘符应当被拦下 */
const BADPATHS = `我试着写到工程外面（应该被拦住）：

\`\`\`file:../evil.txt
should not be written
\`\`\`

\`\`\`file:C:/Windows/evil.txt
should not be written either
\`\`\`

\`\`\`file:ok/safe.txt
this one is fine
\`\`\``;

/** 读文件协议第一轮：只是要看文件，不改代码 */
const READ_ASK = `改之前先看一眼现有的 src/old.js，别把已有逻辑写没了。

@@read: src/old.js`;

/** 读文件协议第二轮：程序已把真实内容回传（消息里带 <<<FILE 标记），这时才动笔 */
const READ_DONE = `看过了，原来的实现里有一个 \`legacyInit\` 函数。我把它改成带导出与兜底判断的版本：

\`\`\`file:src/old.js
// 由 zxz 在读到真实内容后重写
export function legacyInit(root) {
  if (!root) return null;
  const el = root.querySelector('[data-legacy]');
  return el || root;
}
\`\`\`

改完了：新增了空值兜底，并改成 ESM 导出，调用方需要同步改成 \`import { legacyInit }\`。`;

/** 技能附件协议第一轮：按 id 取 refs 下的细则 */
const SKILL_REF_ASK = `先看下细则再动手。

@@ref: ext-skill/refs/detail.md`;

/** 技能附件协议第二轮：程序已回传「技能 ext-skill/...」 */
const SKILL_REF_DONE = `细则看过了：命名用 verbNoun，错误统一抛 AppError。按这个写。`;

/** 最近一次 /chat/completions 的请求体，供测试断言"实际发出去的上下文" */
let lastRequest = null;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-ZXZ-Token, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function json(res, code, body) {
  cors(res);
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/** 按字符切片，避免把中文的代理对切断 */
function slice(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '');

  if (req.method === 'GET' && path === '/_last') {
    return json(res, 200, lastRequest || {});
  }

  if (req.method === 'GET' && path.endsWith('/models')) {
    return json(res, 200, {
      object: 'list',
      data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'zxz-mock' })),
    });
  }

  if (req.method === 'POST' && path.endsWith('/chat/completions')) {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch (_) {
      return json(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } });
    }

    const auth = req.headers.authorization || '';
    const key = auth.replace(/^Bearer\s+/i, '').trim();
    const model = body.model || '';
    lastRequest = { ...body, _auth: key ? 'present' : 'missing' };

    if (model === 'bad-key') {
      return json(res, 401, {
        error: {
          message:
            'Incorrect API key provided: bad-key. You can find your API key at https://platform.openai.com/account/api-keys.',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }
    if (model === 'unknown-model') {
      return json(res, 404, {
        error: {
          message: `The model \`${model}\` does not exist or you do not have access to it.`,
          code: 'model_not_found',
        },
      });
    }
    if (!key) {
      return json(res, 401, { error: { message: "You didn't provide an API key.", code: 'invalid_api_key' } });
    }
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return json(res, 400, { error: { message: 'messages 不能为空', type: 'invalid_request_error' } });
    }

    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
    const prompt = String((lastUser && lastUser.content) || '');
    // 程序回传的读文件结果（buildReadPayload 的标记）
    const toolResult = prompt.includes('<<<FILE ');
    // 技能附件回传（buildReadPayload 里以「技能 <id>/<rel>」标记）
    const refResult = prompt.includes('技能 ext-skill/');
    const slow = prompt.includes('[[slow]]');
    const long = prompt.includes('[[long]]');
    const withReasoning = model.startsWith('reasoner');
    const content = refResult
      ? SKILL_REF_DONE
      : prompt.includes('[[ref]]')
        ? SKILL_REF_ASK
        : toolResult
          ? READ_DONE
          : prompt.includes('[[read]]')
            ? READ_ASK
            : prompt.includes('[[files]]')
              ? FILES
              : prompt.includes('[[badpath]]')
                ? BADPATHS
                : long
                  ? LONG
                  : ANSWER;
    const promptTokens = body.messages.reduce((n, m) => n + String(m.content || '').length, 0);
    const completionTokens = content.length;

    if (!body.stream) {
      const message = { role: 'assistant', content };
      if (withReasoning) message.reasoning_content = REASONING.join('');
      return json(res, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    }

    cors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    const push = (delta, extra) => {
      if (closed) return;
      const chunk = { ...base, choices: [{ index: 0, delta, finish_reason: null }], ...(extra || {}) };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    if (withReasoning) {
      for (const piece of REASONING) {
        push({ reasoning_content: piece });
        if (slow) await wait(300);
      }
    }

    for (const piece of slice(content, slow ? 24 : 96)) {
      push({ content: piece });
      if (slow) await wait(300);
    }

    push(
      {},
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      }
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  json(res, 404, { error: { message: `未知路由 ${req.method} ${path}`, type: 'invalid_request_error' } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock upstream on http://127.0.0.1:${PORT}/v1`);
});
