/** 用真实仓库验证扫描器：结论要和人工审计对得上，否则这工具没用。
 *
 *   npx esbuild src/lib/skillscan.ts --format=cjs --outfile=.zxz/tmp/skillscan.cjs --log-level=error
 *   node tools/scan-real.cjs gstack addy vercel-labs hashicorp
 *
 * 仓库来自 `.zxz/audit-src/`（codeload 拉的 tarball 解压而来，不进仓库）。
 * 只用来人眼复核规则改动的影响面，不参与测试——真实数据会变，不能当断言。
 */
const fs = require("node:fs");
const path = require("node:path");
const { scanSkill, summarizeScans, sortScans, isClean } = require("../.zxz/tmp/skillscan.cjs");

const BASE = path.join(__dirname, "..", ".zxz", "audit-src");

function walk(dir, out = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "SKILL.md") out.push(p);
  }
  return out;
}

const repos = process.argv.slice(2);
if (!repos.length) {
  console.error("用法：node tools/scan-real.cjs <仓库目录名>…");
  process.exit(1);
}

for (const repo of repos) {
  const files = walk(path.join(BASE, repo));
  const results = files.map((f) => {
    const txt = fs.readFileSync(f, "utf8");
    // 去掉 frontmatter，和 parseSkill 的处理一致
    const body = txt.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const id = path.relative(BASE, path.dirname(f)).replace(/\\/g, "/");
    return scanSkill(id, path.basename(path.dirname(f)), body);
  });
  const s = summarizeScans(results);
  console.log(
    `\n=== ${repo}: ${s.total} 个技能，${s.clean} 干净，${s.withCode} 有代码块命中，${s.softOnly} 只有软命中，共 ${s.findings} 处 ===`
  );
  for (const r of sortScans(results).filter((x) => !isClean(x)).slice(0, 6)) {
    console.log(`  ${r.name.padEnd(30)} code=${r.code} prose=${r.prose} guard=${r.guard}`);
    for (const f of r.findings.slice(0, 3)) {
      console.log(`      :${f.line} [${f.kind}] ${f.label} — ${f.text.slice(0, 80)}`);
    }
  }
}
