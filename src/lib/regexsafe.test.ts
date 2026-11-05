/** D-21：正则搜索的 ReDoS 防护，纯函数回归。 */

import { describe, expect, it } from "vitest";
import {
  compileSearchRegExp,
  MAX_REGEX_LENGTH,
  MAX_TEST_LINE_CHARS,
  safeRegExpError,
} from "./regexsafe";

describe("safeRegExpError：拒绝已知灾难性回溯构造", () => {
  it.each([
    "(a+)+$",
    "(a*)*",
    "(.*a){10}",
    "(a|aa)+$",
    "(foo|foobar)*",
    "a{1000}",
    "a{1000,}",
    "a{20,}",
    "(".repeat(10) + "a" + ")".repeat(10),
    "a".repeat(MAX_REGEX_LENGTH + 1),
    "(unclosed",
  ])("拒绝 %s", (pattern) => {
    expect(safeRegExpError(pattern)).not.toBeNull();
  });

  it("拒绝原因带可读中文，方便模型换个写法", () => {
    expect(safeRegExpError("(a+)+$")).toMatch(/嵌套量词/);
    expect(safeRegExpError("a{1000}")).toMatch(/重复次数/);
  });

  it.each(["use[A-Z]", "= 1", "\\d+", "foo|bar", "^import .* from", "[a-z]{2,4}", "TODO|FIXME"])(
    "放行常见合法模式 %s",
    (pattern) => {
      expect(safeRegExpError(pattern)).toBeNull();
    }
  );
});

describe("compileSearchRegExp：run 入口的二次校验", () => {
  it("合法模式编译成大小写不敏感的 RegExp", () => {
    const { re, error } = compileSearchRegExp("use[A-Z]");
    expect(error).toBeNull();
    expect(re).toBeInstanceOf(RegExp);
    expect(re!.test("const useState = 1")).toBe(true);
    expect(re!.test("const usestate = 1")).toBe(true);
  });

  it("危险模式不会产出 RegExp（调用方拿不到可 test 的对象）", () => {
    const { re, error } = compileSearchRegExp("(a+)+$");
    expect(re).toBeNull();
    expect(error).toMatch(/嵌套量词/);
  });

  it("截断常量稳定：行长上限远小于整文件、且为正", () => {
    expect(MAX_TEST_LINE_CHARS).toBeGreaterThan(0);
    expect(MAX_TEST_LINE_CHARS).toBeLessThanOrEqual(4000);
  });
});
