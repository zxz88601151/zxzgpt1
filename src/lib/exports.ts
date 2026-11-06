/** 审计底稿 / 技能扫描报告的文本装配（从 App.tsx 抽出的纯函数）。
 *
 * App 只负责「把这份 md 写到哪」（工程内落盘或浏览器下载），内容怎么拼在这里，
 * 这样两份导出共用同一套协议，也便于单测锁住「清单 + 实测报告合成一份」的事实。
 */

import { buildAuditMarkdown, SOURCES } from "../skills/sources";
import { buildAuditReportMarkdown } from "../skills/audit";
import { buildScanMarkdown, scanSkill } from "./skillscan";
import type { Skill } from "./skill";

export type AuditSkillRow = Parameters<typeof buildAuditMarkdown>[1]["skills"][number];

/** 清单（该查什么）+ 实测报告（查完是什么）合成一份文件，中间用分隔线隔开。 */
export function buildAuditBundle(when: string, skills: AuditSkillRow[]): string {
  return [
    buildAuditMarkdown(SOURCES, { when, skills }),
    "",
    "---",
    "",
    buildAuditReportMarkdown(),
  ].join("\n");
}

/** 本地技能扫描：只含「哪个技能第几行写了什么」，不含技能正文，可直接发给别人。 */
export function buildSkillScanBundle(when: string, local: Skill[]): string {
  return buildScanMarkdown(
    local.map((s) => scanSkill(s.id, s.name, s.body)),
    when,
  );
}
