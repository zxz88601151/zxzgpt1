/** 工具注册表：工具名、参数 Schema、权限等级、参数校验与执行入口，只在这里定义一次。
 *
 * 为什么要有这个文件：这些信息原来是五处手写——
 *   1. `tools.ts` 的 `ToolName` 联合类型
 *   2. `TOOL_DEFS` 的 JSON Schema
 *   3. `validateToolArgs` 的 if 链
 *   4. `App.tsx` 里 `executeTool` 的 if 链
 *   5. `buildToolsPrompt` 的散文描述
 * 新增一个工具要同步改五处，而漏改的后果各不相同：漏 Schema 模型不知道有这个工具；
 * 漏校验是参数直通 Rust；漏权限判断是绕过计划模式直接写盘/执行。这不是"代码不够整洁"，
 * 是安全边界靠人工同步。
 *
 * 现在只有一处 `TOOLS`，其余全部由它派生：`TOOL_DEFS`、`validateToolArgs`、
 * `buildToolsPrompt`、以及 App.tsx 里的分发与拦截。
 *
 * 依赖方向是单向的：registry → tools（白名单与校验原语）。tools 不反向依赖 registry，
 * 否则 state.ts（要 buildToolsPrompt）与 App.tsx 之间会绕出运行时环。
 */

import { relPathError, shouldSkipDir } from "./files";
import {
  checkNpmCommandScript,
  isAllowedCommand,
  npmScriptName,
  runResultHead,
  truncateToolOutput,
  type ToolDefinition,
  type ToolName,
} from "./tools";
import type { FsEntry, RunResult } from "./fsapi";

/**
 * 权限等级。这不是装饰：计划模式与将来的审批流程都按它拦，而不是按工具名手写。
 *
 * - `read`：只读工程内文件，任何模式下都放行；
 * - `write`：改磁盘。计划模式拦截；开了「写入前确认」时走批复面板；
 * - `exec`：起子进程。计划模式拦截；B10 的 exec 默认 ask 也挂在这一档上。
 */
export type ToolAccess = "read" | "write" | "exec";

/** 计划模式只放行只读工具。写与执行都被拦，理由与拦截点都集中在这里。 */
export function planModeBlocks(access: ToolAccess): boolean {
  return access !== "read";
}

/** 一次工具执行的结果：要么有正文，要么有错误，不会两者都有。 */
export interface ToolRunResult {
  result?: string;
  error?: string;
}

/**
 * 工具执行时能用的副作用通道，由调用方（App.tsx）注入。
 *
 * 抽这一层的目的不是"解耦好看"，是为了让每个工具的执行逻辑能在没有 Tauri、
 * 没有 React 的环境里直接单测——否则 executeTool 里那段递归搜索、npm 脚本审计
 * 只能靠人肉点界面验证。
 */
export interface ToolContext {
  /** 读工程内文件（Rust 侧限定在会话根目录内） */
  readFile: (rel: string) => Promise<string>;
  /** 列一层目录 */
  listDir: (rel: string) => Promise<FsEntry[]>;
  /** 写文件。可能被确认面板拦下（返回空数组 = 用户放弃），也可能失败 */
  writeFile: (rel: string, content: string) => Promise<WriteOutcome[]>;
  /** 起子进程跑白名单命令 */
  runCommand: (argv: string[]) => Promise<RunResult>;
}

export interface WriteOutcome {
  ok: boolean;
  path?: string;
  bytes?: number;
  created?: boolean;
  verified?: boolean;
  backup?: string;
  error?: string;
}

export interface ToolSpec {
  name: ToolName;
  /** 一句话说明，用于系统提示里的工具清单 */
  summary: string;
  /** 发给模型的完整描述（写清楚边界，模型才不会去试越界的写法） */
  description: string;
  /** JSON Schema：模型据此生成参数 */
  parameters: Record<string, unknown>;
  access: ToolAccess;
  /** 参数校验：返回 null 表示合法，否则是给模型看的中文原因 */
  validate: (args: Record<string, unknown>) => string | null;
  /** 执行。没接工程目录等前置条件不满足时返回 error，不抛异常 */
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolRunResult>;
}

/** 搜索上限：命中数与访问文件数都是 100，深度 3 层。超了就停，不做全库扫描。 */
const SEARCH_MAX_MATCHES = 100;
const SEARCH_MAX_VISITED = 100;
const SEARCH_MAX_DEPTH = 3;

function asRel(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const readFile: ToolSpec = {
  name: "read_file",
  access: "read",
  summary: "读文件",
  description:
    "读取工程内一个文件的真实内容。路径相对工程根目录，不带盘符、不出现..。返回内容可能被截断，截断时会注明。",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "工程内相对路径" } },
    required: ["path"],
    additionalProperties: false,
  },
  validate: (args) => {
    if (typeof args.path !== "string") return "read_file 需要 path";
    return relPathError(args.path);
  },
  run: async (args, ctx) => ({ result: truncateToolOutput(await ctx.readFile(asRel(args.path))) }),
};

const listDir: ToolSpec = {
  name: "list_dir",
  access: "read",
  summary: "列一层目录",
  description:
    "列出工程内一个目录的条目（目录在前）。不传 path 时列工程根目录。深度只列一层，不要用它遍历整棵树。",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "工程内相对目录，空串表示根目录" } },
    required: [],
    additionalProperties: false,
  },
  validate: (args) => {
    if (args.path === undefined || args.path === "") return null;
    if (typeof args.path !== "string") return "list_dir 的 path 必须是字符串";
    return relPathError(args.path);
  },
  run: async (args, ctx) => {
    const entries = await ctx.listDir(asRel(args.path));
    const lines = entries.map((e) => (e.dir ? `${e.name}/` : `${e.name} (${e.size} bytes)`));
    return { result: lines.length ? lines.join("\n") : "(空目录)" };
  },
};

const searchFiles: ToolSpec = {
  name: "search_files",
  access: "read",
  summary: "字面子串搜索",
  description:
    "在工程内按字面子串搜索文件内容，返回 path:行号 命中。不要用它当正则引擎，query 就是字面文本。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "要找的字面文本" },
      path: { type: "string", description: "限定搜索的相对目录，空串表示整棵树" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  validate: (args) => {
    if (typeof args.query !== "string" || !args.query.trim()) return "search_files 需要非空 query";
    if (args.query.length > 200) return "search_files 的 query 太长（上限 200 字符）";
    if (args.path === undefined || args.path === "") return null;
    if (typeof args.path !== "string") return "search_files 的 path 必须是字符串";
    return relPathError(args.path);
  },
  run: async (args, ctx) => {
    const query = (args.query as string).toLowerCase();
    const matches: string[] = [];
    let visited = 0;

    const walk = async (rel: string, depth: number): Promise<void> => {
      if (matches.length >= SEARCH_MAX_MATCHES || visited >= SEARCH_MAX_VISITED || depth > SEARCH_MAX_DEPTH) return;
      let entries: FsEntry[];
      try {
        // 走工程内通道：搜索不能借相对路径拼绝对路径逃出去
        entries = await ctx.listDir(rel);
      } catch {
        return; // 无权限的目录直接跳过
      }
      for (const e of entries) {
        if (matches.length >= SEARCH_MAX_MATCHES || visited >= SEARCH_MAX_VISITED) return;
        if (e.dir) {
          if (!shouldSkipDir(e.name)) await walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
          continue;
        }
        visited += 1;
        let content: string;
        try {
          content = await ctx.readFile(rel ? `${rel}/${e.name}` : e.name);
        } catch {
          continue; // 读不到（二进制、超大）就跳过，不阻断搜索
        }
        content.split("\n").forEach((line, i) => {
          if (matches.length < SEARCH_MAX_MATCHES && line.toLowerCase().includes(query)) {
            matches.push(`${rel ? `${rel}/` : ""}${e.name}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      }
    };

    await walk(asRel(args.path), 0);
    return { result: matches.length ? matches.join("\n") : "(没有命中)" };
  },
};

const writeFile: ToolSpec = {
  name: "write_file",
  access: "write",
  summary: "整文件写入",
  description:
    "把完整内容写入工程内一个文件（新建或整文件覆盖）。覆盖前程序会自动备份旧内容。计划模式下此工具会被拦截，写入前确认开启时需要用户在面板里批复。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工程内相对路径" },
      content: { type: "string", description: "该文件的完整内容，禁止用省略号占位" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  validate: (args) => {
    if (typeof args.path !== "string") return "write_file 需要 path";
    const bad = relPathError(args.path);
    if (bad) return bad;
    if (typeof args.content !== "string") return "write_file 需要 content（完整文件内容）";
    return null;
  },
  run: async (args, ctx) => {
    const results = await ctx.writeFile(asRel(args.path), args.content as string);
    if (!results.length) return { error: "用户放弃写入，磁盘没有改动" };
    const r = results[0];
    if (!r.ok) return { error: r.error || "写入失败" };
    return {
      result: `已写入 ${r.path}（${r.bytes ?? 0} bytes，${r.created ? "新建" : "覆盖"}，回读校验 ${
        r.verified ? "通过" : "不一致"
      }${r.backup ? `，旧版备份在 ${r.backup}` : ""}）`,
    };
  },
};

const runCommand: ToolSpec = {
  name: "run_command",
  access: "exec",
  summary: "白名单命令",
  description:
    "在工程根目录运行一条白名单命令。只允许测试、构建和只读 Git，且 npm/npx 将要执行的 package.json 脚本必须在受信任运行器清单里（vitest / jest / mocha / node --test / tsc / vite / eslint），否则程序拒绝。超时 60 秒，输出会被截断。不要用它安装、发布、推送、删除或改写历史，那些命令会被直接拒绝。",
  parameters: {
    type: "object",
    properties: {
      argv: {
        type: "array",
        items: { type: "string" },
        description: '命令参数数组，例如 ["npm", "test"]，不要拼成一条 shell 字符串',
      },
    },
    required: ["argv"],
    additionalProperties: false,
  },
  validate: (args) => {
    if (!Array.isArray(args.argv)) return "run_command 需要 argv 数组";
    return isAllowedCommand(args.argv as string[]);
  },
  run: async (args, ctx) => {
    const argv = args.argv as string[];
    // 自己再查一次，不假设调用方一定先跑过 validate：
    // 只要有别的入口直接调 run（审批重放、批量执行、将来的子 Agent），
    // 少这一步就等于白名单只在 UI 路径上生效。
    const denied = isAllowedCommand(argv);
    if (denied) return { error: denied };
    // argv 白名单只审到 argv[0]；npm/npx 真正跑的是 package.json 里的脚本，
    // 那个文件可能正是模型写的。执行前先看脚本内容（Rust 侧还会再查一次）。
    if (npmScriptName(argv)) {
      let pkg: string;
      try {
        pkg = await ctx.readFile("package.json");
      } catch (e) {
        return { error: `无法读取 package.json 审计 npm 脚本：${(e as Error).message}` };
      }
      const denied = checkNpmCommandScript(argv, pkg);
      if (denied) return { error: denied };
    }
    const r = await ctx.runCommand(argv);
    const body = [r.stdout, r.stderr ? `--- stderr ---\n${r.stderr}` : ""].filter(Boolean).join("\n");
    return { result: truncateToolOutput(`${runResultHead(r)}\n${body || "(无输出)"}`) };
  },
};

/** 唯一权威清单。加工具只改这里，其余（Schema / 校验 / 提示 / 分发 / 权限）自动跟上。 */
export const TOOLS: readonly ToolSpec[] = [readFile, listDir, searchFiles, writeFile, runCommand];

const BY_NAME = new Map<string, ToolSpec>(TOOLS.map((t) => [t.name, t]));

/**
 * 按名字取工具。**精确匹配**，不做 trim、不做大小写归一。
 *
 * 归一化看着友好，实际是给模型开了侧门：`Run_Command`、`run_command ` 这类
 * 变形一旦被归一成同一个工具，参数校验与权限等级的对应关系就变成了模糊匹配，
 * 而模糊匹配正是绕过拦截的经典入口。变形一律落到「未知工具」，明确拒绝。
 */
export function findTool(name: string): ToolSpec | null {
  return BY_NAME.get(name) ?? null;
}

/** 发给模型的函数声明，完全由注册表派生 */
export const TOOL_DEFS: ToolDefinition[] = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

/** 参数校验入口：查不到工具就是「未知工具」，绝不放行 */
export function validateToolArgs(name: string, args: Record<string, unknown>): string | null {
  const spec = findTool(name);
  if (!spec) return `未知工具：${name}`;
  return spec.validate(args);
}

/** 给模型看的工具说明：放在工作区提示词之后、计划提示词之前 */
export function buildToolsPrompt(planMode: boolean, confirmWrites: boolean): string {
  const lines = [
    "",
    "优先用工具，不要再用 ```file: 代码块和 @@read: 行写文件、读文件——工具调用才是本轮的正式通道，旧的文本协议只作不支持工具的兼容端回退。",
    `工具：${TOOLS.map((t) => `${t.name}（${t.summary}）`).join("、")}。`,
    "run_command 只允许：npm test、npm run build、npm run lint、npx vitest run、git status、git diff、git diff --stat、以及 --version 类查询；安装、发布、推送、删除、改写历史一律会被程序拒绝，不要尝试。npm/npx 还会审计 package.json 里对应脚本的内容，不是受信任运行器（vitest / jest / mocha / node --test / tsc / vite / eslint）会被拒。",
    "写完文件后程序会自动跑一次 npm test，把结果回传给你；测试失败时先看报错、改代码、再等下一轮测试，不要在测试还没通过时宣称完成；3 轮测试不过程序会停下并报给人。",
  ];
  if (planMode) {
    const names = TOOLS.filter((t) => planModeBlocks(t.access)).map((t) => t.name);
    lines.push(`计划模式：本轮只出方案，${names.join(" 和 ")} 会被程序拦截，不要调用它们；read_file、list_dir、search_files 仍可用。`);
  }
  if (confirmWrites) lines.push("写入前确认已开启：write_file 会先弹差异面板，等用户批复后才真正落盘，批复前不要把写入当成已完成。");
  return lines.join("\n");
}
