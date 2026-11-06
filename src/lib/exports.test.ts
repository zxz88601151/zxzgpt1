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
  });

  it("空技能列表也能产出完整底稿", () => {
    const md = buildAuditBundle("t", []);
    expect(md.length).toBeGreaterThan(100);
    expect(md).toContain("---");
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
});
