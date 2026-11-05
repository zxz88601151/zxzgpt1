/** 工具调用层：工具定义、白名单、流式 tool_calls 合并、测试回路决策。
*
* 设计约束（写给后来人，别顺手放宽）：
* 1) 这里的白名单只是前端的“第一道门”，真正的安全边界在 Rust 侧
* `src-tauri/src/runx.rs`：前端校验永远不能代替 Rust 校验，Rust 必须
* 对每一次调用重新校验一次。两边的白名单必须保持一致，改一边就要改另一边。
* 2) 白名单只放“测试、构建、只读 Git”三类。安装、发布、推送、删除、
* 强制改写历史一律不在里面，模型要这些操作时程序直接拒绝，不弹确认。
* 而且 argv 白名单只是第一层：npm test / npm run 真正执行的是 package.json 里的脚本，
* 脚本内容还要过 `checkNpmCommandScript`（Rust runx 里有权威版本，必然重查）。
* 3) 不走 shell：命令以 argv 数组直接交给子进程，不拼字符串、不解释
* `;`、`|`、`&`、`$`、反引号这类 shell 元字符，带这些字符的参数直接拒绝。
*/

export type ToolName = "read_file" | "list_dir" | "search_files" | "write_file" | "edit_file" | "apply_patch" | "run_command" | "web_search" | "todo_write" | "glob" | "explore";

export interface ToolDefinition {
type: "function";
function: {
// 内置工具的名字是 ToolName 联合类型；MCP 动态工具的名字是运行期生成的
// 字符串（mcp_<server>_<tool>），所以这里放宽成 string。
// 类型放宽不等于校验放宽：执行时仍由 registry 的 findTool 与 MCP 动态清单
// 精确匹配，`Run_Command`、`run_command ` 这类变形一律落到「未知工具」。
name: string;
description: string;
parameters: Record<string, unknown>;
};
}

// 工具清单、参数 Schema、参数校验与系统提示里的工具说明都在 `registry.ts`。
// 这里只留下白名单与脚本审计这些「与具体工具无关的判定原语」——
// registry 单向依赖本文件，本文件不反向依赖 registry（否则 state.ts 会绕出环）。

/** 单个工具结果回传给模型时的字符上限，超了截断并注明（不是静默丢） */
export const MAX_TOOL_OUTPUT_CHARS = 20000;
/** 测试回路最多跑几轮：写完跑一次算一轮，3 轮不过就停下报人 */
export const MAX_TEST_ROUNDS = 3;
/** Rust 侧 run_allowed 的超时秒数，前端只做提示，不以此为准 */
export const RUN_TIMEOUT_SECS = 60;

/** 转义符黑名单：unix 侧一套 + Windows .cmd 经 COMSPEC 执行时会被解释的一套。
 * 两边 white list 必须和 Rust `runx.rs` 的 `has_shell_meta` 完全一致，改一处就改两处。*/
const SHELL_META = /[;|&$`\\\n\r<>^%!"'()]/;

/** 去掉可执行后缀取命令名：npm.cmd → npm、node.exe → node。
 * Windows 下模型可能直接输出带后缀的命令名，白名单要认，但命令清单不放宽。*/
function stripExecExt(cmd: string): string {
  const lower = cmd.toLowerCase();
  for (const ext of [".cmd", ".bat", ".exe"]) {
    if (lower.endsWith(ext) && lower.length > ext.length) return cmd.slice(0, -ext.length);
  }
  return cmd;
}

/** 命令名不接受路径：白名单只认 PATH 上的裸命令名 */
function hasPathSep(cmd: string): boolean {
  return cmd.includes("/") || cmd.includes("\\");
}

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
const cmd = stripExecExt(argv[0] ?? "");
if (hasPathSep(cmd)) return "命令必须是 PATH 上的裸名字，不接受路径";
const rest = argv.slice(1);
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

// 参数校验已随工具定义搬到 `registry.ts`（每个工具自带 validate）。
// 这里不 re-export：那会让 tools → registry → tools 绕成运行时环。

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

/**
 * npm 脚本白名单。
 *
 * 为什么需要这一道：`run_command` 的白名单审的是 argv[0]，但 `npm test` /
 * `npm run <script>` 真正执行的是 package.json 里写死的脚本（npm 自己会起 shell
 * 跑它）。这个文件可能正是模型刚写进去的，也可能被模型读到的内容引导改写——
 * 等于把受控执行变成了任意命令执行。所以凡是会执行 npm 脚本的命令，先逐段
 * 审计脚本内容：按 && / || / ; 切段后，每段首词必须是已知测试/构建运行器。
 * 同一条规则在 Rust `runx.rs` 里有一份权威实现，执行时必然重查，这里只是
 * 提前拦截、给用户和模型一句人能看懂的拒绝原因。
 */
/**
 * 脚本里绝不允许出现的构造：命令替换、变量展开、重定向、反引号、换行。
 *
 * 只按 `&& || ;` 切段是不够的——`vitest run | sh`、`vitest run & curl x`、
 * `vitest run $(curl x)` 的首词都还是受信任运行器，切段后每段都能过白名单，
 * 但 shell 实际会再执行一条命令。所以先做构造级拒绝，再谈切段。
 * 与 Rust `runx.rs` 的 SCRIPT_FORBIDDEN 保持一致。
 */
const SCRIPT_FORBIDDEN = /[$`<>\r\n\0]/;

const SAFE_SCRIPT_SEGMENT = /^\s*(vitest|jest|mocha|node\s+--test(\s|$)|tsc|vite|eslint)(\s|$)/;

/** 脚本内容按 npm 的 shell 语义切段后，每段首词都在白名单里才算安全 */
export function isSafeNpmScript(script: unknown): boolean {
  if (typeof script !== "string" || !script.trim()) return false;
  if (SCRIPT_FORBIDDEN.test(script)) return false;
  // 先吃掉合法的 `&&` / `||`，剩下的单个 `|` 与 `&` 是真正的管道/后台运行，必须切段
  const normalized = script.replace(/&&|\|\|/g, "\u0001");
  return normalized.split(/[\u0001;|&]/).every((seg) => SAFE_SCRIPT_SEGMENT.test(seg));
}

/** 给定 argv，算出它实际要执行的 package.json 脚本名；不执行脚本的命令返回 null。
 * 只有 `npm test` / `npm run build|lint` 会 shell 出 package.json 脚本；
 * `npx vitest run` 直接跑本地二进制、不读 scripts，由 argv 白名单单独约束。
 * 与 Rust `runx.rs` 的 npm_script_name 保持一致。*/
export function npmScriptName(argv: string[]): string | null {
  const cmd = stripExecExt(argv[0] ?? "").toLowerCase();
  if (cmd === "npm") {
    const sub = argv[1] ?? "";
    if (sub === "test") return "test";
    if (sub === "run" && (argv[2] === "build" || argv[2] === "lint")) return argv[2];
    return null;
  }
  return null;
}

/**
 * run_command 执行前的脚本审计：argv 过了 argv 白名单，还不够——
 * 还要看它将要执行的 package.json 脚本内容。返回 null 表示放行，
 * 否则返回中文拒绝原因。pkgRaw 是 package.json 原文（调用方负责读）。
 *
 * npm 跑 `npm test` 实际执行 `pretest → test → posttest`，跑 `npm run build`
 * 是 `prebuild → build → postbuild`。只审主脚本等于把任意命令挂在钩子上：
 * 用户批准的是「npm test」，真正执行的却是 `pretest` 里那条。三个键都要审。
 * 与 Rust `runx.rs` 的 check_npm_script 保持一致。
 */
export function checkNpmCommandScript(argv: string[], pkgRaw: string): string | null {
  const name = npmScriptName(argv);
  if (!name) return null;
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    return "package.json 解析失败，无法审计 npm 将要执行的脚本，命令已拒绝";
  }
  const scripts = pkg?.scripts;
  const check = (key: string, script: unknown): string | null => {
    if (typeof script !== "string" || !script.trim()) {
      return `package.json 里没有可审计的 scripts.${key}，命令已拒绝`;
    }
    if (!isSafeNpmScript(script)) {
      return `npm 将要执行的 scripts.${key} 不在受信任运行器清单里（只认 vitest / jest / mocha / node --test / tsc / vite / eslint），命令已拒绝`;
    }
    return null;
  };
  const primary = check(name, scripts?.[name]);
  if (primary) return primary;
  for (const hook of [`pre${name}`, `post${name}`]) {
    const script = scripts?.[hook];
    if (script === undefined) continue;
    const bad = check(hook, script);
    if (bad) return bad;
  }
  return null;
}

/** 兼容旧入口：自动测试回路用它判断 test 脚本是否受信任 */
export function isSafeTestScript(script: unknown): boolean {
  return isSafeNpmScript(script);
}

/** 测试回路决策：completedRounds 是已经跑完的轮数（含本轮） */
export function testLoopDecision(exitCode: number | null, completedRounds: number): "pass" | "retry" | "give_up" {
if (exitCode === 0) return "pass";
if (completedRounds >= MAX_TEST_ROUNDS) return "give_up";
return "retry";
}

export interface RunSummary {
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
  /** 用户点「停止」终止的（与超时区分：一个是被动失败，一个是人的操作） */
  cancelled?: boolean;
}

/**
* 把一次命令执行的结果头部写成给模型看的一行。
*
* 为什么截断必须显式说出来：输出被截断后，「日志里没有报错」和「测试通过」
* 看起来一模一样，而模型只能看到日志。不告诉它被截断了，它就会把半截日志
* 当成绿灯继续往下走——这正是「静默误判成功」。
*/
export function runResultHead(r: RunSummary): string {
  const notes: string[] = [];
  // 取消排在最前：它解释了"为什么退出码是空的"，比后面两条都更根本
  if (r.cancelled) notes.push("用户已停止，进程被终止，这不是命令自己的结果");
  if (r.timed_out) notes.push("60 秒超时，已终止");
  if (r.truncated) notes.push("输出过长已截断，只保留了开头部分，不要把「没看到报错」当成测试通过");
  const code = r.exit_code === null ? "未知（进程被终止）" : String(r.exit_code);
  return `退出码：${code}${notes.length ? `（${notes.join("；")}）` : ""}`;
}

