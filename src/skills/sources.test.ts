import { describe, expect, it } from "vitest";
import {
  SOURCES,
  buildAuditMarkdown,
  cloneCommand,
  groupSources,
  repoUrl,
  summarizeSources,
  type SourceEntry,
} from "./sources";

const ids = SOURCES.map((s) => s.id);

describe("来源登记表完整性", () => {
  it("两批清单加在一起是 29 条，id 不重复", () => {
    expect(SOURCES).toHaveLength(29);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条都有定位与至少一条审计项", () => {
    for (const s of SOURCES) {
      expect(s.what.trim().length, s.id).toBeGreaterThan(10);
      expect(s.audit.length, s.id).toBeGreaterThan(0);
      for (const a of s.audit) expect(a.trim().length, s.id).toBeGreaterThan(4);
    }
  });

  it("接入方式与类型自洽：能挂技能库的必须是技能包", () => {
    for (const s of SOURCES.filter((x) => x.hook === "attach")) {
      expect(s.kind, s.id).toBe("skill");
    }
    for (const s of SOURCES.filter((x) => x.hook === "mcp")) {
      expect(s.kind, s.id).toBe("mcp");
    }
    for (const s of SOURCES.filter((x) => x.hook === "action")) {
      expect(s.kind, s.id).toBe("action");
    }
  });

  it("标了 API 核实的，必须真的带着核实到的事实", () => {
    for (const s of SOURCES.filter((x) => x.checked === "api")) {
      expect(s.facts, s.id).toBeTruthy();
      expect(typeof s.facts?.stars, s.id).toBe("number");
      expect(s.facts?.pushed, s.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("高风险条目必须带审计项，不能空着标红", () => {
    for (const s of SOURCES.filter((x) => x.risk === "high")) {
      expect(s.audit.length, s.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("三个批次都有内容", () => {
    for (const b of ["pipeline", "hot", "earlier"] as const) {
      expect(SOURCES.filter((s) => s.batch === b).length, b).toBeGreaterThan(0);
    }
  });
});

describe("改名与链接", () => {
  const moved = SOURCES.find((s) => s.id === "ruvnet/claude-flow") as SourceEntry;

  it("改过名的仓库指向新地址", () => {
    expect(moved.facts?.movedTo).toBe("ruvnet/ruflo");
    expect(repoUrl(moved)).toBe("https://github.com/ruvnet/ruflo");
    expect(cloneCommand(moved)).toContain("ruvnet/ruflo.git");
    expect(cloneCommand(moved)).not.toContain("claude-flow");
  });

  it("没改名的用原地址", () => {
    const e = SOURCES.find((s) => s.id === "obra/superpowers") as SourceEntry;
    expect(repoUrl(e)).toBe("https://github.com/obra/superpowers");
    expect(cloneCommand(e)).toBe("git clone --depth 1 https://github.com/obra/superpowers.git");
  });
});

describe("分组与汇总", () => {
  it("汇总数加起来等于总数", () => {
    const s = summarizeSources(SOURCES);
    expect(s.attach + s.hosted + s.readonly).toBe(s.total);
    expect(s.verified).toBeLessThanOrEqual(s.total);
  });

  it("按阶段分组，组内不混入别的阶段", () => {
    const groups = groupSources(SOURCES);
    const flat = groups.flatMap((g) => g.entries);
    expect(flat).toHaveLength(SOURCES.length);
    for (const g of groups) for (const e of g.entries) expect(e.stage).toBe(g.stage);
  });

  it("只保留非空阶段", () => {
    expect(groupSources([])).toEqual([]);
    const one = groupSources([SOURCES.find((s) => s.stage === "infra") as SourceEntry]);
    expect(one).toHaveLength(1);
    expect(one[0].stage).toBe("infra");
  });
});

describe("审计清单导出", () => {
  const md = buildAuditMarkdown(SOURCES, {
    when: "2026-11-01 13:00:00",
    skills: [{ id: "code-style", name: "通用代码规范", category: "通用", stage: "write" }],
  });

  it("开头有汇总与时间", () => {
    expect(md).toContain("# 技能来源审计清单");
    expect(md).toContain("2026-11-01 13:00:00");
    expect(md).toContain("| 登记来源 | 29 |");
  });

  it("每条来源都出现在清单里", () => {
    for (const id of ids) expect(md, id).toContain(id);
  });

  it("审计项写成可勾选的复选框", () => {
    expect(md).toContain("- [ ] SKILL.md 的 name / description 是否齐全");
    expect(md.match(/- \[ \]/g)?.length || 0).toBeGreaterThan(SOURCES.length);
  });

  it("只有可接入的才给 clone 命令", () => {
    const attach = SOURCES.filter((s) => s.hook === "attach").length;
    const blocks = md.match(/```bash/g)?.length || 0;
    expect(blocks).toBe(attach);
  });

  it("改名的在正文里注明，不让人点旧地址", () => {
    expect(md).toContain("原 ruvnet/claude-flow，已改名");
  });

  it("不含任何第三方技能正文（只有事实与检查项）", () => {
    expect(md).not.toContain("## 硬规则");
    expect(md).not.toContain("@@ref");
  });
});
