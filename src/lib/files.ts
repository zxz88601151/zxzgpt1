/** 本地工程模式的纯逻辑：解析模型回复里的文件块、读文件请求、校验相对路径、拼提示词。
 *
 * 两个约定（都是给模型看、由程序执行的指令）：
 *   1) ```file:相对路径 + 完整内容```  → 程序自动写入磁盘，聊天窗口只回显写入结果
 *   2) `@@read: 相对路径`              → 程序把该文件的真实内容回传给模型，继续下一轮
 * 普通 ```ts 代码块仍然只是展示用，不会被落盘。
 */

export interface FileBlock {
  /** 模型给的相对路径（已去首尾空白） */
  path: string;
  content: string;
}

/** 一轮里最多读几个文件，防止模型一口气要整个仓库 */
export const MAX_READ_FILES = 6;
/** 单个文件回传给模型的字符上限 */
export const MAX_READ_CHARS = 24000;

/** 补丁式输出常见的三种「假路径」前缀，统一去掉 */
export function normalizeRelPath(raw: string): string {
  let p = raw.trim().replace(/\\/g, "/");
  p = p.replace(/^\.\//, "");
  p = p.replace(/^\/+/, "");
  return p;
}

/**
 * 路径能不能安全地相对工程根目录写入。
 * 返回 null 表示合法，否则返回中文原因（与 Rust 侧 fsx 的校验保持同一套规则）。
 */
export function relPathError(raw: string): string | null {
  const p = normalizeRelPath(raw);
  if (!p) return "路径为空";
  if (/^[a-zA-Z]:/.test(p)) return "不能带盘符";
  // 开头的 / 已在 normalizeRelPath 里剥掉：模型常把工程内路径写成 /src/a.ts，
  // 按「相对工程根目录」处理更符合预期，真正越权的是 .. 与盘符。
  if (p.split("/").some((seg) => seg === "..")) return "不能包含 ..";
  if (p.split("/").some((seg) => seg === "")) return "路径里有空目录名";
  return null;
}

// 信息串里可能带冒号与路径，所以只用「file:/path:」做前缀判定，不再限制语言字符
const FENCE_SRC = "```[ \\t]*(?:file|path)[ \\t]*:[ \\t]*([^\\n`]+?)[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?```";

/** 从一段 Markdown 里抽出所有 file: 代码块；同路径后者覆盖前者 */
export function parseFileBlocks(text: string): FileBlock[] {
  const re = new RegExp(FENCE_SRC, "g");
  const out: FileBlock[] = [];
  const seen = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = normalizeRelPath(m[1]);
    const content = m[2].replace(/\r\n/g, "\n");
    if (!path) continue;
    const at = seen.get(path);
    if (at === undefined) {
      seen.set(path, out.length);
      out.push({ path, content });
    } else {
      out[at] = { path, content }; // 同一文件被写多次，以最后一次为准
    }
  }
  return out;
}

/** 整行形如 `@@read: src/a.ts` 的读取请求 */
const READ_RE = /^[ \t]*@@(?:read|open)[ \t]*:?[ \t]*([^\n`]+?)[ \t]*$/gim;

/** 模型要读哪些文件；去重、限 6 个 */
export function parseReadRequests(text: string): string[] {
  const re = new RegExp(READ_RE.source, "gim");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = normalizeRelPath(m[1]);
    if (!p || out.includes(p)) continue;
    out.push(p);
  }
  return out.slice(0, MAX_READ_FILES);
}

/** 任何 `@@xxx: ...` 形式的程序指令行（@@read / @@ref …），只用于显示时剥掉 */
const ANY_CMD_RE = /^[ \t]*@@[a-z]+[ \t]*:.*$/gim;

/**
 * 落盘后的显示文本：把已经写进磁盘的文件块和程序指令行从正文里剥掉，
 * 这样对话里只剩解释，代码只存在于文件里。
 */
export function stripControl(text: string): string {
  const body = text
    .replace(new RegExp(FENCE_SRC, "g"), "")
    .replace(new RegExp(ANY_CMD_RE.source, "gim"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return body;
}

/** 只剥掉程序指令行（代码块保留）：没有工程目录时仍要把代码展示出来 */
export function stripReadLines(text: string): string {
  return text.replace(new RegExp(ANY_CMD_RE.source, "gim"), "").replace(/\n{3,}/g, "\n\n").trim();
}

export interface ReadOutcome {
  path: string;
  content?: string;
  error?: string;
}

/** 把读到的真实内容拼成回传给模型的一条消息 */
export function buildReadPayload(items: ReadOutcome[]): string {
  const parts: string[] = ["[程序回传] 以下是你请求的文件真实内容（直接从工程目录读取，未做修改）："];
  for (const it of items) {
    if (it.error) {
      parts.push(`<<<FILE ${it.path}>>>\n读取失败：${it.error}\n<<<END ${it.path}>>>`);
      continue;
    }
    const raw = it.content ?? "";
    const body =
      raw.length > MAX_READ_CHARS
        ? raw.slice(0, MAX_READ_CHARS) + `\n\n/* 已截断：原文件 ${raw.length} 字符，只回传前 ${MAX_READ_CHARS} */`
        : raw;
    parts.push(`<<<FILE ${it.path}>>>\n${body}\n<<<END ${it.path}>>>`);
  }
  parts.push(
    "基于以上真实内容继续。要改文件就输出 ```file:路径 完整内容（程序会自动写入磁盘）；还要看别的文件继续用 @@read: 路径；都完成了就用一段话说明改了什么。"
  );
  return parts.join("\n\n");
}

export function countLines(s: string): number {
  if (!s) return 0;
  return s.split("\n").length;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "target-gnu",
  "dist",
  "build",
  ".next",
  ".idea",
  "__pycache__",
  ".zxz",
]);

export interface TreeEntry {
  name: string;
  path: string;
  dir: boolean;
}

/** 把一层目录条目渲染成提示词里的缩进树（由调用方递归后扁平传入） */
export function treeLine(entry: TreeEntry, depth: number): string {
  return "  ".repeat(depth) + entry.name + (entry.dir ? "/" : "");
}

export function shouldSkipDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

/** 备份目录：覆盖前把旧内容塞进这里，自动写入也要留退路 */
export const UNDO_DIR = ".zxz/undo";

export function backupRelPath(stamp: string, rel: string): string {
  return `${UNDO_DIR}/${stamp}/${normalizeRelPath(rel)}`;
}

export interface WorkspacePromptOptions {
  /** 工具调用开启时，模型应优先用工具而不是 file: 块 */
  toolMode?: boolean;
  /** 写入前确认开启时，提示词必须如实说“要批了才写”，不能再说自动写入 */
  confirmWrites?: boolean;
  /** 计划模式下不落盘，提示词里先说清楚 */
  planMode?: boolean;
}

/** 本地工程模式的系统提示词；tree 为空时只给根目录，不硬编造结构 */
export function buildWorkspacePrompt(root: string, tree: string, opts: WorkspacePromptOptions = {}): string {
  const writeLine = opts.planMode
    ? "计划模式：本轮只出方案，不落盘；你输出的文件块会被程序直接跳过。"
    : opts.confirmWrites
      ? "你输出的文件块会先弹差异面板，等用户批复后才写入磁盘；没批复之前不要把写入当成已完成。"
      : "你输出的文件块会被程序**自动写入磁盘**，不需要用户确认；聊天窗口只显示写入结果，不显示代码正文。所以你说的每个字都不会代替文件内容——只有 file: 块才会真正落盘。";
  const lines = [
    "【本地工程模式 · 真实读写】",
    `你正在用户的本地磁盘上工作，工程根目录：${root}`,
    writeLine,
  ];
  if (tree.trim()) {
    lines.push("当前目录结构（深度有限，已忽略依赖与构建产物）：", tree.trim());
  } else {
    lines.push("当前目录为空或尚未扫描。");
  }
  lines.push(
    opts.toolMode
      ? "工具调用开启时优先用工具读写文件；下面的 file: / @@read: 只是不支持工具的兼容端回退，不要在工具可用时混用两套协议。"
      : "工具调用未开启时用下面的文本协议读写文件。",
    "写入文件（新建或整文件覆盖）：",
    "```file:相对路径",
    "<该文件的完整内容>",
    "```",
    "读取已有文件：单独一行写 `@@read: 相对路径`（一次最多 " + MAX_READ_FILES + " 个）。",
    "程序会把真实内容回传给你，你再继续回答或改文件。",
    "规则：",
    "1. 路径相对工程根目录，不带盘符、不以 / 或 \\ 开头、不出现 ..",
    "2. 一个文件一个代码块，内容必须是完整文件；禁止「…省略…」「其余不变」这类占位",
    "3. 改已有文件前先 @@read 看真实内容，不要凭猜测重写；改完输出整份新内容",
    "4. 解释写在代码块外面；不确定的事先读文件或直接说不知道",
    opts.toolMode
      ? "5. 工具调用开启时，测试与命令输出只能靠 run_command 工具获取，不要凭空编造命令输出"
      : "5. 不要用终端假设：你看不到命令输出，只能靠 @@read 获取事实"
  );
  return lines.join("\n");
}
