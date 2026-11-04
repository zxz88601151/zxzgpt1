import type { Preset, Settings } from "./types";

/** 八家常见 OpenAI 兼容服务商 + 自定义 */
export const PRESETS: Preset[] = [
  {
    id: "openai",
    name: "OpenAI",
    base: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    defaultModel: "gpt-4o-mini",
  },
  {
    id: "deepseek",
    name: "DeepSeek 深度求索",
    base: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
  },
  {
    id: "moonshot",
    name: "Moonshot 月之暗面",
    base: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    defaultModel: "moonshot-v1-32k",
  },
  {
    id: "bigmodel",
    name: "智谱 BigModel",
    base: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-flash", "glm-4-plus", "glm-4-air"],
    defaultModel: "glm-4-flash",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow 硅基流动",
    base: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen2.5-72B-Instruct", "deepseek-ai/DeepSeek-V3"],
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
  },
  {
    id: "dashscope",
    name: "阿里云百炼（兼容模式）",
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
    defaultModel: "qwen-plus",
  },
  {
    id: "volcengine",
    name: "火山方舟",
    base: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-pro-32k", "doubao-lite-32k"],
    defaultModel: "doubao-pro-32k",
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    base: "http://localhost:11434/v1",
    models: ["qwen2.5:7b", "llama3.1:8b"],
    defaultModel: "qwen2.5:7b",
    noKey: true,
  },
  { id: "custom", name: "自定义（OpenAI 兼容）", base: "", models: [], defaultModel: "" },
];

export const DEFAULT_SETTINGS: Settings = {
  preset: "openai",
  baseUrl: PRESETS[0].base,
  apiKey: "",
  model: PRESETS[0].defaultModel,
  temperature: 0.7,
  maxTokens: null,
  contextTurns: 10,
  systemPrompt: "",
  stream: true,
  theme: "dark",
  workspace: null,
  skills: [],
  skillAuto: true,
  skillsDir: null,
  planMode: false,
  confirmWrites: false,
  toolCalls: true,
  // 写完自动跑测试默认关：npm test 会执行工程 package.json 里写死的脚本，
  // 而这文件可能是模型刚写的，默认开等于默认允许自动执行未经人审的命令。
  autoTest: false,
  // 探索模式默认关；A2 已实施：开后模型只能调只读三件套，写/跑命令在发工具定义
  // 与执行层两道门拦截，file: 块也不落盘；查完要改请先关掉它。
  exploreMode: false,
};

/** 空会话时的引导卡片 */
export const WELCOME_CHIPS = [
  { title: "帮我梳理思路", body: "用要点列出我要解决这个问题的关键步骤" },
  { title: "写一段代码", body: "用 Python 写一个读取 CSV 并统计缺失值的脚本，带注释" },
  { title: "解释一个概念", body: "用通俗的话解释什么是向量数据库，再给出使用场景" },
  { title: "润色一段文字", body: "把下面这段话改得更简洁专业：（粘贴你的内容）" },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
