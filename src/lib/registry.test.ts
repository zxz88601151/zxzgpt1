import { describe, expect, it } from "vitest";
import {
  buildToolsPrompt,
  findTool,
  planModeBlocks,
  TOOL_DEFS,
  TOOLS,
  validateToolArgs,
  type ToolContext,
} from "./registry";
import type { RunResult } from "./fsapi";

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    readFile: async () => "",
    listDir: async () => [],
    writeFile: async () => [],
    runCommand: async (): Promise<RunResult> => ({ exit_code: 0, stdout: "", stderr: "", timed_out: false, truncated: false }),
    ...over,
  };
}

describe("注册表是唯一来源", () => {
  it("TOOL_DEFS 完全由 TOOLS 派生，没有第二条手写清单", () => {
    expect(TOOL_DEFS).toHaveLength(TOOLS.length);
    for (const spec of TOOLS) {
      const def = TOOL_DEFS.find((d) => d.function.name === spec.name);
      expect(def, `${spec.name} 没有对应的函数声明`).toBeTruthy();
      // 三个字段必须逐字节一致：任何一处手写副本都会在这里分叉
      expect(def?.function.description).toBe(spec.description);
      expect(def?.function.parameters).toEqual(spec.parameters);
      expect(def?.type).toBe("function");
    }
  });

  it("工具名不重复，且 findTool 精确命中", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(findTool(n)?.name).toBe(n);
  });

  it("未注册的工具名一律拒绝，不做别名归一", () => {
    // 变形一旦被归一成同一个工具，参数校验与权限等级的对应关系就变成模糊匹配，
    // 而模糊匹配正是绕过拦截的经典入口。所以这里逐个确认它们落空。
    for (const alias of ["shell_exec", "exec", "", "Run_Command", "RUN_COMMAND", " run_command", "run_command ", "run-command", "writeFile"]) {
      expect(findTool(alias), `${JSON.stringify(alias)} 不该命中任何工具`).toBeNull();
      expect(validateToolArgs(alias, {})).toBe(`未知工具：${alias}`);
    }
  });
});

describe("权限等级", () => {
  it("每个工具都标了等级，只读工具不被计划模式拦", () => {
    for (const spec of TOOLS) {
      expect(["read", "write", "exec"]).toContain(spec.access);
    }
    // 计划模式必须拦住所有会改磁盘或起进程的工具，且只拦这两类
    const blocked = TOOLS.filter((t) => planModeBlocks(t.access)).map((t) => t.name).sort();
    const risky = TOOLS.filter((t) => t.access === "write" || t.access === "exec").map((t) => t.name).sort();
    expect(blocked).toEqual(risky);
    expect(blocked).toEqual(["run_command", "write_file"]);
    for (const t of TOOLS) {
      if (t.access === "read") expect(planModeBlocks(t.access)).toBe(false);
    }
  });

  it("系统提示里的拦截清单与权限等级一致，不靠手写", () => {
    const prompt = buildToolsPrompt(true, false);
    // 文案由 TOOLS 顺序派生，不手写工具名
    expect(prompt).toContain("write_file 和 run_command 会被程序拦截");
    // 只读工具必须仍然可用，否则模型在计划模式下什么都做不了
    expect(prompt).toContain("read_file、list_dir、search_files 仍可用");
    // 非计划模式不该出现拦截文案
    expect(buildToolsPrompt(false, false)).not.toContain("会被程序拦截");
  });
});

describe("Schema 与参数校验不能互相矛盾", () => {
  it("required 里的字段缺了就一定被 validate 拒掉", () => {
    for (const spec of TOOLS) {
      const required = ((spec.parameters.required as string[] | undefined) ?? []).slice();
      if (!required.length) {
        // 没有必填项的工具，空参数必须合法——否则模型按 schema 传参会莫名被拒
        expect(spec.validate({}), `${spec.name} 无必填项却拒绝了空参数`).toBeNull();
        continue;
      }
      expect(spec.validate({}), `${spec.name} 缺必填项却通过了校验`).not.toBeNull();
      // 只补齐一个必填项之外的东西不该让校验意外通过：逐项去掉必填项都要被拒
      for (const missing of required) {
        const args: Record<string, unknown> = {};
        for (const k of required) if (k !== missing) args[k] = k === "argv" ? ["npm", "test"] : "x";
        expect(spec.validate(args), `${spec.name} 缺 ${missing} 却通过了校验`).not.toBeNull();
      }
    }
  });

  it("每个 schema 都关掉了多余属性", () => {
    for (const spec of TOOLS) {
      expect(spec.parameters.additionalProperties, `${spec.name} 没写 additionalProperties`).toBe(false);
      expect(spec.parameters.type).toBe("object");
    }
  });

  it("validateToolArgs 与各工具自带的 validate 完全一致", () => {
    const samples: Record<string, Record<string, unknown>> = {
      read_file: { path: "../etc/passwd" },
      list_dir: { path: "src" },
      search_files: { query: "abc", path: "src" },
      write_file: { path: "a.ts", content: "x" },
      run_command: { argv: ["npm", "install"] },
    };
    for (const spec of TOOLS) {
      const args = samples[spec.name] ?? {};
      expect(validateToolArgs(spec.name, args)).toBe(spec.validate(args));
    }
  });
});

describe("执行入口", () => {
  it("read_file 返回内容，超长会被截断并注明", async () => {
    const spec = findTool("read_file")!;
    const out = await spec.run({ path: "a.ts" }, fakeCtx({ readFile: async () => "hello" }));
    expect(out).toEqual({ result: "hello" });

    const big = await spec.run({ path: "a.ts" }, fakeCtx({ readFile: async () => "x".repeat(30000) }));
    expect(big.result?.length).toBeLessThan(30000);
    expect(big.result).toContain("已截断");
  });

  it("list_dir 空目录给人话，不返回空字符串", async () => {
    const spec = findTool("list_dir")!;
    expect((await spec.run({}, fakeCtx())).result).toBe("(空目录)");
  });

  it("write_file 用户放弃时不谎报成功", async () => {
    const spec = findTool("write_file")!;
    expect((await spec.run({ path: "a.ts", content: "x" }, fakeCtx({ writeFile: async () => [] }))).error).toContain("用户放弃");
    const failed = await spec.run({ path: "a.ts", content: "x" }, fakeCtx({ writeFile: async () => [{ ok: false, error: "回读不一致" }] }));
    expect(failed.error).toBe("回读不一致");
    const ok = await spec.run(
      { path: "a.ts", content: "x" },
      fakeCtx({ writeFile: async () => [{ ok: true, path: "a.ts", bytes: 1, created: true, verified: true }] })
    );
    expect(ok.result).toContain("已写入 a.ts");
    expect(ok.result).toContain("新建");
  });

  it("run_command 在注册表这一层也重查白名单，不只靠外层", async () => {
    const spec = findTool("run_command")!;
    const out = await spec.run({ argv: ["npm", "install"] }, fakeCtx());
    expect(out.error).toContain("npm 只允许");
  });

  it("run_command 执行前审计 package.json 脚本，坏脚本不进子进程", async () => {
    const spec = findTool("run_command")!;
    let called = false;
    const out = await spec.run(
      { argv: ["npm", "test"] },
      fakeCtx({
        readFile: async () => JSON.stringify({ scripts: { test: "node evil.js" } }),
        runCommand: async () => {
          called = true;
          return { exit_code: 0, stdout: "", stderr: "", timed_out: false, truncated: false };
        },
      })
    );
    expect(out.error).toContain("受信任");
    expect(called, "审计没过还真的把命令跑出去了").toBe(false);
  });

  it("run_command 读不到 package.json 时拒绝，不当成没脚本", async () => {
    const spec = findTool("run_command")!;
    const out = await spec.run(
      { argv: ["npm", "test"] },
      fakeCtx({
        readFile: async () => {
          throw new Error("不存在");
        },
      })
    );
    expect(out.error).toContain("无法读取 package.json");
  });

  it("run_command 正常结果带退出码，截断时明确告知模型", async () => {
    const spec = findTool("run_command")!;
    const base = { exit_code: 0, stdout: "ok", stderr: "", timed_out: false, truncated: false };
    const okOut = await spec.run({ argv: ["git", "status"] }, fakeCtx({ runCommand: async () => base }));
    expect(okOut.result).toContain("退出码：0");

    const cut = await spec.run(
      { argv: ["git", "status"] },
      fakeCtx({ runCommand: async () => ({ ...base, truncated: true }) })
    );
    expect(cut.result).toContain("已截断");
    expect(cut.result).toContain("不要把「没看到报错」当成测试通过");
  });

  it("search_files 走注入的上下文，不做真实 IO", async () => {
    const spec = findTool("search_files")!;
    const out = await spec.run(
      { query: "needle" },
      fakeCtx({
        listDir: async (rel) => (rel === "" ? [{ name: "a.ts", path: "/p/a.ts", dir: false, size: 10 }] : []),
        readFile: async () => "line1\nhas NEEDLE here\n",
      })
    );
    expect(out.result).toContain("a.ts:2");
  });
});
