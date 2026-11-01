/** 内建技能：以 `SKILL.md` 原文打进产物，与外部技能走同一套解析路径。
 *
 * 用 `?raw` 导入 markdown 而不是在 TS 里拼字符串，好处是规范可以直接当文档读、
 * diff 干净，也不需要为内建技能单独写一份数据结构。
 */

import { parseSkill, type Skill } from "../lib/skill";

import codeStyle from "./builtin/code-style.md?raw";
import reactTs from "./builtin/react-ts.md?raw";
import nodeApi from "./builtin/node-api.md?raw";
import pythonService from "./builtin/python-service.md?raw";
import sqlSchema from "./builtin/sql-schema.md?raw";
import testCases from "./builtin/test-cases.md?raw";
import codeReview from "./builtin/code-review.md?raw";
import securityCheck from "./builtin/security-check.md?raw";
import verifyBeforeDone from "./builtin/verify-before-done.md?raw";
import debugFirst from "./builtin/debug-first.md?raw";
import moduleBoundaries from "./builtin/module-boundaries.md?raw";
import dangerousOps from "./builtin/dangerous-ops.md?raw";

/** id 与文件名一致，外部技能库里的同名技能会覆盖内建版本 */
const SOURCES: { id: string; text: string }[] = [
  { id: "code-style", text: codeStyle },
  { id: "react-ts", text: reactTs },
  { id: "node-api", text: nodeApi },
  { id: "python-service", text: pythonService },
  { id: "sql-schema", text: sqlSchema },
  { id: "test-cases", text: testCases },
  { id: "code-review", text: codeReview },
  { id: "security-check", text: securityCheck },
  { id: "dangerous-ops", text: dangerousOps },
  { id: "module-boundaries", text: moduleBoundaries },
  { id: "debug-first", text: debugFirst },
  { id: "verify-before-done", text: verifyBeforeDone },
];

/** 解析内建技能；单份写坏了就跳过，不能因为一个技能让整个技能库挂掉 */
export function builtinSkills(): Skill[] {
  const out: Skill[] = [];
  for (const src of SOURCES) {
    const r = parseSkill(src.text, { id: src.id, source: "builtin" });
    if (r.ok) out.push(r.skill);
  }
  return out;
}

export const BUILTIN_COUNT = SOURCES.length;
