import { describe, expect, it } from "vitest";
import { highlight, isKeyword } from "./hl";

describe("highlight", () => {
  it("标记关键字", () => {
    expect(highlight("const a = 1")).toContain('<span class="tk-key">const</span>');
  });

  it("标记注释（行注释与块注释）", () => {
    expect(highlight("// 说明")).toContain('<span class="tk-com">// 说明</span>');
    expect(highlight("# 说明")).toContain('<span class="tk-com"># 说明</span>');
    expect(highlight("/* 多行\n注释 */")).toContain('<span class="tk-com">/* 多行\n注释 */</span>');
  });

  it("标记字符串", () => {
    expect(highlight('say("你好")')).toContain('<span class="tk-str">"你好"</span>');
  });

  it("标记数字", () => {
    expect(highlight("n = 42")).toContain('<span class="tk-num">42</span>');
  });

  it("函数调用与关键字调用分开处理", () => {
    expect(highlight("foo(1)")).toContain('<span class="tk-fn">foo</span>');
    expect(highlight("if(x)")).toContain('<span class="tk-key">if</span>');
  });

  it("普通标识符不加标记", () => {
    expect(highlight("const total = 1")).toContain("total");
    expect(highlight("const total = 1")).not.toContain('<span class="tk-fn">total</span>');
  });

  it("关键字表覆盖多语言", () => {
    expect(isKeyword("fn")).toBe(true);
    expect(isKeyword("SELECT")).toBe(true);
    expect(isKeyword("self")).toBe(true);
    expect(isKeyword("nonsenseWord")).toBe(false);
  });
});
