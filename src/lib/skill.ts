/** 可插拔技能：解析 `SKILL.md`、拼提示词、按触发词匹配、处理 `@@ref` 取用指令。
 *
 * 格式与 Agent Skills 规范一致，第三方技能仓库可以直接丢进技能目录：
 *
 *   ---
 *   name: react-ts
 *   description: React 18 + TypeScript 组件规范，写组件时加载
 *   triggers: [react, 组件, hooks]
 *   version: 1.0.0
 *   ---
 *   # 正文（给模型看的规则）
 *
 * 目录约定：`<技能库>/<id>/SKILL.md`，可带 `refs/*.md` 等附件，正文里用
 * `@@ref: <id>/refs/xxx.md` 让程序按需回传，避免一上来塞满上下文。
 * 所有函数都是纯逻辑，不碰 IPC，方便单测。
 */

import { normalizeRelPath, relPathError } from "./files";

/** 流水线阶段：技能库与来源清单共用一套，方便两边对着看 */
export type Stage = "plan" | "write" | "test" | "review" | "ship" | "infra" | "release" | "other";

export const STAGE_ORDER: Stage[] = ["plan", "write", "test", "review", "ship", "infra", "release", "other"];

export const STAGE_LABEL: Record<Stage, string> = {
  plan: "需求与计划",
  write: "写代码",
  test: "验证与测试",
  review: "审查与安全",
  ship: "交付与部署",
  infra: "基础设施",
  release: "发版与回滚",
  other: "其它",
};

/** 把任意写法收窄到合法阶段，认不出来就归到 other，不要凭猜分类 */
export function asStage(raw: string | undefined): Stage {
  const t = (raw || "").trim().toLowerCase();
  if ((STAGE_ORDER as string[]).includes(t)) return t as Stage;
  const alias: Record<string, Stage> = {
    写: "write",
    开发: "write",
    编码: "write",
    测试: "test",
    审查: "review",
    部署: "ship",
    发布: "release",
    发版: "release",
    需求: "plan",
    基础设施: "infra",
  };
  return alias[t] || "other";
}

export interface Skill {
  /** 目录名（外部）或内建 id，唯一键 */
  id: string;
  name: string;
  description: string;
  /** 命中即自动加载的关键词 */
  triggers: string[];
  version?: string;
  /** 一级分类（前端 / 后端 / 质量 / 安全 …），面板按它分组 */
  category: string;
  /** 属于流水线的哪个环节 */
  stage: Stage;
  source: "builtin" | "local";
  /** 外部技能所在绝对目录；内建技能为 null */
  dir: string | null;
  /** markdown 正文（已去掉 frontmatter） */
  body: string;
}

/** 单次最多加载几个技能的正文：越多越容易互相冲突，也越烧 token */
export const MAX_ACTIVE_SKILLS = 3;
/** 单个技能正文进上下文的上限 */
export const MAX_SKILL_BODY = 12000;
/** 一轮里最多按需取几个附件 */
export const MAX_SKILL_REFS = 4;
/** 自动匹配一次最多补几个 */
export const MAX_AUTO_MATCH = 2;
/** 目录列表里描述的截断长度 */
const CATALOG_DESC_CHARS = 110;

const REF_RE = /^[ \t]*@@(?:ref|skill)[ \t]*:?[ \t]*([^\n`]+?)[ \t]*$/gim;

/* ---------------------------------------------------------------- frontmatter */

export interface Frontmatter {
  data: Record<string, string | string[]>;
  /** frontmatter 之后的正文 */
  body: string;
}

/**
 * 解析 `---` 包裹的极简 YAML：只支持 `key: value`、`key: [a, b]`、
 * 以及 `key:` 换行接 `- item` 的列表。支持带引号的值。
 * 没有 frontmatter 或没有收尾分隔符时，整段当作正文（宁可少解析，也不要吞内容）。
 */
export function parseFrontmatter(text: string): Frontmatter {
  const raw = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!/^---[ \t]*\n/.test(raw)) return { data: {}, body: raw.trim() };

  const start = raw.indexOf("\n") + 1;
  const close = raw.indexOf("\n---", start - 1);
  if (close < 0) return { data: {}, body: raw.trim() };

  const head = raw.slice(start, close);
  const rest = raw.slice(close + 4);
  const body = rest.replace(/^[ \t]*\n/, "").replace(/\s+$/, "");

  const data: Record<string, string | string[]> = {};
  let listKey = "";
  for (const line of head.split("\n")) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const prev = data[listKey];
      const arr = Array.isArray(prev) ? prev : [];
      arr.push(unquote(item[1].trim()));
      data[listKey] = arr;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (!value) {
      data[key] = [];
      listKey = key;
      continue;
    }
    listKey = "";
    data[key] = value.startsWith("[") ? splitInlineList(value) : unquote(value);
  }
  return { data, body };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function splitInlineList(s: string): string[] {
  const inner = s.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  const out: string[] = [];
  let buf = "";
  let quote = "";
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = "";
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function asText(v: string | string[] | undefined): string {
  if (!v) return "";
  return Array.isArray(v) ? v.join(" ") : v;
}

function asList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

/* ---------------------------------------------------------------- 解析一个技能 */

export type ParseResult = { ok: true; skill: Skill } | { ok: false; error: string };

/** 目录名 → 技能 id：只留安全字符，大写转小写 */
export function sanitizeSkillId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
}

/**
 * 把一份 `SKILL.md` 解成技能对象。
 * `id` 取目录名（外部）或内建 id；正文与 description 缺一个都算无效，
 * 因为缺了 description 就没法在目录里让模型知道什么时候该用它。
 */
export function parseSkill(
  text: string,
  opts: { id: string; source: Skill["source"]; dir?: string | null }
): ParseResult {
  const id = sanitizeSkillId(opts.id);
  if (!id) return { ok: false, error: "技能 id 为空（目录名只允许字母数字与 - _ .）" };

  const { data, body } = parseFrontmatter(text);
  if (!body) return { ok: false, error: "正文为空" };

  const description = asText(data.description).trim();
  if (!description) return { ok: false, error: "frontmatter 缺少 description" };

  const name = asText(data.name).trim() || id;
  const triggers = asList(data.triggers ?? data.keywords ?? data.when);
  const version = asText(data.version).trim();
  // 第三方技能多数没有 category/stage，缺省不编造，归到「未分类 / other」
  const category = asText(data.category).trim() || "未分类";
  const stage = asStage(asText(data.stage));

  return {
    ok: true,
    skill: {
      id,
      name,
      description,
      triggers,
      ...(version ? { version } : {}),
      category,
      stage,
      source: opts.source,
      dir: opts.source === "local" ? opts.dir || null : null,
      body,
    },
  };
}

/* ---------------------------------------------------------------- 提示词 */

/** L0：技能目录清单。只有名字和描述，几百毫秒的 token 就能让模型知道有什么可用 */
export function skillCatalogPrompt(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = [
    "【技能库】",
    "你有以下可插拔技能（一组必须遵守的编码规范）。当前只有目录，正文未加载：",
  ];
  for (const s of skills) {
    const desc =
      s.description.length > CATALOG_DESC_CHARS ? s.description.slice(0, CATALOG_DESC_CHARS) + "…" : s.description;
    const hint = s.triggers.length ? `（触发：${s.triggers.slice(0, 6).join("、")}）` : "";
    lines.push(`- ${s.id} · ${s.name}：${desc}${hint}`);
  }
  lines.push(
    "需要某个技能的完整规则时，在回答前单独一行写 `@@ref: <技能id>/SKILL.md`，程序会把正文回传给你；不确定就不加载，别猜规则。"
  );
  return lines.join("\n");
}

/** L1：把已加载技能的正文拼成一段系统提示 */
export function buildSkillPrompt(active: Skill[]): string {
  const list = active.slice(0, MAX_ACTIVE_SKILLS);
  if (!list.length) return "";
  const parts = [
    "【已加载技能 · 本次必须遵守】",
    "下面是用户启用的规范技能。它们比你的通用习惯优先：冲突时按技能写，技能没规定的再按你的判断。",
  ];
  for (const s of list) {
    const body =
      s.body.length > MAX_SKILL_BODY
        ? s.body.slice(0, MAX_SKILL_BODY) + `\n\n（正文已截断：原 ${s.body.length} 字符，需要细节请 @@ref: ${s.id}/SKILL.md）`
        : s.body;
    parts.push(`\n===== 技能 ${s.id}｜${s.name} =====\n${body}`);
  }
  parts.push(
    "\n【执行要求】",
    "1. 写代码前先对照技能里的「硬规则」，逐条落实；不要只在开头说一句「我会遵守」就算完",
    "2. 技能要求「先读文件」时，先用 @@read 拿真实内容，不要凭记忆改",
    "3. 收尾用 1-3 句话说明这次具体按哪几条规则做的，不要复述技能原文",
    "4. 技能里明确禁止的写法，一律不要出现在输出的文件里"
  );
  return parts.join("\n");
}

/* ---------------------------------------------------------------- 触发词匹配 */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 中文直接子串匹配；英文/符号按词边界匹配，避免 `go` 命中 `django` 这种误触 */
function hits(hay: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  if (/[^\x00-\x7f]/.test(n)) return hay.includes(n);
  const re = new RegExp(`(^|[^a-z0-9_])${escapeRe(n)}([^a-z0-9_]|$)`);
  return re.test(hay);
}

/**
 * 按用户这句话自动挑技能。命中数多的优先，同分保持原顺序；
 * 已启用的不重复挑，最多补 MAX_AUTO_MATCH 个。
 */
export function matchSkills(skills: Skill[], text: string, active: string[] = [], limit = MAX_AUTO_MATCH): Skill[] {
  const hay = text.toLowerCase();
  if (!hay.trim()) return [];
  const picked: { skill: Skill; score: number; at: number }[] = [];
  skills.forEach((s, at) => {
    if (active.includes(s.id)) return;
    let score = 0;
    for (const t of s.triggers) if (hits(hay, t)) score += 1;
    if (score === 0 && hits(hay, s.id)) score += 1;
    if (score > 0) picked.push({ skill: s, score, at });
  });
  return picked
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, Math.max(0, limit))
    .map((p) => p.skill);
}

/* ---------------------------------------------------------------- @@ref 取用 */

export interface SkillRef {
  skillId: string;
  rel: string;
}

/**
 * 解析模型写的 `@@ref: <技能id>/<相对路径>`。
 * skillId 里不允许再有斜杠，rel 走与落盘同一套路径校验。
 */
export function parseSkillRefs(text: string): SkillRef[] {
  const re = new RegExp(REF_RE.source, "gim");
  const out: SkillRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = normalizeRelPath(m[1]);
    if (!raw) continue;
    const slash = raw.indexOf("/");
    const skillId = sanitizeSkillId(slash < 0 ? raw : raw.slice(0, slash));
    const rel = slash < 0 ? "SKILL.md" : raw.slice(slash + 1);
    if (!skillId) continue;
    if (relPathError(rel)) continue;
    if (out.some((r) => r.skillId === skillId && r.rel === rel)) continue;
    out.push({ skillId, rel });
  }
  return out.slice(0, MAX_SKILL_REFS);
}

/** 剥掉 `@@ref` 行：这是给程序看的指令，不该出现在对话里 */
export function stripSkillRefs(text: string): string {
  return text.replace(new RegExp(REF_RE.source, "gim"), "").replace(/\n{3,}/g, "\n\n").trim();
}

/** 对外部技能取附件时的标签，回传内容和工程文件区分开 */
export function skillRefLabel(ref: SkillRef): string {
  return `技能 ${ref.skillId}/${ref.rel}`;
}

/* ---------------------------------------------------------------- 分组 */

/** 已知分类的展示顺序；没列到的分类排在后面，按名称排在最后 */
const CATEGORY_ORDER = ["通用", "前端", "后端", "数据", "质量", "安全", "设计", "文档", "未分类"];

export interface SkillGroup {
  /** 分类名，未填就是「未分类」 */
  key: string;
  skills: Skill[];
}

/**
 * 按分类分组，组内按流水线阶段再按名称排。
 * 只做展示排序，不改 id 顺序——启用列表仍按用户勾选顺序走。
 */
export function groupSkills(skills: Skill[]): SkillGroup[] {
  const map = new Map<string, Skill[]>();
  for (const s of skills) {
    const arr = map.get(s.category);
    if (arr) arr.push(s);
    else map.set(s.category, [s]);
  }
  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i < 0 ? CATEGORY_ORDER.length : i;
  };
  return [...map.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], "zh"))
    .map(([key, list]) => ({
      key,
      skills: list
        .slice()
        .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.name.localeCompare(b.name, "zh")),
    }));
}
