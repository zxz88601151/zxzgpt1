/** D-21 / 独立复审 P1-2：正则搜索的 ReDoS 防护，纯函数回归。 */

import { describe, expect, it } from "vitest";
import {
  compileSearchRegExp,
  MAX_REGEX_LENGTH,
  MAX_TEST_LINE_CHARS,
  safeRegExpError,
  scanRegexRisk,
} from "./regexsafe";

/** 第 1 版静态规则漏掉的绕过形态：? 与 {m,n} 也是量词。 */
const BYPASS_PATTERNS = [
  "(a?)+$",
  "(a?)+",
  "(a*)+$",
  "(a+)*$",
  "(a{1,}){1,}$",
  "(a{0,1})+$",
  "(?:a?)+$",
  "(a?){2,}",
  "(a|a?)+$",
  // 第二轮复审实测可穿透单槽判据的嵌套组：风险必须向上传播
  "((a+))+$",
  "((?:a+))+$",
  "(?:(a+))+$",
  "(((a+)))+$",
  "((a{1,}))+$",
  "((a|aa))+$",
  "((a?))+$",
];

describe("safeRegExpError：拒绝已知灾难性回溯构造", () => {
  it.each([
    "(a+)+$",
    "(a*)*",
    "(.*a){10}",
    "(a|aa)+$",
    "(foo|foobar)*",
    "a{1000}",
    "a{1000,}",
    "a{1,1000}",
    "a{20,}",
    "(".repeat(10) + "a" + ")".repeat(10),
    "a".repeat(MAX_REGEX_LENGTH + 1),
    "(unclosed",
    ...BYPASS_PATTERNS,
  ])("拒绝 %s", (pattern) => {
    expect(safeRegExpError(pattern)).not.toBeNull();
  });

  it("拒绝原因带可读中文，方便模型换个写法", () => {
    expect(safeRegExpError("(a+)+$")).toMatch(/嵌套量词/);
    expect(safeRegExpError("(a?)+$")).toMatch(/嵌套量词/);
    expect(safeRegExpError("(a{1,}){1,}$")).toMatch(/嵌套量词/);
    expect(safeRegExpError("(a|aa)+$")).toMatch(/分支重复/);
    expect(safeRegExpError("a{1000}")).toMatch(/重复次数/);
  });

  it.each(["use[A-Z]", "= 1", "\\d+", "foo|bar", "^import .* from", "[a-z]{2,4}", "TODO|FIXME", "(ab)+", "(a+)b", "(?:foo|bar)"])(
    "放行常见合法模式 %s",
    (pattern) => {
      expect(safeRegExpError(pattern)).toBeNull();
    }
  );
});

describe("scanRegexRisk：独立复审发现的绕过已被同一条判据覆盖", () => {
  it.each(BYPASS_PATTERNS)("%s 判为量词嵌套或量词化分支", (pattern) => {
    const risk = scanRegexRisk(pattern);
    expect(risk.nestedQuantifier || risk.quantifiedAlternation).toBe(true);
  });

  it("分组内无量词、组外量词化 → 放行（不是所有分组都危险）", () => {
    expect(scanRegexRisk("(ab)+")).toEqual({ nestedQuantifier: false, quantifiedAlternation: false, quantifiers: 1 });
    expect(scanRegexRisk("(a+)b")).toEqual({ nestedQuantifier: false, quantifiedAlternation: false, quantifiers: 1 });
  });

  it("量词计数把 ? 与 {m,n} 都算进去，且字符类里的符号不算", () => {
    expect(scanRegexRisk("a?b{2,4}").quantifiers).toBe(2);
    expect(scanRegexRisk("[a-z?+{}]").quantifiers).toBe(0);
  });

  it.each(["((a+))+$", "(?:(a+))+$", "(((a+)))+$", "((a{1,}))+$", "((a|aa))+$"])(
    "嵌套组 %s 的风险传播到外层，仍判为嵌套量词",
    (pattern) => {
      const risk = scanRegexRisk(pattern);
      expect(risk.nestedQuantifier || risk.quantifiedAlternation).toBe(true);
      expect(safeRegExpError(pattern)).toMatch(/灾难性回溯|分支重复/);
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

  it.each(["(a+)+$", ...BYPASS_PATTERNS])("危险模式 %s 不会产出 RegExp（调用方拿不到可 test 的对象）", (pattern) => {
    const { re, error } = compileSearchRegExp(pattern);
    expect(re).toBeNull();
    expect(error).not.toBeNull();
  });

  it("截断常量稳定：行长上限远小于整文件、且为正", () => {
    expect(MAX_TEST_LINE_CHARS).toBeGreaterThan(0);
    expect(MAX_TEST_LINE_CHARS).toBeLessThanOrEqual(4000);
  });
});
