import { describe, expect, it } from "vitest";
import { collapseContext, diffBadge, diffLines, diffStats } from "./diff";

const types = (a: string, b: string) => diffLines(a, b).map((l) => `${l.type}:${l.text}`);

describe("diffLines", () => {
  it("完全相同没有任何变更", () => {
    const t = "a\nb\nc";
    expect(diffLines(t, t).every((l) => l.type === "eq")).toBe(true);
    expect(diffStats(diffLines(t, t))).toEqual({ add: 0, del: 0 });
  });

  it("单行替换 = 一删一加", () => {
    expect(types("a\nb\nc", "a\nB\nc")).toEqual(["eq:a", "del:b", "add:B", "eq:c"]);
  });

  it("纯新增行", () => {
    expect(types("a\nc", "a\nb\nc")).toEqual(["eq:a", "add:b", "eq:c"]);
  });

  it("纯删除行", () => {
    expect(types("a\nb\nc", "a\nc")).toEqual(["eq:a", "del:b", "eq:c"]);
  });

  it("新建文件：旧为空时全是新增", () => {
    const out = diffLines("", "x\ny");
    expect(out).toEqual([
      { type: "add", text: "x", b: 1 },
      { type: "add", text: "y", b: 2 },
    ]);
  });

  it("行号分别跟着两侧走", () => {
    const out = diffLines("a\nb\nc", "a\nc");
    expect(out.find((l) => l.type === "eq" && l.text === "c")).toMatchObject({ a: 3, b: 2 });
    const del = out.find((l) => l.type === "del");
    expect(del?.a).toBe(2);
    expect(del?.b).toBeUndefined();
  });

  it("忽略末尾换行差异（不多出一行空行）", () => {
    expect(diffLines("a\nb\n", "a\nb").filter((l) => l.type !== "eq")).toHaveLength(0);
  });

  it("兼容 CRLF", () => {
    expect(diffLines("a\r\nb", "a\nb").every((l) => l.type === "eq")).toBe(true);
  });

  it("超大块退化成整体替换，不会卡死", () => {
    const old = Array.from({ length: 3000 }, (_, i) => `old-${i}`).join("\n");
    const neu = Array.from({ length: 3000 }, (_, i) => `new-${i}`).join("\n");
    const out = diffLines(old, neu, 1000); // 故意把阈值压到很小
    const stats = diffStats(out);
    expect(stats.del).toBe(3000);
    expect(stats.add).toBe(3000);
  });

  it("公共前后缀被裁掉，中间才是 diff", () => {
    const head = Array.from({ length: 50 }, (_, i) => `h${i}`).join("\n");
    const out = diffLines(`${head}\nold\ntail`, `${head}\nnew\ntail`);
    expect(out.filter((l) => l.type !== "eq")).toHaveLength(2);
    // 50 行前缀 + 1 删 + 1 加 + 1 行后缀
    expect(out).toHaveLength(53);
  });
});

describe("diffBadge", () => {
  it("给出 +N −N 摘要", () => {
    expect(diffBadge(diffLines("a\nb", "a\nc\nd"))).toBe("+2 −1");
    expect(diffBadge(diffLines("a", "a"))).toBe("");
    expect(diffBadge(diffLines("a", "a\nb"))).toBe("+1");
  });
});

describe("collapseContext", () => {
  it("长段未改动折叠成 gap", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const neu = `${old}\nnew`;
    const rows = collapseContext(diffLines(old, neu), 2);
    const gap = rows.find((r) => r.type === "gap");
    expect(gap).toBeTruthy();
    expect(rows.filter((r) => r.type !== "gap").length).toBeLessThan(20);
  });

  it("改动集中时不折叠", () => {
    const rows = collapseContext(diffLines("a\nb\nc", "a\nB\nc"), 3);
    expect(rows.some((r) => r.type === "gap")).toBe(false);
  });
});
