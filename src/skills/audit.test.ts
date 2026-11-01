import { describe, expect, it } from "vitest";
import {
  AUDITS,
  AUDIT_BY_ID,
  SKILL_CHAR_LIMIT,
  auditRank,
  buildAuditReportMarkdown,
  instructionFiles,
  sortAudits,
  summarizeAudits,
  type AuditRecord,
} from "./audit";
import { SOURCES } from "./sources";
import { builtinSkills } from "../skills";

describe("审计记录与登记表对得上", () => {
  it("每条审计都指向登记表里真实存在的来源", () => {
    const known = new Set(SOURCES.map((s) => s.id));
    for (const a of AUDITS) expect(known.has(a.id), a.id).toBe(true);
  });

  it("id 不重复", () => {
    const ids = AUDITS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("登记表里标了高风险的，这一批都完成了实测", () => {
    const audited = new Set(AUDITS.map((a) => a.id));
    for (const s of SOURCES.filter((x) => x.risk === "high")) {
      expect(audited.has(s.id), `${s.id} 标了 high 但没实测`).toBe(true);
    }
  });

  it("predicted 与登记表的 risk 一致，说明预判是从登记表抄来的", () => {
    for (const a of AUDITS) {
      const src = SOURCES.find((s) => s.id === a.id);
      expect(a.predicted, a.id).toBe(src?.risk ?? null);
    }
  });
});

describe("审计记录本身站得住", () => {
  it("超限份数不可能多于总份数", () => {
    for (const a of AUDITS) expect(a.oversize, a.id).toBeLessThanOrEqual(a.skills);
  });

  it("最长字符数是正数，且不超过 10 万", () => {
    for (const a of AUDITS) {
      expect(a.longest, a.id).toBeGreaterThan(0);
      expect(a.longest, a.id).toBeLessThan(100_000);
    }
  });

  it("最长的那份既然最长，就不可能没超限", () => {
    for (const a of AUDITS) {
      if (a.longest > SKILL_CHAR_LIMIT) expect(a.oversize, a.id).toBeGreaterThan(0);
    }
  });

  it("结论与取舍都不能是空话", () => {
    for (const a of AUDITS) {
      expect(a.verdictText.trim().length, a.id).toBeGreaterThan(30);
      expect(a.keep.length + a.drop.length, a.id).toBeGreaterThan(0);
    }
  });

  it("判为不接入的，必须写清为什么不能拿", () => {
    for (const a of AUDITS.filter((x) => x.verdict === "reject")) {
      expect(a.drop.length, a.id).toBeGreaterThan(0);
    }
  });

  it("要求照做的命中必须给到文件:行，否则等于没证据", () => {
    for (const a of AUDITS) {
      for (const h of a.hits.filter((x) => x.kind === "instruction")) {
        expect(h.evidence.length, `${a.id} ${h.pattern}`).toBeGreaterThan(0);
      }
    }
  });

  it("证据都写成 路径:行号 的形式", () => {
    for (const a of AUDITS) {
      for (const h of a.hits) {
        for (const e of h.evidence) expect(e, `${a.id}`).toMatch(/^[\w./-]+:\d+/);
      }
    }
  });

  it("没命中的项也留着，0 本身是结论", () => {
    const addy = AUDIT_BY_ID["addyosmani/agent-skills"];
    const rm = addy.hits.find((h) => h.pattern === "rm -rf");
    expect(rm?.files).toBe(0);
    expect(rm?.evidence).toHaveLength(0);
    // 0 命中不是「仅文档提及」，是压根没有——性质要分开，否则等于虚报
    expect(rm?.kind).toBe("none");
  });

  it("性质与命中数不矛盾：none 必然是 0，非 none 必然大于 0", () => {
    for (const a of AUDITS) {
      for (const h of a.hits) {
        if (h.kind === "none") expect(h.files, `${a.id} ${h.pattern}`).toBe(0);
        else expect(h.files, `${a.id} ${h.pattern}`).toBeGreaterThan(0);
      }
    }
  });

  it("报告里 0 命中写成未命中，不写成仅文档提及", () => {
    expect(buildAuditReportMarkdown()).toContain("未命中");
  });
});

describe("审计结论要落到产出上", () => {
  it("applied 引用的技能必须真实存在", () => {
    const ids = new Set(builtinSkills().map((s) => s.id));
    for (const a of AUDITS) {
      for (const id of a.applied ?? []) expect(ids.has(id), `${a.id} → ${id}`).toBe(true);
    }
  });

  it("至少有一条结论已经落地，不能只有分析没有产出", () => {
    const landed = AUDITS.filter((a) => (a.applied ?? []).length > 0);
    expect(landed.length).toBeGreaterThan(0);
  });

  it("落地成技能的那条，报告里会写出来", () => {
    const md = buildAuditReportMarkdown();
    expect(md).toContain("已落地为本项目内建技能");
    expect(md).toContain("`dangerous-ops`");
  });

  it("危险操作技能本身覆盖了不可逆、放行清单与密钥三块", () => {
    const s = builtinSkills().find((x) => x.id === "dangerous-ops");
    expect(s).toBeTruthy();
    expect(s!.body).toContain("不可逆");
    expect(s!.body).toContain("node_modules");
    expect(s!.body).toMatch(/密钥走环境变量/);
    // 本工具不执行命令，所以要求是「标注后果」而不是「弹窗确认」
    expect(s!.body).toContain("本工具不执行命令");
    expect(s!.description).toContain("不会替你执行");
  });
});

describe("预判修正被记录下来", () => {
  it("addy 的预判高风险被下调，且理由写在结论里", () => {
    const addy = AUDIT_BY_ID["addyosmani/agent-skills"];
    expect(addy.predicted).toBe("high");
    expect(addy.risk).toBe("medium");
    expect(addy.verdictText).toContain("预判该降级");
  });

  it("汇总能算出下调了几条", () => {
    const sum = summarizeAudits();
    expect(sum.downgraded).toBe(1);
    expect(sum.confirmed).toBe(AUDITS.length - 1);
    expect(sum.escalated).toBe(0);
  });

  it("三类结论加起来等于总数", () => {
    const sum = summarizeAudits();
    expect(sum.attach + sum.selective + sum.reject).toBe(sum.total);
    expect(sum.total).toBe(AUDITS.length);
  });

  it("技能份数汇总等于逐条相加", () => {
    const manual = AUDITS.reduce((n, a) => n + a.skills, 0);
    expect(summarizeAudits().skills).toBe(manual);
  });
});

describe("排序与筛选", () => {
  it("只数要求执行的命中，防护规则不算", () => {
    const fake: AuditRecord = {
      ...AUDIT_BY_ID["garrytan/gstack"],
      hits: [
        { pattern: "a", files: 5, kind: "guard", evidence: [] },
        { pattern: "b", files: 3, kind: "instruction", evidence: ["x.md:1"] },
        { pattern: "c", files: 9, kind: "doc", evidence: [] },
      ],
    };
    expect(instructionFiles(fake)).toBe(3);
  });

  it("不接入且带执行指令的排最前", () => {
    const sorted = sortAudits();
    expect(sorted[0].verdict).toBe("reject");
    expect(auditRank(sorted[0])).toBeGreaterThanOrEqual(auditRank(sorted[sorted.length - 1]));
  });

  it("排序不改动原数组", () => {
    const before = AUDITS.map((a) => a.id);
    sortAudits();
    expect(AUDITS.map((a) => a.id)).toEqual(before);
  });
});

describe("审计报告导出", () => {
  const md = buildAuditReportMarkdown();

  it("有标题、日期与扫描方式", () => {
    expect(md).toContain("# 技能来源实测审计报告");
    expect(md).toContain("2026-11-01");
    expect(md).toContain("codeload");
  });

  it("开头给出三类结论的汇总", () => {
    expect(md).toMatch(/可接入 \d+ · 挑着接 \d+ · 不接入 \d+/);
  });

  it("每个仓库都有一节", () => {
    for (const a of AUDITS) expect(md).toContain(`## ${a.id}`);
  });

  it("预判被修正的会写明", () => {
    expect(md).toContain("预判 high，已修正");
  });

  it("命中性质区分得出来，不把防护规则当成风险", () => {
    expect(md).toContain("**要求执行**");
    expect(md).toContain("仅文档提及");
  });

  it("证据收在折叠块里，不撑爆正文", () => {
    expect(md).toContain("<details><summary>");
  });

  it("可以拿和必须排除都落进报告", () => {
    expect(md).toContain("**可以拿**");
    expect(md).toContain("**必须排除**");
  });
});
