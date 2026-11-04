import { describe, expect, it } from "vitest";
import { applyEdit, applyHunks } from "./patch";

describe("applyEdit：单处精确替换", () => {
  it("恰好命中一次时替换成功，其余内容原样不动", () => {
    const r = applyEdit("const a = 1;\nconst b = 2;\n", "const a = 1;", "const a = 10;");
    expect(r).toEqual({ ok: true, content: "const a = 10;\nconst b = 2;\n" });
  });

  it("命中 0 次时报错，不返回半成品", () => {
    const r = applyEdit("const a = 1;\n", "const a = 2;", "const a = 3;");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("没有命中");
  });

  it("命中多次时报错，并告诉你要扩上下文", () => {
    const r = applyEdit("x = 1;\nx = 1;\n", "x = 1;", "x = 2;");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("2 次");
  });

  it("old_text 为空时拒绝：空串处处命中，没法定位", () => {
    const r = applyEdit("abc", "", "x");
    expect(r.ok).toBe(false);
  });

  it("old_text 与 new_text 相同时拒绝：这次编辑没有改动", () => {
    const r = applyEdit("abc", "b", "b");
    expect(r.ok).toBe(false);
  });

  it("new_text 为空串表示删除", () => {
    const r = applyEdit("keep\ndelete me\nkeep2\n", "delete me\n", "");
    expect(r).toEqual({ ok: true, content: "keep\nkeep2\n" });
  });

  it("CRLF 文件按 CRLF 匹配与输出，不被改成 LF", () => {
    const r = applyEdit("a\r\nb\r\n", "a\nb", "a2\nb");
    expect(r).toEqual({ ok: true, content: "a2\r\nb\r\n" });
  });
});

describe("applyHunks：多处补丁", () => {
  it("hunk 按顺序作用，后一个可以用前一个的结果", () => {
    const r = applyHunks("a=1\nb=2\n", [
      { old_text: "a=1", new_text: "a=10" },
      { old_text: "a=10\nb=2", new_text: "a=10\nb=20" },
    ]);
    expect(r).toEqual({ ok: true, content: "a=10\nb=20\n" });
  });

  it("任一 hunk 失败就整体报错，标出是第几个 hunk", () => {
    const r = applyHunks("a=1\nb=2\n", [
      { old_text: "a=1", new_text: "a=10" },
      { old_text: "b=3", new_text: "b=30" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("第 2 个 hunk");
  });

  it("hunks 为空时拒绝", () => {
    const r = applyHunks("abc", []);
    expect(r.ok).toBe(false);
  });

  it("CRLF 文件多 hunk 后仍是 CRLF", () => {
    const r = applyHunks("a\r\nb\r\n", [
      { old_text: "a", new_text: "a2" },
      { old_text: "b", new_text: "b2" },
    ]);
    expect(r).toEqual({ ok: true, content: "a2\r\nb2\r\n" });
  });
});
