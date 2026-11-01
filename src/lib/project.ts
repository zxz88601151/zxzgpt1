/** 项目记忆与计划模式：把 Claude Code 的两条工程纪律落到本工具的架构里。
 *
 * 1) 项目记忆：工程根目录下的 CLAUDE.md（没有就退到 AGENTS.md）是项目给模型的
 *    长期约定，随每轮请求发给上游，而不是每次靠人现口头复述。只在接入工程时读
 *    一次并截断，避免把整个仓库说明塞进上下文。
 * 2) 计划模式：只出方案不落盘。模型仍可用 @@read 看真实文件，但程序会跳过
 *    它输出的 file: 块——先对齐方案，再开写，这是 Claude Code plan mode 的
 *    本工具版本（本工具没有终端，所以计划里不能承诺“跑测试验证”）。
 */

export const PROJECT_MEMORY_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

/** 项目记忆进上下文的字符上限：超了就截断并明说，避免看起来完整实际被腰斩 */
export const MAX_PROJECT_MEMORY_CHARS = 8000;

export function truncateProjectMemory(body: string): string {
  const text = body.trim();
  if (text.length <= MAX_PROJECT_MEMORY_CHARS) return text;
  return (
    text.slice(0, MAX_PROJECT_MEMORY_CHARS) +
    `\n\n/* 项目记忆已截断：原文 ${text.length} 字符，只取前 ${MAX_PROJECT_MEMORY_CHARS} 字符 */`
  );
}

/** 拼进系统消息的项目记忆；没内容返回空串，调用方不发空系统消息 */
export function buildProjectMemoryPrompt(source: string, body: string): string {
  const text = truncateProjectMemory(body);
  if (!text) return "";
  return `项目记忆（${source}）：\n${text}`;
}

/** 计划模式的系统指令：放在所有系统消息最后，离用户消息最近，服从度最高 */
export function buildPlanPrompt(): string {
  return [
    "计划模式（只出方案，不落盘）：",
    "本轮只输出方案，不要输出 ```file:路径 代码块——程序会直接跳过这类块，不会写入磁盘。",
    "方案里写清：要改哪些文件、每个文件改什么、改动顺序、风险点、以及哪些结论还无法验证。",
    "需要事实时继续用 @@read: 路径 读真实文件，不要凭猜测写路径或内容。",
    "不要承诺你做不到的事：计划模式下你不能写文件、不能跑命令；需要验证的步骤要写成给人执行的清单。工具调用开启且不在计划模式时，run_command 可以跑白名单测试命令，那时以工具返回的真实输出为准，不要凭空编造。",
  ].join("\n");
}
