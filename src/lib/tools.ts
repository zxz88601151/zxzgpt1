/** 工具调用层：工具定义、白名单、流式 tool_calls 合并、测试回路决策。
*
* 设计约束（写给后来人，别顺手放宽）：
* 1) 这里的白名单只是前端的“第一道门”，真正的安全边界在 Rust 侧
* `src-tauri/src/runx.rs`：前端校验永远不能代替 Rust 校验，Rust 必须
* 对每一次调用重新校验一次。两边的白名单必须保持一致，改一边就要改另一边。
* 2) 白名单只放“测试、构建、只读 Git”三类。安装、发布、推送、删除、
* 强制改写历史一律不在里面，模型要这些操作时程序直接拒绝，不弹确认。
* 3) 不走 shell：命令以 argv 数组直接交给子进程，不拼字符串、不解释
* `;`、`|`、`&`、`$`、反引号这类 shell 元字符，带这些字符的参数直接拒绝。
*/

import { relPathError} from "./files";

export type ToolName = "read_file" | "list_dir" | "search_files" | "write_file" | "run_command";

export interface ToolDefinition {
type: "function";
function: {
name: ToolName;
description: string;
parameters: Record<string, unknown>;
};
}

export const TOOL_DEFS: ToolDefinition[] = [
{
type: "function",
function: {
name: "read_file",
description: "读取工程内一个文件的真实内容。路径相对工程根目录，不带盘符、不出现..。返回内容可能被截断，截断时会注明。",
parameters: {
type: "object",
properties: { path: { type: "string", description: "工程内相对路径"}},
required: ["path"],
additionalProperties: false,
},
},
},
{
type: "function",
function: {
name: "list_dir",
description: "列出工程内一个目录的条目（目录在前）。不传 path 时列工程根目录。深度只列一层，不要用它遍历整棵树。",
parameters: {
type: "object",
properties: { path: { type: "string", description: "工程内相对目录，空串表示根目录"}},
required: [],
additionalProperties: false,
},
},
},
{
type: "function",
function: {
name: "search_files",
description: "在工程内按字面子串搜索文件内容，返回 path:行号 命中。不要用它当正则引擎，query 就是字面文本。",
parameters: {
type: "object",
properties: {
query: { type: "string", description: "要找的字面文本"},
path: { type: "string", description: "限定搜索的相对目录，空串表示整棵树"},
},
required: ["query"],
additionalProperties: false,
},
},
},
{
type: "function",
function: {
name: "write_file",
description: "把完整内容写入工程内一个文件（新建或整文件覆盖）。覆盖前程序会自动备份旧内容。计划模式下此工具会被拦截，写入前确认开启时需要用户在面板里批复。",
parameters: {
type: "object",
properties: {
path: { type: "string", description: "工程内相对路径"},
content: { type: "string", description: "该文件的完整内容，禁止用省略号占位"},
},
required: ["path", "content"],
additionalProperties: false,
},
},
},
{
type: "function",
function: {
name: "run_command",
description: "在工程根目录运行一条白名单命令。只允许测试、构建和只读 Git，超时 60 秒，输出会被截断。不要用它安装、发布、推送、删除或改写历史，那些命令会被直接拒绝。",
parameters: {
type: "object",
properties: {
argv: { type: "array", items: { type: "string"}, description: "命令参数数组，例如 [\"npm\", \"test\"]，不要拼成一条 shell 字符串"},
},
required: ["argv"],
additionalProperties: false,
},
},
},
];

/** 单个工具结果回传给模型时的字符上限，超了截断并注明（不是静默丢） */
export const MAX_TOOL_OUTPUT_CHARS = 20000;
/** 测试回路最多跑几轮：写完跑一次算一轮，3 轮不过就停下报人 */
export const MAX_TEST_ROUNDS = 3;
/** Rust 侧 run_allowed 的超时秒数，前端只做提示，不以此为准 */
export const RUN_TIMEOUT_SECS = 60;

const SHELL_META = /[;|&$`\\\n\r<>]/;

/** 额外参数是不是一个安全的相对路径/过滤词：不以 - 开头、不含..、不含 shell 元字符、不以 / 开头 */
function isSafeFilterArg(arg: string): boolean {
if (!arg || arg.startsWith("-")) return false;
if (arg.split("/").some((seg) => seg === ".." || seg === "")) return false;
if (SHELL_META.test(arg)) return false;
return true;
}

/**
* 白名单校验：返回 null 表示允许，否则返回中文拒绝原因。
* 注意：这份逻辑必须与 Rust 侧 runx::is_allowed 保持一致。
*/
export function isAllowedCommand(argv: string[]): string | null {
if (!argv.length) return "命令为空";
for (const a of argv) {
if (typeof a!== "string" ||!a) return "命令参数不能为空";
if (/[\0\n\r]/.test(a)) return "命令参数不能含控制字符";
}
const [cmd,...rest] = argv;
if (cmd === "npm") {
if (rest.length >= 1 && rest[0] === "test") {
const filters = rest.slice(1);
if (filters.every(isSafeFilterArg)) return null;
return "npm test 只允许附加安全的测试文件过滤词";
}
if (rest.length === 2 && rest[0] === "run" && (rest[1] === "build" || rest[1] === "lint")) return null;
if (rest.length === 1 && rest[0] === "--version") return null;
return "npm 只允许 test、run build、run lint、--version";
}
if (cmd === "npx") {
if (rest.length >= 2 && rest[0] === "vitest" && rest[1] === "run") {
const filters = rest.slice(2);
if (filters.every(isSafeFilterArg)) return null;
return "npx vitest run 只允许附加安全的测试文件过滤词";
}
return "npx 只允许 vitest run";
}
if (cmd === "node") {
if (rest.length === 1 && rest[0] === "--version") return null;
return "node 只允许 --version";
}
if (cmd === "git") {
if (rest.length === 1 && rest[0] === "status") return null;
if (rest.length >= 1 && rest[0] === "status" && rest.slice(1).every((a) => a === "--short" || a === "--porcelain" || a === "-s")) return null;
if (rest.length === 1 && rest[0] === "diff") return null;
if (rest.length === 2 && rest[0] === "diff" && rest[1] === "--stat") return null;
if (rest.length === 1 && rest[0] === "--version") return null;
return "git 只允许 status、diff、diff --stat、--version";
}
return "不在白名单里的命令：只允许 npm、npx、node、git 的测试/构建/只读子命令";
}

/** 校验一次工具调用的参数，返回 null 表示合法，否则返回中文原因 */
export function validateToolArgs(name: string, args: Record<string, unknown>): string | null {
if (name === "read_file") {
if (typeof args.path!== "string") return "read_file 需要 path";
return relPathError(args.path);
}
if (name === "list_dir") {
if (args.path === undefined || args.path === "") return null;
if (typeof args.path!== "string") return "list_dir 的 path 必须是字符串";
return relPathError(args.path);
}
if (name === "search_files") {
if (typeof args.query!== "string" ||!args.query.trim()) return "search_files 需要非空 query";
if (args.query.length > 200) return "search_files 的 query 太长（上限 200 字符）";
if (args.path === undefined || args.path === "") return null;
if (typeof args.path!== "string") return "search_files 的 path 必须是字符串";
return relPathError(args.path);
}
if (name === "write_file") {
if (typeof args.path!== "string") return "write_file 需要 path";
const bad = relPathError(args.path);
if (bad) return bad;
if (typeof args.content!== "string") return "write_file 需要 content（完整文件内容）";
return null;
}
if (name === "run_command") {
if (!Array.isArray(args.argv)) return "run_command 需要 argv 数组";
return isAllowedCommand(args.argv as string[]);
}
return `未知工具：${name}`;
}

export interface ToolCallFragment {
index: number;
id?: string;
name?: string;
arguments?: string;
}

export interface ToolCall {
id: string;
name: string;
arguments: string;
}

/**
* 合并流式 tool_calls 增量：同一 index 的 arguments 片段按顺序拼接，
* id/name 以第一次出现为准。OpenAI 兼容端在流式里经常把 arguments 拆成
* 很多片，不合并直接 JSON.parse 一定会失败。
*/
export function accumulateToolCallDeltas(fragments: ToolCallFragment[]): ToolCall[] {
const byIndex = new Map<number, ToolCall>();
for (const f of fragments) {
const cur = byIndex.get(f.index) || { id: f.id || `call_${f.index}`, name: "", arguments: ""};
if (f.id && cur.id.startsWith("call_")) cur.id = f.id;
if (f.name) cur.name = f.name;
if (f.arguments) cur.arguments += f.arguments;
byIndex.set(f.index, cur);
}
return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

/** 非流式响应里 message.tool_calls 的原始形态转成 ToolCall */
export function parseToolCallsFromMessage(raw: unknown): ToolCall[] {
if (!raw || typeof raw!== "object") return [];
const list = (raw as { tool_calls?: unknown}).tool_calls;
if (!Array.isArray(list)) return [];
const out: ToolCall[] = [];
list.forEach((t, i) => {
if (!t || typeof t!== "object") return;
const fn = (t as { function?: { name?: unknown; arguments?: unknown}}).function;
out.push({
id: typeof (t as { id?: unknown}).id === "string"? ((t as { id: string}).id as string): `call_${i}`,
name: typeof fn?.name === "string"? fn.name: "",
arguments: typeof fn?.arguments === "string"? fn.arguments: "",
});
});
return out;
}

export function truncateToolOutput(text: string): string {
if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n\n/* 工具输出已截断：原文 ${text.length} 字符，只取前 ${MAX_TOOL_OUTPUT_CHARS} 字符 */`;
}

/** 测试回路决策：completedRounds 是已经跑完的轮数（含本轮） */
export function testLoopDecision(exitCode: number | null, completedRounds: number): "pass" | "retry" | "give_up" {
if (exitCode === 0) return "pass";
if (completedRounds >= MAX_TEST_ROUNDS) return "give_up";
return "retry";
}

/** 给模型看的工具说明：放在工作区提示词之后、计划提示词之前 */
export function buildToolsPrompt(planMode: boolean, confirmWrites: boolean): string {
const lines = [
"",
"优先用工具，不要再用 ```file: 代码块和 @@read: 行写文件、读文件——工具调用才是本轮的正式通道，旧的文本协议只作不支持工具的兼容端回退。",
"工具：read_file（读文件）、list_dir（列一层目录）、search_files（字面子串搜索）、write_file（整文件写入，覆盖前自动备份）、run_command（白名单命令）。",
"run_command 只允许：npm test、npm run build、npm run lint、npx vitest run、git status、git diff、git diff --stat、以及 --version 类查询；安装、发布、推送、删除、改写历史一律会被程序拒绝，不要尝试。",
"写完文件后程序会自动跑一次 npm test，把结果回传给你；测试失败时先看报错、改代码、再等下一轮测试，不要在测试还没通过时宣称完成；3 轮测试不过程序会停下并报给人。",
];
if (planMode) lines.push("计划模式：本轮只出方案，write_file 和 run_command 会被程序拦截，不要调用它们；read_file、list_dir、search_files 仍可用。");
if (confirmWrites) lines.push("写入前确认已开启：write_file 会先弹差异面板，等用户批复后才真正落盘，批复前不要把写入当成已完成。");
return lines.join("\n");
}
