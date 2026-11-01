/** 外部技能库扫描：从用户选的目录里读出每个技能目录下的 `SKILL.md`。
 *
 * 两种布局都认：
 *   <技能库>/<id>/SKILL.md          单层仓库
 *   <技能库>/skills/<id>/SKILL.md   多数开源技能仓的组织方式
 * 目录里没有 SKILL.md 的文件夹直接跳过（常见于 refs/、assets/、示例工程），
 * 只有「读了 SKILL.md 但解析失败」才报错——那种才需要用户去改。
 */

import { fsList, fsRead } from "./fsapi";
import { parseSkill, sanitizeSkillId, type Skill } from "./skill";

/** 一个技能库最多认几个技能，防止误选整个 home 目录导致卡死 */
const MAX_SCAN = 200;
/** 单个 SKILL.md 的读取上限：超过这个体积基本是塞了别的东西 */
const MAX_SKILL_FILE = 200_000;

export interface ScanOutcome {
  skills: Skill[];
  /** 解析失败的技能，键为目录名 */
  errors: { id: string; error: string }[];
}

export async function loadLocalSkills(root: string): Promise<ScanOutcome> {
  const skills: Skill[] = [];
  const errors: { id: string; error: string }[] = [];
  const seen = new Set<string>();

  let top: { name: string; path: string; dir: boolean }[] = [];
  try {
    top = await fsList(root);
  } catch (e) {
    return { skills, errors: [{ id: root, error: (e as Error).message }] };
  }

  const candidates: { id: string; rel: string; dir: string }[] = [];
  for (const e of top) {
    if (!e.dir) continue;
    candidates.push({ id: e.name, rel: `${e.name}/SKILL.md`, dir: e.path });
    // 常见仓库布局：真正技能在 skills/<id>/ 下面
    if (e.name === "skills" || e.name === "plugins") {
      try {
        const sub = await fsList(e.path);
        for (const s of sub) {
          if (s.dir) candidates.push({ id: s.name, rel: `${e.name}/${s.name}/SKILL.md`, dir: s.path });
        }
      } catch {
        /* 读不进去就只认单层布局 */
      }
    }
    if (candidates.length >= MAX_SCAN) break;
  }

  for (const c of candidates.slice(0, MAX_SCAN)) {
    let text: string;
    try {
      text = await fsRead(root, c.rel);
    } catch {
      continue; // 没有 SKILL.md，不是技能目录
    }
    if (text.length > MAX_SKILL_FILE) {
      errors.push({ id: c.id, error: `SKILL.md 过大（${text.length} 字符）` });
      continue;
    }
    const r = parseSkill(text, { id: c.id, source: "local", dir: c.dir });
    if (!r.ok) {
      errors.push({ id: c.id, error: r.error });
      continue;
    }
    if (seen.has(r.skill.id)) continue;
    seen.add(r.skill.id);
    skills.push(r.skill);
  }

  return { skills, errors };
}

/** 内建 + 本地：同 id 时本地覆盖内建，方便用户改一份自己的版本 */
export function mergeSkills(builtin: Skill[], local: Skill[]): Skill[] {
  const map = new Map<string, Skill>();
  for (const s of builtin) map.set(s.id, s);
  for (const s of local) map.set(s.id, s);
  return [...map.values()];
}

/** 按 id 取技能，顺便过滤掉已经被删掉的 id */
export function pickSkills(all: Skill[], ids: string[]): Skill[] {
  const byId = new Map(all.map((s) => [s.id, s]));
  const out: Skill[] = [];
  for (const id of ids) {
    const s = byId.get(sanitizeSkillId(id));
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
