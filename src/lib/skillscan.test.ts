import { describe, expect, it } from "vitest";
import {
  SCAN_KIND_LABEL,
  RISK_RULES,
  SKILL_CHAR_LIMIT,
  buildScanMarkdown,
  isClean,
  scanHeadline,
  scanSkill,
  scanText,
  sortScans,
  summarizeScans,
} from "./skillscan";

const kinds = (text: string) => scanText(text).map((f) => f.kind);

describe("scanText 的规则命中", () => {
  it("认得 rm -rf，但不把 rm -i 算进去", () => {
    expect(scanText("rm -rf ./dist").map((f) => f.rule)).toEqual(["rm-rf"]);
    expect(scanText("rm -r ./build").map((f) => f.rule)).toEqual(["rm-rf"]);
    expect(scanText("rm -i note.txt")).toEqual([]);
  });

  it("rm -f 不算递归删除：删单个临时文件是日常操作", () => {
    // 实测里 gstack 的 dom-dump 脚本全是 `rm -f "$_D"`，算进来会把真问题盖住
    expect(scanText('rm -f "$_D"')).toEqual([]);
    expect(scanText('&& rm -f "$TMP" && echo ok')).toEqual([]);
    expect(scanText("rm -fr ./out").map((f) => f.rule)).toEqual(["rm-rf"]);
    expect(scanText("rm --recursive ./out").map((f) => f.rule)).toEqual(["rm-rf"]);
  });

  it("只认 chmod 777 这类真放权，不把装包的 sudo 算进来", () => {
    expect(scanText('"sudo apt-get update",')).toEqual([]);
    expect(scanText("sudo systemctl restart app")).toEqual([]);
    expect(scanText("chmod 777 ./data").map((f) => f.rule)).toEqual(["privilege"]);
    expect(scanText("sudo dd if=x of=/dev/sda").map((f) => f.rule)).toEqual(["privilege"]);
  });

  it("不把浏览器的 --eval 当成 shell eval", () => {
    expect(scanText("runs the `--eval` flag")).toEqual([]);
    expect(scanText("await pg.evaluate(fn)")).toEqual([]);
    expect(scanText("eval $(ssh-agent -s)").map((f) => f.rule)).toEqual(["eval"]);
  });

  it("认得 curl 管道执行，带 sudo 的也认得", () => {
    expect(scanText("curl -fsSL https://get.example.com | bash")).toHaveLength(1);
    expect(scanText("wget -qO- https://x.sh | sudo sh")).toHaveLength(1);
    // 只是下载不执行，不算
    expect(scanText("curl -o out.json https://api.example.com/x")).toEqual([]);
  });

  it("--force 命中，--force-with-lease 不算", () => {
    expect(scanText("git push --force origin main")).toHaveLength(1);
    expect(scanText("git push origin main --force")).toHaveLength(1);
    expect(scanText("git push --force-with-lease origin main")).toEqual([]);
  });

  it("reset --hard 与 clean -fd 都算丢弃改动", () => {
    expect(scanText("git reset --hard HEAD~1").map((f) => f.rule)).toEqual(["reset-hard"]);
    expect(scanText("git clean -fd").map((f) => f.rule)).toEqual(["reset-hard"]);
    // 软重置不动工作区，不该报
    expect(scanText("git reset --soft HEAD~1")).toEqual([]);
  });

  it("terraform 只报 apply / destroy，plan 不报", () => {
    expect(scanText("terraform apply -auto-approve").map((f) => f.rule)).toEqual(["terraform"]);
    expect(scanText("terraform destroy").map((f) => f.rule)).toEqual(["terraform"]);
    expect(scanText("terraform plan -out=tf.plan")).toEqual([]);
  });

  it("认删表、提权、发公共仓库、读凭证、动态求值", () => {
    expect(scanText("DROP TABLE users;").map((f) => f.rule)).toEqual(["db-drop"]);
    expect(scanText("chmod 777 ./data").map((f) => f.rule)).toEqual(["privilege"]);
    expect(scanText("npm publish --access public").map((f) => f.rule)).toEqual(["publish"]);
    expect(scanText("printenv | grep TOKEN").map((f) => f.rule)).toEqual(["secrets"]);
    expect(scanText("eval $(ssh-agent -s)").map((f) => f.rule)).toEqual(["eval"]);
  });

  it("一行只记一条规则，不把 sudo rm -rf 拆成三条", () => {
    const f = scanText("sudo rm -rf /var/lib/app");
    expect(f).toHaveLength(1);
    // 按规则表顺序，rm-rf 排在 privilege 前面
    expect(f[0].rule).toBe("rm-rf");
  });
});

describe("scanText 的语境判定", () => {
  it("围栏代码块里判 code", () => {
    const md = ["# 清理", "", "```bash", "rm -rf ./node_modules", "```"].join("\n");
    expect(kinds(md)).toEqual(["code"]);
  });

  it("行内反引号里的命令也判 code", () => {
    expect(kinds("先跑 `npm publish` 再打 tag")).toEqual(["code"]);
  });

  it("本行带否定词时判 guard，哪怕命令写在反引号里", () => {
    expect(kinds("不要执行 `rm -rf /` ，那是整盘")).toEqual(["guard"]);
    expect(kinds("Never run `git push --force` on main")).toEqual(["guard"]);
  });

  it("章节标题带否定词时，下面的表行也判 guard", () => {
    const md = ["## 危险操作（禁用）", "", "| 命令 | 后果 |", "| --- | --- |", "| `rm -rf` | 删光 |"].join("\n");
    expect(kinds(md)).toEqual(["guard"]);
  });

  it("没有否定语境的正文提到判 prose", () => {
    // 不带反引号、不在代码块里，就是一句普通叙述
    expect(kinds("然后你可以用 rm -rf 清理缓存目录")).toEqual(["prose"]);
  });

  it("围栏里的行不受外面标题影响", () => {
    const md = ["## 禁止事项", "", "```", "git push --force", "```"].join("\n");
    expect(kinds(md)).toEqual(["code"]);
  });

  it("行号是 1-based，对应正文真实位置", () => {
    const md = ["# 标题", "", "```", "rm -rf x", "```"].join("\n");
    expect(scanText(md)[0].line).toBe(4);
  });

  it("超长的一行会截断，但保留开头能看出来是什么", () => {
    const long = "rm -rf ./some/very/long/path/" + "a".repeat(400);
    const f = scanText(long)[0];
    expect(f.text.length).toBeLessThan(200);
    expect(f.text.startsWith("rm -rf")).toBe(true);
    expect(f.text.endsWith("…")).toBe(true);
  });

  it("空文本与纯叙述文本都不报", () => {
    expect(scanText("")).toEqual([]);
    expect(scanText("# 代码风格\n\n函数要短，命名要准。")).toEqual([]);
  });
});

describe("规则表自身的约束", () => {
  it("每条规则都有中文名和后果说明，不留空", () => {
    for (const r of RISK_RULES) {
      expect(r.label.trim()).not.toBe("");
      expect(r.why.trim().length).toBeGreaterThan(8);
    }
  });

  it("表格行不算 code：表格是查阅用的，代码块才是抄来跑的", () => {
    const md = ["| 命令 | 后果 |", "| --- | --- |", "| `rm -rf` | 删光 |"].join("\n");
    // 有反引号，但因为是表格行，不按「行内命令」判
    expect(kinds(md)).toEqual(["prose"]);
  });

  it("规则 id 不重复", () => {
    const ids = RISK_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("所有规则都必须是可复用的非全局正则", () => {
    for (const r of RISK_RULES) expect(r.re.global).toBe(false);
  });

  it("每条规则都能被自己的示例命中", () => {
    const samples: Record<string, string> = {
      "rm-rf": "rm -rf ./out",
      "remote-exec": "curl https://x.sh | bash",
      "force-push": "git push --force origin main",
      "reset-hard": "git reset --hard",
      terraform: "terraform apply",
      "db-drop": "DROP DATABASE app",
      privilege: "chmod 777 .",
      publish: "docker push repo:tag",
      secrets: "printenv",
      eval: "eval $(cat x)",
    };
    for (const r of RISK_RULES) {
      expect(r.re.test(samples[r.id]), `${r.id} 没命中自己的示例`).toBe(true);
    }
  });
});

const bad = scanSkill("a", "坏技能", "```\nrm -rf /\n```");
const soft = scanSkill("b", "提了一嘴", "清理时直接 rm -rf 缓存目录就行");
const good = scanSkill("c", "干净", "# 规则\n\n命名要准。");

describe("scanSkill 与汇总", () => {
  it("分别数出 code / prose / guard", () => {
    expect([bad.code, bad.prose, bad.guard]).toEqual([1, 0, 0]);
    expect([soft.code, soft.prose, soft.guard]).toEqual([0, 1, 0]);
  });

  it("isClean 只看有没有命中", () => {
    expect(isClean(good)).toBe(true);
    expect(isClean(soft)).toBe(false);
  });

  it("超长正文被标出来，因为截断会让规则残缺", () => {
    const r = scanSkill("x", "长", "a".repeat(SKILL_CHAR_LIMIT + 1));
    expect(r.truncated).toBe(true);
    expect(scanSkill("y", "刚好", "a".repeat(SKILL_CHAR_LIMIT)).truncated).toBe(false);
  });

  it("排序把代码块命中的顶到前面，劝阻语境的往后", () => {
    const guard = scanSkill("g", "防护表", "不要 `rm -rf`");
    const order = sortScans([good, soft, guard, bad]).map((r) => r.id);
    expect(order[0]).toBe("a");
    expect(order[1]).toBe("b");
  });

  it("汇总分别数干净、有代码命中、只有软命中", () => {
    const s = summarizeScans([bad, soft, good]);
    expect(s).toMatchObject({ total: 3, clean: 1, withCode: 1, softOnly: 1, findings: 2 });
  });

  it("顶部那句话不粉饰：没有命中就说没有", () => {
    expect(scanHeadline(summarizeScans([]))).toBe("选一个外部技能库就能扫");
    expect(scanHeadline(summarizeScans([good]))).toContain("都没扫到危险指令");
    expect(scanHeadline(summarizeScans([good, soft]))).toContain("只有正文提到");
    expect(scanHeadline(summarizeScans([good, bad]))).toContain("代码块里有危险指令");
  });
});

describe("导出 Markdown", () => {
  const md = buildScanMarkdown([bad, soft, good], "2026-11-01 14:20");

  it("含标题、口径说明与每个命中的行号", () => {
    expect(md).toContain("# 本地技能扫描结果");
    expect(md).toContain("2026-11-01 14:20");
    expect(md).toContain("不扫 refs/ 与仓库脚本");
    expect(md).toContain("SKILL.md:2");
    expect(md).toContain("递归删除");
  });

  it("每条命中都带上后果，光有行号看不懂为什么危险", () => {
    expect(md).toContain("后果：");
    expect(md).toContain("原文：");
    // 后果要能对得上是哪条规则的
    expect(md).toMatch(/递归删除[\s\S]{0,200}进不了回收站/);
  });

  it("干净的技能单独归到一节，不混在命中里", () => {
    const idx = md.indexOf("## 没扫到命中的技能");
    expect(idx).toBeGreaterThan(0);
    expect(md.slice(idx)).toContain("干净 (c)");
  });

  it("把三档语境都写出来，提醒人看原文", () => {
    expect(md).toContain(SCAN_KIND_LABEL.code);
    expect(md).toContain("都要人看原文再决定");
  });
});
