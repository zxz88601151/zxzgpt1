/** 实测审计结论：把登记表里的「该查什么」变成「查完了是什么」。
 *
 * 和 sources.ts 的分工：
 *   sources.ts  预判——名字听起来危险就先标红，写清要核实哪几条
 *   audit.ts    实测——仓库真拉下来扫过，用文件:行 说话，允许推翻预判
 *
 * 所以 `predicted` 和 `risk` 是分开的两个字段：两条不一致时，
 * 恰恰是最该被看见的部分（本批 4 条里就有 1 条预判被推翻）。
 *
 * 扫描口径（2026-11-01，codeload 取 tag 为 main 的 tarball）：
 *   只扫 *.md —— 这些仓库的技能本体就是 markdown，脚本在技能目录里反而是少数
 *   同一条正则会同时命中「要求照做」和「明令禁止」，必须人工看上下文分成：
 *     instruction  流程步骤里要求执行
 *     guard        防护规则里列举出来准备拦截
 *     doc          只在说明/变更记录里被提到
 *   把三者混为一谈就会得出「gstack 满页 rm -rf 所以最危险」这种半对结论。
 */

export type Verdict = "attach" | "selective" | "reject";

/** 命中性质。决定这条命中该不该算进风险分 */
export type HitKind = "instruction" | "guard" | "doc" | "none";

export interface PatternHit {
  pattern: string;
  /** 命中的 markdown 文件数 */
  files: number;
  kind: HitKind;
  /** 命中范围说明，同一个 pattern 拆成多条时用来区分 */
  note?: string;
  /** 人工看过的那几行，写成 仓库相对路径:行号 */
  evidence: string[];
}

export interface AuditRecord {
  /** 与 sources.ts 的 id 对齐 */
  id: string;
  at: string;
  verdict: Verdict;
  /** 实测风险 */
  risk: "high" | "medium" | "low";
  /** 登记表当初的预判，没有就是 null */
  predicted: "high" | "medium" | "low" | null;
  /** SKILL.md 数量 */
  skills: number;
  /** 最大单份字符数 */
  longest: number;
  /** 超过本项目单份 12000 字符加载上限的份数 */
  oversize: number;
  hits: PatternHit[];
  /** 结论一句话，直接给人看 */
  verdictText: string;
  /** 还能拿的部分 */
  keep: string[];
  /** 必须排除的部分及原因 */
  drop: string[];
  /** 已经落地成本项目哪个内建技能（id）——审计结论不落到产出就等于没审 */
  applied?: string[];
}

/** 本项目 buildSkillPrompt 的单份截断线，audit 用它算 oversize */
export const SKILL_CHAR_LIMIT = 12000;

export const AUDITS: AuditRecord[] = [
  {
    id: "garrytan/gstack",
    at: "2026-11-01",
    verdict: "reject",
    risk: "high",
    predicted: "high",
    skills: 33,
    longest: 84868,
    oversize: 26,
    hits: [
      {
        pattern: "rm -rf",
        files: 1,
        kind: "instruction",
        note: "写在卸载脚本的 shell 块里",
        evidence: [
          "docs/uninstall.md:30  rm -rf \"$dir\"  (遍历 ~/.claude/skills 下指向 gstack 的目录)",
          "docs/uninstall.md:37  rm -rf \"$(dirname \"$marker\")\"",
          "docs/uninstall.md:43  rm -rf ~/.claude/skills/gstack",
          "docs/uninstall.md:46  rm -rf ~/.gstack",
        ],
      },
      {
        pattern: "rm -rf",
        files: 1,
        kind: "instruction",
        note: "写在升级脚本里做换装与回滚",
        evidence: [
          "gstack-upgrade/SKILL.md:218  git clone 到 mktemp 目录",
          "gstack-upgrade/SKILL.md:224  换装失败时 rm -rf \"$INSTALL_DIR\" 后再 mv 回来",
          "gstack-upgrade/SKILL.md:222  成功时 rm -rf \"$INSTALL_DIR.bak\" \"$TMP_DIR\"",
        ],
      },
      {
        pattern: "rm -rf",
        files: 1,
        kind: "guard",
        note: "防护规则里列出来准备拦截",
        evidence: ["careful/SKILL.md:44  把 rm -rf / rm -r / --recursive 列为递归删除风险"],
      },
      {
        pattern: "rm -rf",
        files: 22,
        kind: "doc",
        note: "只在 CHANGELOG 与设计文档里被提到",
        evidence: [],
      },
      {
        pattern: "curl … | bash",
        files: 5,
        kind: "instruction",
        evidence: ["gstack-upgrade/SKILL.md:180  让用户 curl -fsSL https://bun.sh/install | bash"],
      },
      {
        pattern: "git push",
        files: 13,
        kind: "doc",
        evidence: ["CHANGELOG.md:1455  /modernize 用 --force-with-lease，且明说不碰裸 --force"],
      },
    ],
    verdictText:
      "整体不接。33 个技能里 26 个超过本项目单份加载上限，最长 84868 字符是上限的 7 倍；" +
      "卸载与升级流程会在用户 home 下批量 rm -rf（~/.claude/skills/*、~/.gstack）并跑 ./setup；" +
      "还硬依赖 bun，本项目既没有 bun 也没有终端执行。",
    keep: [
      "browse（无头浏览器）与 careful/guard 的拦截规则表——规则本身写得比多数项目细，可当设计参考抄规则不抄代码",
    ],
    drop: [
      "uninstall.md 整段：会遍历并删除 ~/.claude/skills 下所有非 gstack 目录",
      "gstack-upgrade：git clone + mv + rm -rf + ./setup 换装，失败才回滚，成功路径不可逆",
      "全部 33 个 SKILL.md 的正文：体积与截断比过高，截断后的技能比没有更糟",
    ],
    applied: ["dangerous-ops"],
  },
  {
    id: "vercel-labs/agent-skills",
    at: "2026-11-01",
    verdict: "selective",
    risk: "high",
    predicted: "high",
    skills: 9,
    longest: 17311,
    oversize: 2,
    hits: [
      {
        pattern: "rm -rf",
        files: 0,
        kind: "none",
        evidence: [],
      },
      {
        pattern: "凭证扫描（grep .env / printenv）",
        files: 1,
        kind: "instruction",
        evidence: [
          "skills/vercel-cli-with-tokens/SKILL.md:20  printenv VERCEL_TOKEN",
          "skills/vercel-cli-with-tokens/SKILL.md:28  grep '^VERCEL_TOKEN=' .env",
          "skills/vercel-cli-with-tokens/SKILL.md:42  grep -i 'vercel' .env  (按 vca_ 前缀猜哪个变量是 token)",
          "skills/vercel-cli-with-tokens/SKILL.md:48  export VERCEL_TOKEN=$(grep … | cut -d= -f2-)",
        ],
      },
      {
        pattern: "git push",
        files: 2,
        kind: "doc",
        evidence: [],
      },
    ],
    verdictText:
      "挑着接。deploy 与 token 两条不要——vercel-cli-with-tokens 的 Step 1 会主动 printenv、grep .env、" +
      "按 vca_ 前缀猜变量名再 export，等于教模型翻用户磁盘上的密钥；本项目无凭证管理，装进来只有坏处。" +
      "不过它第 57 行那条劝告（别把 token 放进 --token 参数，会留在 shell history）是对的，值得单独抄进安全规则。",
    keep: [
      "composition-patterns（2886 字符）与 react-best-practices（7251 字符）：纯规则、体积小、不碰凭证",
      "「secrets 走环境变量不走命令行参数」这一条安全约定",
    ],
    drop: [
      "vercel-cli-with-tokens 整条：会读用户 .env 并把密钥注入环境",
      "deploy-to-vercel：必须有 token 才能跑，本项目没有凭证保管设施",
      "react-best-practices 与内建 react-ts 规则重叠，同时挂会互相抢规则，只能二选一",
    ],
    applied: ["dangerous-ops"],
  },
  {
    id: "hashicorp/agent-skills",
    at: "2026-11-01",
    verdict: "selective",
    risk: "high",
    predicted: "high",
    skills: 20,
    longest: 18322,
    oversize: 7,
    hits: [
      {
        pattern: "terraform apply / destroy",
        files: 4,
        kind: "instruction",
        evidence: [
          "plugins/terraform/skills/terraform-search-import/SKILL.md:89  流程第 5 步「Run terraform plan and terraform apply to import」",
          "plugins/terraform/skills/terraform-search-import/SKILL.md:394  terraform apply",
          "plugins/terraform/skills/refactor-module/SKILL.md:521  terraform apply migration.tfplan",
        ],
      },
      {
        pattern: "AWS_SECRET_ACCESS_KEY",
        files: 3,
        kind: "instruction",
        evidence: [
          "plugins/packer/skills/aws-ami-builder/SKILL.md:133  export AWS_SECRET_ACCESS_KEY=\"your-secret-key\"",
          "plugins/terraform/skills/terraform-test/references/CI_CD.md:44  ${{ secrets.AWS_SECRET_ACCESS_KEY }}",
        ],
      },
      {
        pattern: "rm -rf",
        files: 0,
        kind: "none",
        evidence: [],
      },
    ],
    verdictText:
      "挑着接。terraform apply 是写在流程步骤里的执行指令（search-import 第 5 步、refactor-module 的 migration.tfplan），" +
      "不是「别忘了先 plan」这种提醒；aws-ami-builder 还给了 export AWS_SECRET_ACCESS_KEY 的示范。" +
      "这两类装进一个单轮生成、没有终端的产品里，只会让模型写出它自己跑不了的命令，或者把密钥写进代码。" +
      "terraform-style-guide 是纯规范，可以接。",
    keep: [
      "terraform-style-guide：命名、文件布局、变量写法，纯规范无副作用",
      "terraform-policy 的 plan-time / apply-time 概念区分，可当评审检查项",
    ],
    drop: [
      "terraform-search-import 与 refactor-module：流程里带 terraform apply，会改真实基础设施",
      "packer 的 aws-ami-builder / azure-image-builder：直接给 export AWS_SECRET_ACCESS_KEY 的示范",
      "其余 7 条超过 12000 字符的，接进来会被截断",
    ],
  },
  {
    id: "addyosmani/agent-skills",
    at: "2026-11-01",
    verdict: "selective",
    risk: "medium",
    predicted: "high",
    skills: 25,
    longest: 22216,
    oversize: 15,
    hits: [
      {
        pattern: "rm -rf",
        files: 0,
        kind: "none",
        evidence: [],
      },
      {
        pattern: "git push",
        files: 2,
        kind: "instruction",
        evidence: [
          "skills/git-workflow-and-versioning/SKILL.md:292  git push origin v1.4.0（打 tag 流程）",
          "skills/shipping-and-launch/SKILL.md:272  回滚方案 git revert <commit> && git push",
        ],
      },
      {
        pattern: "curl … | bash",
        files: 0,
        kind: "none",
        evidence: [],
      },
    ],
    verdictText:
      "预判该降级。它名字里有个 /ship、又带 ci-cd，初看最像会自动发布的那一类；" +
      "拉下来扫完，rm -rf 与 curl|bash 都是 0 命中，12 个脚本全在 evals/fixtures 测试夹具里、不在技能目录，" +
      "两条 git push 都写在「打 tag」和「怎么回滚」的说明位置，没有一条要求改 CI 或配 token。" +
      "25 份 description 都带明确 Use when，质量是四个仓库里最好的。真问题不在安全，在体积：15/25 超过本项目的加载上限。",
    keep: [
      "shipping-and-launch：发布前清单 + 回滚预案，本项目自己的 undo 正好能对上，适合改成内建技能",
      "code-review-and-quality 的评审维度、constraint-driven-development 的「防止 agent 偷偷降低验收线」思路",
      "25 份 description 的写法：Use when + 具体输出物，可直接当作本项目技能 description 的范本",
    ],
    drop: [
      "超过 12000 字符的 15 份不能整份挂，必须摘编（constraint-driven-development 22216、code-review-and-quality 20976）",
      "browser-testing-with-devtools 需要 Chrome DevTools MCP，本项目没有 MCP 宿主",
      "ci-cd-and-automation 与本项目无 CI 的现状不匹配",
    ],
  },
];

export const AUDIT_BY_ID: Record<string, AuditRecord> = Object.fromEntries(
  AUDITS.map((a) => [a.id, a]),
);

export const VERDICT_LABEL: Record<Verdict, string> = {
  attach: "可接入",
  selective: "挑着接",
  reject: "不接入",
};

export interface AuditSummary {
  total: number;
  attach: number;
  selective: number;
  reject: number;
  /** 实测风险高于预判 */
  escalated: number;
  /** 实测风险低于预判 */
  downgraded: number;
  /** 实测与预判一致 */
  confirmed: number;
  /** 已扫描的 SKILL.md 总数 */
  skills: number;
}

const RISK_ORDER: Record<"high" | "medium" | "low", number> = { high: 3, medium: 2, low: 1 };

/** 实测结论对整体判断的价值：先看推翻了几条预判 */
export function summarizeAudits(audits: AuditRecord[] = AUDITS): AuditSummary {
  const sum: AuditSummary = {
    total: audits.length,
    attach: 0,
    selective: 0,
    reject: 0,
    escalated: 0,
    downgraded: 0,
    confirmed: 0,
    skills: 0,
  };
  for (const a of audits) {
    sum[a.verdict] += 1;
    sum.skills += a.skills;
    if (a.predicted === null) continue;
    const now = RISK_ORDER[a.risk];
    const was = RISK_ORDER[a.predicted];
    if (now > was) sum.escalated += 1;
    else if (now < was) sum.downgraded += 1;
    else sum.confirmed += 1;
  }
  return sum;
}

/** 只看「要求照做」的命中——防护规则和变更记录不算风险 */
export function instructionFiles(a: AuditRecord): number {
  return a.hits.filter((h) => h.kind === "instruction").reduce((n, h) => n + h.files, 0);
}

/** 该按什么顺序读：不接入的、且真带执行指令的排前面 */
export function auditRank(a: AuditRecord): number {
  const verdictWeight = (v: Verdict) => (v === "reject" ? 3 : v === "selective" ? 2 : 1);
  return verdictWeight(a.verdict) * 100 + instructionFiles(a);
}

export function sortAudits(audits: AuditRecord[] = AUDITS): AuditRecord[] {
  return [...audits].sort((a, b) => auditRank(b) - auditRank(a));
}

/** 可下载的审计报告。和 sources.ts 的清单不同：这里给结论，不给待办 */
export function buildAuditReportMarkdown(audits: AuditRecord[] = AUDITS): string {
  const sum = summarizeAudits(audits);
  const lines: string[] = [];
  lines.push("# 技能来源实测审计报告");
  lines.push("");
  lines.push(`扫描日期：${audits[0]?.at ?? "-"}　扫描方式：codeload 取仓库 tarball 后本地 grep`);
  lines.push("");
  lines.push(`- 审计 ${sum.total} 个仓库，覆盖 ${sum.skills} 份 SKILL.md`);
  lines.push(`- 结论：可接入 ${sum.attach} · 挑着接 ${sum.selective} · 不接入 ${sum.reject}`);
  lines.push(
    `- 与登记表预判对照：确认 ${sum.confirmed} · 上调 ${sum.escalated} · 下调 ${sum.downgraded}`,
  );
  lines.push("");
  lines.push("> 扫描只认上下文，不认关键词。同一条 `rm -rf` 出现在防护规则里是设计，出现在卸载脚本里是风险。");
  lines.push("");

  for (const a of sortAudits(audits)) {
    lines.push(`## ${a.id}`);
    lines.push("");
    lines.push(
      `**${VERDICT_LABEL[a.verdict]}** · 实测风险 ${a.risk}${
        a.predicted && a.predicted !== a.risk ? `（预判 ${a.predicted}，已修正）` : ""
      }`,
    );
    lines.push("");
    lines.push(`技能 ${a.skills} 份，最长 ${a.longest} 字符，超 ${SKILL_CHAR_LIMIT} 字符上限 ${a.oversize} 份。`);
    lines.push("");
    lines.push(a.verdictText);
    lines.push("");
    if (a.hits.length > 0) {
      lines.push("| 命中 | 文件数 | 性质 |");
      lines.push("| --- | --- | --- |");
      const kindLabel: Record<HitKind, string> = {
        instruction: "**要求执行**",
        guard: "防护规则",
        doc: "仅文档提及",
        none: "未命中",
      };
      for (const h of a.hits) lines.push(`| \`${h.pattern}\` | ${h.files} | ${kindLabel[h.kind]} |`);
      lines.push("");
      for (const h of a.hits.filter((x) => x.evidence.length > 0)) {
        lines.push(`<details><summary>${h.pattern} 的证据</summary>`);
        lines.push("");
        for (const e of h.evidence) lines.push(`- \`${e}\``);
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }
    if (a.keep.length > 0) {
      lines.push("**可以拿**");
      for (const k of a.keep) lines.push(`- ${k}`);
      lines.push("");
    }
    if (a.drop.length > 0) {
      lines.push("**必须排除**");
      for (const d of a.drop) lines.push(`- ${d}`);
      lines.push("");
    }
    if (a.applied?.length) {
      lines.push(`**已落地为本项目内建技能**：${a.applied.map((x) => `\`${x}\``).join("、")}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
