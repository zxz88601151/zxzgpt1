import { describe, expect, it } from "vitest";
import { clamp, escapeHtml, formatTime, safeJsonParse, sliceContext, uid } from "./text";

describe("escapeHtml", () => {
  it("转义三个危险字符", () => {
    expect(escapeHtml('<a href="x">&\'')).toBe("&lt;a href=\"x\"&gt;&amp;'");
  });

  it("非字符串输入按字符串处理", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(null)).toBe("null");
  });
});

describe("clamp", () => {
  it("限制上下界", () => {
    expect(clamp(-1, 0, 100)).toBe(0);
    expect(clamp(101, 0, 100)).toBe(100);
    expect(clamp(50, 0, 100)).toBe(50);
  });
});

describe("formatTime", () => {
  it("补零到 HH:MM", () => {
    const ts = new Date(2026, 0, 2, 9, 5).getTime();
    expect(formatTime(ts)).toBe("09:05");
  });
});

describe("safeJsonParse", () => {
  it("合法 JSON 返回对象", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it("非法 JSON 返回 null 而不抛错", () => {
    expect(safeJsonParse("data: x")).toBeNull();
  });
});

describe("uid", () => {
  it("短时间内多次生成也不重复", () => {
    const set = new Set(Array.from({ length: 200 }, () => uid()));
    expect(set.size).toBe(200);
  });
});

describe("sliceContext", () => {
  const list = [
    { role: "user", content: "1" },
    { role: "assistant", content: "2" },
    { role: "user", content: "3" },
    { role: "assistant", content: "4" },
    { role: "user", content: "5" },
  ];

  it("最后一条是提问时，提问不占轮数名额", () => {
    expect(sliceContext(list, 1).map((m) => m.content)).toEqual(["3", "4", "5"]);
    expect(sliceContext(list, 2).map((m) => m.content)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("轮数超过历史长度时返回全部", () => {
    expect(sliceContext(list, 99)).toHaveLength(5);
  });

  it("空列表安全", () => {
    expect(sliceContext([], 3)).toEqual([]);
  });
});
