/** 导出文本装配的回归（纯函数，不碰 Blob / DOM / IPC）。 */

import { describe, expect, it } from "vitest";
import { buildAuditBundle, buildSkillScanBundle, type AuditSkillRow } from "./exports";
import type { Skill } from "./skill";

const row = (id: string): AuditSkillRow => ({
  id, name: `技能${id}`, category: "通用", stage: "stable",
} as unknown as AuditSkillRow);

const skill = (id: string, body: string): Skill => ({ id, name: `技能${id}`, body } as Skill);

describe("buildAuditBundle", () => {
  it("清单与实测报告合成一份，带分隔线与时间", () => {
    const md = buildAuditBundle("2026-11-06 08:00", [row("a")]);
    expect(md).toContain("技能来源审计清单");
    expect(md).toContain("\n---\n");
    expect(md).toContain("2026-11-06 08:00");
    expect(md).toContain("技能a");
    // 清单 + 实测报告合成一份是这个函数存在的唯一理由：报告整段丢失必须变红，
    // 且实测报告必须排在分隔线之后（顺序反了同样是缺陷）。
    expect(md).toContain("# 技能来源实测审计报告");
    expect(md).toContain("实测风险");
    expect(md.indexOf("\n---\n")).toBeLessThan(md.indexOf("# 技能来源实测审计报告"));
    // 只锁模板头部仍不够：报告被掏空成「标题 + 字样」的空壳也必须变红。
    // 这两个锚点来自 AUDITS 的实测数据，不在报告模板的头部里。
    expect(md).toContain("garrytan/gstack");
    expect(md).toContain("整体不接");
    // 「硬依赖 bun」只在 AUDITS[0].verdictText 里，清单 SOURCES 没有：
    // 即便报告被掏空后仍挂着标题/仓库 id，这条也能把空壳抓住（复核 N5）。
    expect(md).toContain("硬依赖 bun");
  });

  it("空技能列表也能产出完整底稿", () => {
    const md = buildAuditBundle("t", []);
    expect(md.length).toBeGreaterThan(100);
    expect(md).toContain("---");
    expect(md).toContain("# 技能来源实测审计报告");
    expect(md).toContain("garrytan/gstack");
    expect(md).toContain("硬依赖 bun");
  });
});

describe("buildSkillScanBundle", () => {
  it("报告里含技能名与时间", () => {
    const md = buildSkillScanBundle("2026-11-06", [skill("s1", "普通说明文字\n第二行")]);
    expect(md).toContain("本地技能扫描结果");
    expect(md).toContain("2026-11-06");
    expect(md).toContain("技能s1");
  });

  it("不把技能正文整段塞进报告（只给行号与语境）", () => {
    const body = "这是一个很长的技能正文标记 XYZ_UNIQUE_BODY_MARKER";
    const md = buildSkillScanBundle("t", [skill("s1", body)]);
    expect(md).not.toContain("XYZ_UNIQUE_BODY_MARKER");
  });

  it("扫描输入 body 真的参与装配：危险指令命中会出现在报告里", () => {
    // 只断言固定模板会让「body 被置空」的回归全绿（独立复审 P1-2）。
    // 这里用只可能来自 body 的命中反证装配确实把扫描结果传了进去。
    const body = "部署脚本：rm -rf /tmp/old-release";
    const md = buildSkillScanBundle("2026-11-06", [skill("s1", body)]);
    expect(md).toContain("## 技能s1 (s1)");
    expect(md).toContain("递归删除");
    expect(md).toContain("SKILL.md:1");
    expect(md).toContain("rm -rf /tmp/old-release");
  });
});
