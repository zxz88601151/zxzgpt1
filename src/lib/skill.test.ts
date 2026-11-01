import { describe, expect, it } from "vitest";
import {
  asStage,
  buildSkillPrompt,
  matchSkills,
  parseFrontmatter,
  parseSkill,
  parseSkillRefs,
  sanitizeSkillId,
  skillCatalogPrompt,
  groupSkills,
  stripSkillRefs,
  type Skill,
} from "./skill";
import { mergeSkills, pickSkills } from "./skillstore";
import { BUILTIN_COUNT, builtinSkills } from "../skills";

function mk(id: string, extra: Partial<Skill> = {}): Skill {
  return {
    id,
    name: id,
    description: `关于 ${id} 的规范`,
    triggers: [id],
    category: "通用",
    stage: "write",
    source: "builtin",
    dir: null,
    body: `# ${id} 正文`,
    ...extra,
  };
}

describe("parseFrontmatter", () => {
  it("读出键值对与正文", () => {
    const r = parseFrontmatter("---\nname: demo\ndescription: 说明\n---\n# 标题\n正文");
    expect(r.data.name).toBe("demo");
    expect(r.data.description).toBe("说明");
    expect(r.body).toBe("# 标题\n正文");
  });

  it("去掉值两侧的引号", () => {
    const r = parseFrontmatter('---\nname: "带: 冒号"\ndescription: \'单引号\'\n---\nx');
    expect(r.data.name).toBe("带: 冒号");
    expect(r.data.description).toBe("单引号");
  });

  it("支持行内列表", () => {
    const r = parseFrontmatter('---\ntriggers: [react, "组件, 页面", hooks]\n---\nx');
    expect(r.data.triggers).toEqual(["react", "组件, 页面", "hooks"]);
  });

  it("支持换行列表", () => {
    const r = parseFrontmatter("---\ntriggers:\n  - react\n  - 组件\nversion: 1\n---\nx");
    expect(r.data.triggers).toEqual(["react", "组件"]);
    expect(r.data.version).toBe("1");
  });

  it("兼容 CRLF 与 BOM", () => {
    const r = parseFrontmatter("\uFEFF---\r\nname: demo\r\n---\r\n正文\r\n第二行");
    expect(r.data.name).toBe("demo");
    expect(r.body).toBe("正文\n第二行");
  });

  it("没有 frontmatter 时整段当正文", () => {
    const r = parseFrontmatter("# 只有正文\n内容");
    expect(r.data).toEqual({});
    expect(r.body).toBe("# 只有正文\n内容");
  });

  it("分隔符没闭合时不吞内容", () => {
    const r = parseFrontmatter("---\nname: demo\n正文没结束");
    expect(r.data).toEqual({});
    expect(r.body).toContain("正文没结束");
  });
});

describe("parseSkill", () => {
  const md = "---\nname: React 规范\ndescription: 写组件时用\ntriggers: [react]\nversion: 1.0.0\n---\n# 规则\n1. 不滥用 effect";

  it("解析成功时字段齐全", () => {
    const r = parseSkill(md, { id: "react-ts", source: "builtin" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.name).toBe("React 规范");
    expect(r.skill.triggers).toEqual(["react"]);
    expect(r.skill.version).toBe("1.0.0");
    expect(r.skill.body).toContain("不滥用 effect");
    expect(r.skill.dir).toBeNull();
  });

  it("本地技能保留目录，供 @@ref 取附件", () => {
    const r = parseSkill(md, { id: "react-ts", source: "local", dir: "F:\\lib\\react-ts" });
    expect(r.ok && r.skill.dir).toBe("F:\\lib\\react-ts");
  });

  it("缺 description 直接判无效", () => {
    const r = parseSkill("---\nname: x\n---\n正文", { id: "x", source: "builtin" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("description");
  });

  it("正文为空直接判无效", () => {
    const r = parseSkill("---\nname: x\ndescription: y\n---\n\n", { id: "x", source: "builtin" });
    expect(r.ok).toBe(false);
  });

  it("id 会被清洗成安全形式", () => {
    expect(sanitizeSkillId("React TS")).toBe("react-ts");
    const r = parseSkill(md, { id: "React TS", source: "builtin" });
    expect(r.ok && r.skill.id).toBe("react-ts");
  });
});

describe("skillCatalogPrompt", () => {
  it("没有技能时为空串", () => {
    expect(skillCatalogPrompt([])).toBe("");
  });

  it("列出 id、名称、描述与触发词", () => {
    const p = skillCatalogPrompt([mk("react-ts", { name: "React 规范", triggers: ["react", "组件"] })]);
    expect(p).toContain("react-ts · React 规范");
    expect(p).toContain("触发：react、组件");
    expect(p).toContain("@@ref:");
  });

  it("过长描述会截断", () => {
    const p = skillCatalogPrompt([mk("x", { description: "长".repeat(200) })]);
    expect(p).toContain("…");
    expect(p.length).toBeLessThan(400);
  });
});

describe("buildSkillPrompt", () => {
  it("没有启用技能时为空串", () => {
    expect(buildSkillPrompt([])).toBe("");
  });

  it("带上正文与执行要求", () => {
    const p = buildSkillPrompt([mk("react-ts", { body: "# 规则\n不滥用 effect" })]);
    expect(p).toContain("react-ts");
    expect(p).toContain("不滥用 effect");
    expect(p).toContain("执行要求");
  });

  it("超过上限只取前几个", () => {
    const many = [mk("a"), mk("b"), mk("c"), mk("d")];
    const p = buildSkillPrompt(many);
    expect(p).toContain("技能 a｜");
    expect(p).toContain("技能 c｜");
    expect(p).not.toContain("技能 d｜");
    expect(p).not.toContain("= d =");
  });

  it("超长正文截断并给出取用提示", () => {
    const p = buildSkillPrompt([mk("big", { body: "x".repeat(20000) })]);
    expect(p).toContain("正文已截断");
    expect(p).toContain("@@ref: big/SKILL.md");
  });
});

describe("matchSkills", () => {
  const skills = [
    mk("react-ts", { triggers: ["react", "组件"] }),
    mk("go-svc", { triggers: ["go"] }),
    mk("sql-schema", { triggers: ["建表", "索引"] }),
  ];

  it("中文触发词按子串命中", () => {
    expect(matchSkills(skills, "帮我建一张订单表，需要索引").map((s) => s.id)).toEqual(["sql-schema"]);
  });

  it("英文按词边界，django 不会命中 go", () => {
    expect(matchSkills(skills, "改一下 django 的模型")).toEqual([]);
    expect(matchSkills(skills, "用 go 写个服务").map((s) => s.id)).toEqual(["go-svc"]);
  });

  it("已启用的不重复挑", () => {
    expect(matchSkills(skills, "写个 react 组件", ["react-ts"])).toEqual([]);
  });

  it("最多补 limit 个，命中多的优先", () => {
    const out = matchSkills(skills, "react 组件里查数据库建表", [], 2);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("react-ts"); // 命中 react + 组件
  });

  it("空输入不匹配", () => {
    expect(matchSkills(skills, "   ")).toEqual([]);
  });
});

describe("parseSkillRefs", () => {
  it("解析 id/相对路径", () => {
    expect(parseSkillRefs("看下细节\n@@ref: react-ts/refs/hooks.md\n然后继续")).toEqual([
      { skillId: "react-ts", rel: "refs/hooks.md" },
    ]);
  });

  it("只写 id 时默认取 SKILL.md", () => {
    expect(parseSkillRefs("@@ref: react-ts")).toEqual([{ skillId: "react-ts", rel: "SKILL.md" }]);
  });

  it("同一个不重复，越界路径丢弃", () => {
    const out = parseSkillRefs("@@ref: a/SKILL.md\n@@ref: a/SKILL.md\n@@ref: b/../../etc/passwd");
    expect(out).toEqual([{ skillId: "a", rel: "SKILL.md" }]);
  });

  it("最多 4 个", () => {
    const text = [1, 2, 3, 4, 5].map((i) => `@@ref: s${i}/SKILL.md`).join("\n");
    expect(parseSkillRefs(text)).toHaveLength(4);
  });

  it("剥掉指令行后正文干净", () => {
    expect(stripSkillRefs("解释\n\n@@ref: a/SKILL.md\n\n继续")).toBe("解释\n\n继续");
  });
});

describe("mergeSkills / pickSkills", () => {
  it("同 id 时本地覆盖内建", () => {
    const merged = mergeSkills([mk("a", { source: "builtin" })], [mk("a", { source: "local", body: "我的" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].body).toBe("我的");
  });

  it("按 id 取用，丢掉已删除的 id", () => {
    const all = [mk("a"), mk("b")];
    expect(pickSkills(all, ["b", "ghost", "a"]).map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("分类与阶段", () => {
  const src = (fm: string) => `---\nname: 测试\ndescription: 说明${fm}\n---\n# 正文`;

  it("读出 category 与 stage", () => {
    const r = parseSkill(src("\ncategory: 前端\nstage: test"), { id: "x", source: "builtin" });
    expect(r.ok && r.skill.category).toBe("前端");
    expect(r.ok && r.skill.stage).toBe("test");
  });

  it("没有分类时不编造，归到未分类 / other", () => {
    const r = parseSkill(src(""), { id: "x", source: "local" });
    expect(r.ok && r.skill.category).toBe("未分类");
    expect(r.ok && r.skill.stage).toBe("other");
  });

  it("认中文阶段名，认不出来归 other", () => {
    expect(asStage("测试")).toBe("test");
    expect(asStage("发版")).toBe("release");
    expect(asStage("随便写")).toBe("other");
    expect(asStage(undefined)).toBe("other");
  });

  it("分组按已知分类顺序，组内按阶段", () => {
    const list = [
      mk("a", { category: "质量", stage: "review" }),
      mk("b", { category: "前端", stage: "write" }),
      mk("c", { category: "质量", stage: "test" }),
      mk("d", { category: "自定义", stage: "write" }),
    ];
    const g = groupSkills(list);
    expect(g.map((x) => x.key)).toEqual(["前端", "质量", "自定义"]);
    expect(g[1].skills.map((s) => s.id)).toEqual(["c", "a"]);
  });

  it("内建技能都带分类，且没有落进未分类", () => {
    const all = builtinSkills();
    // 断言的是「写的份数」和「解析成功的份数」一致：只要有一份写坏被跳过就会挂，
    // 而不是靠记住 8 还是 11
    expect(all.length).toBe(BUILTIN_COUNT);
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const s of all) expect(s.category).not.toBe("未分类");
  });

  it("新增的三条能力类技能都在，且带触发词", () => {
    const all = builtinSkills();
    for (const id of ["module-boundaries", "debug-first", "verify-before-done"]) {
      const s = all.find((x) => x.id === id);
      expect(s, id).toBeTruthy();
      expect(s!.triggers.length, id).toBeGreaterThan(0);
      expect(s!.body.length, id).toBeGreaterThan(500);
      expect(s!.body.length, id).toBeLessThan(12000);
    }
  });
});
