/** 本地技能扫描：把「这条技能会不会让我删库 / 推远端 / 漏密钥」变成可查的行号。
 *
 * 和 `src/skills/audit.ts` 的分工：
 *   audit.ts     只描述我 2026-11-01 真拉下来扫过的那 4 个仓库，性质是我人工看上下文定的
 *   本文件        跑在用户自己的技能目录上，只给「第几行写了什么」，性质靠启发式猜
 *
 * **为什么不给危险分**：同一条 `rm -rf` 写在卸载脚本里是风险，写在拦截规则表里是防护。
 * 上一轮实测里 gstack 的 25 个 `rm -rf` 命中，真正会被执行的只有 2 个文件。给一个数字出来，
 * 用户会拿它当结论；分错一次要么删掉一个好技能，要么留下一个坏技能。所以这里只排序、只给原文。
 *
 * 扫描口径：只扫 SKILL.md 正文（也就是会被拼进提示词的那些字），不扫 refs/ 与仓库里的脚本。
 * 这个边界是故意的——脚本不会自己跑，正文会进上下文。
 */

/** 命中在什么语境里。这个判断决定这条命中要不要紧 */
export type FindingKind = "code" | "prose" | "guard";

export const SCAN_KIND_LABEL: Record<FindingKind, string> = {
  code: "代码块里",
  prose: "正文提到",
  guard: "劝阻语境",
};

export interface RiskRule {
  id: string;
  /** 表格里的名字，短 */
  label: string;
  re: RegExp;
  /** 一句话说清后果，显示在命中行下面 */
  why: string;
}

/**
 * 规则表按「能不能一步回不来」排序，不是按常见程度。
 * 每条都给后果而不是给等级——等级要靠上下文判断，后果不需要。
 */
export const RISK_RULES: RiskRule[] = [
  {
    id: "rm-rf",
    label: "递归删除",
    // 必须带 r（-r / -rf / -fr / --recursive）。`rm -f` 只是强制删单个文件，日常操作，
    // 实测里 gstack 的 DOM dump 脚本全是 `rm -f "$_D"`，算进来噪音会盖住真问题。
    // 末尾允许反引号/引号/分号收尾：技能里常写成 `rm -rf`，命令后面紧接着就是反引号
    re: /\brm\s+[^\n]*(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)(?=\s|$|[`"';,)\]])/i,
    why: "进不了回收站；后面那个路径只要拼错一个变量，删的就是别的地方",
  },
  {
    id: "remote-exec",
    label: "远程脚本直跑",
    re: /(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i,
    why: "你没法先看内容，对端随时能把它换成别的东西",
  },
  {
    id: "force-push",
    label: "覆盖远端历史",
    // (?![-\w]) 让 --force-with-lease 不被算进来——它只在自己是最新时放行，是安全的替代写法
    re: /\bgit\s+push\b[^\n]*--force(?![-\w])/i,
    why: "--force 会盖掉别人已推的提交；要覆盖也只用 --force-with-lease",
  },
  {
    id: "reset-hard",
    label: "丢弃未提交改动",
    // reset --hard 与 clean -f 都会让工作区改动直接消失，合成一条
    re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/i,
    why: "改动没进过提交就找不回来，连 reflog 也没有",
  },
  {
    id: "terraform",
    label: "真改基础设施",
    re: /\bterraform\s+(apply|destroy)\b/i,
    why: "apply 动的是线上资源，destroy 会真删；先 plan 看一眼代价最低",
  },
  {
    id: "db-drop",
    label: "删表 / 删库",
    re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
    why: "DDL 多数不能回滚，备份策略没确认之前别跑",
  },
  {
    id: "privilege",
    label: "放开权限",
    // 不把裸 sudo 算进来：镜像构建里的 `sudo apt-get` 一抓一大把，真问题只在这几种
    re: /\bchmod\s+777\b|\bsudo\s+(dd|mkfs|fdisk|tee\s+\/(etc|usr|bin|boot))/i,
    why: "777 等于把文件交给本机所有账号；dd / mkfs 直接写块设备，一步到底",
  },
  {
    id: "publish",
    label: "发到公共仓库",
    re: /\b(npm\s+publish|docker\s+push|cargo\s+publish|twine\s+upload)\b/i,
    why: "发出去收不回，版本号也被占掉；私密内容一进 registry 就是永久公开",
  },
  {
    id: "secrets",
    label: "读 / 写死凭证",
    re: /(printenv\b|(cat|grep|less)\b[^\n]*\.env\b|AWS_SECRET|\bapi[_-]?key\s*[:=]\s*["'][^"']{8,})/i,
    why: "技能让模型去翻 .env，等于把密钥送进下一次请求的上下文",
  },
  {
    id: "eval",
    label: "动态求值",
    // (?<![-\w]) 挡掉 chrome 的 `--eval` 与 `pg.evaluate(` —— 那是调浏览器，不是把字符串当代码跑
    re: /(?<![-\w])eval\s*[("'`$]/i,
    why: "拼进去的字符串会被当代码执行，外部内容一旦进来就是注入点",
  },
];

/** 否定语境：出现在这些词旁边，说明这条是在拦而不是在教 */
const NEG_RE =
  /\b(never|don'?t|do\s+not|must\s+not|should\s+not|avoid|forbid(den)?|refuse|blocked|deny|forbidden)\b|不要|禁止|禁用|切勿|严禁|别用|别把|不可|不能|避免|不允许|危险|❌/i;

/** 命中行原文最多留多少字，够看清上下文又不至于把卡片撑爆 */
const MAX_LINE = 160;

export interface Finding {
  rule: string;
  label: string;
  why: string;
  /** 1-based 行号，对应 SKILL.md 正文（frontmatter 已去掉） */
  line: number;
  text: string;
  kind: FindingKind;
}

export interface ScanResult {
  id: string;
  name: string;
  findings: Finding[];
  /** 代码块里的命中——最可能被照着跑 */
  code: number;
  /** 正文提到但没有劝阻语境 */
  prose: number;
  /** 明确在劝阻语境里，通常是防护规则表 */
  guard: number;
  chars: number;
  /** 超过加载上限会被截断，规则残缺的技能比没有更糟 */
  truncated: boolean;
}

/** 与 `skill.ts` 里拼提示词时的截断线保持一致 */
export const SKILL_CHAR_LIMIT = 12000;

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_LINE ? t.slice(0, MAX_LINE) + "…" : t;
}

/**
 * 扫一段正文。纯函数，逐行判断，不改输入。
 *
 * 三档语境按可信度排：
 *   代码块内   —— 大概率是要执行的，最要紧
 *   劝阻语境   —— 所在章节标题或本行带否定词，多半是防护规则表
 *   正文提到   —— 剩下这些，可能是规则表也可能是指令，必须人看
 *
 * 章节标题也算否定语境，是因为 gstack 那种拦截表整节标题写着「危险操作」，
 * 表里的行自己不带否定词，只看行内会全判成正文。
 */
export function scanText(text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let sectionNeg = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // 围栏代码块：``` 与 ~~~ 都认，四个反引号也算
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && /^#{1,6}\s/.test(raw)) {
      sectionNeg = NEG_RE.test(raw);
    }

    // 行内反引号的位置，用来判断命中是不是写在 `` 里面
    const ticks: number[] = [];
    for (let k = 0; k < raw.length; k++) if (raw[k] === "`") ticks.push(k);
    const inInlineCode = (pos: number) => {
      for (let k = 0; k + 1 < ticks.length; k += 2) {
        if (pos > ticks[k] && pos < ticks[k + 1]) return true;
      }
      return false;
    };

    for (const r of RISK_RULES) {
      // 每条规则都是非全局正则，exec 不带 lastIndex 状态，可以放心复用
      const m = r.re.exec(raw);
      if (!m) continue;
      const negated = NEG_RE.test(raw) || sectionNeg;
      // 表格行永远不算 code：表格是查阅用的，代码块才是抄来跑的。
      // gstack/careful 那张拦截表把 `rm -rf` 写在单元格里，按行内代码判会整张表变红。
      const isTable = /^\s*\|/.test(raw);
      // 顺序有意义：围栏里没有叙述语，一定是执行的；本行明确劝阻就按防护算，
      // 哪怕命令写在反引号里（「不要执行 `rm -rf /`」是在拦，不是在教）
      const kind: FindingKind = inFence
        ? "code"
        : negated
          ? "guard"
          : isTable
            ? "prose"
            : inInlineCode(m.index)
              ? "code"
              : "prose";
      out.push({ rule: r.id, label: r.label, why: r.why, line: i + 1, text: clip(raw), kind });
      break; // 一行只记最靠前的一条规则，免得同一句被拆成三行
    }
  }

  return out;
}

export function scanSkill(id: string, name: string, body: string): ScanResult {
  const findings = scanText(body);
  return {
    id,
    name,
    findings,
    code: findings.filter((f) => f.kind === "code").length,
    prose: findings.filter((f) => f.kind === "prose").length,
    guard: findings.filter((f) => f.kind === "guard").length,
    chars: body.length,
    truncated: body.length > SKILL_CHAR_LIMIT,
  };
}

/** 干净 = 一条都没命中。不区分语境，因为「没提到」本身就是结论 */
export function isClean(r: ScanResult): boolean {
  return r.findings.length === 0;
}

/**
 * 排序：先看代码块里的命中，再看正文，最后按名字。
 * 劝阻语境的不参与排序——那是好现象，不该把技能往上顶。
 */
export function sortScans(rs: ScanResult[]): ScanResult[] {
  return [...rs].sort((a, b) => b.code - a.code || b.prose - a.prose || a.name.localeCompare(b.name));
}

export interface ScanSummary {
  total: number;
  clean: number;
  /** 至少有一处代码块命中的技能数 */
  withCode: number;
  /** 只有正文/劝阻语境的技能数 */
  softOnly: number;
  /** 超长被截断的技能数 */
  truncated: number;
  findings: number;
}

export function summarizeScans(rs: ScanResult[]): ScanSummary {
  return {
    total: rs.length,
    clean: rs.filter(isClean).length,
    withCode: rs.filter((r) => r.code > 0).length,
    softOnly: rs.filter((r) => r.code === 0 && !isClean(r)).length,
    truncated: rs.filter((r) => r.truncated).length,
    findings: rs.reduce((n, r) => n + r.findings.length, 0),
  };
}

/** 一句话结论，用在面板顶部。没有命中就说没有，不粉饰 */
export function scanHeadline(s: ScanSummary): string {
  if (s.total === 0) return "选一个外部技能库就能扫";
  if (s.findings === 0) return `${s.total} 个技能都没扫到危险指令`;
  if (s.withCode === 0) {
    return `${s.clean}/${s.total} 干净；其余 ${s.softOnly} 个只有正文提到，逐条看一眼`;
  }
  return `${s.withCode} 个技能的代码块里有危险指令，先看这几个`;
}

/** 导出扫描结果成 Markdown，只含「哪个技能第几行写了什么」，不含技能正文 */
export function buildScanMarkdown(rs: ScanResult[], when: string): string {
  const s = summarizeScans(rs);
  const lines: string[] = [];
  lines.push("# 本地技能扫描结果");
  lines.push("");
  lines.push(`扫描时间：${when}`);
  lines.push(
    `共 ${s.total} 个技能，${s.clean} 个干净，${s.withCode} 个代码块里有危险指令，${s.softOnly} 个只在正文提到，共 ${s.findings} 处命中。`
  );
  lines.push("");
  lines.push(
    "口径：只扫 SKILL.md 正文（会被拼进提示词的那部分），不扫 refs/ 与仓库脚本。"
  );
  lines.push(
    "性质是启发式判断：代码块里判 `code`，所在章节标题或本行带否定词判 `guard`，其余判 `prose`。**都要人看原文再决定。**"
  );
  lines.push("");

  for (const r of sortScans(rs)) {
    if (isClean(r)) continue;
    lines.push(`## ${r.name} (${r.id})`);
    const bits = [`代码块 ${r.code}`, `正文 ${r.prose}`, `劝阻 ${r.guard}`];
    if (r.truncated) bits.push(`超长 ${r.chars} 字符`);
    lines.push(bits.join(" · "));
    lines.push("");
    for (const f of r.findings) {
      lines.push(`- \`SKILL.md:${f.line}\` **${f.label}**（${SCAN_KIND_LABEL[f.kind]}）`);
      lines.push(`  - 原文：\`${f.text}\``);
      lines.push(`  - 后果：${f.why}`);
    }
    lines.push("");
  }

  if (s.clean > 0) {
    lines.push("## 没扫到命中的技能");
    lines.push("");
    lines.push(sortScans(rs).filter(isClean).map((r) => `- ${r.name} (${r.id})`).join("\n"));
    lines.push("");
  }

  return lines.join("\n");
}
