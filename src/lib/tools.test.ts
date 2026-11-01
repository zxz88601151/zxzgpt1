import { describe, expect, it } from "vitest";
import {
  accumulateToolCallDeltas,
  isAllowedCommand,
  MAX_TEST_ROUNDS,
  parseToolCallsFromMessage,
  testLoopDecision,
  truncateToolOutput,
  validateToolArgs,
} from "./tools";

describe("isAllowedCommand", () => {
  it("放行测试、构建与只读 Git", () => {
    expect(isAllowedCommand(["npm", "test"])).toBeNull();
    expect(isAllowedCommand(["npm", "test", "src/lib/tools.test.ts"])).toBeNull();
    expect(isAllowedCommand(["npm", "run", "build"])).toBeNull();
    expect(isAllowedCommand(["npm", "run", "lint"])).toBeNull();
    expect(isAllowedCommand(["npx", "vitest", "run"])).toBeNull();
    expect(isAllowedCommand(["npx", "vitest", "run", "src/lib/tools.test.ts"])).toBeNull();
    expect(isAllowedCommand(["git", "status"])).toBeNull();
    expect(isAllowedCommand(["git", "status", "--short"])).toBeNull();
    expect(isAllowedCommand(["git", "diff"])).toBeNull();
    expect(isAllowedCommand(["git", "diff", "--stat"])).toBeNull();
  });
  it("拒绝安装、发布、推送、删除与改写历史", () => {
    expect(isAllowedCommand(["npm", "install"])).not.toBeNull();
    expect(isAllowedCommand(["npm", "publish"])).not.toBeNull();
    expect(isAllowedCommand(["git", "push"])).not.toBeNull();
    expect(isAllowedCommand(["git", "commit", "-m", "x"])).not.toBeNull();
    expect(isAllowedCommand(["git", "reset", "--hard"])).not.toBeNull();
    expect(isAllowedCommand(["git", "clean", "-fd"])).not.toBeNull();
    expect(isAllowedCommand(["rm", "-rf", "."])).not.toBeNull();
    expect(isAllowedCommand(["curl", "https://example.com"])).not.toBeNull();
  });
  it("拒绝 shell 元字符与危险附加参数", () => {
    expect(isAllowedCommand(["npm", "test", "a;rm -rf ."])).not.toBeNull();
    expect(isAllowedCommand(["npm", "test", "$(whoami)"])).not.toBeNull();
    expect(isAllowedCommand(["npm", "test", "--watch"])).not.toBeNull();
    expect(isAllowedCommand(["npm", "test", "../outside"])).not.toBeNull();
    expect(isAllowedCommand(["git", "diff", "--cached"])).not.toBeNull();
    expect(isAllowedCommand([])).not.toBeNull();
  });
});

describe("validateToolArgs", () => {
  it("路径校验与 write_file 必填项", () => {
    expect(validateToolArgs("read_file", { path: "../x.ts" })).not.toBeNull();
    expect(validateToolArgs("read_file", { path: "src/a.ts" })).toBeNull();
    expect(validateToolArgs("write_file", { path: "src/a.ts" })).not.toBeNull();
    expect(validateToolArgs("write_file", { path: "src/a.ts", content: "" })).toBeNull();
    expect(validateToolArgs("search_files", { query: "  " })).not.toBeNull();
    expect(validateToolArgs("search_files", { query: "TODO" })).toBeNull();
    expect(validateToolArgs("run_command", { argv: ["npm", "test"] })).toBeNull();
    expect(validateToolArgs("run_command", { argv: ["npm", "install"] })).not.toBeNull();
    expect(validateToolArgs("nope", {})).not.toBeNull();
  });
});

describe("accumulateToolCallDeltas", () => {
  it("按 index 合并 arguments 片段，id/name 取首次", () => {
    const out = accumulateToolCallDeltas([
      { index: 0, id: "call_1", name: "read_file", arguments: "{\"pa" },
      { index: 0, arguments: "th\": \"src/a.ts\"}" },
      { index: 1, id: "call_2", name: "run_command", arguments: "{\"argv\": [\"npm\", \"test\"]}" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: "call_1", name: "read_file", arguments: "{\"path\": \"src/a.ts\"}" });
    expect(out[1].name).toBe("run_command");
  });
  it("缺 id 时用 index 补位，不丢调用", () => {
    const out = accumulateToolCallDeltas([{ index: 3, name: "list_dir", arguments: "{}" }]);
    expect(out[0].id).toBe("call_3");
  });
});

describe("parseToolCallsFromMessage", () => {
  it("解析非流式 tool_calls，缺字段不崩", () => {
    const out = parseToolCallsFromMessage({
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
        { function: {} },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("read_file");
    expect(out[1].id).toBe("call_1");
  });
  it("没有 tool_calls 返回空数组", () => {
    expect(parseToolCallsFromMessage({})).toEqual([]);
    expect(parseToolCallsFromMessage(null)).toEqual([]);
  });
});

describe("truncateToolOutput", () => {
  it("短输出原样返回，长输出截断并注明", () => {
    expect(truncateToolOutput("ok")).toBe("ok");
    const long = "x".repeat(25000);
    const out = truncateToolOutput(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("已截断");
  });
});

describe("testLoopDecision", () => {
  it("通过、重试、放弃三态分明", () => {
    expect(testLoopDecision(0, 1)).toBe("pass");
    expect(testLoopDecision(1, 1)).toBe("retry");
    expect(testLoopDecision(1, MAX_TEST_ROUNDS)).toBe("give_up");
    expect(testLoopDecision(null, 2)).toBe("retry");
  });
});
