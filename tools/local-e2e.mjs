#!/usr/bin/env node
/**
 * 本地模型全流程端到端测试（工具调用 + 上下文压缩）
 * ----------------------------------------------------------------
 * 目标模型：.200 上的 Ollama qwen2.5:3b（OpenAI 兼容 /v1 接口）
 * 覆盖两个核心能力：
 *   ① 工具调用 —— 真实 fs 读取工程文件，验证本地模型能产出 tool_calls 并消费工具结果
 *   ② 上下文压缩 —— 复刻 zxz 压缩引擎算法（estimateTokens / planCompaction /
 *                   structuralSummary / 增量摘要 / 预算触发），在长会话超预算时自动压缩
 *
 * 运行：node tools/local-e2e.mjs
 * 环境变量：LM_BASE（默认 .200 Ollama）、LM_MODEL（默认 qwen2.5:3b）
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.LM_BASE || "http://192.168.3.200:11434/v1/chat/completions";
const MODEL = process.env.LM_MODEL || "qwen2.5:3b";
const ROOT = "F:/zhuomian/zxz"; // 允许工具读取的工程根（安全边界）

let PASS = 0;
let FAIL = 0;
function check(name, cond, detail = "") {
  if (cond) { PASS++; console.log(`    ✓ ${name} ${detail}`); }
  else { FAIL++; console.log(`    ✗ ${name} ${detail}`); }
}

// ===================== token 估算（一致于 src/lib/tokens.ts） =====================
function estimateTokens(text) {
  if (!text) return 0;
  const len = text.length;
  let cjk = 0;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
  }
  const non = len - cjk;
  return Math.max(1, Math.ceil(cjk + non / 4));
}
function estimateWireTokens(messages) {
  let s = 0;
  for (const m of messages) {
    s += estimateTokens(m.content || "");
    if (m.tool_calls?.length) s += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return s;
}

// ===================== 压缩引擎（一致于 src/orchestration/compact.ts） =====================
function structuralSummary(window) {
  const actions = [];
  const files = new Set();
  for (const m of window) {
    if (m.role === "user") {
      const line = (m.content || "").split("\n")[0].trim().slice(0, 100);
      if (line) actions.unshift(`- 用户诉求：${line}`);
    }
    const tcs = m.toolCalls || m.tool_calls;
    if (tcs) {
      for (const t of tcs) {
        const name = t.name || t.function?.name;
        const err = t.error;
        actions.push(`- 工具 ${name}${err ? `（失败：${err.slice(0, 60)}）` : ""}`);
        const arg = t.arguments || t.function?.arguments || "";
        const pm = arg.match(/"path"\s*:\s*"([^"]+)"/);
        if (pm) files.add(pm[1]);
      }
    }
  }
  const lines = [...actions];
  if (files.size) lines.push(`- 涉及文件：${[...files].join("、")}`);
  return lines.join("\n") || "- （空窗口）";
}
function planCompaction(conv, messages, keepRounds) {
  const full = messages;
  const after = conv.compactAfterIndex ?? 0;
  const keepRecent = Math.max(1, keepRounds) * 2;
  const newEnd = Math.max(after, full.length - keepRecent);
  if (newEnd <= after) return null;
  if (newEnd >= full.length) return null;
  const window = full.slice(after, newEnd);
  if (window.length < 1) return null;
  return { window, afterIndex: newEnd, summarizedCount: window.length };
}
function mergeSummary(existing, delta) {
  return existing ? `${existing}\n\n${delta}` : delta;
}
// 压缩后实际发给模型的视图：摘要系统消息 + 保留区原文（一致于 state.buildMessages 压缩感知）
function buildView(conv, messages) {
  const out = [];
  if (conv.compactSummary) out.push({ role: "system", content: `[对话历史压缩摘要]\n${conv.compactSummary}` });
  const after = conv.compactAfterIndex ?? 0;
  for (let i = after; i < messages.length; i++) out.push(messages[i]);
  return out;
}

// ===================== 工具（真实 fs 执行） =====================
const TOOLS = [
  { type: "function", function: { name: "read_file", description: "读取工程内文本文件内容（相对于工程根）", parameters: { type: "object", properties: { path: { type: "string", description: "文件路径，如 package.json 或 src/lib/tokens.ts" } }, required: ["path"] } } },
  { type: "function", function: { name: "list_dir", description: "列出目录下的文件与子目录", parameters: { type: "object", properties: { path: { type: "string", description: "目录路径，缺省为工程根" } }, required: [] } } },
];
function executeTool(name, args) {
  try {
    if (name === "read_file") {
      const p = resolve(ROOT, args.path || "");
      const buf = readFileSync(p, "utf8");
      const content = buf.length > 2000 ? buf.slice(0, 2000) + "\n...[截断]" : buf;
      return { ok: true, content };
    }
    if (name === "list_dir") {
      const p = resolve(ROOT, args.path || ".");
      const ents = readdirSync(p).map((e) => { try { return statSync(resolve(p, e)).isDirectory() ? e + "/" : e; } catch { return e; } });
      return { ok: true, content: ents.join("\n") };
    }
    return { ok: false, error: `未知工具 ${name}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ===================== chat 调用 =====================
async function chat(messages, withTools = false, maxTokens = 400) {
  const body = { model: MODEL, messages, stream: false, max_tokens: maxTokens };
  if (withTools) { body.tools = TOOLS; body.tool_choice = "auto"; }
  const r = await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.choices[0].message;
}

// ===================== 阶段一：工具调用 =====================
async function stageToolCall() {
  console.log("\n=== 阶段一：工具调用（本地模型 " + MODEL + "）===");
  const messages = [
    { role: "system", content: "你是一个文件助手。当需要读取文件时必须调用 read_file 工具，不要凭空编造内容。回答简洁。" },
    { role: "user", content: "请读取 package.json 文件，告诉我这个项目的 name 和 version 分别是什么。" },
  ];
  let rounds = 0;
  let calledReadFile = false;
  let finalAnswer = "";
  while (rounds++ < 6) {
    const msg = await chat(messages, true, 400);
    messages.push(msg);
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function;
        const args = JSON.parse(fn.arguments || "{}");
        console.log(`  → 模型调用工具: ${fn.name}(${JSON.stringify(args)})`);
        if (fn.name === "read_file") calledReadFile = true;
        const res = executeTool(fn.name, args);
        console.log(`  ← 工具结果: ${res.ok ? res.content.replace(/\n/g, " ").slice(0, 90) + "…" : "错误 " + res.error}`);
        messages.push({ role: "tool", tool_call_id: tc.id || `call_${rounds}`, content: res.ok ? res.content : "错误：" + res.error });
      }
    } else {
      finalAnswer = msg.content || "";
      console.log(`  ✓ 最终回答: ${finalAnswer}`);
      break;
    }
  }
  console.log(`  阶段一完成，共 ${rounds} 轮。`);
  check("模型产出了 read_file 工具调用", calledReadFile);
  check("最终回答非空且未陷入工具循环", finalAnswer.trim().length > 0 && rounds <= 6);
  check("回答包含项目名/版本线索", /zxz|0\.3\.0|name|version/i.test(finalAnswer));
}

// ===================== 阶段二：上下文压缩全流程 =====================
async function stageCompact() {
  console.log("\n=== 阶段二：上下文压缩全流程 ===");
  const KEEP_ROUNDS = 3;
  const BUDGET = 1800; // 估算 token 预算
  // 构造长会话：20 轮 user/assistant 长文本，制造超预算上下文
  const msgs = [{ role: "system", content: "你是项目助手。" }];
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: "user", content: `请记住第 ${i + 1} 条事实：项目部署在盐城，今天处理任务编号 T${i + 1}，涉及模块 X${i + 1} 与配置 Y${i + 1}。这是用于填充上下文的长文本，用于测试压缩引擎在长会话下是否能正确触发并产出高质量摘要。` });
    msgs.push({ role: "assistant", content: `已记录第 ${i + 1} 条事实。盐城项目的任务 T${i + 1} 涉及模块 X${i + 1} 与配置 Y${i + 1}，我会保留这些上下文以便后续引用与核对，确保任务连续性。` });
  }
  const before = estimateWireTokens(msgs);
  console.log(`  压缩前：消息 ${msgs.length} 条，估算 token ≈ ${before}`);
  check("压缩前已超预算", before > BUDGET);

  // 模型摘要函数（失败退化 structuredSummary），实现 zxz「模型优先、结构化兜底」
  let usedModelSummary = false;
  const summarize = async (window) => {
    try {
      const wtext = window.map((m) => `[${m.role}] ${m.content || ""}`).join("\n");
      const m = await chat([{ role: "system", content: "把下面这段对话压缩成中文要点摘要，保留关键事实，不超过120字。" }, { role: "user", content: wtext }], false, 200);
      usedModelSummary = true;
      return m.content.trim();
    } catch { return ""; }
  };

  const conv = { compactAfterIndex: 0, compactSummary: undefined };
  let guard = 0;
  let compactCount = 0;
  while (guard++ < 12) {
    const view = buildView(conv, msgs);
    if (estimateWireTokens(view) <= BUDGET) break;
    const plan = planCompaction(conv, msgs, KEEP_ROUNDS);
    if (!plan) break;
    let delta = await summarize(plan.window);
    if (!delta) delta = structuralSummary(plan.window);
    conv.compactSummary = mergeSummary(conv.compactSummary, delta);
    conv.compactAfterIndex = plan.afterIndex;
    compactCount++;
    console.log(`  第 ${compactCount} 次压缩：摘要 ${plan.summarizedCount} 条 → 「${delta.replace(/\n/g, " ").slice(0, 56)}…」`);
  }

  const afterView = buildView(conv, msgs);
  const after = estimateWireTokens(afterView);
  const summaryTokens = estimateTokens(conv.compactSummary || "");
  console.log(`  压缩后：摘要 ${summaryTokens} token + 保留区 ${afterView.length - (conv.compactSummary ? 1 : 0)} 条 = 发送 ≈ ${after} token`);
  console.log(`  节省：${(((before - after) / before) * 100).toFixed(1)}%  | 摘要方式：${usedModelSummary ? "模型摘要" : "结构化兜底"}`);
  console.log(`  compactAfterIndex=${conv.compactAfterIndex}\n  摘要内容:\n----\n${conv.compactSummary}\n----`);

  check("压缩把发送量压到预算内", after <= BUDGET);
  check("压缩节省超过 50%", (before - after) / before > 0.5);
  check("保留最近 KEEP_ROUNDS 轮原文", (msgs.length - conv.compactAfterIndex) === KEEP_ROUNDS * 2);
  check("生成了非空摘要", !!conv.compactSummary && conv.compactSummary.trim().length > 0);
}

// ===================== 主流程 =====================
async function main() {
  console.log(`本地模型全流程测试 → ${BASE}  model=${MODEL}`);
  const t0 = Date.now();
  await stageToolCall();
  await stageCompact();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== 汇总：${PASS} PASS / ${FAIL} FAIL，耗时 ${dt}s ===`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error("运行失败：", e); process.exit(2); });
