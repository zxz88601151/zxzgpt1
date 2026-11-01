/** 会话、消息、设置的类型定义。字段与 localStorage(`zxz.state.v1`) 的历史结构保持一致。 */

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
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
  root: string;
  name: string;
  /** 给模型看的目录树快照（深度 2，忽略依赖与构建产物） */
  tree: string;
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
}

export interface AppState {
  settings: Settings;
  conversations: Conversation[];
  activeId: string | null;
}

/** 发给上游的一条消息 */
export interface WireMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 统一事件：Rust 代理与浏览器直连都归一到这个形状 */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "error"; message: string }
  | { type: "done" };

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
