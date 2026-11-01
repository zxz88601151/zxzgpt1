/** 外部来源登记表：把「清单里看到的仓库」变成可审计的条目。
 *
 * 这里只登记「这个仓库是什么、能不能挂进技能库、审计时要查什么」，
 * 不放它的任何正文——技能内容仍然只从你磁盘上的 SKILL.md 读，
 * 免得变成把别人的仓库抄进来。
 *
 * `checked` 是核实程度，不要为了好看写成已核实：
 *   api  = 调 GitHub API 拿到了语言/星数/许可/最后推送
 *   web  = 只确认仓库页面存在（当时 API 被限速）
 *   none = 还没核实
 */

import type { Stage } from "../lib/skill";

export type SourceKind = "skill" | "mcp" | "action" | "framework" | "app" | "reference";

/** attach 才是本项目能直接挂的：一个目录 + SKILL.md */
export type Hook = "attach" | "mcp" | "action" | "readonly";

export type Batch = "pipeline" | "hot" | "earlier";

export interface SourceFacts {
  stars?: number;
  lang?: string | null;
  license?: string | null;
  /** 最后推送日期 YYYY-MM-DD */
  pushed?: string;
  /** 仓库已改名，实际地址是这个 */
  movedTo?: string;
}

export interface SourceEntry {
  /** 用 owner/repo 当唯一键 */
  id: string;
  name: string;
  kind: SourceKind;
  stage: Stage;
  hook: Hook;
  /** 一句话：它是干什么的 */
  what: string;
  /** 审计时要逐条确认的点，写成肯定句式的检查项 */
  audit: string[];
  checked: "api" | "web" | "none";
  /** 会动远端、凭证或基础设施，装之前必须先读 */
  risk?: "high";
  facts?: SourceFacts;
  batch: Batch;
}

export const KIND_LABEL: Record<SourceKind, string> = {
  skill: "技能包",
  mcp: "MCP 服务",
  action: "CI 动作",
  framework: "框架",
  app: "独立应用",
  reference: "资料库",
};

export const HOOK_LABEL: Record<Hook, string> = {
  attach: "可接入技能库",
  mcp: "需 MCP 宿主",
  action: "需 CI 环境",
  readonly: "仅参考",
};

export const BATCH_LABEL: Record<Batch, string> = {
  pipeline: "写代码 → 成品（10 条）",
  hot: "开源热榜（10 条）",
  earlier: "上批清单里的技能仓（9 条）",
};

/** 2026-11-01 核实；星数与最后推送会变，审计时以仓库当时状态为准 */
export const SOURCES: SourceEntry[] = [
  /* ---------------------------------------------------- 流水线批 */
  {
    id: "obra/superpowers",
    name: "superpowers",
    kind: "skill",
    stage: "write",
    hook: "attach",
    what: "强制 TDD 的开发工作流：没先写失败测试就不写正式代码，另含系统化调试与多视角评审。",
    audit: [
      "SKILL.md 是在要求真的先跑测试，还是只在描述里提一句",
      "是否含分支收尾 / 提交 / 推送这类会改 git 状态的步骤",
      "触发词覆盖是否过宽（会把其它技能挤掉，最多只能同时挂 3 个）",
    ],
    checked: "api",
    facts: { stars: 310163, lang: "Shell", license: "MIT", pushed: "2026-10-29" },
    batch: "pipeline",
  },
  {
    id: "addyosmani/agent-skills",
    name: "agent-skills（Addy Osmani）",
    kind: "skill",
    stage: "plan",
    hook: "attach",
    what: "25 个工程技能，从需求分析、写 PRD、增量开发、TDD、调试、五维评审一直到 /ship 上线。",
    audit: [
      "逐个看 25 个技能的 description 有没有写清输出物，只写「做得更好」的没有价值",
      "/ship 类技能是否要求 token 或改 CI 配置",
      "「反偷懒表」能否抽成一条通用规则并入 code-style",
    ],
    checked: "api",
    risk: "high",
    facts: { stars: 112283, lang: "JavaScript", license: "MIT", pushed: "2026-10-31" },
    batch: "pipeline",
  },
  {
    id: "mattpocock/skills",
    name: "skills（Matt Pocock）",
    kind: "skill",
    stage: "test",
    hook: "attach",
    what: "tdd 技能：先列出测试的公共边界（seam）与人确认，只测行为不测实现。",
    audit: [
      "是否有「先问用户确认 seam」的交互步骤——本项目单轮生成，遇到提问会停住",
      "是否绑定特定测试框架命令（vitest/jest），与本项目工具链是否冲突",
      "生成用例是否带断言，而不是只给测试名称",
    ],
    checked: "api",
    facts: { stars: 308555, lang: "Shell", license: "MIT", pushed: "2026-10-31" },
    batch: "pipeline",
  },
  {
    id: "anthropics/skills",
    name: "skills（Anthropic 官方）",
    kind: "skill",
    stage: "test",
    hook: "attach",
    what: "官方技能库与规范来源；其中 webapp-testing 让 agent 用 Playwright 真开本地页面、点按钮、截图、读日志。",
    audit: [
      "API 返回的 license 字段为空，分发前要确认仓库实际许可",
      "webapp-testing 需要本机装有 Playwright 与浏览器，本项目没内置，先只当参考",
      "spec/ 与 template/ 是本项目解析器的对照源，格式变更要跟进",
    ],
    checked: "api",
    facts: { stars: 185969, lang: "Python", license: null, pushed: "2026-10-28" },
    batch: "pipeline",
  },
  {
    id: "garrytan/gstack",
    name: "gstack",
    kind: "skill",
    stage: "review",
    hook: "attach",
    what: "一整套角色化命令：/qa 用无头浏览器真测、/cso 做 OWASP + STRIDE 安全审计、/ship 带监控发布。",
    audit: [
      "/ship 与 /cso 会碰发布与安全边界，装之前逐行读，必要时只留 /qa",
      "是否依赖 gstack 自带的脚本或二进制，没有就无法执行",
      "角色命令是否假设了可交互确认，本项目跑不了交互",
    ],
    checked: "api",
    risk: "high",
    facts: { stars: 138497, lang: "TypeScript", license: "MIT", pushed: "2026-11-01" },
    batch: "pipeline",
  },
  {
    id: "vercel-labs/agent-skills",
    name: "agent-skills（Vercel）",
    kind: "skill",
    stage: "ship",
    hook: "attach",
    what: "Vercel 官方技能库：deploy-to-vercel 可直接建预览部署，另有 React 最佳实践与组合模式。",
    audit: [
      "deploy 技能必须有 Vercel token 才能跑，本项目无凭证管理，默认不启用",
      "React 最佳实践部分与内建 react-ts 有重叠，同时挂会互相抢规则",
      "API 的 license 为空，转发前确认许可",
    ],
    checked: "api",
    risk: "high",
    facts: { stars: 33317, lang: "JavaScript", license: null, pushed: "2026-10-28" },
    batch: "pipeline",
  },
  {
    id: "anthropics/claude-code-action",
    name: "claude-code-action",
    kind: "action",
    stage: "ship",
    hook: "action",
    what: "GitHub Actions 集成：在 PR / Issue 里 @ 一下让 agent 跑评审、修 CI、处理反馈。",
    audit: [
      "它是 workflow 而不是技能，只能作为 CI 侧参考，不能挂进技能库",
      "需要 ANTHROPIC_API_KEY 等仓库 secret，注意别在 fork PR 上暴露",
      "仓库描述为空，用途以 README 为准",
    ],
    checked: "api",
    facts: { stars: 9733, lang: "TypeScript", license: "MIT", pushed: "2026-10-31" },
    batch: "pipeline",
  },
  {
    id: "github/github-mcp-server",
    name: "github-mcp-server",
    kind: "mcp",
    stage: "ship",
    hook: "mcp",
    what: "GitHub 官方 MCP 服务，给 agent 直接操作仓库、PR、Actions 的能力。",
    audit: [
      "本项目没有 MCP 客户端，挂不上；要用得先加 MCP 宿主层",
      "它的权限来自 GitHub token，最小权限原则要写清（只读还是可写）",
      "若将来接入，必须限制可操作仓库范围并留审计日志",
    ],
    checked: "api",
    facts: { stars: 34131, lang: "Go", license: "MIT", pushed: "2026-10-30" },
    batch: "pipeline",
  },
  {
    id: "hashicorp/agent-skills",
    name: "agent-skills（HashiCorp）",
    kind: "skill",
    stage: "infra",
    hook: "attach",
    what: "Terraform 相关技能：terraform-style 写法规范、terraform-testing 测试方法。",
    audit: [
      "技能正文里是否夹带 terraform apply / destroy 之类会改真实基础设施的指令",
      "HCL 示例的版本约束是否过期（provider 版本漂移会让示例直接失败）",
      "MPL-2.0 许可，二次分发要保留声明",
    ],
    checked: "api",
    risk: "high",
    facts: { stars: 911, lang: "HCL", license: "MPL-2.0", pushed: "2026-10-28" },
    batch: "pipeline",
  },
  {
    id: "ruvnet/claude-flow",
    name: "claude-flow（已改名 ruflo）",
    kind: "framework",
    stage: "release",
    hook: "readonly",
    what: "多 agent 编排框架，带 release-management 技能：语义化版本、changelog、蓝绿/金丝雀发布与自动回滚。",
    audit: [
      "仓库已改名为 ruvnet/ruflo，清单里的旧地址会 301，clone 要用新地址",
      "它是框架不是技能包，编排能力无法直接搬；只参考它的发版流程设计",
      "回滚策略依赖它自己的运行器，别把「自动回滚」当成已有能力写进文档",
    ],
    checked: "web",
    facts: { movedTo: "ruvnet/ruflo" },
    batch: "pipeline",
  },

  /* ---------------------------------------------------- 热榜批 */
  {
    id: "deepseek-ai/dsh-superagent-prototype",
    name: "dsh-superagent-prototype",
    kind: "app",
    stage: "write",
    hook: "readonly",
    what: "DeepSeek 的自主编程智能体原型：对单仓库跑后台编程会话，通过 PR 与 Issue 评论与人沟通。",
    audit: [
      "是独立运行时，不是技能；只能借鉴它在 PR 上留痕的交互设计",
      "它需要自己的 harness 与仓库权限，与本项目定位不同",
      "开源时间很短，接口与行为可能还会变",
    ],
    checked: "api",
    facts: { stars: 3549, lang: "TypeScript", license: "MIT", pushed: "2026-10-31" },
    batch: "hot",
  },
  {
    id: "Donchitos/Claude-Code-Game-Studios",
    name: "Claude-Code-Game-Studios",
    kind: "skill",
    stage: "write",
    hook: "attach",
    what: "把一次会话变成游戏工作室：49 个角色 agent、74 个技能，按总监/组长/专家三层分工，覆盖 Godot、Unity、Unreal。",
    audit: [
      "74 个技能一次全挂会互相冲突，只能挑与本项目相关的 2-3 个",
      "角色 prompt 里是否写死引擎版本或资产路径",
      "是否有生成二进制资产、调用引擎 CLI 的步骤（本项目跑不了）",
    ],
    checked: "api",
    facts: { stars: 31302, lang: "Shell", license: "MIT", pushed: "2026-10-19" },
    batch: "hot",
  },
  {
    id: "THU-MAIC/OpenMAIC",
    name: "OpenMAIC",
    kind: "app",
    stage: "other",
    hook: "readonly",
    what: "清华团队的多智能体互动课堂：给一个主题或文档，生成 AI 老师与同学授课的课堂，可导出 PPTX / 离线 HTML。",
    audit: [
      "它是独立应用（服务端架构），不产生 SKILL.md，不能挂进技能库",
      "v1.2.0 起改为服务端架构，本地跑需要额外服务",
      "与本项目的「本地单机、自配 Key」定位不一致，只作参考",
    ],
    checked: "api",
    facts: { stars: 42254, lang: "TypeScript", license: "MIT", pushed: "2026-10-31" },
    batch: "hot",
  },
  {
    id: "jakubkrehel/skills",
    name: "skills（界面设计）",
    kind: "skill",
    stage: "write",
    hook: "attach",
    what: "界面设计技能包：better-ui、better-typography、better-colors、better-accessibility 各管一块。",
    audit: [
      "设计类规则容易和现有 UI 冲突，启用时只挑一条（例如只挂 typography）",
      "规则是否给具体数值（字阶、间距），只写「更好看」的没有约束力",
      "是否会要求引入设计 token 文件或外部依赖",
    ],
    checked: "api",
    facts: { stars: 9648, lang: "Markdown", license: "MIT", pushed: "2026-10-25" },
    batch: "hot",
  },
  {
    id: "AstrBotDevs/AstrBot",
    name: "AstrBot",
    kind: "app",
    stage: "other",
    hook: "readonly",
    what: "把 AI 助手接进 QQ / Telegram / Discord / 飞书的机器人平台，带插件市场、知识库与 Web 面板。",
    audit: [
      "独立平台，不是技能；接入意味着再跑一套服务与数据库",
      "AGPL-3.0，改动后分发有传染性，注意合规",
      "与「无账号、本地自用」定位冲突，仅作参考",
    ],
    checked: "api",
    facts: { stars: 45378, lang: "Python", license: "AGPL-3.0", pushed: "2026-10-31" },
    batch: "hot",
  },
  {
    id: "Arjun-Ingole/hop",
    name: "hop",
    kind: "app",
    stage: "other",
    hook: "readonly",
    what: "Windows 小工具：不用 U 盘在 Windows 旁边装 Linux，选系统、拖分区、点安装。",
    audit: [
      "与编程技能无关，登记只为核对清单完整性",
      "会改分区表，属于高风险操作，不做任何自动化尝试",
    ],
    checked: "api",
    facts: { stars: 795, lang: "PowerShell", license: "MIT", pushed: "2026-11-01" },
    batch: "hot",
  },
  {
    id: "bregman-arie/devops-exercises",
    name: "devops-exercises",
    kind: "reference",
    stage: "infra",
    hook: "readonly",
    what: "DevOps 题库：Linux、网络、Docker、K8s、CI/CD、云原生的面试题与实操练习。",
    audit: [
      "是学习资料，不是技能；可作为 infra 类技能的规则来源",
      "许可为 NOASSERTION，引用内容前先看仓库 LICENSE 原文",
      "最后推送在一年前，部分云厂商细节可能过时",
    ],
    checked: "api",
    facts: { stars: 86083, lang: "Python", license: "NOASSERTION", pushed: "2025-12-27" },
    batch: "hot",
  },
  {
    id: "vorssaint/vorssaint-utils",
    name: "vorssaint-utils",
    kind: "app",
    stage: "other",
    hook: "readonly",
    what: "macOS 菜单栏工具箱：分应用音量、系统监控、窗口切换、剪贴板、卸载器、录屏。",
    audit: [
      "macOS 应用，与本项目（Windows 桌面）无交集",
      "登记价值仅在于：它的功能清单可作本项目工具面板的参考",
    ],
    checked: "web",
    batch: "hot",
  },
  {
    id: "mizorewww/gdirect",
    name: "gdirect",
    kind: "app",
    stage: "other",
    hook: "readonly",
    what: "终端里的 Google Drive 客户端：浏览、下载、上传、挂载，自动扫描可用 IP，多连接断点续传。",
    audit: [
      "独立 CLI，不是技能；与技能库无关",
      "涉及账号凭证与网络代理，不做自动化集成",
    ],
    checked: "web",
    batch: "hot",
  },
  {
    id: "aschmelyun/print-my-profile-pic",
    name: "print-my-profile-pic",
    kind: "app",
    stage: "other",
    hook: "readonly",
    what: "趣味项目：点 Star 后作者的小票打印机会打印你的头像。",
    audit: ["与技能库无关，登记只为清单完整"],
    checked: "web",
    batch: "hot",
  },

  /* ---------------------------------------------------- 上批清单里的技能仓 */
  {
    id: "anthropics/knowledge-work-plugins",
    name: "knowledge-work-plugins",
    kind: "skill",
    stage: "other",
    hook: "attach",
    what: "Anthropic 的知识工作插件集，以插件目录组织，含多份技能与命令。",
    audit: [
      "插件目录结构与本项目的「一目录一 SKILL.md」不同，要确认能否直接扫",
      "含命令（slash command）定义，本项目不支持，加载时只取技能部分",
    ],
    checked: "web",
    batch: "earlier",
  },
  {
    id: "android/skills",
    name: "skills（Android）",
    kind: "skill",
    stage: "write",
    hook: "attach",
    what: "Android 官方技能集，面向 Android 应用开发规范。",
    audit: [
      "只对 Android 工程有用，与当前 Web 技术栈不同，默认不启用",
      "确认技能是否依赖 Android Studio / gradle 命令",
    ],
    checked: "web",
    batch: "earlier",
  },
  {
    id: "expo/skills",
    name: "skills（Expo）",
    kind: "skill",
    stage: "write",
    hook: "attach",
    what: "Expo / React Native 官方技能集。",
    audit: ["确认与内建 react-ts 的规则重叠程度，避免同时启用", "是否假设 Expo CLI 可用"],
    checked: "web",
    batch: "earlier",
  },
  {
    id: "cloudflare/security-audit-skill",
    name: "security-audit-skill",
    kind: "skill",
    stage: "review",
    hook: "attach",
    what: "多阶段安全审计技能，输出机器可读的审计结论。",
    audit: [
      "读它的阶段划分与结论格式，可作为本项目 security-check 的升级方向",
      "是否要求联网查 CVE 或调用外部 API",
    ],
    checked: "web",
    batch: "earlier",
  },
  {
    id: "wshobson/agents",
    name: "agents（wshobson）",
    kind: "skill",
    stage: "write",
    hook: "attach",
    what: "大量按语言与框架划分的 agent / 技能集合。",
    audit: ["数量大，必须先看目录挑 2-3 个，全挂会互相抢规则", "同 id 会覆盖内建技能，注意别把内建覆盖掉"],
    checked: "web",
    batch: "earlier",
  },
  {
    id: "elayadesign/ai-design-skills",
    name: "ai-design-skills",
    kind: "skill",
    stage: "write",
    hook: "attach",
    what: "面向 UI/视觉的设计技能集合。",
    audit: ["与本项目现有设计 token 是否冲突", "规则是否可验证（有具体数值）而不是审美口号"],
    checked: "web",
    batch: "earlier",
  },
  {
    id: "NVIDIA/SkillSpector",
    name: "SkillSpector",
    kind: "framework",
    stage: "review",
    hook: "readonly",
    what: "给技能本身做安全扫描的工具：检查 SKILL.md 里有没有危险指令。",
    audit: [
      "它审计的是技能，不是代码——正好对应「装之前先读一遍」这一步",
      "是独立工具，需单独运行，不挂进技能库",
    ],
    checked: "web",
    batch: "earlier",
  },
  {
    id: "anthropics/claude-plugins-official",
    name: "claude-plugins-official",
    kind: "framework",
    stage: "other",
    hook: "readonly",
    what: "官方插件市场索引，插件内含技能与命令。",
    audit: ["是市场不是技能，且需要宿主支持插件协议", "与本项目本地加载的定位不同，仅作格式参考"],
    checked: "web",
    batch: "earlier",
  },
  {
    id: "cursor/plugins",
    name: "plugins（Cursor）",
    kind: "framework",
    stage: "other",
    hook: "readonly",
    what: "Cursor 的插件目录。",
    audit: ["插件格式绑定 Cursor 编辑器", "无独立技能价值，登记为不接入"],
    checked: "web",
    batch: "earlier",
  },
];

/** 按阶段分组，空组不出现 */
export function groupSources(entries: SourceEntry[]): { stage: Stage; entries: SourceEntry[] }[] {
  const order: Stage[] = ["plan", "write", "test", "review", "ship", "infra", "release", "other"];
  const out: { stage: Stage; entries: SourceEntry[] }[] = [];
  for (const stage of order) {
    const list = entries.filter((e) => e.stage === stage);
    if (list.length) out.push({ stage, entries: list });
  }
  return out;
}

export interface SourceSummary {
  total: number;
  attach: number;
  /** 需要额外宿主（MCP / CI） */
  hosted: number;
  readonly: number;
  risk: number;
  verified: number;
}

export function summarizeSources(entries: SourceEntry[]): SourceSummary {
  return {
    total: entries.length,
    attach: entries.filter((e) => e.hook === "attach").length,
    hosted: entries.filter((e) => e.hook === "mcp" || e.hook === "action").length,
    readonly: entries.filter((e) => e.hook === "readonly").length,
    risk: entries.filter((e) => e.risk === "high").length,
    verified: entries.filter((e) => e.checked !== "none").length,
  };
}

/** 仓库地址；改过名的用新地址，避免点到 301 */
export function repoUrl(e: SourceEntry): string {
  return `https://github.com/${e.facts?.movedTo || e.id}`;
}

/** clone 命令：改过名的用新仓库名 */
export function cloneCommand(e: SourceEntry): string {
  const target = e.facts?.movedTo || e.id;
  return `git clone --depth 1 https://github.com/${target}.git`;
}

const CHECKED_LABEL: Record<SourceEntry["checked"], string> = {
  api: "已通过 GitHub API 核实",
  web: "仅确认仓库页面存在（API 限流）",
  none: "未核实",
};

/**
 * 生成审计清单 Markdown：给「装之前逐个过一遍」这件事一个可勾选的底稿。
 * 只写我们真实知道的事实，核实程度如实标注。
 */
export function buildAuditMarkdown(
  entries: SourceEntry[],
  opts: { when: string; skills: { id: string; name: string; category: string; stage: Stage }[] }
): string {
  const sum = summarizeSources(entries);
  const lines: string[] = [
    "# 技能来源审计清单",
    "",
    `生成时间：${opts.when}`,
    "",
    "> 这份清单只登记「仓库是什么、能不能接入、要查什么」，不含任何第三方技能正文。",
    "> 技能内容仍从你磁盘上的 SKILL.md 读取；核实程度见每条标注。",
    "",
    "## 汇总",
    "",
    "| 项目 | 数量 |",
    "| --- | --- |",
    `| 登记来源 | ${sum.total} |`,
    `| 可直接接入技能库 | ${sum.attach} |`,
    `| 需额外宿主（MCP / CI） | ${sum.hosted} |`,
    `| 仅参考 | ${sum.readonly} |`,
    `| 高风险（动远端 / 凭证 / 基础设施） | ${sum.risk} |`,
    "",
    `当前技能库内建 ${opts.skills.length} 个技能：`,
    "",
    ...opts.skills.map((s) => `- \`${s.id}\`（${s.category} · ${s.stage}）${s.name}`),
    "",
  ];

  const batches: { key: Batch; list: SourceEntry[] }[] = (["pipeline", "hot", "earlier"] as Batch[]).map((key) => ({
    key,
    list: entries.filter((e) => e.batch === key),
  }));

  for (const b of batches) {
    if (!b.list.length) continue;
    lines.push(`## ${BATCH_LABEL[b.key]}`, "");
    for (const e of b.list) {
      lines.push(`### ${e.kind === "skill" ? "[技能包]" : `[${KIND_LABEL[e.kind]}]`} ${e.id}`, "");
      lines.push(`- 地址：${repoUrl(e)}${e.facts?.movedTo ? `（原 ${e.id}，已改名）` : ""}`);
      lines.push(`- 环节：${e.stage} · 接入方式：${HOOK_LABEL[e.hook]}${e.risk === "high" ? " · **高风险**" : ""}`);
      const f = e.facts;
      const facts: string[] = [];
      if (f?.lang) facts.push(f.lang);
      if (typeof f?.stars === "number") facts.push(`${f.stars} stars`);
      if (f?.license) facts.push(f.license);
      if (f?.pushed) facts.push(`最后推送 ${f.pushed}`);
      if (facts.length) lines.push(`- 仓库事实：${facts.join(" · ")}（2026-11-01）`);
      lines.push(`- 核实：${CHECKED_LABEL[e.checked]}`);
      lines.push(`- 定位：${e.what}`);
      lines.push("- 审计项：");
      for (const a of e.audit) lines.push(`  - [ ] ${a}`);
      if (e.hook === "attach") lines.push("", "```bash", cloneCommand(e), "```");
      lines.push("");
    }
  }
  lines.push("## 接入前统一检查", "");
  for (const item of [
    "SKILL.md 的 name / description 是否齐全（缺 description 的技能本程序会拒载）",
    "正文里有没有 rm -rf、curl | bash、git push、terraform apply 这类会改环境或远端的命令",
    "是否需要网络或凭证（本项目不托管 Key，也不会代为登录）",
    "触发词是否与已启用技能冲突（同时最多 3 个）",
    "vendor 进来的内容许可是否允许再分发",
  ]) {
    lines.push(`- [ ] ${item}`);
  }
  lines.push("");
  return lines.join("\n");
}
