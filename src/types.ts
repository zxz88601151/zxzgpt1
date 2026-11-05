/** 会话、消息、设置的类型定义。字段与 localStorage(`zxz.state.v1`) 的历史结构保持一致。 */

export type Role = "user" | "assistant";

/** 一次工具调用及其执行结果：挂在助手消息上，渲染成工具日志；
 *  下一轮发给上游时由 buildMessages 展开成 assistant tool_calls + tool 消息 */
export interface ToolCallRecord {
  id: string;
  name: string;
  /** 原始 JSON 参数串（发给上游时原样回填，不重新序列化，避免改动模型给的格式） */
  arguments: string;
  /** 执行成功时的结果文本（已截断） */
  result?: string;
  /** 执行失败时的错误文案 */
  error?: string;
}

export interface Message {
  role: Role;
  content: string;
  /** 本条助手消息发起的工具调用（含结果），没有表示本轮没调工具 */
  toolCalls?: ToolCallRecord[];
  /** 思维链（DeepSeek-reasoner / o 系列等） */
  reasoning?: string;
  model?: string;
  createdAt: number;
  /** 请求失败时的错误文案，渲染成红色引用块 */
  error?: string;
  usage?: Usage;
  /** 正在流式接收（不落盘，仅内存态） */
  streaming?: boolean;
  /** 本地工程模式：这条回复自动落盘的结果 */
  files?: FileWriteResult[];
  /** 本次实际加载了哪些技能（id），显示在消息尾部，方便回溯输出为什么是这个风格 */
  skills?: string[];
  /** 程序注入的工具结果（读文件回传），不渲染成用户消息 */
  hidden?: boolean;
}

export interface FileWriteResult {
  path: string;
  ok: boolean;
  bytes?: number;
  /** true = 新建，false = 覆盖 */
  created?: boolean;
  error?: string;
  /** 覆盖前的旧内容备份在工程内的相对路径（新建文件没有） */
  backup?: string;
  /** 落盘后回读校验：true = 回读内容与写入内容一致，false = 不一致或回读失败 */
  verified?: boolean;
  /** 相比旧版的增删行数，用于回执上显示 +N −N */
  add?: number;
  del?: number;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export type Theme = "dark" | "light";

/** 本地工程目录：选中后模型输出的 file: 代码块可以一键落盘 */
export interface Workspace {
  /** Rust 登记的会话号：所有文件/命令操作只认它，root 不再参与任何 IPC */
  sessionId: string;
  /** 展示用根目录（Rust canonicalize 后的值），只给人看，不能再传给文件 IPC */
  root: string;
  name: string;
  /** 给模型看的目录树快照（深度 2，忽略依赖与构建产物） */
  tree: string;
  /** 接入时从工程根读到的项目记忆（CLAUDE.md / AGENTS.md），没有为 null */
  memory?: string | null;
  /** 项目记忆来自哪个文件 */
  memorySource?: string | null;
}

export interface Settings {
  preset: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number | null;
  contextTurns: number;
  systemPrompt: string;
  stream: boolean;
  theme: Theme;
  /** 未选择工程目录时为 null */
  workspace: Workspace | null;
  /** 启用的技能 id（内建 + 本地技能库） */
  skills: string[];
  /** 按用户这句话的触发词自动补技能 */
  skillAuto: boolean;
  /** 外部技能库目录；未接入为 null */
  skillsDir: string | null;
  /** 计划模式：只出方案，程序跳过 file: 块不落盘（默认关，老设置缺字段时按关处理） */
  planMode?: boolean;
  /** 写入前确认：file: 块先弹差异面板，批了才写盘（默认关，保持老版自动落盘约定） */
  confirmWrites?: boolean;
  /** 工具调用：模型可用 read/list/search/write/run 五个工具（默认开；关了回到纯文本 file:/@@read 协议） */
  toolCalls?: boolean;
  /** 自动测试回路：写完文件后自动跑一次 npm test，失败把报错回传给模型再改，最多 3 轮（**默认关**，必须显式开；仅桌面端、仅工具调用开启时生效） */
  autoTest?: boolean;
  /** 探索模式开关（C1 只负责存取这个开关；只读拦截行为属 A2，不在本批）。
   *  缺省 undefined 按关处理，老设置无此字段兼容 */
  exploreMode?: boolean;
  /** 子代理模型：explore 工具触发子代理时用的模型名。复用主对话的 baseUrl/apiKey，只换 model。
   *  空/未设置 = 不启用子代理（explore 工具会拒绝并提示先配）。 */
  subagentModel?: string;
}

export interface AppState {
  settings: Settings;
  conversations: Conversation[];
  activeId: string | null;
}

/** 发给上游的一条消息：tool_calls / tool_call_id 只在工具调用轮次出现，
 *  普通消息不带这两个字段，上游按普通 chat 处理 */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** 统一事件：Rust 代理与浏览器直连都归一到这个形状 */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "error"; message: string }
  | { type: "done" }
  /** 流式 tool_calls 的一个增量片：前端按 index 累计，流结束时再合成完整调用 */
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  /** 非流式一次返回的完整工具调用列表 */
  | { type: "tool_calls"; calls: { id: string; name: string; arguments: string }[] };

export type TransportMode = "proxy" | "direct";

export interface Transport {
  mode: TransportMode;
  port: number;
  token: string;
}

export interface Preset {
  id: string;
  name: string;
  base: string;
  models: string[];
  defaultModel: string;
  /** 本地部署（如 Ollama）不校验 Key */
  noKey?: boolean;
}

export interface ModelListResult {
  ok: boolean;
  models: string[];
  message?: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
}
